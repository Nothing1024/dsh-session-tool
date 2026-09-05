// Task 7 verification: 303 cookie harvest (redirect:manual), 401/403 →
// web-unreachable, session/not-found slash code stays session-not-found.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import { SessionHttpClient } from '../src/session-client.ts'
import { SESSION_WIRE_CODES } from '../src/session-client.ts'
import { HTTP_WIRE_CODES } from '../src/http-rpc.ts'

const BASE = 'http://127.0.0.1:3180'
const COOKIE_PAIR = 'dsh-auth-abc=v1.payload.sig'

function okResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(rpcId: string, code: string, message: string): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: {} } },
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

describe('HTTP auth + slash-code mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DSH_LAUNCH_TOKEN
  })

  it('maps the required slash codes onto hyphen seam codes', () => {
    expect(HTTP_WIRE_CODES['session/not-found']).toBe('session-not-found')
    expect(HTTP_WIRE_CODES['session/title-invalid']).toBe('title-invalid')
    expect(HTTP_WIRE_CODES['workspace/not-found']).toBe('workspace-not-found')
    expect(HTTP_WIRE_CODES['workspace/name-conflict']).toBe('workspace-name-conflict')
    expect(HTTP_WIRE_CODES['workspace/invalid-path']).toBe('workspace-invalid-path')
    expect(SESSION_WIRE_CODES['session/not-found']).toBe('session-not-found')
  })

  it('maps unauthenticated POST 401 to web-unreachable', async () => {
    const inits: RequestInit[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init !== undefined) inits.push(init)
      return new Response('unauthorized', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SessionHttpClient(BASE)
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(headerOf(inits[0], 'cookie')).toBeUndefined()
  })

  it('maps POST 403 to web-unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    const client = new SessionHttpClient(BASE)
    const failure = await client.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionWebUnreachableError).code).toBe('web-unreachable')
  })

  it('maps session/not-found onto [session-not-found] and does not swallow as web-unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return errorResponse(body.rpcId, 'session/not-found', 'session missing')
    }))
    const client = new SessionHttpClient(BASE)
    const failure = await client.rename('missing', { title: 'x' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionToolError)
    expect(failure).not.toBeInstanceOf(SessionWebUnreachableError)
    expect((failure as SessionToolError).code).toBe('session-not-found')
  })

  it('GET /?token= uses redirect:manual, harvests 303 Set-Cookie, and POSTs the same Cookie', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
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
      expect(url.pathname).toBe('/api/session/list')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).not.toBe('follow')
      expect(headerOf(init, 'cookie')).toBe(COOKIE_PAIR)
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      expect(body.method).toBe('session/list')
      expect(body.payload).toEqual({ args: { _request: {} } })
      return okResponse(body.rpcId, { items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SessionHttpClient(BASE, { launchToken: 'launch-token-1' })
    const rows = await client.list()
    expect(rows).toEqual([])
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

  it('reads DSH_LAUNCH_TOKEN when constructor omits launchToken', async () => {
    process.env.DSH_LAUNCH_TOKEN = 'from-env'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/') {
        expect(url.searchParams.get('token')).toBe('from-env')
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': `${COOKIE_PAIR}; Path=/` },
        })
      }
      expect(headerOf(init, 'cookie')).toBe(COOKIE_PAIR)
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return okResponse(body.rpcId, { items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SessionHttpClient(BASE)
    await client.list()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
