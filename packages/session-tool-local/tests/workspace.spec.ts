// SessionToolLocalService workspace surface: create's workspacePath branch
// (register-then-bind through the mocked gateway client, header cwd = the
// canonical workspace path) and the four workspace verbs.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTagsService from '@deepseek-ai/dsh-session-tags'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionToolLocalService from 'session-tool-local'
import type { Config as ToolConfig } from 'session-tool-local'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolCaller } from 'session-tool'
import { WorkspaceHttpClient } from '../src/workspace-client.ts'
import { SessionHttpClient } from '../src/session-client.ts'

vi.mock('../src/workspace-client.ts')
vi.mock('../src/session-client.ts')

const TOOL_CONFIG: ToolConfig = {
  allowAllScope: 'top-level',
  cliAllowAll: true,
  readMaxBlocks: 500,
  listMaxRows: 100,
  hiddenPrefixes: ['~'],
  webUrl: 'http://127.0.0.1:3080',
}

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }
const TAGS_CONFIG = { maxTags: 5, maxTagBytes: 32, hiddenPrefixes: ['~', '[internal]'] }

const WS = {
  workspaceId: 'ws-1',
  path: '/canonical/ws',
  title: 'ws',
  sessionIds: [] as string[],
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
}

/** Compose the minimal session stack over one persistence root. */
async function compose(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root })
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  await ctx.plugin(SessionTagsService, TAGS_CONFIG)
  await ctx.plugin(SessionToolLocalService, TOOL_CONFIG)
  return ctx
}

/** The last mock client instance (the provider constructs one per boot). */
function clientMock(): {
  addWorkspace: ReturnType<typeof vi.fn>
  listWorkspaces: ReturnType<typeof vi.fn>
  renameWorkspace: ReturnType<typeof vi.fn>
  deleteWorkspace: ReturnType<typeof vi.fn>
} {
  const constructor = vi.mocked(WorkspaceHttpClient)
  const instance = constructor.mock.instances.at(-1) as {
    addWorkspace: ReturnType<typeof vi.fn>
    listWorkspaces: ReturnType<typeof vi.fn>
    renameWorkspace: ReturnType<typeof vi.fn>
    deleteWorkspace: ReturnType<typeof vi.fn>
  }
  return instance
}

/** The last mock session-client instance. */
function sessionClientMock() {
  const constructor = vi.mocked(SessionHttpClient)
  return constructor.mock.instances.at(-1) as { durableCreate: ReturnType<typeof vi.fn> }
}

function agent(id: string): SessionToolCaller {
  return { kind: 'agent', sessionId: SessionId(id), delegationDepth: 0 }
}

const CLI: SessionToolCaller = { kind: 'cli' }

