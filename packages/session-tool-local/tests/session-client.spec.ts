// SessionHttpClient: the full fetch-carrier round trip against a stubbed
// global fetch — durableCreate/prompt/list/rename payloads, ok/error
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

  it('durableCreate posts title, tags, lineage, and workspace to the gateway', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.href).toBe(`${BASE}/api/session.durableCreate`)
      expect(body.method).toBe('session.durableCreate')
      expect(body.payload).toEqual({
        title: 't',
        parentSessionId: 'caller',
        tags: ['a', 'b'],
        workspaceId: 'ws-1',
      })
      return okResponse(body.rpcId, { sessionId: 'session-9', title: 't', tags: ['a', 'b'] })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.durableCreate({
      title: 't',
      parentSessionId: 'caller',
      tags: ['a', 'b'],
      workspaceId: 'ws-1',
    })
    expect(result).toEqual({ sessionId: 'session-9', title: 't', tags: ['a', 'b'] })
    expect(fetchMock).toHaveBeenCalledOnce()
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

  it('rename posts title and tags and echoes the accepted values', async () => {
    const fetchMock = stubFetch((url, body) => {
      expect(url.pathname).toBe('/api/session.rename')
      expect(body.payload).toEqual({ sessionId: 'session-1', title: 'new', tags: ['x'] })
      return okResponse(body.rpcId, { title: 'new', tags: ['x'], seq: 7 })
    })
    const client = new SessionHttpClient(BASE)
    const result = await client.rename('session-1', { title: 'new', tags: ['x'] })
    expect(result).toEqual({ title: 'new', tags: ['x'], seq: 7 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('translates a title-invalid business error onto the seam code', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'title-invalid', 'bad title', { sessionId: 'session-1' }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('session-1', { title: '  ' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('title-invalid')
  })

  it('translates a tag-invalid business error onto the seam code', async () => {
    stubFetch((_url, body) => errorResponse(body.rpcId, 'tag-invalid', 'bad tags', { sessionId: 'session-1' }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.durableCreate({ tags: [''] }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect((failure as SessionToolError).code).toBe('tag-invalid')
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
