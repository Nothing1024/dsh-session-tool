// WorkspaceHttpClient: unary POST /api/workspace/{create,rename,delete} with
// { args }, 401 → web-unreachable, slash-code mapping, 303 cookie
// (redirect:manual). List via workspace/follow first baseline then cancel.
// InProcessWorkspaceClient: mock controller + registry, no fetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import { WorkspaceHttpClient, WORKSPACE_WIRE_CODES } from '../src/workspace-client.ts'
import { InProcessWorkspaceClient } from '../src/workspace-client-in-process.ts'
import type {
  InProcessWorkspaceController,
  InProcessWorkspaceRegistry,
} from '../src/workspace-client-in-process.ts'
import { IN_PROCESS_WIRE_CODES } from '../src/in-process-wire.ts'

const WS = {
  workspaceId: 'ws-1',
  path: '/tmp/ws',
  title: 'ws',
  sessionIds: [],
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
}

function stubFetch(handler: (
  url: URL,
  body: { rpcId: string; method: string; payload: unknown },
  init?: RequestInit,
) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const raw = init?.body === undefined ? undefined : String(init.body)
    const body = raw === undefined
      ? { rpcId: '', method: '', payload: null }
      : JSON.parse(raw) as { rpcId: string; method: string; payload: unknown }
    return await handler(url, body, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function okResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

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

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const hit = headers.find(entry => entry[0]?.toLowerCase() === name.toLowerCase())
    return hit?.[1]
  }
  if (headers !== undefined && typeof headers === 'object') {
    const record = headers as Record<string, string>
    return record[name] ?? record[name.toLowerCase()]
  }
  return undefined
}

function remoteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { isDSHRemoteError: true as const, code })
}

const BASE = 'http://127.0.0.1:3080'
const COOKIE_PAIR = 'dsh-auth-abc=v1.payload.sig'

describe('WorkspaceHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DSH_LAUNCH_TOKEN
  })

  it('maps the required slash codes onto hyphen seam codes', () => {
    expect(WORKSPACE_WIRE_CODES['workspace/not-found']).toBe('workspace-not-found')
    expect(WORKSPACE_WIRE_CODES['workspace/name-conflict']).toBe('workspace-name-conflict')
    expect(WORKSPACE_WIRE_CODES['workspace/invalid-path']).toBe('workspace-invalid-path')
    expect(WORKSPACE_WIRE_CODES['session/not-found']).toBe('session-not-found')
    expect(WORKSPACE_WIRE_CODES['session/title-invalid']).toBe('title-invalid')
  })

  it('rejects a malformed gateway URL at construction', () => {
    expect(() => new WorkspaceHttpClient('not a url')).toThrow()
  })

  it('addWorkspace posts the path to /api/workspace/create and returns the workspace', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.href).toBe(`${BASE}/api/workspace/create`)
      expect(body.method).toBe('workspace/create')
      expect(body.payload).toEqual({ args: { request: { path: '/tmp/ws' } } })
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
    stubFetch((_url, body) => errorResponse(body.rpcId, 'workspace/invalid-path', 'path is not a directory', { path: '/tmp/missing' }))
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

  it('maps unauthenticated POST 401 to web-unreachable', async () => {
    const fetchMock = stubFetch(() => new Response('unauthorized', { status: 401 }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.addWorkspace('/tmp/ws').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps POST 403 to web-unreachable', async () => {
    stubFetch(() => new Response('forbidden', { status: 403 }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.deleteWorkspace('ws-1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
  })

  it('GET /?token= uses redirect:manual, harvests 303 Set-Cookie, and POSTs /api/workspace/create with the same Cookie', async () => {
    const fetchMock = stubFetch((url, body, init) => {
      if (url.pathname === '/') {
        expect(init?.method).toBe('GET')
        expect(init?.redirect).toBe('manual')
        expect(url.searchParams.get('token')).toBe('launch-token-1')
        expect(url.host).toBe('127.0.0.1:3080')
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': `${COOKIE_PAIR}; Path=/; HttpOnly; SameSite=Strict`,
          },
        })
      }
      expect(url.href).toBe(`${BASE}/api/workspace/create`)
      expect(init?.method).toBe('POST')
      expect(init?.redirect).not.toBe('follow')
      expect(headerOf(init, 'cookie')).toBe(COOKIE_PAIR)
      expect(body.method).toBe('workspace/create')
      return okResponse(body.rpcId, { workspace: WS, created: true })
    })
    const client = new WorkspaceHttpClient(BASE, { launchToken: 'launch-token-1' })
    const result = await client.addWorkspace('/tmp/ws')
    expect(result).toEqual({ workspace: WS, created: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('listWorkspaces reads workspace/follow baseline then cancels', async () => {
    let opened: { endpoint: string; args: unknown } | undefined
    const openStream = vi.fn(async (input: { endpoint: string; args: unknown }) => {
      opened = { endpoint: input.endpoint, args: input.args }
      return {
        type: 'baseline',
        value: { items: [WS], archivedSessionIds: ['session-1'] },
      }
    })
    const client = new WorkspaceHttpClient(BASE, { openStream })
    const result = await client.listWorkspaces()
    expect(result.items).toEqual([WS])
    expect(result.archivedSessionIds).toEqual(['session-1'])
    expect(openStream).toHaveBeenCalledOnce()
    expect(opened).toEqual({
      endpoint: 'workspace/follow',
      args: {},
    })
  })

  it('renameWorkspace posts the id and title and returns the workspace', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/workspace/rename')
      expect(body.payload).toEqual({ args: { request: { workspaceId: 'ws-1', title: 'renamed' } } })
      return okResponse(body.rpcId, { workspace: { ...WS, title: 'renamed' } })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.renameWorkspace('ws-1', 'renamed')
    expect(result.title).toBe('renamed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deleteWorkspace posts the id and returns the deleted flag', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/workspace/delete')
      expect(body.payload).toEqual({ args: { request: { workspaceId: 'ws-1' } } })
      return okResponse(body.rpcId, { deleted: true })
    })
    const client = new WorkspaceHttpClient(BASE)
    const result = await client.deleteWorkspace('ws-1')
    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deleteWorkspace surfaces a workspace-not-found business error', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'workspace/not-found', 'no such workspace', { workspaceId: 'ws-void' }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.deleteWorkspace('ws-void').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionToolError).code).toBe('workspace-not-found')
  })

  it('maps workspace/name-conflict onto workspace-name-conflict', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'workspace/name-conflict', 'taken', { name: 'x' }))
    const client = new WorkspaceHttpClient(BASE)
    const failure = await client.renameWorkspace('ws-1', 'x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('workspace-name-conflict')
  })
})

