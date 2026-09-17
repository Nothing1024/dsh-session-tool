// SessionToolLocalService (remote): owner fences, scope gates, visibility
// rules, and pagination over the web gateway. Session create/write/rename/
// list delegate to the mocked gateway clients; read stays local over the
// persistence backend; the fence and scope logic run in-process over the
// merged header index.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { get, marksPath, put } from 'session-marks'
import SessionToolLocalService from 'session-tool-local'
import type { Config as ToolConfig } from 'session-tool-local'
import {
  SessionEmptyContentError,
  SessionNotFoundError,
  SessionScopeDeniedError,
  SessionTagInvalidError,
  SessionToolError,
  SessionToolUnauthorizedError,
} from 'session-tool'
import type { SessionToolCaller } from 'session-tool'
import { SessionHttpClient } from '../src/session-client.ts'
import { WorkspaceHttpClient } from '../src/workspace-client.ts'
import { putLineage } from '../src/lineage.ts'

vi.mock('../src/session-client.ts')
vi.mock('../src/workspace-client.ts')

const TOOL_CONFIG: ToolConfig = {
  allowAllScope: 'top-level',
  cliAllowAll: true,
  readMaxBlocks: 500,
  listMaxRows: 100,
  hiddenPrefixes: ['~', '[internal]'],
  webUrl: 'http://127.0.0.1:3180',
  allowOthersToWrite: 'workspace',
  showDelegated: true,
}

/** Compose the minimal read stack: live store + persistence + the service. */
async function compose(root: string, config: ToolConfig = TOOL_CONFIG): Promise<Context> {
  process.env.DSH_HOME = root
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root: join(root, 'sessions') })
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
  return constructor.mock.instances.at(-1) as unknown as {
    durableCreate: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    subagentPrompt: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    wait: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
}

/** The last mock workspace-client instance (the provider constructs one per boot). */
function workspaceClient() {
  const constructor = vi.mocked(WorkspaceHttpClient)
  return constructor.mock.instances.at(-1) as unknown as {
    listWorkspaces: ReturnType<typeof vi.fn>
    archiveSession: ReturnType<typeof vi.fn>
    unarchiveSession: ReturnType<typeof vi.fn>
  }
}