describe('SessionToolLocalService workspace surface', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'session-tool-ws-test-'))
    ctx = await compose(root)
    ctx.sessions.create(SessionId('caller'))
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  describe('create with workspacePath', () => {
    it('registers the workspace first, binds the gateway create to it, and echoes the binding', async () => {
      clientMock().addWorkspace.mockResolvedValue({ workspace: WS, created: true })
      sessionClientMock().durableCreate.mockResolvedValue({ sessionId: 'session-9' })
      const result = await ctx.sessionTool.create(agent('caller'), { workspacePath: '/some/path' })
      expect(clientMock().addWorkspace).toHaveBeenCalledWith('/some/path')
      expect(sessionClientMock().durableCreate).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
      }))
      expect(result.workspaceId).toBe('ws-1')
      expect(result.workspacePath).toBe('/canonical/ws')
    })

    it('passes the plain cwd when no workspacePath is requested', async () => {
      sessionClientMock().durableCreate.mockResolvedValue({ sessionId: 'session-9' })
      const result = await ctx.sessionTool.create(agent('caller'), { cwd: '/plain' })
      expect(clientMock().addWorkspace).not.toHaveBeenCalled()
      expect(sessionClientMock().durableCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/plain' }))
      expect(result.workspaceId).toBeUndefined()
    })

    it('fails loud on an unreachable gateway and never calls the session create', async () => {
      clientMock().addWorkspace.mockRejectedValue(new SessionWebUnreachableError('web gateway unreachable'))
      await expect(ctx.sessionTool.create(agent('caller'), { workspacePath: '/some/path' }))
        .rejects.toBeInstanceOf(SessionWebUnreachableError)
      expect(sessionClientMock().durableCreate).not.toHaveBeenCalled()
    })

    it('propagates a gateway business rejection without calling the session create', async () => {
      clientMock().addWorkspace.mockRejectedValue(
        new SessionToolError('path is not a directory', 'workspace-invalid-path'),
      )
      await expect(ctx.sessionTool.create(agent('caller'), { workspacePath: '/missing' }))
        .rejects.toMatchObject({ code: 'workspace-invalid-path' })
      expect(sessionClientMock().durableCreate).not.toHaveBeenCalled()
    })
  })

  describe('workspace verbs', () => {
    it('workspaceAdd reuses an existing workspace and skips the title rename', async () => {
      clientMock().addWorkspace.mockResolvedValue({ workspace: WS, created: false })
      const result = await ctx.sessionTool.workspaceAdd(CLI, { path: '/canonical/ws', title: 'renamed' })
      expect(clientMock().renameWorkspace).not.toHaveBeenCalled()
      expect(result).toEqual({ workspaceId: 'ws-1', path: '/canonical/ws', created: false })
    })

    it('workspaceAdd titles a freshly created workspace', async () => {
      clientMock().addWorkspace.mockResolvedValue({ workspace: WS, created: true })
      clientMock().renameWorkspace.mockResolvedValue({ ...WS, title: 'renamed' })
      const result = await ctx.sessionTool.workspaceAdd(CLI, { path: '/canonical/ws', title: 'renamed' })
      expect(clientMock().renameWorkspace).toHaveBeenCalledWith('ws-1', 'renamed')
      expect(result.created).toBe(true)
    })

    it('workspaceAdd skips a title identical to the basename default', async () => {
      clientMock().addWorkspace.mockResolvedValue({ workspace: WS, created: true })
      const result = await ctx.sessionTool.workspaceAdd(CLI, { path: '/canonical/ws', title: 'ws' })
      expect(clientMock().renameWorkspace).not.toHaveBeenCalled()
      expect(result.created).toBe(true)
    })

    it('workspaceList maps gateway rows onto the contract rows', async () => {
      clientMock().listWorkspaces.mockResolvedValue({ items: [WS], archivedSessionIds: ['session-9'] })
      const result = await ctx.sessionTool.workspaceList(CLI)
      expect(result.workspaces).toEqual([{
        workspaceId: 'ws-1',
        path: '/canonical/ws',
        title: 'ws',
        sessionIds: [],
        createdAt: WS.createdAt,
        updatedAt: WS.updatedAt,
      }])
      expect(result.archivedSessionIds).toEqual(['session-9'])
    })

    it('workspaceRename passes the id and title through', async () => {
      clientMock().renameWorkspace.mockResolvedValue({ ...WS, title: 'renamed' })
      const result = await ctx.sessionTool.workspaceRename(CLI, { workspaceId: 'ws-1', title: 'renamed' })
      expect(clientMock().renameWorkspace).toHaveBeenCalledWith('ws-1', 'renamed')
      expect(result).toEqual({ workspaceId: 'ws-1', title: 'renamed' })
    })

    it('workspaceDelete passes the id through and reports the outcome', async () => {
      clientMock().deleteWorkspace.mockResolvedValue(true)
      const result = await ctx.sessionTool.workspaceDelete(CLI, 'ws-1')
      expect(clientMock().deleteWorkspace).toHaveBeenCalledWith('ws-1')
      expect(result).toEqual({ workspaceId: 'ws-1', deleted: true })
    })

    it('workspaceDelete reports an unknown id as a false no-op', async () => {
      clientMock().deleteWorkspace.mockResolvedValue(false)
      const result = await ctx.sessionTool.workspaceDelete(CLI, 'ws-void')
      expect(result.deleted).toBe(false)
    })

    it('surfaces gateway failures on every verb', async () => {
      clientMock().listWorkspaces.mockRejectedValue(new SessionWebUnreachableError('refused'))
      await expect(ctx.sessionTool.workspaceList(CLI)).rejects.toBeInstanceOf(SessionWebUnreachableError)
    })
  })
})
