// SessionHttpClient: unary POST /api/session/{create,prompt,cancel,rename,list}
// with { args }, 401 → web-unreachable, slash-code mapping, 303 cookie
// (redirect:manual). InProcessSessionClient: mock sessionController, no fetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import { SessionHttpClient, SESSION_WIRE_CODES } from '../src/session-client.ts'
import { InProcessSessionClient } from '../src/session-client-in-process.ts'
import type {
  InProcessSessionController,
  InProcessSessionPersistence,
  InProcessSessionStore,
} from '../src/session-client-in-process.ts'
import { IN_PROCESS_WIRE_CODES } from '../src/in-process-wire.ts'

/** One wire SessionSummary-shaped row for list tests. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    updatedAt: 1_700_000_000_000,
    running: false,
    blank: false,
    ...overrides,
  }
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

const BASE = 'http://127.0.0.1:3180'
const COOKIE_PAIR = 'dsh-auth-abc=v1.payload.sig'
const completedEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

describe('SessionHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DSH_LAUNCH_TOKEN
  })

  it('maps the required slash codes onto hyphen seam codes', () => {
    expect(SESSION_WIRE_CODES['session/not-found']).toBe('session-not-found')
    expect(SESSION_WIRE_CODES['session/title-invalid']).toBe('title-invalid')
    expect(SESSION_WIRE_CODES['workspace/not-found']).toBe('workspace-not-found')
    expect(SESSION_WIRE_CODES['workspace/name-conflict']).toBe('workspace-name-conflict')
    expect(SESSION_WIRE_CODES['workspace/invalid-path']).toBe('workspace-invalid-path')
  })

  it('durableCreate posts create then rename on slash paths with args.request', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((url, body) => {
      methods.push(body.method)
      if (body.method === 'session/create') {
        expect(url.href).toBe(`${BASE}/api/session/create`)
        expect(body.payload).toEqual({ args: { request: { workspaceId: 'ws-1' } } })
        return okResponse(body.rpcId, { sessionId: 'session-9' })
      }
      expect(url.href).toBe(`${BASE}/api/session/rename`)
      expect(body.payload).toEqual({ args: { request: { sessionId: 'session-9', title: 't' } } })
      return okResponse(body.rpcId, { title: 't', seq: 1 })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.durableCreate({
      title: 't',
      parentSessionId: 'caller',
      workspaceId: 'ws-1',
      delegationDepth: 1,
    })
    expect(result).toEqual({ sessionId: 'session-9', title: 't' })
    expect(result).not.toHaveProperty('tags')
    expect(methods).toEqual(['session/create', 'session/rename'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('durableCreate posts a bare cwd request when nothing optional is given', async () => {
    const fetchMock = stubFetch((_url, body) => {
      expect(body.payload).toEqual({ args: { request: { cwd: '/proj' } } })
      return okResponse(body.rpcId, { sessionId: 'session-9' })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.durableCreate({ cwd: '/proj' })
    expect(result.sessionId).toBe('session-9')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('prompt sends the content as a queued text message with requestId', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session/prompt')
      const payload = body.payload as { args: { request: Record<string, unknown> } }
      expect(payload.args.request).toEqual({
        requestId: expect.any(String),
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'text', text: 'hello' }],
      })
      return okResponse(body.rpcId, { accepted: true })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.prompt('session-1', 'hello')
    expect(result).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('subagentPrompt posts the continuable parent/child address', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/subagents/prompt')
      const payload = body.payload as { args: { request: Record<string, unknown> } }
      expect(payload.args.request).toMatchObject({
        parentSessionId: 'root',
        childSessionId: 'child',
        mode: 'continuable',
        content: [{ type: 'text', text: 'go' }],
      })
      return okResponse(body.rpcId, { messageId: 'msg-1' })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.subagentPrompt('root', 'child', 'go')
    expect(result).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('wait polls session/list running and reports idle when not running', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((_url, body) => {
      methods.push(body.method)
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { until: 'idle', timeoutMs: 5000 })
    expect(result).toEqual({ status: 'idle' })
    expect(methods).toEqual(['session/list'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('wait reports timeout when the session is still running and the deadline is 0', async () => {
    const fetchMock = stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: true })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { timeoutMs: 0 })
    expect(result).toEqual({ status: 'timeout' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancel posts the session id and echoes the admission', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session/cancel')
      expect(body.payload).toEqual({ args: { request: { sessionId: 'session-1' } } })
      return okResponse(body.rpcId, { accepted: true })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.cancel('session-1')
    expect(result).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('list folds title projection onto the rows and ignores gateway tags', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      expect(body.payload).toEqual({ args: { _request: {} } })
      return okResponse(body.rpcId, {
        items: [
          summary({
            sessionId: 'session-1',
            parentSessionId: 'caller',
            cwd: '/proj',
            projections: {
              asOfSeq: 5,
              values: { title: 'named', tags: ['a', 'b'] },
            },
          }),
          summary({ sessionId: 'session-2' }),
        ],
      })
    })
    const client = new SessionHttpClient(BASE)
    const rows = await client.list()
    expect(rows).toEqual([
      {
        sessionId: 'session-1',
        parentSessionId: 'caller',
        cwd: '/proj',
        title: 'named',
        running: false,
        updatedAt: 1_700_000_000_000,
      },
      { sessionId: 'session-2', running: false, updatedAt: 1_700_000_000_000 },
    ])
    expect(rows[0]).not.toHaveProperty('tags')
  })

  it('rename posts only the title and does not echo tags', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session/rename')
      expect(body.payload).toEqual({ args: { request: { sessionId: 'session-1', title: 'new' } } })
      return okResponse(body.rpcId, { title: 'new', seq: 7 })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.rename('session-1', { title: 'new' })
    expect(result).toEqual({ title: 'new', seq: 7 })
    expect(result).not.toHaveProperty('tags')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('translates a title-invalid business error onto the seam code', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'title-invalid', 'bad title', { sessionId: 'session-1' }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('session-1', { title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('maps session/title-invalid onto title-invalid', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'session/title-invalid', 'bad title'))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('session-1', { title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('maps session/not-found onto session-not-found and does not swallow as web-unreachable', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'session/not-found', 'session missing'))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('missing', { title: 'x' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionToolError).code).toBe('session-not-found')
  })

  it('translates a title-invalid error from the create follow-up rename', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session/create') {
        return okResponse(body.rpcId, { sessionId: 'session-9' })
      }
      return errorResponse(body.rpcId, 'session/title-invalid', 'bad title', { sessionId: 'session-9' })
    })
    const client = new SessionHttpClient(BASE)
    const failure = await client.durableCreate({ title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('maps unauthenticated POST 401 to web-unreachable', async () => {
    const fetchMock = stubFetch(() => new Response('unauthorized', { status: 401 }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps POST 403 to web-unreachable', async () => {
    stubFetch(() => new Response('forbidden', { status: 403 }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.durableCreate({ cwd: '/proj' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
  })

  it('GET /?token= uses redirect:manual, harvests 303 Set-Cookie, and POSTs /api/session/create with the same Cookie', async () => {
    const fetchMock = stubFetch((url, body, init) => {
      if (url.pathname === '/') {
        expect(init?.method).toBe('GET')
        expect(init?.redirect).toBe('manual')
        expect(url.searchParams.get('token')).toBe('launch-token-1')
        expect(url.host).toBe('127.0.0.1:3180')
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': `${COOKIE_PAIR}; Path=/; HttpOnly; SameSite=Strict`,
          },
        })
      }
      expect(url.href).toBe(`${BASE}/api/session/create`)
      expect(init?.method).toBe('POST')
      expect(init?.redirect).not.toBe('follow')
      expect(headerOf(init, 'cookie')).toBe(COOKIE_PAIR)
      expect(body.method).toBe('session/create')
      expect(body.payload).toEqual({ args: { request: { cwd: '/proj' } } })
      return okResponse(body.rpcId, { sessionId: 'session-9' })
    })
    const client = new SessionHttpClient(BASE, { launchToken: 'launch-token-1' })
    const result = await client.durableCreate({ cwd: '/proj' })
    expect(result).toEqual({ sessionId: 'session-9' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('GET /?token= 401 maps to web-unreachable and does not follow the 303', async () => {
    const seen: { url: string; redirect?: RequestInit['redirect'] }[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect })
      return new Response('unauthorized', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SessionHttpClient(BASE, { launchToken: 'bad' })
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]?.url ?? '')
    expect(url.pathname).toBe('/')
    expect(seen[0]?.redirect).toBe('manual')
  })

  it('wait maps a completed turn/end from inspectEvents and never posts history', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((url, body) => {
      methods.push(body.method)
      expect(url.pathname).not.toContain('history')
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const inspectEvents = vi.fn(async () => [completedEnd])
    const client = new SessionHttpClient(BASE, { inspectEvents })
    const result = await client.wait('session-1', { until: 'idle', timeoutMs: 5000 })
    expect(result).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
    expect(inspectEvents).toHaveBeenCalledWith('session-1')
    expect(methods).toEqual(['session/list'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('wait maps an aborted turn/end onto aborted', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const client = new SessionHttpClient(BASE, {
      inspectEvents: async () => [{ type: 'turn/end', data: { reason: { kind: 'aborted' } } }],
    })
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'aborted', lastTurnEndReason: { kind: 'aborted' } })
  })

  it('wait maps an unknown turn/end kind onto failed', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const client = new SessionHttpClient(BASE, {
      inspectEvents: async () => [{ type: 'turn/end', data: { reason: { kind: 'blocked' } } }],
    })
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'failed', lastTurnEndReason: { kind: 'blocked' } })
  })

  it('wait until turn-end returns idle when the session is cold', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { until: 'turn-end', timeoutMs: 0 })
    expect(result).toEqual({ status: 'idle' })
  })

  it('wait treats a failed inspect as no turn/end', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const client = new SessionHttpClient(BASE, {
      inspectEvents: async () => {
        throw new Error('session-not-found')
      },
    })
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'idle' })
  })

  it('wait until turn-end settles on a reason even while running', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: true })] })
    })
    const client = new SessionHttpClient(BASE, {
      inspectEvents: async () => [{ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }],
    })
    const result = await client.wait('session-1', { until: 'turn-end', timeoutMs: 1000 })
    expect(result).toEqual({ status: 'aborted', lastTurnEndReason: { kind: 'interrupted' } })
  })

  it('wait sleeps then times out while the session stays running', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: true })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { timeoutMs: 20 })
    expect(result).toEqual({ status: 'timeout' })
  })

  it('wait ignores a turn/end event with a non-object payload', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const client = new SessionHttpClient(BASE, {
      inspectEvents: async () => [
        { type: 'user/message', data: {} },
        { type: 'turn/end', data: null },
      ],
    })
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'idle' })
  })

  it('maps a refused connection to web-unreachable', async () => {
    stubFetch(() => { throw new TypeError('fetch failed') })
    const client = new SessionHttpClient(BASE)
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
  })

  it('maps an unknown business code as web-unreachable', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'internal', 'boom'))
    const client = new SessionHttpClient(BASE)
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
  })

  it('rejects a malformed gateway URL at construction', () => {
    expect(() => new SessionHttpClient('not a url')).toThrow()
  })
})

describe('InProcessSessionClient (mock controller)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function persistence(events: readonly { readonly type: string; readonly data?: unknown }[] = []): InProcessSessionPersistence {
    return { inspect: async () => ({ events }) }
  }

  function store(
    live?: { snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[] },
  ): InProcessSessionStore {
    return {
      get: (id) => id === SessionId('session-1') ? live : undefined,
    }
  }

  function controller(overrides: Partial<InProcessSessionController> = {}): InProcessSessionController {
    return {
      create: vi.fn(async () => ({ sessionId: 'session-9' })),
      prompt: vi.fn(async () => ({ accepted: true as const })),
      cancel: vi.fn(() => ({ accepted: true as const })),
      rename: vi.fn(async ({ title }) => ({ title, seq: 1 })),
      list: vi.fn(async () => ({
        items: [{
          sessionId: 'session-1',
          parentSessionId: 'caller',
          cwd: '/proj',
          running: false,
          updatedAt: 1_700_000_000_000,
          projections: { values: { title: 'named', tags: ['a'] } },
        }],
      })),
      ...overrides,
    }
  }

  it('maps the required slash codes onto hyphen seam codes', () => {
    expect(IN_PROCESS_WIRE_CODES['session/not-found']).toBe('session-not-found')
    expect(IN_PROCESS_WIRE_CODES['session/title-invalid']).toBe('title-invalid')
  })

  it('durableCreate calls controller.create then rename and does not fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const sessionController = controller()
    const client = new InProcessSessionClient({
      sessionController,
      sessions: store(),
      sessionPersistence: persistence(),
    })
    const result = await client.durableCreate({
      title: 't',
      parentSessionId: 'caller',
      workspaceId: 'ws-1',
      cwd: '/proj',
      delegationDepth: 1,
    })
    expect(result).toEqual({ sessionId: 'session-9', title: 't' })
    expect(sessionController.create).toHaveBeenCalledWith({ workspaceId: 'ws-1', cwd: '/proj' })
    expect(sessionController.rename).toHaveBeenCalledWith({ sessionId: 'session-9', title: 't' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prompt, cancel, list, and rename go through the controller', async () => {
    const sessionController = controller()
    const client = new InProcessSessionClient({
      sessionController,
      sessions: store(),
      sessionPersistence: persistence(),
    })
    await expect(client.prompt('session-1', 'hello')).resolves.toEqual({ accepted: true })
    await expect(client.cancel('session-1')).resolves.toEqual({ accepted: true })
    await expect(client.rename('session-1', { title: 'new' })).resolves.toEqual({ title: 'new', seq: 1 })
    const rows = await client.list()
    expect(rows).toEqual([{
      sessionId: 'session-1',
      parentSessionId: 'caller',
      cwd: '/proj',
      title: 'named',
      running: false,
      updatedAt: 1_700_000_000_000,
    }])
    expect(rows[0]).not.toHaveProperty('tags')
    expect(sessionController.prompt).toHaveBeenCalled()
    expect(sessionController.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(sessionController.list).toHaveBeenCalled()
  })

  it('maps controller session/not-found onto session-not-found, not web-unreachable', async () => {
    const sessionController = controller({
      rename: async () => {
        throw remoteError('session/not-found', 'session missing')
      },
    })
    const client = new InProcessSessionClient({
      sessionController,
      sessions: store(),
      sessionPersistence: persistence(),
    })
    const failure = await client.rename('missing', { title: 'x' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionToolError).code).toBe('session-not-found')
  })

  it('maps controller session/title-invalid onto title-invalid', async () => {
    const sessionController = controller({
      rename: async () => {
        throw remoteError('session/title-invalid', 'bad title')
      },
    })
    const client = new InProcessSessionClient({
      sessionController,
      sessions: store(),
      sessionPersistence: persistence(),
    })
    const failure = await client.rename('session-1', { title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('propagates an unmapped remote error without turning it into web-unreachable', async () => {
    const boom = remoteError('internal', 'boom')
    const sessionController = controller({
      create: async () => {
        throw boom
      },
    })
    const client = new InProcessSessionClient({
      sessionController,
      sessions: store(),
      sessionPersistence: persistence(),
    })
    const failure = await client.durableCreate({ cwd: '/proj' }).catch((error: unknown) => error)
    expect(failure).toBe(boom)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
  })

  it('subagentPrompt fails loud when SubagentRuntime is not injected', async () => {
    const client = new InProcessSessionClient({
      sessionController: controller(),
      sessions: store(),
      sessionPersistence: persistence(),
    })
    await expect(client.subagentPrompt('root', 'child', 'go'))
      .rejects.toThrow(/ctx.subagents/)
  })

  it('subagentPrompt uses the injected runtime and does not fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const prompt = vi.fn(async () => ({ accepted: true }))
    const client = new InProcessSessionClient({
      sessionController: controller(),
      sessions: store(),
      sessionPersistence: persistence(),
      subagents: { prompt },
    })
    await expect(client.subagentPrompt('root', 'child', 'go')).resolves.toEqual({ accepted: true })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    }), expect.any(AbortSignal))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