/** A mock list row shaped like the gateway's SessionListRow. */
function listRow(id: string, options: {
  parentSessionId?: string
  title?: string
  tags?: readonly string[]
  running?: boolean
  updatedAt?: number
} = {}): {
  sessionId: string
  parentSessionId?: string
  title?: string
  tags?: readonly string[]
  running: boolean
  updatedAt: number
} {
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
  let previousHome: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    previousHome = process.env.DSH_HOME
    root = mkdtempSync(join(tmpdir(), 'session-tool-test-'))
    ctx = await compose(root)
    workspaceClient().listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: [] })
    workspaceClient().archiveSession.mockResolvedValue(undefined)
    workspaceClient().unarchiveSession.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  /** Establish the caller's own session in the live store. */
  function callerSession(id: string) {
    return ctx.sessions.create(SessionId(id))
  }

  it('admits authenticated web operators without widening agent or CLI scope policy', async () => {
    await ctx.fiber.dispose()
    ctx = await compose(root, { ...TOOL_CONFIG, allowAllScope: 'none', cliAllowAll: false, allowOthersToWrite: 'creator' })
    workspaceClient().listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: [] })
    callerSession('caller')
    callerSession('foreign')
    sessionClient().list.mockResolvedValue([listRow('foreign')])
    const web = { kind: 'web' } as const
    await expect(ctx.sessionTool.list(web, { scope: 'all' })).resolves.toMatchObject({ sessions: [{ sessionId: 'foreign' }] })
    await ctx.plugin({
      inject: ['sessionTool'],
      async apply(callerCtx: Context) {
        await expect(callerCtx.sessionTool.list(web, { scope: 'all' })).resolves.toMatchObject({ sessions: [{ sessionId: 'foreign' }] })
      },
    })
    await expect(ctx.sessionTool.list(CLI, { scope: 'all' })).rejects.toBeInstanceOf(SessionScopeDeniedError)
    await expect(ctx.sessionTool.list(agent('caller'), { scope: 'all' })).rejects.toBeInstanceOf(SessionScopeDeniedError)
    await expect(ctx.sessionTool.read(web, SessionId('foreign'), {})).resolves.toBeDefined()
    await expect(ctx.sessionTool.read(agent('caller'), SessionId('foreign'), {})).rejects.toBeInstanceOf(SessionToolUnauthorizedError)
    await ctx.sessionTool.write(web, SessionId('foreign'), 'human continuation')
    await ctx.sessionTool.cancel(web, SessionId('foreign'))
    expect(sessionClient().prompt).toHaveBeenCalledWith('foreign', 'human continuation')
    expect(sessionClient().cancel).toHaveBeenCalledWith('foreign')
    await expect(ctx.sessionTool.write(agent('caller'), SessionId('foreign'), 'agent continuation')).rejects.toBeInstanceOf(SessionToolUnauthorizedError)
  })

  describe('create', () => {
    it('delegates to the gateway without tags, then puts marks after success', async () => {
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
        cwd: '/proj',
        delegationDepth: 1,
      })
      expect(sessionClient().durableCreate.mock.calls[0]?.[0]).not.toHaveProperty('tags')
      expect(created.sessionId).toBe('session-9')
      expect(await get('session-9')).toEqual(['child', 'kind:delegated', 'parent:caller', 'wip'])
      const jsonl = readFileSync(marksPath(root), 'utf8')
      expect(jsonl).toContain('"id":"session-9"')
      expect(jsonl).toContain('kind:delegated')
      expect(jsonl).toContain('wip')
    })

    it('joins an agent caller tree by default and stays top-level for the CLI', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-1' })
      await ctx.sessionTool.create(agent('caller'), { title: 'child' })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        parentSessionId: 'caller',
        delegationDepth: 1,
      }))
      expect(sessionClient().durableCreate.mock.calls.at(-1)?.[0]).not.toHaveProperty('tags')
      expect(await get('session-1')).toEqual(['child', 'kind:delegated', 'parent:caller'])
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-2' })
      await ctx.sessionTool.create(CLI, { title: 'top' })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.not.objectContaining({
        parentSessionId: expect.anything(),
      }))
      // The CLI (human identity) records no depth.
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.not.objectContaining({
        delegationDepth: expect.anything(),
      }))
      expect(await get('session-2')).toBeUndefined()
    })

    it('auto-tags delegated creates and leaves a parentless CLI unmarked', async () => {
      callerSession('caller')
      callerSession('other')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'cli-child' })
      await ctx.sessionTool.create(CLI, { parentSessionId: SessionId('other'), tags: ['plan'] })
      expect(await get('cli-child')).toEqual(['child', 'kind:delegated', 'parent:other', 'plan'])
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'cli-plain' })
      await ctx.sessionTool.create(CLI, { tags: ['plan'] })
      expect(await get('cli-plain')).toEqual(['plan'])
      expect(await get('cli-plain')).not.toContain('kind:delegated')
    })

    it('rejects invalid tags before the gateway call', async () => {
      callerSession('caller')
      await expect(ctx.sessionTool.create(agent('caller'), { tags: [''] }))
        .rejects.toBeInstanceOf(SessionTagInvalidError)
      await expect(ctx.sessionTool.create(CLI, { tags: [] }))
        .rejects.toMatchObject({ code: 'tag-invalid' })
      expect(sessionClient().durableCreate).not.toHaveBeenCalled()
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

    it('inherits the caller cwd when create omits cwd and workspacePath', async () => {
      ctx.sessions.create(SessionId('caller'), { meta: { cwd: '/from-parent' } })
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'session-9' })
      await ctx.sessionTool.create(agent('caller'), { title: 'child' })
      expect(sessionClient().durableCreate).toHaveBeenCalledWith(expect.objectContaining({
        cwd: '/from-parent',
      }))
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
      expect(await get('session-x')).toEqual(['child', 'kind:delegated', 'parent:other'])
    })

    it('propagates a gateway validation rejection and does not write marks', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockRejectedValue(
        new SessionToolError('session title must contain visible characters', 'title-invalid'),
      )
      await expect(ctx.sessionTool.create(agent('caller'), { title: '   ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
      expect(await get('session-9')).toBeUndefined()
    })
  })

  describe('write and read', () => {
    it('sends the prompt to the gateway and returns the session id', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
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
      const session = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      const append = (text: string): number => {
        const event = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
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

    it('optionally reads the current turn status independently of the message page', async () => {
      callerSession('caller')
      const session = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      const read = () => ctx.sessionTool.read(agent('caller'), session.id, { includeDelegationStatus: true, maxBlocks: 1 })
      expect((await read()).delegationStatus).toBe('idle')
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      expect((await read()).delegationStatus).toBe('running')
      session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect((await read()).delegationStatus).toBe('aborted')
      expect((await ctx.sessionTool.read(agent('caller'), session.id, { sinceSeq: 999, includeDelegationStatus: true })).delegationStatus).toBe('aborted')
      expect(await ctx.sessionTool.read(agent('caller'), session.id, {})).not.toHaveProperty('delegationStatus')
    })

    it('maps assistant and tool events onto their roles', async () => {
      callerSession('caller')
      const session = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'user says' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'assistant says' }],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/result', {
        turn: 1,
        step: 2,
        message: createToolResultMessage({
          callId: ToolCallId('call-1'),
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
      const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/proj', parentSession: SessionId('root') } })
      await ctx.sessions.flush(child)
      sessionClient().prompt.mockResolvedValue({ accepted: true })
      await ctx.sessionTool.write(agent('root'), SessionId('child'), 'parent writes child')
      expect(sessionClient().prompt).toHaveBeenCalledWith('child', 'parent writes child')
      await expect(ctx.sessionTool.write(agent('child'), SessionId('root'), 'nope'))
        .rejects.toThrow(SessionToolUnauthorizedError)
    })

    it('admits the creator to a child whose live header dropped parentSession (rc.7)', async () => {
      const caller = callerSession('caller')
      await ctx.sessions.flush(caller)
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'child' })
      await ctx.sessionTool.create(agent('caller'), { parentSessionId: SessionId('caller') })
      const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/proj' } })
      await ctx.sessions.flush(child)
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('child'), {}))
        .resolves.toMatchObject({ sessionId: 'child' })
      sessionClient().prompt.mockResolvedValue({ accepted: true })
      await expect(ctx.sessionTool.write(agent('caller'), SessionId('child'), 'hi'))
        .resolves.toBeDefined()
    })

    it('reloads remembered lineage so a creator can read after restart', async () => {
      callerSession('caller')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'child' })
      await ctx.sessionTool.create(agent('caller'), {
        parentSessionId: SessionId('caller'),
        cwd: '/proj',
      })
      await ctx.fiber.dispose()

      ctx = await compose(root)
      callerSession('caller')
      ctx.sessions.create(SessionId('child'), { meta: { cwd: '/proj' } })
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('child'), {}))
        .resolves.toBeDefined()
    })

    it('picks up CLI-written lineage without a process restart', async () => {
      callerSession('caller')
      await ctx.sessionTool.read(agent('caller'), SessionId('caller'), {})
      await putLineage({ id: 'cli-child', parentSession: 'caller', delegationDepth: 1 })
      ctx.sessions.create(SessionId('cli-child'), { meta: { cwd: '/proj' } })
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('cli-child'), {}))
        .resolves.toMatchObject({ sessionId: 'cli-child' })
    })

    it('resolves caller depth from the overlay when the live header omitted it', async () => {
      callerSession('root')
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'child' })
      await ctx.sessionTool.create(agent('root'), { cwd: '/proj' })
      ctx.sessions.create(SessionId('child'), { meta: { cwd: '/proj' } })
      sessionClient().list.mockResolvedValue([listRow('root'), listRow('child')])
      await expect(ctx.sessionTool.list(agent('child', 0), { scope: 'all' }))
        .rejects.toThrow(SessionScopeDeniedError)
      sessionClient().durableCreate.mockResolvedValue({ sessionId: 'grandchild' })
      await ctx.sessionTool.create(agent('child', 0), { cwd: '/proj' })
      expect(sessionClient().durableCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        parentSessionId: 'child',
        delegationDepth: 2,
      }))
    })

    it('writes a badged rc.7 child through subagent.prompt, not session.prompt', async () => {
      callerSession('root')
      const child = ctx.sessions.create(SessionId('child'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), origin: 'subagent', delegationDepth: 1 },
      })
      await ctx.sessions.flush(child)
      const client = sessionClient()
      client.subagentPrompt.mockResolvedValue({ accepted: true })
      const result = await ctx.sessionTool.write(agent('root'), SessionId('child'), 'go')
      expect(result).toEqual({ sessionId: 'child' })
      expect(client.subagentPrompt).toHaveBeenCalledWith('root', 'child', 'go')
      expect(client.prompt).not.toHaveBeenCalled()
    })

    it('keeps the fence before the subagent door and rejects a missing parent', async () => {
      callerSession('root')
      callerSession('peer')
      const child = ctx.sessions.create(SessionId('child'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), origin: 'subagent', delegationDepth: 1 },
      })
      await ctx.sessions.flush(child)
      const client = sessionClient()
      client.subagentPrompt.mockResolvedValue({ accepted: true })
      await expect(ctx.sessionTool.write(agent('peer'), SessionId('child'), 'go'))
        .rejects.toThrow(SessionToolUnauthorizedError)
      expect(client.subagentPrompt).not.toHaveBeenCalled()
      const orphan = ctx.sessions.create(SessionId('orphan'), {
        meta: { cwd: '/proj', origin: 'subagent', delegationDepth: 1 },
      })
      await ctx.sessions.flush(orphan)
      await expect(ctx.sessionTool.write(CLI, SessionId('orphan'), 'go'))
        .rejects.toThrow(SessionNotFoundError)
      expect(client.subagentPrompt).not.toHaveBeenCalled()
    })
  })

  describe('continuation constraints (allowOthersToWrite / maxDelegationDepth / showDelegated)', () => {
    /** Establish a caller session on a specific context. */
    function callerOn(target: Context, id: string, cwd = '/proj') {
      return target.sessions.create(SessionId(id), {
        ...cwd === undefined ? {} : { meta: { cwd } },
      })
    }

    it('creator mode admits only the lineage for write and wait', async () => {
      const ctx2 = await compose(join(root, 'creator'), {
        ...TOOL_CONFIG,
        allowOthersToWrite: 'creator',
      })
      try {
        callerOn(ctx2, 'root')
        callerOn(ctx2, 'peer')
        const child = ctx2.sessions.create(SessionId('delegated-child'), {
          meta: { cwd: '/proj', parentSession: SessionId('root') },
        })
        await ctx2.sessions.flush(child)
        const client = sessionClient()
        client.prompt.mockResolvedValue({ accepted: true })
        client.wait.mockResolvedValue({ status: 'completed' })

        // The lineage creator (root) may continue the child.
        await expect(ctx2.sessionTool.write(agent('root'), SessionId('delegated-child'), 'go'))
          .resolves.toBeDefined()
        await expect(ctx2.sessionTool.wait(agent('root'), SessionId('delegated-child'), {}))
          .resolves.toBeDefined()
        // A peer (same workspace, not in the lineage) is rejected.
        await expect(ctx2.sessionTool.write(agent('peer'), SessionId('delegated-child'), 'go'))
          .rejects.toThrow(SessionToolUnauthorizedError)
        await expect(ctx2.sessionTool.wait(agent('peer'), SessionId('delegated-child'), {}))
          .rejects.toThrow(SessionToolUnauthorizedError)
        expect(client.prompt).toHaveBeenCalledTimes(1)
        expect(client.wait).toHaveBeenCalledTimes(1)
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('workspace mode admits same-workspace callers and rejects foreign workspaces', async () => {
      const ctx2 = await compose(join(root, 'workspace'), {
        ...TOOL_CONFIG,
        allowOthersToWrite: 'workspace',
      })
      try {
        callerOn(ctx2, 'root')
        callerOn(ctx2, 'peer')
        callerOn(ctx2, 'foreign-peer', '/other')
        const target = ctx2.sessions.create(SessionId('delegated-target'), {
          meta: { cwd: '/proj', parentSession: SessionId('root') },
        })
        await ctx2.sessions.flush(target)
        const client = sessionClient()
        client.prompt.mockResolvedValue({ accepted: true })

        // Same workspace: admitted.
        await expect(ctx2.sessionTool.write(agent('peer'), SessionId('delegated-target'), 'go'))
          .resolves.toBeDefined()
        // Different workspace: rejected.
        await expect(ctx2.sessionTool.write(agent('foreign-peer'), SessionId('delegated-target'), 'go'))
          .rejects.toThrow(SessionToolUnauthorizedError)
        // A badged rc.7 child uses the subagent door after the same fence.
        const badged = ctx2.sessions.create(SessionId('badged-child'), {
          meta: { cwd: '/proj', parentSession: SessionId('root'), origin: 'subagent', delegationDepth: 1 },
        })
        await ctx2.sessions.flush(badged)
        client.subagentPrompt.mockResolvedValue({ accepted: true })
        await expect(ctx2.sessionTool.write(agent('peer'), SessionId('badged-child'), 'go'))
          .resolves.toBeDefined()
        expect(client.subagentPrompt).toHaveBeenCalledWith('root', 'badged-child', 'go')
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('anyone mode admits every caller', async () => {
      const ctx2 = await compose(join(root, 'anyone'), {
        ...TOOL_CONFIG,
        allowOthersToWrite: 'anyone',
      })
      try {
        callerOn(ctx2, 'root')
        callerOn(ctx2, 'stranger')
        const target = ctx2.sessions.create(SessionId('delegated-anyone'), {
          meta: { cwd: '/proj', parentSession: SessionId('root') },
        })
        await ctx2.sessions.flush(target)
        const client = sessionClient()
        client.prompt.mockResolvedValue({ accepted: true })
        await expect(ctx2.sessionTool.write(agent('stranger'), SessionId('delegated-anyone'), 'go'))
          .resolves.toBeDefined()
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('maxDelegationDepth rejects a creation deeper than the ceiling', async () => {
      const ctx2 = await compose(join(root, 'depth'), {
        ...TOOL_CONFIG,
        maxDelegationDepth: 2,
      })
      try {
        callerOn(ctx2, 'root')
        const client = sessionClient()
        client.durableCreate.mockResolvedValue({ sessionId: 'session-d' })
        // depth 1 (0+1) and 2 are admitted; 3 is rejected.
        await expect(ctx2.sessionTool.create(agent('root', 1), {}))
          .resolves.toBeDefined()
        await expect(ctx2.sessionTool.create(agent('root', 1), { delegationDepth: 2 }))
          .resolves.toBeDefined()
        await expect(ctx2.sessionTool.create(agent('root', 2), {}))
          .rejects.toThrow(SessionToolUnauthorizedError)
        expect(client.durableCreate).toHaveBeenCalledTimes(2)
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('showDelegated false hides delegated rows unless explicitly requested', async () => {
      const ctx2 = await compose(join(root, 'visible'), {
        ...TOOL_CONFIG,
        showDelegated: false,
      })
      workspaceClient().listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: [] })
      try {
        callerOn(ctx2, 'root')
        const delegated = ctx2.sessions.create(SessionId('delegated-hidden'), {
          meta: { cwd: '/proj', parentSession: SessionId('root'), delegationDepth: 1 },
        })
        await ctx2.sessions.flush(delegated)
        const client = sessionClient()
        client.list.mockResolvedValue([
          listRow('root', {}),
          listRow('delegated-hidden', { parentSessionId: 'root' }),
        ])
        await put('delegated-hidden', ['kind:delegated'])

        const hidden = await ctx2.sessionTool.list(agent('root'), { scope: 'all' })
        expect(hidden.sessions.map(row => row.sessionId)).toEqual(['root'])
        // An explicit delegated-origin filter still surfaces them.
        const explicit = await ctx2.sessionTool.list(agent('root'), { scope: 'all', origin: 'delegated' })
        expect(explicit.sessions.map(row => row.sessionId)).toEqual(['delegated-hidden'])
      } finally {
        await ctx2.fiber.dispose()
      }
    })
  })

  describe('rename', () => {
    it('renames title on the gateway and replaces tags in the mark table', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      sessionClient().rename.mockResolvedValue({ title: 'new title', seq: 7 })
      const result = await ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {
        title: 'new title',
        tags: ['b', 'c'],
      })
      expect(sessionClient().rename).toHaveBeenCalledWith('session-1', { title: 'new title' })
      expect(result).toMatchObject({ title: 'new title', tags: ['b', 'c'] })
      expect(await get('session-1')).toEqual(['b', 'c'])
    })

    it('replaces tags without calling the gateway when title is omitted', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['a', 'b'])
      const result = await ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {
        tags: ['kind:hidden'],
      })
      expect(sessionClient().rename).not.toHaveBeenCalled()
      expect(result).toMatchObject({ tags: ['hidden', 'kind:hidden'] })
      expect(await get('session-1')).toEqual(['hidden', 'kind:hidden'])
    })

    it('requires at least one of title or tags and maps validation codes', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {}))
        .rejects.toThrow(SessionEmptyContentError)
      sessionClient().rename.mockRejectedValue(
        new SessionToolError('session title must contain visible characters', 'title-invalid'),
      )
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), { title: ' ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), { tags: [' ', ''] }))
        .rejects.toMatchObject({ code: 'tag-invalid' })
      expect(sessionClient().rename).toHaveBeenCalledTimes(1)
    })

    it('keeps structured marks when rename replaces free tags or hidden', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['kind:vibee', 'plan'])
      const result = await ctx.sessionTool.rename(agent('caller'), SessionId('session-1'), {
        tags: ['kind:hidden', 'wip'],
      })
      expect(result.tags).toEqual(['hidden', 'kind:hidden', 'kind:vibee', 'wip'])
      expect(await get('session-1')).toEqual(['hidden', 'kind:hidden', 'kind:vibee', 'wip'])
    })
  })

  describe('mark', () => {
    it('adds and removes with hidden/child aliases expanded', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['kind:vibee', 'plan'])
      const added = await ctx.sessionTool.mark(agent('caller'), SessionId('session-1'), { add: ['hidden'] })
      expect(added.tags).toEqual(['hidden', 'kind:hidden', 'kind:vibee', 'plan'])
      const removed = await ctx.sessionTool.mark(agent('caller'), SessionId('session-1'), { remove: ['kind:hidden'] })
      expect(removed.tags).toEqual(['kind:vibee', 'plan'])
    })

    it('requires add or remove and enforces the access fence', async () => {
      callerSession('caller')
      callerSession('other')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      const foreign = ctx.sessions.create(SessionId('foreign'), {
        meta: { cwd: '/proj', parentSession: SessionId('other') },
      })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.mark(agent('caller'), SessionId('session-1'), {}))
        .rejects.toThrow(SessionEmptyContentError)
      await expect(ctx.sessionTool.mark(agent('caller'), SessionId('foreign'), { add: ['wip'] }))
        .rejects.toThrow(SessionToolUnauthorizedError)
    })
  })

  describe('getVisibility / hide / unhide', () => {
    it('reports both flags false when neither marked nor archived', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      const result = await ctx.sessionTool.getVisibility(agent('caller'), SessionId('session-1'))
      expect(result).toEqual({ hasHiddenMark: false, archived: false, isHidden: false })
    })

    it('getVisibility composes the kind:hidden mark and the archive set', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['kind:hidden'])
      const result = await ctx.sessionTool.getVisibility(agent('caller'), SessionId('session-1'))
      expect(result).toEqual({ hasHiddenMark: true, archived: false, isHidden: true })
      await put('session-1', ['hidden'])
      const alias = await ctx.sessionTool.getVisibility(agent('caller'), SessionId('session-1'))
      expect(alias.hasHiddenMark).toBe(true)

      workspaceClient().listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: ['session-2'] })
      const archivedOnly = await ctx.sessionTool.getVisibility(agent('caller'), SessionId('session-2'))
      expect(archivedOnly).toEqual({ hasHiddenMark: false, archived: true, isHidden: true })
    })


    it('hide archives the official sidebar and unhide restores it', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)

      const hidden = await ctx.sessionTool.hide(agent('caller'), SessionId('session-1'))
      expect(hidden).toEqual({ hasHiddenMark: true, archived: false, isHidden: true })
      expect(await get('session-1')).toEqual(['hidden', 'kind:hidden'])
      expect(workspaceClient().archiveSession).toHaveBeenCalledWith('session-1')

      const unhidden = await ctx.sessionTool.unhide(agent('caller'), SessionId('session-1'))
      expect(unhidden).toEqual({ hasHiddenMark: false, archived: false, isHidden: false })
      expect(await get('session-1')).toBeUndefined()
      expect(workspaceClient().unarchiveSession).toHaveBeenCalledWith('session-1')
    })

    it('hide preserves any other marks already on the session', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['plan'])
      await ctx.sessionTool.hide(agent('caller'), SessionId('session-1'))
      expect(await get('session-1')).toEqual(['hidden', 'kind:hidden', 'plan'])
      await ctx.sessionTool.unhide(agent('caller'), SessionId('session-1'))
      expect(await get('session-1')).toEqual(['plan'])
    })

    it('enforces the access fence before hiding, unhiding, or reading visibility', async () => {
      callerSession('caller')
      callerSession('other')
      const foreign = ctx.sessions.create(SessionId('foreign'), {
        meta: { cwd: '/proj', parentSession: SessionId('other') },
      })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.hide(agent('caller'), SessionId('foreign')))
        .rejects.toThrow(SessionToolUnauthorizedError)
      await expect(ctx.sessionTool.unhide(agent('caller'), SessionId('foreign')))
        .rejects.toThrow(SessionToolUnauthorizedError)
      expect(await get('foreign')).toBeUndefined()
      expect(workspaceClient().archiveSession).not.toHaveBeenCalled()
    })

    it('hide still succeeds when archiveSession throws', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      workspaceClient().archiveSession.mockRejectedValue(new Error('archive boom'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const hidden = await ctx.sessionTool.hide(agent('caller'), SessionId('session-1'))
        expect(hidden.hasHiddenMark).toBe(true)
        expect(await get('session-1')).toEqual(['hidden', 'kind:hidden'])
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('archiveSession failed'))
      } finally {
        warn.mockRestore()
      }
    })

    it('skips archive when syncToArchived is false', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await ctx.sessionTool.hide(agent('caller'), SessionId('session-1'), { syncToArchived: false })
      expect(workspaceClient().archiveSession).not.toHaveBeenCalled()
      await ctx.sessionTool.unhide(agent('caller'), SessionId('session-1'), { syncToArchived: false })
      expect(workspaceClient().unarchiveSession).not.toHaveBeenCalled()
    })
  })
  describe('readMarks', () => {
    it('returns tags and hiddenPrefixes for an existing session', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      await put('session-1', ['app:dsh-bot', 'form:plugin'])
      await expect(ctx.sessionTool.readMarks(agent('caller'), SessionId('session-1'))).resolves.toEqual({
        sessionId: 'session-1',
        tags: ['app:dsh-bot', 'form:plugin'],
        hiddenPrefixes: ['~', '[internal]'],
      })
      await expect(ctx.sessionTool.readMarks({ kind: 'web' }, SessionId('session-1'))).resolves.toMatchObject({
        sessionId: 'session-1',
        tags: ['app:dsh-bot', 'form:plugin'],
      })
    })

    it('returns empty tags when the session has no mark row', async () => {
      callerSession('caller')
      await expect(ctx.sessionTool.readMarks(agent('caller'), SessionId('caller'))).resolves.toEqual({
        sessionId: 'caller',
        tags: [],
        hiddenPrefixes: ['~', '[internal]'],
      })
    })

    it('rejects a missing session and fences agent callers', async () => {
      callerSession('caller')
      ctx.sessions.create(SessionId('foreign'), { meta: { cwd: '/other' } })
      await expect(ctx.sessionTool.readMarks(agent('caller'), SessionId('missing')))
        .rejects.toBeInstanceOf(SessionNotFoundError)
      await expect(ctx.sessionTool.readMarks(agent('caller'), SessionId('foreign')))
        .rejects.toBeInstanceOf(SessionToolUnauthorizedError)
    })
  })


  describe('cancel', () => {
    it('delegates to the gateway', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
      await ctx.sessions.flush(target)
      sessionClient().cancel.mockResolvedValue({ accepted: true })
      await ctx.sessionTool.cancel(agent('caller'), SessionId('session-1'))
      expect(sessionClient().cancel).toHaveBeenCalledWith('session-1')
    })

    it('enforces the access fence before delegating', async () => {
      callerSession('caller')
      callerSession('other')
      const foreign = ctx.sessions.create(SessionId('foreign'), {
        meta: { cwd: '/proj', parentSession: SessionId('other') },
      })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.cancel(agent('caller'), SessionId('foreign')))
        .rejects.toThrow(SessionToolUnauthorizedError)
      expect(sessionClient().cancel).not.toHaveBeenCalled()
    })
  })

  describe('wait', () => {
    it('delegates to the gateway and maps the terminal status', async () => {
      callerSession('caller')
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
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
      const target = ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/proj', parentSession: SessionId('caller') } })
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
        meta: { cwd: '/proj', parentSession: SessionId('other') },
      })
      await ctx.sessions.flush(foreign)
      await expect(ctx.sessionTool.wait(agent('caller'), SessionId('foreign'), {}))
        .rejects.toThrow(SessionToolUnauthorizedError)
      expect(sessionClient().wait).not.toHaveBeenCalled()
    })
  })

  describe('collect', () => {
    /** Three delegated children under the caller with distinct terminal statuses. */
    async function delegatedTree(): Promise<{
      done: SessionId
      failedId: SessionId
      runningId: SessionId
    }> {
      callerSession('root')
      const done = ctx.sessions.create(SessionId('collect-done'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      done.append('turn/start', { turn: 1 })
      done.append('assistant/message', {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'finished work' }],
          source: { provider: 'p', model: 'm' },
        }),
      }, { surfaceOp: 'append' })
      done.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const failedId = ctx.sessions.create(SessionId('collect-failed'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      failedId.append('turn/start', { turn: 1 })
      failedId.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'X' } },
      })
      const runningId = ctx.sessions.create(SessionId('collect-running'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      runningId.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(done)
      await ctx.sessions.flush(failedId)
      await ctx.sessions.flush(runningId)
      sessionClient().list.mockResolvedValue([
        listRow('root', {}),
        listRow('collect-done', { parentSessionId: 'root' }),
        listRow('collect-failed', { parentSessionId: 'root' }),
        listRow('collect-running', { parentSessionId: 'root' }),
      ])
      return { done: done.id, failedId: failedId.id, runningId: runningId.id }
    }

    it('wait-all aggregates when every member is terminal', async () => {
      const { done } = await delegatedTree()
      // The running child becomes terminal before the poll deadline.
      const running = ctx.sessions.get(SessionId('collect-running'))!
      setTimeout(() => {
        running.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }, 50)
      const result = await ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'),
        wait: 'all',
        timeoutMs: 5000,
      })
      expect(result.satisfied).toBe(true)
      const rows = result.sessions
      // The set is the root's workers only (the root itself is excluded).
      expect(rows.map(row => row.sessionId)).toEqual(['collect-done', 'collect-failed', 'collect-running'])
      expect(rows.map(row => row.status)).toEqual(['completed', 'failed', 'completed'])
      expect(rows.find(row => row.sessionId === done)?.result).toBe('finished work')
    })

    it('wait-n returns early and cancel-rest cancels the unfinished members', async () => {
      const { done, failedId, runningId } = await delegatedTree()
      sessionClient().cancel.mockResolvedValue({ accepted: true })
      const result = await ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'),
        wait: 'n',
        n: 2,
        onFailure: 'cancel-rest',
        timeoutMs: 5000,
      })
      // done + failed are terminal → n=2 satisfied immediately; the running
      // member is cancelled (never deleted).
      expect(result.satisfied).toBe(true)
      expect(sessionClient().cancel).toHaveBeenCalledWith('collect-running')
      expect(sessionClient().cancel).not.toHaveBeenCalledWith('collect-done')
      expect(ctx.sessions.get(runningId)).toBeDefined()
      expect(ctx.sessions.get(done)).toBeDefined()
      expect(ctx.sessions.get(failedId)).toBeDefined()
    })

    it('first-failed satisfies on the failed member', async () => {
      const { failedId } = await delegatedTree()
      const result = await ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'),
        wait: 'first-failed',
        timeoutMs: 5000,
      })
      expect(result.satisfied).toBe(true)
      expect(result.sessions.find(row => row.sessionId === failedId)?.status).toBe('failed')
    })

    it('returns a timeout snapshot without error when the deadline passes', async () => {
      await delegatedTree()
      // The running member never finishes; the 100ms deadline expires.
      const result = await ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'),
        wait: 'all',
        timeoutMs: 100,
      })
      expect(result.satisfied).toBe(false)
      expect(result.sessions.map(row => row.status)).toContain('running')
      expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
    })

    it('resolves a tag aggregation and reports an empty set as unsatisfied', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([
        listRow('tagged-a', { parentSessionId: 'root' }),
        listRow('tagged-b', { parentSessionId: 'root' }),
      ])
      await put('tagged-a', ['delegated', 'plan'])
      await put('tagged-b', ['plan'])
      const aggregated = await ctx.sessionTool.collect(agent('root'), {
        tags: ['plan'],
        wait: 'any',
        timeoutMs: 500,
      })
      expect(aggregated.satisfied).toBe(false)
      expect(aggregated.sessions.length).toBe(2)

      const empty = await ctx.sessionTool.collect(agent('root'), {
        tags: ['missing'],
        wait: 'all',
        timeoutMs: 100,
      })
      expect(empty.satisfied).toBe(false)
      expect(empty.sessions).toEqual([])
    })

    it('requires exactly one of root or tags, and a positive n for wait n', async () => {
      callerSession('root')
      await expect(ctx.sessionTool.collect(agent('root'), { wait: 'all' } as never))
        .rejects.toThrow(SessionEmptyContentError)
      await expect(ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'), tags: ['x'], wait: 'all',
      } as never)).rejects.toThrow(SessionEmptyContentError)
      await expect(ctx.sessionTool.collect(agent('root'), {
        root: SessionId('root'), wait: 'n',
      })).rejects.toThrow(SessionEmptyContentError)
    })
  })

  describe('list', () => {
    it('lists the caller tree for scope own, with hidden titles excluded by default', async () => {
      const rootAt = Date.now()
      callerSession('root')
      const child = ctx.sessions.create(SessionId('child'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), createdAt: rootAt + 1_000 },
      })
      const grandchild = ctx.sessions.create(SessionId('grandchild'), {
        meta: { cwd: '/proj', parentSession: SessionId('child'), createdAt: rootAt + 2_000 },
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

    it('hides ~ titles and kind:hidden unless includeHidden is set', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([
        listRow('secret', { title: '~secret' }),
        listRow('hidden-kind', { title: '订单同步' }),
        listRow('ok', { title: 'ok' }),
      ])
      await put('hidden-kind', ['kind:hidden'])
      const hidden = await ctx.sessionTool.list(agent('root'), { scope: 'all' })
      expect(hidden.sessions.map(row => row.sessionId)).toEqual(['ok'])
      const included = await ctx.sessionTool.list(agent('root'), { scope: 'all', includeHidden: true })
      expect(included.sessions.map(row => row.sessionId)).toEqual(['hidden-kind', 'ok', 'secret'])
      expect(included.sessions.find(row => row.sessionId === 'hidden-kind')?.tags).toEqual(['kind:hidden'])
      await put('hidden-kind', ['hidden'])
      const hiddenAlias = await ctx.sessionTool.list(agent('root'), { scope: 'all' })
      expect(hiddenAlias.sessions.map(row => row.sessionId)).toEqual(['ok'])
    })

    it('filters by tag intersection, title substring, and status', async () => {
      callerSession('root')
      sessionClient().list.mockResolvedValue([
        listRow('a', { parentSessionId: 'root', title: 'alpha plan' }),
        listRow('b', { parentSessionId: 'root', title: 'beta notes' }),
        listRow('c', { parentSessionId: 'root', title: 'gamma', running: true }),
      ])
      await put('a', ['plan', 'wip'])
      await put('b', ['notes'])
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
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      child.append('turn/start', { turn: 1 })
      child.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'work' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const failed = ctx.sessions.create(SessionId('failed'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      failed.append('turn/start', { turn: 1 })
      failed.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'X' } },
      })
      const running = ctx.sessions.create(SessionId('running'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      running.append('turn/start', { turn: 1 })
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

    it('filters origin=delegated by child / kind:delegated / delegated', async () => {
      callerSession('root')
      const tagged = ctx.sessions.create(SessionId('tagged'), {
        meta: { cwd: '/proj', parentSession: SessionId('root') },
      })
      ctx.sessions.create(SessionId('bare'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), createdAt: tagged.header.createdAt },
      })
      ctx.sessions.create(SessionId('plain'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), createdAt: tagged.header.createdAt },
      })
      sessionClient().list.mockResolvedValue([
        listRow('root', {}),
        listRow('tagged', { parentSessionId: 'root' }),
        listRow('bare', { parentSessionId: 'root' }),
        listRow('plain', { parentSessionId: 'root' }),
      ])
      await put('tagged', ['kind:delegated'])
      await put('bare', ['delegated'])
      ctx.sessions.create(SessionId('new-child'), {
        meta: { cwd: '/proj', parentSession: SessionId('root'), createdAt: tagged.header.createdAt },
      })
      sessionClient().list.mockResolvedValue([
        listRow('root', {}),
        listRow('tagged', { parentSessionId: 'root' }),
        listRow('bare', { parentSessionId: 'root' }),
        listRow('plain', { parentSessionId: 'root' }),
        listRow('new-child', { parentSessionId: 'root' }),
      ])
      await put('new-child', ['child'])

      const delegated = await ctx.sessionTool.list(agent('root'), { scope: 'all', origin: 'delegated' })
      expect(delegated.sessions.map(row => row.sessionId)).toEqual(['bare', 'new-child', 'tagged'])
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
      const second = await ctx.sessionTool.list(agent('root'), {
        scope: 'all',
        limit: 2,
        ...first.nextCursor === undefined ? {} : { cursor: first.nextCursor },
      })
      expect(second.sessions).toHaveLength(2)
      const third = await ctx.sessionTool.list(agent('root'), {
        scope: 'all',
        ...second.nextCursor === undefined ? {} : { cursor: second.nextCursor },
      })
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

  describe('delegation status via the projection registry cache', () => {
    it('reads through sessionProjections.stateOf when the registry is composed', async () => {
      const projRoot = mkdtempSync(join(tmpdir(), 'session-tool-proj-test-'))
      process.env.DSH_HOME = projRoot
      const projCtx = new Context()
      await projCtx.plugin(SessionStore)
      await projCtx.plugin(SessionPersistenceJsonl, { root: join(projRoot, 'sessions') })
      await projCtx.plugin(SessionProjectionRegistry)
      await projCtx.plugin(SessionToolLocalService, TOOL_CONFIG)
      try {
        projCtx.sessions.create(SessionId('root'))
        const child = projCtx.sessions.create(SessionId('child'), {
          meta: { cwd: '/proj', parentSession: SessionId('root') },
        })
        child.append('turn/start', { turn: 1 })
        child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

        const constructor = vi.mocked(SessionHttpClient)
        const client = constructor.mock.instances.at(-1) as unknown as { list: ReturnType<typeof vi.fn> }
        client.list.mockResolvedValue([
          listRow('root', {}),
          listRow('child', { parentSessionId: 'root' }),
        ])
        const wsConstructor = vi.mocked(WorkspaceHttpClient)
        const wsClient = wsConstructor.mock.instances.at(-1) as unknown as { listWorkspaces: ReturnType<typeof vi.fn> }
        wsClient.listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: [] })

        await projCtx.plugin({
          inject: ['sessionTool'],
          async apply(callerCtx: Context) {
            const result = await callerCtx.sessionTool.list(agent('root'), { scope: 'all' })
            const row = result.sessions.find(r => r.sessionId === 'child')
            expect(row?.delegationStatus).toBe('completed')
          },
        })
      } finally {
        await projCtx.fiber.dispose()
        rmSync(projRoot, { recursive: true, force: true })
      }
    })
  })

  describe('restart recovery (BR-004 / EVD-008)', () => {
    it('rebuilds delegation statuses from persisted logs after a process restart', async () => {
      // 0.1.5: ctx.sessions.create + flush does not materialize. Seed through
      // a write handle so the second process can inspect the same root.
      const persistence = ctx.sessionPersistence
      const completedId = SessionId('restart-completed')
      const runningId = SessionId('restart-running')
      const completedHandle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: completedId,
        createdAt: Date.now(),
        isSeeded: false,
        cwd: '/proj',
        parentSession: SessionId('root'),
        delegationDepth: 1,
      })
      await completedHandle.append([
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 1,
          time: 2,
          data: createUserMessage({
            content: [{ type: 'text', text: 'work' }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        },
        { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never)
      await completedHandle.flush()
      await completedHandle.close()
      const runningHandle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: runningId,
        createdAt: Date.now(),
        isSeeded: false,
        cwd: '/proj',
        parentSession: SessionId('root'),
        delegationDepth: 1,
      })
      await runningHandle.append([
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      ] as never)
      await runningHandle.flush()
      await runningHandle.close()
      await ctx.fiber.dispose()

      const ctx2 = await compose(root)
      workspaceClient().listWorkspaces.mockResolvedValue({ items: [], archivedSessionIds: [] })
      try {
        sessionClient().list.mockResolvedValue([
          listRow('restart-completed', { parentSessionId: 'root', tags: ['delegated'] }),
          listRow('restart-running', { parentSessionId: 'root', tags: ['delegated'] }),
        ])
        const all = await ctx2.sessionTool.list(CLI, { scope: 'all', status: 'completed' })
        expect(all.sessions.map(row => row.sessionId)).toEqual(['restart-completed'])
        // V3 cold inspect does not synthesize interruptedTurnClosers. An
        // open turn/start therefore stays `running` until a real turn/end.
        const open = await ctx2.sessionTool.list(CLI, { scope: 'all', status: 'running' })
        expect(open.sessions.map(row => row.sessionId)).toEqual(['restart-running'])
      } finally {
        await ctx2.fiber.dispose()
      }
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
