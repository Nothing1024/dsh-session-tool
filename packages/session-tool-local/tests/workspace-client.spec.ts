// WorkspaceHttpClient: the full fetch-carrier round trip against a stubbed
// global fetch — envelope minting, payload shape, ok/error narrowing, and the
// transport/business failure mapping onto the session-tool error seam.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import { WorkspaceHttpClient } from '../src/workspace-client.ts'

const WS = {
  workspaceId: 'ws-1',
  path: '/tmp/ws',
  title: 'ws',
  sessionIds: [],
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
}

/** Stub global fetch with a handler over the parsed request. */
function stubFetch(handler: (url: URL, body: { rpcId: string; method: string; payload: unknown }) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body ?? '{"rpcId":"","method":"","payload":null}')) as {
      rpcId: string
      method: string
      payload: unknown
    }
    return await handler(url, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The gateway's envelope echo for one request. */
function okResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The gateway's business-error envelope echo (details carry the wire fields). */
function errorResponse(rpcId: string, code: string, message: string, details: object = {}): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details } },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE = 'http://127.0.0.1:3080'

describe('WorkspaceHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a malformed gateway URL at construction', () => {
    expect(() => new WorkspaceHttpClient('not a url')).toThrow()
  })

  it('addWorkspace posts the path to /api/workspace.create and returns the workspace', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.href).toBe(`${BASE}/api/workspace.create`)
      expect(body.method).toBe('workspace.create')
      expect(body.payload).toEqual({ path: '/tmp/ws' })
      return okResponse(body.rpcId, { workspace: WS, created: true })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.addWorkspace('/tmp/ws')
    expect(result).toEqual({ workspace: WS, created: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('addWorkspace surfaces a reuse (created: false)', async () => {
    stubFetch((_url, body) => okResponse(body.rpcId, { workspace: WS, created: false }))
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.addWorkspace('/tmp/ws')
    expect(result.created).toBe(false)
  })

  it('translates a workspace business error onto the seam code', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'workspace-invalid-path', 'path is not a directory', { path: '/tmp/missing' }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.addWorkspace('/tmp/missing').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('workspace-invalid-path')
  })

  it('translates an unknown business code as web-unreachable', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'internal', 'boom'))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.addWorkspace('/tmp/ws').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).message).toContain('internal')
  })

  it('maps a refused connection to web-unreachable', async () => {
    stubFetch(() => { throw new TypeError('fetch failed') })
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.addWorkspace('/tmp/ws').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
  })

  it('maps a non-2xx carrier response to web-unreachable', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.addWorkspace('/tmp/ws').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
  })

  it('listWorkspaces returns items and the archive set', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/workspace.list')
      expect(body.payload).toEqual({})
      return okResponse(body.rpcId, { items: [WS], archivedSessionIds: ['session-1'] })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.listWorkspaces()
    expect(result.items).toEqual([WS])
    expect(result.archivedSessionIds).toEqual(['session-1'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('renameWorkspace posts the id and title and returns the workspace', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/workspace.rename')
      expect(body.payload).toEqual({ workspaceId: 'ws-1', title: 'renamed' })
      return okResponse(body.rpcId, { workspace: { ...WS, title: 'renamed' } })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.renameWorkspace('ws-1', 'renamed')
    expect(result.title).toBe('renamed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deleteWorkspace posts the id and returns the deleted flag', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/workspace.delete')
      expect(body.payload).toEqual({ workspaceId: 'ws-1' })
      return okResponse(body.rpcId, { deleted: true })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.deleteWorkspace('ws-1')
    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deleteWorkspace surfaces a workspace-not-found business error', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'workspace-not-found', 'no such workspace', { workspaceId: 'ws-void' }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.deleteWorkspace('ws-void').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('workspace-not-found')
  })
})
