/**
 * HTTP client for the web gateway's session domain. Every session operation
 * of this provider goes through the gateway's fetch carrier
 * (`POST /api/session.*`, JSON envelopes), so sessions created, written, and
 * renamed here are the web process's own live sessions — published to every
 * GUI client through the ordinary event push. The carrier is the
 * host-apiproxy `AbstractApiClient`, imported through the `./client` subpath
 * so no host-side implementation is pulled into this headless process.
 *
 * Transport failures surface as `SessionWebUnreachableError`; the gateway's
 * business errors surface as `SessionToolError` with the wire code.
 * @module session-tool-local
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'
// Side-effect type imports: resolve the title/tags projection keys onto the
// merge-extensible SessionProjectionMap this client reads.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-tags'

/** One gateway session list row (wire SessionSummary + title/tags projections). */
export interface SessionListRow {
  /** The session id. */
  readonly sessionId: string
  /** Durable parent lineage, when recorded. */
  readonly parentSessionId?: string
  /** The session's working directory, when recorded. */
  readonly cwd?: string
  /** Normalized title projection, when one has been accepted. */
  readonly title?: string
  /** Normalized tag set projection, when one has been accepted. */
  readonly tags?: readonly string[]
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
  /** The accepted tag set, when requested. */
  readonly tags?: readonly string[]
}

/** Wire codes this client translates onto the session-tool seam. */
const SESSION_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = {
  'session-not-found': 'session-not-found',
  'title-invalid': 'title-invalid',
  'tag-invalid': 'tag-invalid',
  'workspace-not-found': 'workspace-not-found',
}

/**
 * The session gateway client: an `AbstractApiClient` subclass whose only
 * aspects are the transport (global fetch) and the base URL (the configured
 * web gateway).
 */
export class SessionHttpClient extends AbstractApiClient {
  /** @param webUrl - the web gateway base URL (e.g. `http://127.0.0.1:3080`). */
  constructor(private readonly webUrl: string, timeoutMs?: number) {
    super(timeoutMs)
    new URL(webUrl)
  }

  /** Transport aspect: plain global fetch. */
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  /** Base URL aspect: every request targets the configured gateway. */
  protected override resolveBase(): string {
    return this.webUrl
  }

  /**
   * Create a durable session WITHOUT starting an agent: the session lands in
   * the web process's live store (published to every GUI client) and is
   * flushed to persistence. A later `prompt` resumes it into a conversation.
   */
  async durableCreate(options: {
    sessionId?: string
    title?: string
    parentSessionId?: string
    tags?: readonly string[]
    workspaceId?: string
    cwd?: string
    delegationDepth?: number
  }): Promise<DurableCreateResult> {
    return await this.invoke('session.durableCreate', async () => {
      const response = await this.sessions.durableCreate({
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId as never },
        ...options.title === undefined ? {} : { title: options.title },
        ...options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId as never },
        ...options.tags === undefined ? {} : { tags: [...options.tags] },
        ...options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId as never },
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
        ...options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth },
      })
      const value = this.unwrap(response)
      return {
        sessionId: value.sessionId,
        ...value.title === undefined ? {} : { title: value.title },
        ...value.tags === undefined ? {} : { tags: [...value.tags] },
      }
    })
  }

  /**
   * Send one prompt: the web process resumes the session's agent (creating
   * it from the durable log on first touch) and delivers the message into
   * the conversation loop. The reply streams back through the gateway's
   * event push; this call settles when the message is admitted.
   * @param sessionId - target session.
   * @param content - non-empty prompt text.
   * @returns the admission result.
   */
  async prompt(sessionId: string, content: string): Promise<{ accepted: true }> {
    return await this.invoke('session.prompt', async () => {
      const response = await this.sessions.prompt({
        sessionId: sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      })
      return this.unwrap(response)
    })
  }

  /**
   * Wait for a session's agent to settle, then report its terminal status.
   * Single-session semantics: the wait never follows descendants. `until`
   * selects the settle point (`idle` by default); `timeoutMs` bounds the wait
   * and reports `timeout` without error. A cold session (no live agent) is
   * reported from its log and settles immediately.
   * @param sessionId - target session.
   * @param options - optional settle point and deadline.
   * @returns the terminal status and the last turn-end reason kind, when one
   *   has ended.
   */
  async wait(sessionId: string, options: {
    until?: 'idle' | 'turn-end'
    timeoutMs?: number
  } = {}): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout'
    lastTurnEndReason?: { kind: string }
  }> {
    return await this.invoke('session.wait', async () => {
      const response = await this.sessions.wait({
        sessionId: sessionId as never,
        ...options.until === undefined ? {} : { until: options.until },
        ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      })
      const value = this.unwrap(response)
      return {
        status: value.status,
        ...value.lastTurnEndReason === undefined ? {} : { lastTurnEndReason: value.lastTurnEndReason },
      }
    })
  }

  /**
   * Cancel a session's active turn, preserving pending inbox work that
   * resumes in FIFO order after cancellation settles. The session is kept,
   * never deleted.
   * @param sessionId - target session.
   * @returns the admission result.
   */
  async cancel(sessionId: string): Promise<{ accepted: true }> {
    return await this.invoke('session.cancel', async () => {
      const response = await this.sessions.cancel({ sessionId: sessionId as never })
      return this.unwrap(response)
    })
  }

  /** List every served session (web view: cwd-bearing sessions) with title/tags projections. */
  async list(): Promise<readonly SessionListRow[]> {
    return await this.invoke('session.list', async () => {
      const response = await this.sessions.list({})
      const { items } = this.unwrap(response)
      return items.map((item): SessionListRow => {
        const values = item.projections?.values
        return {
          sessionId: item.sessionId,
          ...item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId },
          ...item.cwd === undefined ? {} : { cwd: item.cwd },
          ...values?.title === undefined || values.title === null ? {} : { title: values.title },
          ...values?.tags === undefined || values.tags === null ? {} : { tags: [...values.tags] },
          running: item.running,
          updatedAt: item.updatedAt,
        }
      })
    })
  }

  /** Rename a session and/or replace its tag set (at least one required). */
  async rename(sessionId: string, options: { title?: string; tags?: readonly string[] }): Promise<{
    title?: string
    tags?: readonly string[]
    seq: number
  }> {
    return await this.invoke('session.rename', async () => {
      const response = await this.sessions.rename({
        sessionId: sessionId as never,
        ...options.title === undefined ? {} : { title: options.title },
        ...options.tags === undefined ? {} : { tags: [...options.tags] },
      })
      const value = this.unwrap(response)
      return {
        ...value.title === undefined ? {} : { title: value.title },
        ...value.tags === undefined ? {} : { tags: [...value.tags] },
        seq: value.seq,
      }
    })
  }

  /**
   * Run one gateway call, translating every failure onto the session-tool
   * seam: business errors with a known wire code keep that code; anything
   * else becomes `SessionWebUnreachableError`.
   */
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

  /** Narrow an RpcResponse to its value, translating a business failure. */
  private unwrap<V>(response: RpcResponse<V>): V {
    if (response.result.ok) return response.result.value
    const error = response.result.error
    const mapped = SESSION_WIRE_CODES[error.code]
    if (mapped !== undefined) {
      throw new SessionToolError(error.message, mapped, { cause: error })
    }
    throw new SessionWebUnreachableError(
      `web gateway rejected the session call: ${error.code}: ${error.message}`,
      { cause: error },
    )
  }
}
