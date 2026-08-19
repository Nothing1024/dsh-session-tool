// SessionHttpClient: the full fetch-carrier round trip against a stubbed
// global fetch — rc.7 create/rename/list/history/prompt payloads, ok/error
// narrowing, projection folding, and the failure mapping onto the
// session-tool error seam.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import { SessionHttpClient } from '../src/session-client.ts'

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

function stubFetch(handler: (url: URL, body: { rpcId: string; method: string; payload: unknown }) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as { rpcId: string; method: string; payload: unknown }
    return await handler(url, body)
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

const BASE = 'http://127.0.0.1:3180'

describe('SessionHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('durableCreate posts create then rename; drops tags and lineage', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((url, body) => {
      methods.push(body.method)
      if (body.method === 'session.create') {
        expect(url.href).toBe(`${BASE}/api/session.create`)
        expect(body.payload).toEqual({ workspaceId: 'ws-1' })
        return okResponse(body.rpcId, { sessionId: 'session-9' })
      }
      expect(url.href).toBe(`${BASE}/api/session.rename`)
      expect(body.payload).toEqual({ sessionId: 'session-9', title: 't' })
      return okResponse(body.rpcId, { title: 't', seq: 1 })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.durableCreate({
      title: 't',
      parentSessionId: 'caller',
      tags: ['a', 'b'],
      workspaceId: 'ws-1',
      delegationDepth: 1,
    })
    expect(result).toEqual({ sessionId: 'session-9', title: 't' })
    expect(methods).toEqual(['session.create', 'session.rename'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('durableCreate posts a bare cwd request when nothing optional is given', async () => {
    const fetchMock = stubFetch((_url, body) => {
      expect(body.payload).toEqual({ cwd: '/proj' })
      return okResponse(body.rpcId, { sessionId: 'session-9' })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.durableCreate({ cwd: '/proj' })
    expect(result.sessionId).toBe('session-9')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('prompt sends the content as a queued text message', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session.prompt')
      expect(body.payload).toEqual({
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
      expect(url.pathname).toBe('/api/subagent.prompt')
      expect(body.payload).toEqual({
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

  it('wait polls list then history and maps a completed turn/end', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((_url, body) => {
      methods.push(body.method)
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      expect(body.method).toBe('session.history')
      expect(body.payload).toEqual({ sessionId: 'session-1' })
      return okResponse(body.rpcId, {
        events: [{ event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } }],
        hasMore: false,
      })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { until: 'idle', timeoutMs: 5000 })
    expect(result).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
    expect(methods).toEqual(['session.list', 'session.history'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('wait reports timeout when the session is still running and the deadline is 0', async () => {
    const fetchMock = stubFetch((_url, body) => {
      expect(body.method).toBe('session.list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: true })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { timeoutMs: 0 })
    expect(result).toEqual({ status: 'timeout' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancel posts the session id and echoes the admission', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session.cancel')
      expect(body.payload).toEqual({ sessionId: 'session-1' })
      return okResponse(body.rpcId, { accepted: true })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.cancel('session-1')
    expect(result).toEqual({ accepted: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('list folds title/tags projections onto the rows', async () => {
    stubFetch((_url, body) => okResponse(body.rpcId, {
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
    }))
    const client = new SessionHttpClient(BASE)
    const rows = await client.list()
    expect(rows).toEqual([
      {
        sessionId: 'session-1',
        parentSessionId: 'caller',
        cwd: '/proj',
        title: 'named',
        tags: ['a', 'b'],
        running: false,
        updatedAt: 1_700_000_000_000,
      },
      { sessionId: 'session-2', running: false, updatedAt: 1_700_000_000_000 },
    ])
  })

  it('rename posts only the title and echoes tags locally', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session.rename')
      expect(body.payload).toEqual({ sessionId: 'session-1', title: 'new' })
      return okResponse(body.rpcId, { title: 'new', seq: 7 })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.rename('session-1', { title: 'new', tags: ['x'] })
    expect(result).toEqual({ title: 'new', tags: ['x'], seq: 7 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rename with tags only does not call the gateway', async () => {
    const fetchMock = stubFetch(() => {
      throw new Error('unexpected gateway call')
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.rename('session-1', { tags: ['x'] })
    expect(result).toEqual({ tags: ['x'], seq: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('translates a title-invalid business error onto the seam code', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'title-invalid', 'bad title', { sessionId: 'session-1' }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('session-1', { title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('translates a title-invalid error from the create follow-up rename', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.create') {
        return okResponse(body.rpcId, { sessionId: 'session-9' })
      }
      return errorResponse(body.rpcId, 'title-invalid', 'bad title', { sessionId: 'session-9' })
    })
    const client = new SessionHttpClient(BASE)
    const failure = await client.durableCreate({ title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('wait reports idle when the session is not running and has no turn/end', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return okResponse(body.rpcId, { events: [], hasMore: false })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'idle' })
  })

  it('wait maps an aborted turn/end onto aborted', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return okResponse(body.rpcId, {
        events: [{ event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'aborted' } } } }],
        hasMore: false,
      })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'aborted', lastTurnEndReason: { kind: 'aborted' } })
  })

  it('wait maps an unknown turn/end kind onto failed', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return okResponse(body.rpcId, {
        events: [{ event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'blocked' } } } }],
        hasMore: false,
      })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'failed', lastTurnEndReason: { kind: 'blocked' } })
  })

  it('wait until turn-end returns idle when the session is cold', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return okResponse(body.rpcId, { events: [], hasMore: false })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { until: 'turn-end', timeoutMs: 0 })
    expect(result).toEqual({ status: 'idle' })
  })

  it('wait treats a session-not-found history as no turn/end', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return errorResponse(body.rpcId, 'session-not-found', 'missing', { sessionId: 'session-1' })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'idle' })
  })

  it('wait until turn-end settles on a reason even while running', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: true })] })
      }
      return okResponse(body.rpcId, {
        events: [{ event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'interrupted' } } } }],
        hasMore: false,
      })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { until: 'turn-end', timeoutMs: 1000 })
    expect(result).toEqual({ status: 'aborted', lastTurnEndReason: { kind: 'interrupted' } })
  })

  it('wait sleeps then times out while the session stays running', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session.list')
      return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: true })] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.wait('session-1', { timeoutMs: 20 })
    expect(result).toEqual({ status: 'timeout' })
  })

  it('wait ignores a turn/end event with a non-object payload', async () => {
    stubFetch((_url, body) => {
      if (body.method === 'session.list') {
        return okResponse(body.rpcId, { items: [summary({ sessionId: 'session-1', running: false })] })
      }
      return okResponse(body.rpcId, {
        events: [
          { event: { type: 'user/message', seq: 1, time: 1, data: {} } },
          { event: { type: 'turn/end', seq: 2, time: 1, data: null } },
        ],
        hasMore: false,
      })
    })
    const client = new SessionHttpClient(BASE)
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