describe('InProcessWorkspaceClient (mock controller/registry)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function controller(overrides: Partial<InProcessWorkspaceController> = {}): InProcessWorkspaceController {
    return {
      create: vi.fn(async ({ path }) => ({ workspace: { ...WS, path }, created: true })),
      rename: vi.fn(async ({ title }) => ({ workspace: { ...WS, title } })),
      delete: vi.fn(async () => ({ deleted: true })),
      ...overrides,
    }
  }

  function registry(overrides: Partial<InProcessWorkspaceRegistry> = {}): InProcessWorkspaceRegistry {
    return {
      list: () => [{
        id: 'ws-1',
        path: '/tmp/ws',
        title: 'ws',
        sessionIds: ['session-1'],
        createdAt: WS.createdAt,
        updatedAt: WS.updatedAt,
      }],
      archivedSessionIds: ['session-2'],
      ...overrides,
    }
  }

  it('maps the required slash codes onto hyphen seam codes', () => {
    expect(IN_PROCESS_WIRE_CODES['workspace/not-found']).toBe('workspace-not-found')
    expect(IN_PROCESS_WIRE_CODES['workspace/name-conflict']).toBe('workspace-name-conflict')
    expect(IN_PROCESS_WIRE_CODES['workspace/invalid-path']).toBe('workspace-invalid-path')
  })

  it('addWorkspace / rename / delete go through the controller and do not fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const workspaceController = controller()
    const client = new InProcessWorkspaceClient({
      workspaceController,
      workspaceRegistry: registry(),
    })
    const created = await client.addWorkspace('/tmp/ws')
    expect(created).toEqual({ workspace: { ...WS, path: '/tmp/ws' }, created: true })
    expect(workspaceController.create).toHaveBeenCalledWith({ path: '/tmp/ws' })
    const renamed = await client.renameWorkspace('ws-1', 'renamed')
    expect(renamed.title).toBe('renamed')
    expect(workspaceController.rename).toHaveBeenCalledWith({ workspaceId: 'ws-1', title: 'renamed' })
    await expect(client.deleteWorkspace('ws-1')).resolves.toBe(true)
    expect(workspaceController.delete).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('listWorkspaces reads registry.list plus archivedSessionIds and does not fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const workspaceRegistry = registry()
    const client = new InProcessWorkspaceClient({
      workspaceController: controller(),
      workspaceRegistry,
    })
    const result = await client.listWorkspaces()
    expect(result.items).toEqual([{
      workspaceId: 'ws-1',
      path: '/tmp/ws',
      title: 'ws',
      sessionIds: ['session-1'],
      createdAt: WS.createdAt,
      updatedAt: WS.updatedAt,
    }])
    expect(result.archivedSessionIds).toEqual(['session-2'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps controller workspace/invalid-path onto workspace-invalid-path', async () => {
    const client = new InProcessWorkspaceClient({
      workspaceController: controller({
        create: async () => {
          throw remoteError('workspace/invalid-path', 'path is not a directory')
        },
      }),
      workspaceRegistry: registry(),
    })
    const failure = await client.addWorkspace('/tmp/missing').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionToolError).code).toBe('workspace-invalid-path')
  })

  it('maps controller workspace/not-found onto workspace-not-found', async () => {
    const client = new InProcessWorkspaceClient({
      workspaceController: controller({
        delete: async () => {
          throw remoteError('workspace/not-found', 'no such workspace')
        },
      }),
      workspaceRegistry: registry(),
    })
    const failure = await client.deleteWorkspace('ws-void').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('workspace-not-found')
  })

  it('maps controller workspace/name-conflict onto workspace-name-conflict', async () => {
    const client = new InProcessWorkspaceClient({
      workspaceController: controller({
        rename: async () => {
          throw remoteError('workspace/name-conflict', 'taken')
        },
      }),
      workspaceRegistry: registry(),
    })
    const failure = await client.renameWorkspace('ws-1', 'x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('workspace-name-conflict')
  })

  it('propagates an unmapped remote error without turning it into web-unreachable', async () => {
    const boom = remoteError('internal', 'boom')
    const client = new InProcessWorkspaceClient({
      workspaceController: controller({
        create: async () => {
          throw boom
        },
      }),
      workspaceRegistry: registry(),
    })
    const failure = await client.addWorkspace('/tmp/ws').catch((error: unknown) => error)
    expect(failure).toBe(boom)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
  })
})
