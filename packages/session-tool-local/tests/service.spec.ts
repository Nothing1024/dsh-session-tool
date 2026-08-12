// SessionToolLocalService (remote): owner fences, scope gates, visibility
// rules, and pagination over the web gateway. Session create/write/rename/
// list delegate to the mocked gateway clients; read stays local over the
// persistence backend; the fence and scope logic run in-process over the
// merged header index.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionToolLocalService from 'session-tool-local'
import type { Config as ToolConfig } from 'session-tool-local'
import {
  SessionEmptyContentError,
  SessionNotFoundError,
  SessionScopeDeniedError,
  SessionToolError,
  SessionToolUnauthorizedError,
} from 'session-tool'
import type { SessionToolCaller } from 'session-tool'
import { SessionHttpClient } from '../src/session-client.ts'

vi.mock('../src/session-client.ts')

const TOOL_CONFIG: ToolConfig = {
  allowAllScope: 'top-level',
  cliAllowAll: true,
  readMaxBlocks: 500,
  listMaxRows: 100,
  hiddenPrefixes: ['~', '[internal]'],
  webUrl: 'http://127.0.0.1:3180',
}

/** Compose the minimal read stack: live store + persistence + the service. */
async function compose(root: string, config: ToolConfig = TOOL_CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root })
  await ctx.plugin(SessionToolLocalService, config)
  return ctx
}

/** An agent caller whose own session must exist in the store. */
function agent(id: string, depth = 0): SessionToolCaller {
  return { kind: 'agent', sessionId: SessionId(id), delegationDepth: depth }
}

const CLI: SessionToolCaller = { kind: 'cli' }

/** The last mock session-client instance (the provider constructs one per boot). */
function sessionClient() {
  const constructor = vi.mocked(SessionHttpClient)
  return constructor.mock.instances.at(-1) as {
    durableCreate: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    wait: ReturnType<typeof vi.fn>
  }
}

/** A mock list row shaped like the gateway's SessionListRow. */
function listRow(id: string, options: {
  parentSessionId?: string
  title?: string
  tags?: readonly string[]
  running?: boolean
  updatedAt?: number
} = {}): Parameters<ReturnType<typeof sessionClient>['list']['mock']['resolvedValue']>[0][number] {
  return {
    sessionId: id,
    ...options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId },
    ...options.title === undefined ? {} : { title: options.title },
    ...options.tags === undefined ? {} : { tags: options.tags },
    running: options.running ?? false,
    updatedAt: options.updatedAt ?? 1_700_000_000_000,
  }
}

