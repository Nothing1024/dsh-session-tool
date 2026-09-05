// ASM-001 transport selector: auto in-process iff both controllers exist and
// webUrl host:port equals this process webServer listen; otherwise HTTP.
// Explicit in-process without controllers fails loud (no silent fetch loopback).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionToolLocalService from 'session-tool-local'
import type { Config as ToolConfig } from 'session-tool-local'
import type { SessionToolCaller } from 'session-tool'
import {
  hostPortEquals,
  hostPortOfUrl,
  inProcessMissingControllersError,
  selectTransport,
  webServerListen,
} from '../src/transport.ts'

const BASE_CONFIG: ToolConfig = {
  allowAllScope: 'top-level',
  cliAllowAll: true,
  readMaxBlocks: 500,
  listMaxRows: 100,
  hiddenPrefixes: ['~'],
  webUrl: 'http://127.0.0.1:3081',
  allowOthersToWrite: 'workspace',
  showDelegated: true,
}

function agent(id: string): SessionToolCaller {
  return { kind: 'agent', sessionId: SessionId(id), delegationDepth: 0 }
}

function okResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('selectTransport', () => {
  const controllers = {
    sessionController: { create() { return undefined } },
    workspaceController: { create() { return undefined } },
  }

  it('auto picks in-process when controllers exist and webUrl matches listen', () => {
    expect(selectTransport({
      transport: 'auto',
      webUrl: 'http://127.0.0.1:3080',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 3080 },
    })).toBe('in-process')
  })

  it('default auto still in-process for official webUrl 3080 + same-process web', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3080',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 3080 },
    })).toBe('in-process')
  })

  it('auto picks HTTP when webUrl points at another process even if controllers exist', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3081',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 3999 },
    })).toBe('http')
  })

  it('auto picks HTTP when this process has no webServer listen (CLI headless)', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3081',
      ...controllers,
      webServer: undefined,
    })).toBe('http')
  })

  it('auto picks HTTP when controllers are missing and listen does not match', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3081',
      sessionController: undefined,
      workspaceController: undefined,
      webServer: undefined,
    })).toBe('http')
  })

  it('auto fails loud when webUrl matches this process but controllers are missing', () => {
    expect(() => selectTransport({
      webUrl: 'http://127.0.0.1:3080',
      sessionController: undefined,
      workspaceController: undefined,
      webServer: { host: '127.0.0.1', port: 3080 },
    })).toThrow(inProcessMissingControllersError().message)
  })

  it('explicit in-process fails loud without both controllers', () => {
    expect(() => selectTransport({
      transport: 'in-process',
      webUrl: 'http://127.0.0.1:3080',
      sessionController: { create() { return undefined } },
      workspaceController: undefined,
      webServer: undefined,
    })).toThrow(/sessionController and ctx.workspaceController/)
  })

  it('explicit http stays HTTP even when controllers and listen match', () => {
    expect(selectTransport({
      transport: 'http',
      webUrl: 'http://127.0.0.1:3080',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 3080 },
    })).toBe('http')
  })

  it('treats localhost and 127.0.0.1 as the same loopback', () => {
    expect(selectTransport({
      webUrl: 'http://localhost:3081',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 3081 },
    })).toBe('in-process')
  })

  it('wildcard 0.0.0.0 listen matches 127.0.0.1 webUrl on the same port', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3080',
      ...controllers,
      webServer: { host: '0.0.0.0', port: 3080 },
    })).toBe('in-process')
  })

  it('does not match a not-yet-bound webServer port 0', () => {
    expect(selectTransport({
      webUrl: 'http://127.0.0.1:3080',
      ...controllers,
      webServer: { host: '127.0.0.1', port: 0 },
    })).toBe('http')
  })
})

