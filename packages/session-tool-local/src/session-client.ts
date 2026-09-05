/**
 * Authenticated HTTP client for the GUI process session domain. Unary calls
 * POST `/api/session/{create,prompt,cancel,rename,list}` with Connection
 * `{ args }` envelopes (ASM-003). Cookie auth is ASM-002. Wait uses
 * `session/list` running plus local persistence inspect for `turn/end`.
 * @module session-tool-local
 */

import { randomUUID } from 'node:crypto'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'
import {
  GatewayHttpRpc,
  HTTP_WIRE_CODES,
  throwGatewayFailure,
  type GatewayHttpRpcOptions,
} from './http-rpc.ts'
import { lastTurnEndReason, settleWait, type WaitEvent } from './wait-settle.ts'

/** Title field on a list projection block. */
function listRowTitle(values: unknown): string | undefined {
  if (values === undefined || values === null || typeof values !== 'object') return undefined
  if (!('title' in values)) return undefined
  const title = values.title
  return typeof title === 'string' ? title : undefined
}

/** One gateway session list row (wire SessionSummary + title projection). */
export interface SessionListRow {
  /** The session id. */
  readonly sessionId: string
  /** Durable parent lineage, when recorded. */
  readonly parentSessionId?: string
  /** The session's working directory, when recorded. */
  readonly cwd?: string
  /** Normalized title projection, when one has been accepted. */
  readonly title?: string
  /** Whether the web process currently runs a turn for this session. */
  readonly running: boolean
  /** Last-activity instant (ms). */
  readonly updatedAt: number
}

/** Result of {@link SessionHttpClient.durableCreate}. */
export interface DurableCreateResult {
  /** The created session id. */
  readonly sessionId: string
  /** The accepted title, when requested. */
  readonly title?: string
}

/**
 * Wire codes this client translates onto the session-tool seam.
 * Slash codes from 0.1.2 map to the existing hyphen vocabulary (BR-006).
 */
export const SESSION_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = HTTP_WIRE_CODES

/** Poll interval for the wait substitute (`session/list` running bit). */
const WAIT_POLL_MS = 250

/** Local inspect used by wait to read the last `turn/end` (BR-005). */
export type SessionInspectEvents = (sessionId: string) => Promise<readonly WaitEvent[] | undefined>

/** Options accepted beside a webUrl string constructor. */
export type SessionHttpClientOptions = Omit<GatewayHttpRpcOptions, 'webUrl'> & {
  /** Persistence inspect for wait turn/end; omitted treats every session as cold. */
  readonly inspectEvents?: SessionInspectEvents
}

/**
 * Cross-process session client. Token cookie exchange and unary POST live in
 * {@link GatewayHttpRpc}; this class owns session method payloads.
 */
export class SessionHttpClient {
  private readonly rpc: GatewayHttpRpc
  private readonly inspectEvents: SessionInspectEvents | undefined

  constructor(webUrlOrRpc: string | GatewayHttpRpc, options?: SessionHttpClientOptions) {
    this.inspectEvents = options?.inspectEvents
    this.rpc = typeof webUrlOrRpc === 'string'
      ? new GatewayHttpRpc({ webUrl: webUrlOrRpc, ...options })
      : webUrlOrRpc
  }