describe('SessionToolLocalService (remote)', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'session-tool-test-'))
    ctx = await compose(root)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  /** Establish the caller's own session in the live store. */
  function callerSession(id: string) {
    return ctx.sessions.create(SessionId(id))
  }

  describe('create', () => {
    it('delegates to the gateway with title, tags, and explicit lineage', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-9' })
      const created = await ctx.sessionTool.create(agent('caller'), {
        title: 'my session',
        tags: ['wip'],
        parentSessionId: SessionId('caller'),
        cwd: '/proj',
      })
      // An agent caller's creation records its own depth plus one.
      expect(sessionClient().durableCreate).toHaveBeenCalledWith({
        title: 'my session',
        parentSessionId: 'caller',
        tags: ['wip'],
        cwd: '/proj',
        delegationDepth: 1,
      })
      expect(created.sessionId).toBe('session-9')
    })

    it('joins an agent caller tree by default and stays top-level for the CLI', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-1' })
      await ctx.sessionTool.create(agent('caller'), { title: 'child' })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        parentSessionId: 'caller',
        delegationDepth: 1,
      }))
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-2' })
      await ctx.sessionTool.create(CLI, { title: 'top' })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.not.objectContaining({
        parentSessionId: expect.anything(),
      }))
      // The CLI (human identity) records no depth.
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.not.objectContaining({
        delegationDepth: expect.anything(),
      }))
    })

    it('honours an explicit delegation depth and carries a deeper caller depth', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-1' })
      await ctx.sessionTool.create(agent('caller', 2), {
        title: 'deep',
        delegationDepth: 3,
      })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        delegationDepth: 3,
      }))
    })

    it('passes the cwd through when no workspace binding is requested', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-9' })
      await ctx.sessionTool.create(agent('caller'), { cwd: '/custom' })
      expect(sessionClient().durableCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/custom' }))
    })

    it('rejects a ghost caller, a missing parent, and a parent outside the lineage', async () => {
      await expect(ctx.sessionTool.create(agent('ghost'), {}))
        .rejects.toThrow(SessionNotFoundError)
      callerSession('caller')
      callerSession('other')
      await expect(ctx.sessionTool.create(agent('caller'), { parentSessionId: SessionId('nobody') }))
        .rejects.toThrow(SessionNotFoundError)
      await expect(ctx.sessionTool.create(agent('caller'), { parentSessionId: SessionId('other') }))
        .rejects.toThrow(SessionToolUnauthorizedError)
      // The CLI (human) may create under any existing session.
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-x' })
      await expect(ctx.sessionTool.create(CLI, { parentSessionId: SessionId('other') }))
        .resolves.toBeDefined()
    })

    it('propagates a gateway validation rejection', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockRejectedValue(
        new SessionToolError('session title must contain visible characters', 'title-invalid'),
      )
      await expect(ctx.sessionTool.create(agent('caller'), { title: '   ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
    })
  })

  describe('write and read', () => {
    it('sends the prompt to the gateway and returns the session id', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      await ctx.sessions.flush(target)
      sessionClient().prompt.mockResolvedValue({ accepted: true })
      const result = await ctx.sessionTool.write(agent('caller'), SessionId('session-1'), 'hello world')
      expect(sessionClient().prompt).toHaveBeenCalledWith('session-1', 'hello world')
      expect(result).toEqual({ sessionId: 'session-1' })
    })

    it('rejects empty content', async () => {
      callerSession('caller')
      await expect(ctx.sessionTool.write(agent('caller'), SessionId('session-1'), '   '))
        .rejects.toThrow(SessionEmptyContentError)
      expect(sessionClient().prompt).not.toHaveBeenCalled()
    })

    it('reads a locally persisted transcript with incremental and capped reads', async () => {
      callerSession('caller')
      const session = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      const append = (text: string): number => {
        const event = session.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        return event.seq
      }
      append('first')
      const last = append('second')
      await ctx.sessions.flush(session)

      const all = await ctx.sessionTool.read(agent('caller'), SessionId('session-1'), {})
      expect(all.messages.map(row => (row.blocks[0] as { text: string }).text)).toEqual(['first', 'second'])
      const incremental = await ctx.sessionTool.read(agent('caller'), SessionId('session-1'), { sinceSeq: last })
      expect(incremental.messages).toHaveLength(1)
      const capped = await ctx.sessionTool.read(agent('caller'), SessionId('session-1'), { maxBlocks: 1 })
      expect(capped.messages).toHaveLength(1)
      const clamped = await ctx.sessionTool.read(agent('caller'), SessionId('session-1'), { maxBlocks: 999_999 })
      expect(clamped.messages.length).toBeLessThanOrEqual(500)
    })

    it('maps assistant and tool events onto their roles', async () => {
      callerSession('caller')
      const session = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      session.append('user/message', {
        content: [{ type: 'text', text: 'user says' }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'assistant says' }],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/result', {
        turn: 1,
        step: 2,
        message: createToolResultMessage({
          callId: CallId('call-1'),
          content: [{ type: 'text', text: 'tool says' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await ctx.sessions.flush(session)

      const read = await ctx.sessionTool.read(agent('caller'), SessionId('session-1'), {})
      expect(read.messages.map(row => row.role)).toEqual(['user', 'assistant', 'tool'])
      expect(read.messages[1]?.blocks).toEqual([{ type: 'text', text: 'assistant says' }])
    })

    it('rejects missing and foreign sessions; the CLI bypasses the fence', async () => {
      callerSession('caller')
      callerSession('other')
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('missing'), {}))
        .rejects.toThrow(SessionNotFoundError)
      const foreign = ctx.sessions.create(SessionId('foreign'), { meta: { cwd: '/other' } })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('foreign'), {}))
        .rejects.toThrow(SessionToolUnauthorizedError)
      await expect(ctx.sessionTool.read(CLI, SessionId('foreign'), {})).resolves.toBeDefined()
    })

    it('lets a parent reach a child session but not a sibling', async () => {
      callerSession('root')
      const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/proj', parentSession: 'root' } })
      await ctx.sessions.flush(child)
      sessionClient().prompt.mockResolvedValue({ accepted: true })
      await ctx.sessionTool.write(agent('root'), SessionId('child'), 'parent writes child')
      expect(sessionClient().prompt).toHaveBeenCalledWith('child', 'parent writes child')
      await expect(ctx.sessionTool.write(agent('child'), SessionId('root'), 'nope'))
        .rejects.toThrow(SessionToolUnauthorizedError)
    })
  })

  describe('rename', () => {
    it('delegates to the gateway and echoes the accepted values', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      await ctx.sessions.flush(target)
      sessionClient().rename.mockResolvedValue({ title: 'new title', tags: ['b', 'c'], seq: 7 })
      const result = await ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {
        title: 'new title',
        tags: ['b', 'c'],
      })
      expect(sessionClient().rename).toHaveBeenCalledWith('session-1', { title: 'new title', tags: ['b', 'c'] })
      expect(result).toMatchObject({ title: 'new title', tags: ['b', 'c'] })
    })

    it('requires at least one of title or tags and maps validation codes', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      await ctx.sessions.flush(target)
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {}))
        .rejects.toThrow(SessionEmptyContentError)
      sessionClient().rename.mockRejectedValue(
        new SessionToolError('session title must contain visible characters', 'title-invalid'),
      )
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), { title: ' ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
      sessionClient().rename.mockRejectedValue(new SessionToolError('invalid tag set', 'tag-invalid'))
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), { tags: [' ', ''] }))
        .rejects.toMatchObject({ code: 'tag-invalid' })
    })
  })

  describe('wait', () => {
    it('delegates to the gateway and maps the terminal status', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      await ctx.sessions.flush(target)
      sessionClient().wait.mockResolvedValue({
        status: 'completed',
        lastTurnEndReason: { kind: 'completed' },
      })
      const result = await ctx.sessionTool.wait(agent('caller'), SessionId('session-1'), {
        until: 'idle',
        timeoutMs: 5000,
      })
      expect(sessionClient().wait).toHaveBeenCalledWith('session-1', { until: 'idle', timeoutMs: 5000 })
      expect(result).toEqual({
        sessionId: 'session-1',
        status: 'completed',
        lastTurnEndReason: 'completed',
      })
    })

    it('defaults the options and maps a timeout status through', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: 'caller' } })
      await ctx.sessions.flush(target)
      sessionClient().wait.mockResolvedValue({ status: 'timeout' })
      const result = await ctx.sessionTool.wait(agent('caller'), SessionId('session-1'), {})
      expect(sessionClient().wait).toHaveBeenCalledWith('session-1', {})
      expect(result).toEqual({ sessionId: 'session-1', status: 'timeout' })
    })

    it('enforces the access fence before delegating', async () => {
      callerSession('caller')
      callerSession('other')
      const foreign = ctx.sessions.create(SessionId('foreign'), {
        meta: { cwd: '/proj', parentSession: 'other' },
      })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.wait(agent('caller'), SessionId('foreign'), {}))
        .rejects.toThrow(SessionToolUnauthorizedError)
      expect(sessionClient().wait).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('lists the caller tree for scope own, with hidden titles excluded by default', async () => {
      const rootAt = Date.now()
      callerSession('root')
      const child = ctx.sessions.create(SessionId('child'), {
        meta: { cwd: '/proj', parentSession: 'root', createdAt: rootAt + 1_000 },
      })
      const grandchild = ctx.sessions.create(SessionId('grandchild'), {
        meta: { cwd: '/proj', parentSession: 'child', createdAt: rootAt + 2_000 },
      })
      await ctx.sessions.flush(child)
      await ctx.sessions.flush(grandchild)
      sessionClient().list.mockResolvedValue([
        listRow('root', { title: 'root title' }),
        listRow('child', { parentSessionId: 'root', title: 'child' }),
        listRow('grandchild', { parentSessionId: 'child', title: '~hidden' }),
      ])
      const own = await ctx.sessionTool.list(agent('root'), {})
      expect(own.sessions.map(row => row.sessionId)).toEqual(['root', 'child'])
      expect(own.sessions.map(row => row.title)).toEqual(['root title', 'child'])
      const included = await ctx.sessionTool.list(agent('root'), { includeHidden: true })
      expect(included.sessions.map(row => row.sessionId)).toEqual(['root', 'child', 'grandchild'])
    })

    it('filters by tag intersection, title substring, and status', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([
        listRow('a', { parentSessionId: 'root', title: 'alpha plan', tags: ['plan', 'wip'] }),
        listRow('b', { parentSessionId: 'root', title: 'beta notes', tags: ['notes'] }),
        listRow('c', { parentSessionId: 'root', title: 'gamma', running: true }),
      ])
      const byTag = await ctx.sessionTool.list(agent('root'), { scope: 'all', tags: ['plan'] })
      expect(byTag.sessions.map(row => row.sessionId)).toEqual(['a'])
      const byTitle = await ctx.sessionTool.list(agent('root'), { scope: 'all', title: 'notes' })
      expect(byTitle.sessions.map(row => row.title)).toEqual(['beta notes'])
      const live = await ctx.sessionTool.list(agent('root'), { scope: 'all', status: 'live' })
      expect(live.sessions.map(row => row.sessionId)).toEqual(['c'])
      const idle = await ctx.sessionTool.list(agent('root'), { scope: 'all', status: 'idle' })
      expect(idle.sessions.map(row => row.sessionId)).toEqual(['a', 'b'])
    })

    it('derives and filters by the delegation projection status', async () => {
      callerSession('root')
      const child = ctx.sessions.create(SessionId('child'), {
        meta: { cwd: '/proj', parentSession: 'root' },
      })
      child.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      child.append('user/message', { content: [{ type: 'text', text: 'work' }] }, { surfaceOp: 'append' })
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const failed = ctx.sessions.create(SessionId('failed'), {
        meta: { cwd: '/proj', parentSession: 'root' },
      })
      failed.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      failed.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'X' } },
      })
      const running = ctx.sessions.create(SessionId('running'), {
        meta: { cwd: '/proj', parentSession: 'root' },
      })
      running.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      sessionClient().list.mockResolvedValue([
        listRow('root', {}),
        listRow('child', { parentSessionId: 'root' }),
        listRow('failed', { parentSessionId: 'root' }),
        listRow('running', { parentSessionId: 'root' }),
      ])

      const completed = await ctx.sessionTool.list(agent('root'), { scope: 'all', status: 'completed' })
      expect(completed.sessions.map(row => row.sessionId)).toEqual(['child'])
      const failedRows = await ctx.sessionTool.list(agent('root'), { scope: 'all', status: 'failed' })
      expect(failedRows.sessions.map(row => row.sessionId)).toEqual(['failed'])
      const runningRows = await ctx.sessionTool.list(agent('root'), { scope: 'all', status: 'running' })
      expect(runningRows.sessions.map(row => row.sessionId)).toEqual(['running'])
      // The row carries the derived status for model consumption.
      const row = completed.sessions[0]
      expect(row?.delegationStatus).toBe('completed')
    })

    it('filters by the delegated origin (tag or positive delegation depth)', async () => {
      callerSession('root')
      const tagged = ctx.sessions.create(SessionId('tagged'), {
        meta: { cwd: '/proj', parentSession: 'root' },
      })
      tagged.append('session/tags', { tags: ['delegated'], source: { kind: 'user' } })
      const deep = ctx.sessions.create(SessionId('deep'), {
        meta: { cwd: '/proj', parentSession: 'root', delegationDepth: 2 },
      })
      const plain = ctx.sessions.create(SessionId('plain'), {
        meta: { cwd: '/proj', parentSession: 'root' },
      })
      sessionClient().list.mockResolvedValue([
        listRow('root', {}),
        listRow('tagged', { parentSessionId: 'root', tags: ['delegated'] }),
        listRow('deep', { parentSessionId: 'root' }),
        listRow('plain', { parentSessionId: 'root' }),
      ])

      const delegated = await ctx.sessionTool.list(agent('root'), { scope: 'all', origin: 'delegated' })
      // Same createdAt, so rows sort by id.
      expect(delegated.sessions.map(row => row.sessionId)).toEqual(['deep', 'tagged'])
    })

    it('paginates with cursor and limit', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([
        listRow('one', { parentSessionId: 'root', title: 'one' }),
        listRow('two', { parentSessionId: 'root', title: 'two' }),
        listRow('three', { parentSessionId: 'root', title: 'three' }),
        listRow('four', { parentSessionId: 'root', title: 'four' }),
        listRow('five', { parentSessionId: 'root', title: 'five' }),
      ])
      const first = await ctx.sessionTool.list(agent('root'), { scope: 'all', limit: 2 })
      expect(first.sessions).toHaveLength(2)
      expect(first.nextCursor).toBe(first.sessions[1]?.sessionId)
      const second = await ctx.sessionTool.list(agent('root'), { scope: 'all', limit: 2, cursor: first.nextCursor })
      expect(second.sessions).toHaveLength(2)
      const third = await ctx.sessionTool.list(agent('root'), { scope: 'all', cursor: second.nextCursor })
      expect(third.sessions).toHaveLength(1)
      expect(third.nextCursor).toBeUndefined()
    })

    it('enforces the tree root fence and the all-scope gates', async () => {
      callerSession('caller')
      callerSession('other')
      sessionClient().list.mockResolvedValue([listRow('other', { parentSessionId: 'other' })])
      await expect(ctx.sessionTool.list(agent('caller'), { scope: 'tree', sessionId: SessionId('other') }))
        .rejects.toThrow(SessionToolUnauthorizedError)
      await expect(ctx.sessionTool.list(agent('caller'), { scope: 'tree' }))
        .rejects.toThrow(SessionEmptyContentError)

      await expect(ctx.sessionTool.list(agent('caller', 1), { scope: 'all' }))
        .rejects.toThrow(SessionScopeDeniedError)
      const allowed = await ctx.sessionTool.list(agent('caller', 0), { scope: 'all' })
      expect(allowed.sessions.length).toBeGreaterThanOrEqual(1)

      await expect(ctx.sessionTool.list(CLI, { scope: 'all' })).resolves.toBeDefined()
      const ctx2 = await compose(join(root, 'second'), { ...TOOL_CONFIG, cliAllowAll: false })
      try {
        await expect(ctx2.sessionTool.list(CLI, { scope: 'all' }))
          .rejects.toThrow(SessionScopeDeniedError)
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('denies the own scope to the CLI', async () => {
      await expect(ctx.sessionTool.list(CLI, { scope: 'own' }))
        .rejects.toThrow(SessionScopeDeniedError)
    })

    it('rejects a missing tree root for the CLI too (no silent empty listing)', async () => {
      await expect(ctx.sessionTool.list(CLI, { scope: 'tree', sessionId: SessionId('missing-root') }))
        .rejects.toThrow(SessionNotFoundError)
    })

    it('rejects an unknown cursor', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([listRow('one', { parentSessionId: 'root' })])
      await expect(ctx.sessionTool.list(agent('root'), { cursor: 'nope' }))
        .rejects.toThrow(SessionNotFoundError)
    })
  })

  describe('error codes', () => {
    it('carries stable wire codes on the typed errors', async () => {
      try {
        await ctx.sessionTool.read(agent('caller'), SessionId('missing'), {})
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(SessionToolError)
        expect((error as SessionToolError).code).toBe('session-not-found')
      }
    })
  })
})
