/**
 * ASM-001 transport selector: in-process vs authenticated HTTP.
 *
 * Auto is in-process only when both controllers exist AND Config.webUrl
 * host:port equals this process's webServer listen address. CLI headless
 * with its own controllers still goes HTTP when webUrl points at the GUI.
 * Explicit in-process (or auto when the listen address matches) without
 * controllers fails loud — never a silent HTTP self-loop.
 * @module session-tool-local
 */

/** Configured transport; `auto` is the default. */
export type TransportMode = 'in-process' | 'http' | 'auto'

/** Resolved client kind after {@link selectTransport}. */
export type ResolvedTransport = 'in-process' | 'http'

/** Inputs the selector reads off Config + ctx.get. */
export interface TransportSelectionInput {
  /** Configured transport; omitted is `auto`. */
  readonly transport?: TransportMode
  /** GUI authority URL (`Config.webUrl`). */
  readonly webUrl: string
  /** `ctx.sessionController`, when the web-app tree injected one. */
  readonly sessionController: unknown
  /** `ctx.workspaceController`, when the web-app tree injected one. */
  readonly workspaceController: unknown
  /** `ctx.webServer`, when this process is the HTTP carrier. */
  readonly webServer: unknown
}

/** One host:port pair used for ASM-001 equality. */
export interface HostPort {
  readonly host: string
  readonly port: number
}

/**
 * Pick in-process or HTTP. Throws when in-process is required but either
 * controller is missing (fail loud, no HTTP fallback).
 */
export function selectTransport(input: TransportSelectionInput): ResolvedTransport {
  const transport = input.transport ?? 'auto'
  const hasControllers = isPresent(input.sessionController) && isPresent(input.workspaceController)
  if (transport === 'http') return 'http'
  if (transport === 'in-process') {
    if (!hasControllers) throw inProcessMissingControllersError()
    return 'in-process'
  }
  const listen = webServerListen(input.webServer)
  const target = hostPortOfUrl(input.webUrl)
  if (listen !== undefined && hostPortEquals(target, listen)) {
    if (!hasControllers) throw inProcessMissingControllersError()
    return 'in-process'
  }
  return 'http'
}

/** Fail-loud error when in-process was selected without both controllers. */
export function inProcessMissingControllersError(): Error {
  return new Error(
    'session-tool-local transport in-process requires ctx.sessionController and ctx.workspaceController; refusing HTTP loopback',
  )
}

/** Parse Config.webUrl into hostname + port (http 80 / https 443 defaults). */
export function hostPortOfUrl(webUrl: string): HostPort {
  const url = new URL(webUrl)
  const port = url.port === ''
    ? (url.protocol === 'https:' ? 443 : 80)
    : Number(url.port)
  return { host: url.hostname, port }
}

/**
 * Read the process listen address from a webServer-shaped value.
 * Missing, not-yet-bound (port 0), or malformed values are "no listen".
 */
export function webServerListen(webServer: unknown): HostPort | undefined {
  if (webServer === undefined || webServer === null || typeof webServer !== 'object') return undefined
  if (!('host' in webServer) || !('port' in webServer)) return undefined
  const host = webServer.host
  const port = webServer.port
  if (typeof host !== 'string' || host === '') return undefined
  if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) return undefined
  return { host, port }
}

/**
 * Whether advertised webUrl host:port is this process's listen address.
 * A wildcard listen (`0.0.0.0` / `::`) matches any hostname on that port.
 * `localhost` and `127.0.0.1` are the same loopback.
 */
export function hostPortEquals(webUrl: HostPort, listen: HostPort): boolean {
  if (webUrl.port !== listen.port) return false
  if (isWildcardListen(listen.host)) return true
  return canonicalHost(webUrl.host) === canonicalHost(listen.host)
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null
}

function canonicalHost(host: string): string {
  const trimmed = host.trim().toLowerCase()
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed
  if (unbracketed === 'localhost' || unbracketed === '::1') return '127.0.0.1'
  return unbracketed
}

function isWildcardListen(host: string): boolean {
  const canonical = canonicalHost(host)
  return canonical === '0.0.0.0' || canonical === '::'
}