  /**
   * Create a durable session WITHOUT starting a turn. A requested title is
   * applied by a follow-up `session/rename`. Lineage fields are not sent.
   */
  async durableCreate(options: {
    sessionId?: string
    title?: string
    parentSessionId?: string
    workspaceId?: string
    cwd?: string
    delegationDepth?: number
  }): Promise<DurableCreateResult> {
    return await this.invoke('session/create', async () => {
      const created = await this.call<{ sessionId: string }>('session/create', {
        request: {
          ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
          ...options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId },
          ...options.cwd === undefined ? {} : { cwd: options.cwd },
        },
      })
      if (options.title === undefined) return { sessionId: created.sessionId }
      const renamed = await this.call<{ title: string; seq: number }>('session/rename', {
        request: { sessionId: created.sessionId, title: options.title },
      })
      return { sessionId: created.sessionId, title: renamed.title }
    })
  }

  /**
   * Admit one queued text prompt. Settles when the gateway accepts the
   * message; the reply streams through the ordinary session event push.
   */
  async prompt(sessionId: string, content: string): Promise<{ accepted: true }> {
    return await this.invoke('session/prompt', async () => {
      return await this.call<{ accepted: true }>('session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: content }],
        },
      })
    })
  }

  /**
   * Deliver a prompt to a continuable subagent child via `subagents/prompt`.
   */
  async subagentPrompt(parentSessionId: string, childSessionId: string, content: string): Promise<{ accepted: true }> {
    return await this.invoke('subagents/prompt', async () => {
      await this.call('subagents/prompt', {
        request: {
          requestId: randomUUID(),
          parentSessionId,
          childSessionId,
          mode: 'continuable',
          content: [{ type: 'text', text: content }],
        },
      })
      return { accepted: true }
    })
  }

  /**
   * Wait for a session's agent to settle. Polls `session/list` `running`
   * and reads the last `turn/end` from local persistence inspect. A cold
   * session with no turn/end is `idle`. `timeoutMs` reports `timeout`
   * without error.
   */
  async wait(sessionId: string, options: {
    until?: 'idle' | 'turn-end'
    timeoutMs?: number
  } = {}): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout'
    lastTurnEndReason?: { kind: string }
  }> {
    return await this.invoke('session/list', async () => {
      const deadline = options.timeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() + options.timeoutMs
      const until = options.until ?? 'idle'
      for (;;) {
        const settled = await this.settleFromGateway(sessionId, until)
        if (settled !== undefined) return settled
        if (Date.now() >= deadline) return { status: 'timeout' }
        await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())))
        if (Date.now() >= deadline) return { status: 'timeout' }
      }
    })
  }

  /** Cancel a session's active turn; pending inbox work is preserved. */
  async cancel(sessionId: string): Promise<{ accepted: true }> {
    return await this.invoke('session/cancel', async () => {
      return await this.call<{ accepted: true }>('session/cancel', {
        request: { sessionId },
      })
    })
  }

  /** List every served session with title projection (`session/list`). */
  async list(): Promise<readonly SessionListRow[]> {
    return await this.invoke('session/list', async () => {
      const { items } = await this.call<{ items: readonly Record<string, unknown>[] }>('session/list', {
        _request: {},
      })
      return items.map((item): SessionListRow => {
        const title = listRowTitle(
          isRecord(item.projections) ? item.projections.values : undefined,
        )
        return {
          sessionId: String(item.sessionId),
          ...typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {},
          ...typeof item.cwd === 'string' ? { cwd: item.cwd } : {},
          ...title === undefined ? {} : { title },
          running: item.running === true,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        }
      })
    })
  }

  /** Rename a session (`session/rename`, title only). */
  async rename(sessionId: string, options: { title: string }): Promise<{
    title?: string
    seq: number
  }> {
    return await this.invoke('session/rename', async () => {
      const value = await this.call<{ title: string; seq: number }>('session/rename', {
        request: { sessionId, title: options.title },
      })
      return { title: value.title, seq: Number(value.seq) }
    })
  }

  /** One list cut: undefined means the wait should keep polling. */
  private async settleFromGateway(sessionId: string, until: 'idle' | 'turn-end'): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted'
    lastTurnEndReason?: { kind: string }
  } | undefined> {
    const items = await this.list()
    const running = items.find(item => item.sessionId === sessionId)?.running === true
    return settleWait({
      running,
      lastTurnEndReason: await this.readLastTurnEndReason(sessionId),
      until,
    })
  }

  /** Latest `turn/end` reason from local inspect; missing inspect is cold. */
  private async readLastTurnEndReason(sessionId: string): Promise<{ kind: string } | undefined> {
    const inspect = this.inspectEvents
    if (inspect === undefined) return undefined
    try {
      const events = await inspect(sessionId)
      return events === undefined ? undefined : lastTurnEndReason(events)
    } catch {
      return undefined
    }
  }

  private async call<V>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<V> {
    const result = await this.rpc.call<V>(endpoint, args)
    if (result.ok) return result.value
    throwGatewayFailure(endpoint, result.error)
  }

  private async invoke<V>(method: string, call: () => Promise<V>): Promise<V> {
    try {
      return await call()
    } catch (error: unknown) {
      if (error instanceof SessionToolError) throw error
      throw new SessionWebUnreachableError(
        `web gateway unreachable for ${method}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