describe('hostPort helpers', () => {
  it('defaults http/https ports', () => {
    expect(hostPortOfUrl('http://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 80 })
    expect(hostPortOfUrl('https://example.test')).toEqual({ host: 'example.test', port: 443 })
  })

  it('reads webServer listen and rejects incomplete values', () => {
    expect(webServerListen({ host: '127.0.0.1', port: 3081 })).toEqual({ host: '127.0.0.1', port: 3081 })
    expect(webServerListen(undefined)).toBeUndefined()
    expect(webServerListen({ host: '127.0.0.1' })).toBeUndefined()
  })

  it('compares advertised URL against listen', () => {
    expect(hostPortEquals(
      { host: '127.0.0.1', port: 3081 },
      { host: '127.0.0.1', port: 3081 },
    )).toBe(true)
    expect(hostPortEquals(
      { host: '127.0.0.1', port: 3081 },
      { host: '127.0.0.1', port: 3080 },
    )).toBe(false)
  })
})

describe('SessionToolLocalService transport binding', () => {
  let root: string | undefined
  let ctx: Context | undefined
  let previousHome: string | undefined

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (ctx !== undefined) await ctx.fiber.dispose()
    ctx = undefined
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
    root = undefined
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  async function compose(options: {
    config?: Partial<ToolConfig>
    gui?: boolean
    webServer?: { host: string; port: number }
    sessionController?: Record<string, unknown>
    workspaceController?: Record<string, unknown>
  } = {}): Promise<{
    ctx: Context
    fetchMock: ReturnType<typeof vi.fn>
    sessionController: {
      create: ReturnType<typeof vi.fn>
      prompt: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
      rename: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
    }
  }> {
    previousHome = process.env.DSH_HOME
    root = mkdtempSync(join(tmpdir(), 'session-tool-transport-'))
    process.env.DSH_HOME = root
    const next = new Context()
    const sessionController = options.sessionController ?? {
      create: vi.fn(async () => ({ sessionId: 'session-9' })),
      prompt: vi.fn(async () => ({ accepted: true })),
      cancel: vi.fn(() => ({ accepted: true })),
      rename: vi.fn(async (request: { title: string }) => ({ title: request.title, seq: 1 })),
      list: vi.fn(async () => ({ items: [] })),
    }
    const workspaceController = options.workspaceController ?? {
      create: vi.fn(async (request: { path: string }) => ({
        workspace: {
          workspaceId: 'ws-1',
          path: request.path,
          title: 'ws',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        created: true,
      })),
      rename: vi.fn(),
      delete: vi.fn(),
    }
    await next.plugin(SessionStore)
    await next.plugin(SessionPersistenceJsonl, { root: join(root, 'sessions') })
    if (options.gui !== false) {
      await next.plugin({
        name: 'fake-gui',
        apply(c) {
          c.provide('sessionController', sessionController)
          c.provide('workspaceController', workspaceController)
          c.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] })
          c.provide('webServer', options.webServer ?? { host: '127.0.0.1', port: 3081 })
        },
      })
    }
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = init?.body === undefined ? undefined : String(init.body)
      const body = raw === undefined
        ? { rpcId: '', method: '' }
        : JSON.parse(raw) as { rpcId: string; method: string }
      if (body.method === 'session/create') return okResponse(body.rpcId, { sessionId: 'session-http' })
      if (body.method === 'session/rename') return okResponse(body.rpcId, { title: 't', seq: 1 })
      if (body.method === 'session/list') return okResponse(body.rpcId, { items: [] })
      return okResponse(body.rpcId, {})
    })
    vi.stubGlobal('fetch', fetchMock)
    await next.plugin(SessionToolLocalService, { ...BASE_CONFIG, ...options.config })
    ctx = next
    return {
      ctx: next,
      fetchMock,
      sessionController: sessionController as {
        create: ReturnType<typeof vi.fn>
        prompt: ReturnType<typeof vi.fn>
        cancel: ReturnType<typeof vi.fn>
        rename: ReturnType<typeof vi.fn>
        list: ReturnType<typeof vi.fn>
      },
    }
  }

  it('same-process auto create does not fetch', async () => {
    const { ctx: tree, fetchMock, sessionController } = await compose()
    tree.sessions.create(SessionId('caller'))
    const created = await tree.sessionTool.create(agent('caller'), { title: 'side', cwd: '/proj' })
    expect(created.sessionId).toBe('session-9')
    expect(sessionController.create).toHaveBeenCalled()
    expect(sessionController.rename).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explicit http mode fetches even when controllers exist', async () => {
    const { ctx: tree, fetchMock, sessionController } = await compose({
      config: { transport: 'http' },
    })
    tree.sessions.create(SessionId('caller'))
    const created = await tree.sessionTool.create(agent('caller'), { title: 't', cwd: '/proj' })
    expect(created.sessionId).toBe('session-http')
    expect(fetchMock).toHaveBeenCalled()
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('CLI-shaped auto (controllers, webUrl not this listen) fetches', async () => {
    const { ctx: tree, fetchMock, sessionController } = await compose({
      webServer: { host: '127.0.0.1', port: 3999 },
    })
    tree.sessions.create(SessionId('caller'))
    await tree.sessionTool.create(agent('caller'), { cwd: '/proj' })
    expect(fetchMock).toHaveBeenCalled()
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('explicit in-process without controllers fails loud at boot', async () => {
    previousHome = process.env.DSH_HOME
    root = mkdtempSync(join(tmpdir(), 'session-tool-transport-fail-'))
    process.env.DSH_HOME = root
    const next = new Context()
    await next.plugin(SessionStore)
    await next.plugin(SessionPersistenceJsonl, { root: join(root, 'sessions') })
    ctx = next
    await expect(next.plugin(SessionToolLocalService, {
      ...BASE_CONFIG,
      transport: 'in-process',
    })).rejects.toThrow(/sessionController and ctx.workspaceController/)
  })
})
