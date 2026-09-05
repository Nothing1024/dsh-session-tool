/**
 * Authenticated Connection unary RPC (ASM-002 / ASM-003): GET /?token= with
 * redirect:manual to harvest 303 Set-Cookie, then POST /api/{endpoint} with
 * payload `{ args }`. 401/403 become web-unreachable. Does not read
 * `.credentials.yaml`.
 * @module session-tool-local
 */

import { randomUUID } from 'node:crypto'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'

/** Slash/hyphen Remote codes mapped onto the session-tool hyphen seam (BR-006). */
export const HTTP_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = {
  'session/not-found': 'session-not-found',
  'session-not-found': 'session-not-found',
  'session/title-invalid': 'title-invalid',
  'title-invalid': 'title-invalid',
  'tag-invalid': 'tag-invalid',
  'workspace/not-found': 'workspace-not-found',
  'workspace-not-found': 'workspace-not-found',
  'workspace/name-conflict': 'workspace-name-conflict',
  'workspace-name-conflict': 'workspace-name-conflict',
  'workspace/invalid-path': 'workspace-invalid-path',
  'workspace-invalid-path': 'workspace-invalid-path',
}

/** Connection unary result after envelope unwrap. */
export type GatewayRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Injected opener for one Remote stream item (workspace/follow baseline). */
export type GatewayStreamOpener = (input: {
  readonly muxUrl: URL
  readonly cookie: string
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}) => Promise<unknown>

/** Options for {@link GatewayHttpRpc}. */
export interface GatewayHttpRpcOptions {
  /** Web gateway base URL (`Config.webUrl`); cookie is bound to this host:port. */
  readonly webUrl: string
  /** Launch token from `DSH_LAUNCH_TOKEN` or CLI `--token`. */
  readonly launchToken?: string
  /** Unary timeout in milliseconds; omitted calls have no transport deadline. */
  readonly timeoutMs?: number
  /** Test seam for workspace/follow; production uses `/api/remote.mux`. */
  readonly openStream?: GatewayStreamOpener
}

const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/**
 * One Connection HTTP session: token→cookie exchange once, then unary POSTs
 * and a follow-first-item-then-cancel stream helper.
 */
export class GatewayHttpRpc {
  private readonly origin: URL
  private readonly launchToken: string | undefined
  private readonly timeoutMs: number | undefined
  private readonly openStream: GatewayStreamOpener
  private cookie: string | undefined
  private cookieExchange: Promise<void> | undefined

  constructor(options: GatewayHttpRpcOptions) {
    this.origin = new URL(options.webUrl)
    const token = options.launchToken ?? process.env.DSH_LAUNCH_TOKEN
    this.launchToken = token === undefined || token === '' ? undefined : token
    this.timeoutMs = options.timeoutMs
    this.openStream = options.openStream ?? openMuxFirstItem
  }

  /** Origin used for every request (host:port must match the cookie audience). */
  get webUrl(): string {
    return this.origin.href
  }

  /**
   * POST `/api/{endpoint}` with Connection envelope `{ type, rpcId, method, payload: { args } }`.
   */
  async call<T>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<GatewayRpcResult<T>> {
    await this.ensureCookie()
    const rpcId = randomUUID()
    const message = {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }
    const url = new URL(`/api/${endpoint}`, this.origin)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.cookie === undefined ? {} : { cookie: this.cookie },
        },
        body: JSON.stringify(message),
        redirect: 'error',
        ...this.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.timeoutMs) },
      })
    } catch (error: unknown) {
      throw unreachable(endpoint, error)
    }
    if (response.status === 401 || response.status === 403) {
      throw unreachable(endpoint, new Error(`HTTP ${response.status}`))
    }
    if (!response.ok) {
      throw unreachable(endpoint, new Error(`HTTP ${response.status}`))
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      throw unreachable(endpoint, error)
    }
    return parseServerResponse<T>(endpoint, rpcId, body)
  }

  /**
   * Open `workspace/follow` (or another stream endpoint), take the first item,
   * then cancel. Used to read the workspace baseline without a unary list.
   */
  async followFirst(endpoint: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    await this.ensureCookie()
    const muxUrl = new URL(REMOTE_STREAM_MUX_PATH, this.origin)
    muxUrl.protocol = this.origin.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      return await this.openStream({
        muxUrl,
        cookie: this.cookie ?? '',
        endpoint,
        args,
      })
    } catch (error: unknown) {
      if (error instanceof SessionToolError) throw error
      if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
        throwGatewayFailure(endpoint, { code: error.code, message: error.message })
      }
      throw unreachable(endpoint, error)
    }
  }

  /** Exchange `GET /?token=` for the 303 Set-Cookie; skipped when no token. */
  private async ensureCookie(): Promise<void> {
    if (this.cookie !== undefined || this.launchToken === undefined) return
    if (this.cookieExchange !== undefined) return this.cookieExchange
    this.cookieExchange = this.exchangeCookie().finally(() => {
      this.cookieExchange = undefined
    })
    return this.cookieExchange
  }

  private async exchangeCookie(): Promise<void> {
    const token = this.launchToken
    if (token === undefined) return
    const url = new URL('/', this.origin)
    url.search = ''
    url.searchParams.set('token', token)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
      })
    } catch (error: unknown) {
      throw unreachable('GET /?token=', error)
    }
    if (response.status === 401 || response.status === 403) {
      throw unreachable('GET /?token=', new Error(`HTTP ${response.status}`))
    }
    if (response.status !== 303) {
      throw unreachable('GET /?token=', new Error(`HTTP ${response.status}`))
    }
    const cookie = cookieHeaderFromSetCookie(response.headers)
    if (cookie !== undefined) this.cookie = cookie
  }
}

