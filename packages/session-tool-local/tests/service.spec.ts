// SessionToolLocalService: owner fences, cold resume, visibility rules,
// scope gates, and pagination over the DSH session stack.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTagsService from '@deepseek-ai/dsh-session-tags'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
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

const TOOL_CONFIG: ToolConfig = {
  allowAllScope: 'top-level',
  cliAllowAll: true,
  readMaxBlocks: 500,
  listMaxRows: 100,
}

const TITLE_CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
}

const TAGS_CONFIG = {
  maxTags: 5,
  maxTagBytes: 32,
  hiddenPrefixes: ['~', '[internal]'],
}

/** Compose a minimal session stack over one persistence root. */
async function compose(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root })
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  await ctx.plugin(SessionTagsService, TAGS_CONFIG)
  await ctx.plugin(SessionToolLocalService, TOOL_CONFIG)
  return ctx
}

/** An agent caller whose own session must exist in the store. */
function agent(id: string, depth = 0): SessionToolCaller {
  return { kind: 'agent', sessionId: SessionId(id), delegationDepth: depth }
}

const CLI: SessionToolCaller = { kind: 'cli' }

describe('SessionToolLocalService', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
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
    it('creates a session with title, tags, and explicit lineage', async () => {
      callerSession('caller')
      const created = await ctx.sessionTool.create(agent('caller'), {
        title: 'my session',
        tags: ['wip'],
        parentSessionId: SessionId('caller'),
      })
      const session = ctx.sessions.get(SessionId(created.sessionId))
      expect(session).toBeDefined()
      expect(session?.header.parentSession).toBe('caller')
      expect(ctx.sessionTitle.get(session!)?.title).toBe('my session')
      expect(ctx.sessionTags.get(session!)?.tags).toEqual(['wip'])
    })

    it('joins an agent caller tree by default and stays top-level for the CLI', async () => {
      callerSession('caller')
      const created = await ctx.sessionTool.create(agent('caller'), { title: 'child' })
      expect(ctx.sessions.get(SessionId(created.sessionId))?.header.parentSession).toBe('caller')
      const cliCreated = await ctx.sessionTool.create(CLI, { title: 'top' })
      expect(ctx.sessions.get(SessionId(cliCreated.sessionId))?.header.parentSession).toBeUndefined()
    })

    it('rejects a ghost caller, a missing parent, and a parent outside the lineage', async () => {
      await expect(ctx.sessionTool.create(agent('ghost'), {}))
        .rejects.toThrow(SessionNotFoundError)
      callerSession('caller')
      callerSession('other')
      await expect(ctx.sessionTool.create(agent('caller'), { parentSessionId: SessionId('nobody') }))
        .rejects.toThrow(SessionNotFoundError)
      const other = await ctx.sessionTool.create(agent('other'), { parentSessionId: SessionId('other') })
      await expect(ctx.sessionTool.create(agent('caller'), { parentSessionId: SessionId(other.sessionId) }))
        .rejects.toThrow(SessionToolUnauthorizedError)
      // The CLI (human) may create under any existing session.
      await expect(ctx.sessionTool.create(CLI, { parentSessionId: SessionId(other.sessionId) }))
        .resolves.toBeDefined()
    })

    it('rejects an empty explicit title with the title-invalid code', async () => {
      callerSession('caller')
      await expect(ctx.sessionTool.create(agent('caller'), { title: '   ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
    })
  })

  describe('write and read', () => {
    it('appends a user message durably and reads it back', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), { title: 't' })
      const { seq } = await ctx.sessionTool.write(agent('caller'), SessionId(sessionId), 'hello world')
      expect(seq).toBeGreaterThanOrEqual(0)
      const read = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), {})
      expect(read.messages).toEqual([{ seq, role: 'user', blocks: [{ type: 'text', text: 'hello world' }] }])
    })

    it('rejects empty content', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), {})
      await expect(ctx.sessionTool.write(agent('caller'), SessionId(sessionId), '   '))
        .rejects.toThrow(SessionEmptyContentError)
    })

    it('supports incremental reads and clamps max_blocks to the configured cap', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), { title: 't' })
      await ctx.sessionTool.write(agent('caller'), SessionId(sessionId), 'first')
      await ctx.sessionTool.write(agent('caller'), SessionId(sessionId), 'second')
      const all = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), {})
      expect(all.messages.map(row => (row.blocks[0] as { text: string }).text))
        .toEqual(['first', 'second'])
      const lastSeq = all.messages.at(-1)?.seq
      expect(lastSeq).toBeDefined()
      const incremental = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), { sinceSeq: lastSeq })
      expect(incremental.messages).toHaveLength(1)
      const capped = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), { maxBlocks: 1 })
      expect(capped.messages).toHaveLength(1)
      const clamped = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), { maxBlocks: 999_999 })
      expect(clamped.messages.length).toBeLessThanOrEqual(500)
    })

    it('maps assistant and tool events onto their roles', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), {})
      await ctx.sessionTool.write(agent('caller'), SessionId(sessionId), 'user says')
      const session = ctx.sessions.get(SessionId(sessionId))!
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
      const read = await ctx.sessionTool.read(agent('caller'), SessionId(sessionId), {})
      expect(read.messages.map(row => row.role)).toEqual(['user', 'assistant', 'tool'])
      expect(read.messages[1]?.blocks).toEqual([{ type: 'text', text: 'assistant says' }])
    })

    it('materializes a cold session on write (resume semantics)', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), { title: 'cold' })
      await ctx.sessionTool.write(agent('caller'), SessionId(sessionId), 'before')
      // A fresh process: same persistence root, no live sessions.
      const ctx2 = await compose(root)
      try {
        const written = await ctx2.sessionTool.write(agent('caller'), SessionId(sessionId), 'after')
        expect(written.sessionId).toBe(sessionId)
        const read = await ctx2.sessionTool.read(agent('caller'), SessionId(sessionId), {})
        const texts = read.messages.map(row => (row.blocks[0] as { text: string }).text)
        expect(texts).toEqual(['before', 'after'])
      } finally {
        await ctx2.fiber.dispose()
      }
    })

    it('rejects missing and foreign sessions; the CLI bypasses the fence', async () => {
      callerSession('caller')
      callerSession('other')
      await expect(ctx.sessionTool.read(agent('caller'), SessionId('missing'), {}))
        .rejects.toThrow(SessionNotFoundError)
      const { sessionId } = await ctx.sessionTool.create(agent('other'), {})
      await expect(ctx.sessionTool.read(agent('caller'), SessionId(sessionId), {}))
        .rejects.toThrow(SessionToolUnauthorizedError)
      await expect(ctx.sessionTool.read(CLI, SessionId(sessionId), {})).resolves.toBeDefined()
    })

    it('lets a parent reach a child session but not a sibling', async () => {
      callerSession('root')
      const child = await ctx.sessionTool.create(agent('root'), { title: 'child' })
      const stranger = await ctx.sessionTool.create(agent('root'), { title: 'stranger' })
      await ctx.sessionTool.write(agent('root'), SessionId(child.sessionId), 'parent writes child')
      const read = await ctx.sessionTool.read(agent('root'), SessionId(child.sessionId), {})
      expect(read.messages).toHaveLength(1)
      await expect(ctx.sessionTool.write(agent(child.sessionId), SessionId(stranger.sessionId), 'nope'))
        .rejects.toThrow(SessionToolUnauthorizedError)
    })
  })

  describe('rename', () => {
    it('pins the title and replaces tags', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), { title: 'old', tags: ['a'] })
      const result = await ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), {
        title: 'new title',
        tags: ['b', 'c'],
      })
      expect(result).toMatchObject({ title: 'new title', tags: ['b', 'c'] })
      const session = ctx.sessions.get(SessionId(sessionId))!
      expect(ctx.sessionTitle.get(session)?.title).toBe('new title')
      expect(ctx.sessionTags.get(session)?.tags).toEqual(['b', 'c'])
    })

    it('requires at least one of title or tags and maps validation codes', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), {})
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), {}))
        .rejects.toThrow(SessionEmptyContentError)
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), { title: ' ' }))
        .rejects.toMatchObject({ code: 'title-invalid' })
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), { tags: [' ', ''] }))
        .rejects.toMatchObject({ code: 'tag-invalid' })
    })

    it('pre-validates before committing: a rejected tag set leaves the title untouched', async () => {
      callerSession('caller')
      const { sessionId } = await ctx.sessionTool.create(agent('caller'), {})
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), {
        title: 'would-commit',
        tags: [' ', ''],
      })).rejects.toMatchObject({ code: 'tag-invalid' })
      const session = ctx.sessions.get(SessionId(sessionId))!
      expect(ctx.sessionTitle.get(session)?.title).toBeUndefined()
      // And a rejected title leaves the tag set untouched.
      await expect(ctx.sessionTool.rename(agent('caller'), SessionId(sessionId), {
        title: ' ',
        tags: ['valid'],
      })).rejects.toMatchObject({ code: 'title-invalid' })
      expect(ctx.sessionTags.get(session)?.tags).toBeUndefined()
    })
  })

  describe('list', () => {
    it('lists the caller tree for scope own, with hidden titles excluded by default', async () => {
      callerSession('root')
      const top = await ctx.sessionTool.create(agent('root'), { title: 'top', tags: ['a'] })
      const child = await ctx.sessionTool.create(agent('root'), { title: 'child' })
      const grandchild = await ctx.sessionTool.create(agent(child.sessionId), { title: '~hidden' })
      const own = await ctx.sessionTool.list(agent('root'), {})
      // The hidden-prefix grandchild is excluded by default.
      expect(own.sessions.map(row => row.sessionId)).toEqual(['root', top.sessionId, child.sessionId])
      expect(own.sessions.map(row => row.title)).toEqual([undefined, 'top', 'child'])
      const included = await ctx.sessionTool.list(agent('root'), { includeHidden: true })
      expect(included.sessions.map(row => row.sessionId))
        .toEqual(['root', top.sessionId, child.sessionId, grandchild.sessionId])
      expect(included.sessions.map(row => row.title)).toEqual([undefined, 'top', 'child', '~hidden'])
    })

    it('filters by tag intersection, title substring, and status', async () => {
      callerSession('root')
      await ctx.sessionTool.create(agent('root'), { title: 'alpha plan', tags: ['plan', 'wip'] })
      await ctx.sessionTool.create(agent('root'), { title: 'beta notes', tags: ['notes'] })
      const byTag = await ctx.sessionTool.list(agent('root'), { tags: ['plan'] })
      expect(byTag.sessions).toHaveLength(1)
      expect(byTag.sessions[0]?.title).toBe('alpha plan')
      const byTitle = await ctx.sessionTool.list(agent('root'), { title: 'notes' })
      expect(byTitle.sessions.map(row => row.title)).toEqual(['beta notes'])
      const live = await ctx.sessionTool.list(agent('root'), { status: 'live' })
      expect(live.sessions).toHaveLength(3)
      const idle = await ctx.sessionTool.list(agent('root'), { status: 'idle' })
      expect(idle.sessions).toHaveLength(0)
    })

    it('paginates with cursor and limit', async () => {
      callerSession('root')
      for (const title of ['one', 'two', 'three', 'four', 'five']) {
        await ctx.sessionTool.create(agent('root'), { title })
      }
      const first = await ctx.sessionTool.list(agent('root'), { limit: 2 })
      expect(first.sessions).toHaveLength(2)
      expect(first.nextCursor).toBe(first.sessions[1]?.sessionId)
      const second = await ctx.sessionTool.list(agent('root'), { limit: 2, cursor: first.nextCursor })
      expect(second.sessions).toHaveLength(2)
      const third = await ctx.sessionTool.list(agent('root'), { cursor: second.nextCursor })
      expect(third.sessions).toHaveLength(2)
      expect(third.nextCursor).toBeUndefined()
    })

    it('enforces the tree root fence and the all-scope gates', async () => {
      callerSession('caller')
      callerSession('other')
      const other = await ctx.sessionTool.create(agent('other'), { title: 'foreign' })
      await expect(ctx.sessionTool.list(agent('caller'), { scope: 'tree', sessionId: SessionId(other.sessionId) }))
        .rejects.toThrow(SessionToolUnauthorizedError)
      await expect(ctx.sessionTool.list(agent('caller'), { scope: 'tree' }))
        .rejects.toThrow(SessionEmptyContentError)

      await expect(ctx.sessionTool.list(agent('caller', 1), { scope: 'all' }))
        .rejects.toThrow(SessionScopeDeniedError)
      const allowed = await ctx.sessionTool.list(agent('caller', 0), { scope: 'all' })
      expect(allowed.sessions.length).toBeGreaterThanOrEqual(1)

      // CLI gate: cliAllowAll true by default; false denies.
      await expect(ctx.sessionTool.list(CLI, { scope: 'all' })).resolves.toBeDefined()
      const ctx2 = new Context()
      await ctx2.plugin(SessionStore)
      await ctx2.plugin(SessionPersistenceJsonl, { root: join(root, 'second') })
      await ctx2.plugin(SessionTitleService, TITLE_CONFIG)
      await ctx2.plugin(SessionTagsService, TAGS_CONFIG)
      await ctx2.plugin(SessionToolLocalService, { ...TOOL_CONFIG, cliAllowAll: false })
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
      await ctx.sessionTool.create(agent('root'), { title: 'one' })
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