/** Map a Connection business code onto the hyphen seam, or undefined if unlisted. */
export function mapHttpWireCode(code: string): SessionToolErrorCode | undefined {
  return HTTP_WIRE_CODES[code]
}

/** Throw a seam error for a known wire code, else web-unreachable (401/transport stay unreachable). */
export function throwGatewayFailure(method: string, error: { readonly code: string; readonly message: string }): never {
  const mapped = mapHttpWireCode(error.code)
  if (mapped !== undefined) {
    throw new SessionToolError(error.message, mapped, { cause: error })
  }
  throw new SessionWebUnreachableError(
    `web gateway rejected the ${method} call: ${error.code}: ${error.message}`,
    { cause: error },
  )
}

function unreachable(method: string, error: unknown): SessionWebUnreachableError {
  if (error instanceof SessionWebUnreachableError) return error
  return new SessionWebUnreachableError(
    `web gateway unreachable for ${method}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}

function cookieHeaderFromSetCookie(headers: Headers): string | undefined {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : []
  const lines = cookies.length > 0
    ? cookies
    : [headers.get('set-cookie')].filter((line): line is string => line !== null && line !== '')
  const pairs = lines.map(line => line.split(';', 1)[0]?.trim()).filter((pair): pair is string => pair !== undefined && pair !== '')
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

function parseServerResponse<T>(endpoint: string, rpcId: string, value: unknown): GatewayRpcResult<T> {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw unreachable(endpoint, new TypeError('invalid server-response envelope'))
  }
  if (value.rpcId !== rpcId) {
    throw unreachable(endpoint, new Error(`rpcId mismatch: sent ${rpcId}, got ${value.rpcId}`))
  }
  const result = value.result
  if (!isRecord(result)) {
    throw unreachable(endpoint, new TypeError('invalid server-response result'))
  }
  if (result.ok === true) {
    return { ok: true, value: result.value as T }
  }
  if (result.ok !== false || !isRecord(result.error)) {
    throw unreachable(endpoint, new TypeError('invalid server-response result'))
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw unreachable(endpoint, new TypeError('invalid server-response failure'))
  }
  const details = isRecord(error.details) ? error.details : {}
  return { ok: false, error: { code: error.code, message: error.message, details } }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type WebSocketInit = { readonly headers?: Record<string, string> }

/** Open `/api/remote.mux`, read the first item, cancel the logical stream. */
async function openMuxFirstItem(input: {
  readonly muxUrl: URL
  readonly cookie: string
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}): Promise<unknown> {
  const WebSocketCtor = globalThis.WebSocket as unknown as {
    new (url: string | URL, init?: WebSocketInit): WebSocket
  }
  const streamId = randomUUID()
  const ws = new WebSocketCtor(input.muxUrl, {
    ...input.cookie === '' ? {} : { headers: { Cookie: input.cookie } },
  })
  try {
    await waitOpen(ws)
    ws.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: input.endpoint,
      payload: { args: input.args },
    }))
    const frame = await waitFirstFrame(ws, streamId)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel', streamId }))
    }
    return frame
  } finally {
    ws.close()
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      cleanup()
      reject(new Error('HTTP 401'))
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

function waitFirstFrame(ws: WebSocket, streamId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      cleanup()
      reject(new Error('HTTP 401'))
    }
    const onMessage = (event: MessageEvent): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch (error: unknown) {
        cleanup()
        reject(error)
        return
      }
      if (!isRecord(parsed) || parsed.streamId !== streamId) return
      if (parsed.type === 'item') {
        cleanup()
        resolve(parsed.value)
        return
      }
      if (parsed.type === 'error' && isRecord(parsed.error) && typeof parsed.error.code === 'string') {
        cleanup()
        const message = typeof parsed.error.message === 'string' ? parsed.error.message : parsed.error.code
        reject({ code: parsed.error.code, message })
        return
      }
      if (parsed.type === 'end') {
        cleanup()
        reject(new Error('stream ended before baseline'))
      }
    }
    const cleanup = (): void => {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', onError)
  })
}
