/**
 * HTTP client for the web gateway's session domain. Every session operation
 * of this provider goes through the gateway's fetch carrier
 * (`POST /api/session.*`, JSON envelopes), so sessions created, written, and
 * renamed here are the web process's own live sessions — published to every
 * GUI client through the ordinary event push. The carrier is the
 * host-apiproxy `AbstractApiClient`, imported through the `./client` subpath
 * so no host-side implementation is pulled into this headless process.
 *
 * rc.6 has no `session.durableCreate` / `session.wait`. This adapter keeps
 * the SessionHttpClient surface and maps those calls onto `session.create`
 * + `session.rename` and a `session.list` poll. parentSessionId, tags, and
 * delegationDepth have no create/rename field on rc.6 and are not sent.
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

/** Poll interval for the rc.6 wait substitute (`session.list` running bit). */
const WAIT_POLL_MS = 250

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
   * Create a durable session WITHOUT starting a turn. rc.6 `session.create`
   * only accepts workspace/cwd/sessionId/agentPreset; a requested title is
   * applied by a follow-up `session.rename`.
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
    return await this.invoke('session.create', async () => {
      const created = this.unwrap(await this.sessions.create({
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId as never },
        ...options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId as never },
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
      }))
      if (options.title === undefined) return { sessionId: created.sessionId }
      const renamed = this.unwrap(await this.sessions.rename({
        sessionId: created.sessionId,
        title: options.title,
      }))
      return { sessionId: created.sessionId, title: renamed.title }
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
   * Deliver a prompt to a continuable rc.6 subagent child. The gateway
   * rejects `session.prompt` on these sessions (`agent-busy`); the address
   * is the durable parent/child pair, not the session-only door.
   */
  async subagentPrompt(parentSessionId: string, childSessionId: string, content: string): Promise<{ accepted: true }> {
    return await this.invoke('subagent.prompt', async () => {
      const response = await this.subagents.prompt({
        parentSessionId: parentSessionId as never,
        childSessionId: childSessionId as never,
        mode: 'continuable',
        content: [{ type: 'text', text: content }],
      })
      this.unwrap(response)
      return { accepted: true }
    })
  }

  /**
   * Wait for a session's agent to settle. rc.6 has no `session.wait`; this
   * polls `session.list` `running` and reads the last `turn/end` from
   * `session.history`. A cold session settles immediately. `timeoutMs`
   * bounds the wait and reports `timeout` without error.
   */
  async wait(sessionId: string, options: {
    until?: 'idle' | 'turn-end'
    timeoutMs?: number
  } = {}): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout'
    lastTurnEndReason?: { kind: string }
  }> {
    return await this.invoke('session.list', async () => {
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

  /**
   * Rename a session. rc.6 `session.rename` accepts only `title`. Tags have
   * no RPC and are echoed in the result without a wire write (Step A).
   */
  async rename(sessionId: string, options: { title?: string; tags?: readonly string[] }): Promise<{
    title?: string
    tags?: readonly string[]
    seq: number
  }> {
    return await this.invoke('session.rename', async () => {
      if (options.title !== undefined) {
        const value = this.unwrap(await this.sessions.rename({
          sessionId: sessionId as never,
          title: options.title,
        }))
        return {
          title: value.title,
          ...options.tags === undefined ? {} : { tags: [...options.tags] },
          seq: value.seq,
        }
      }
      return {
        ...options.tags === undefined ? {} : { tags: [...options.tags] },
        seq: 0,
      }
    })
  }

  /** One list/history cut: undefined means the wait should keep polling. */
  private async settleFromGateway(sessionId: string, until: 'idle' | 'turn-end'): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted'
    lastTurnEndReason?: { kind: string }
  } | undefined> {
    const { items } = this.unwrap(await this.sessions.list({}))
    const running = items.find(item => item.sessionId === sessionId)?.running === true
    if (until === 'turn-end') {
      const reason = await this.readLastTurnEndReason(sessionId)
      if (reason === undefined) return running ? undefined : { status: 'idle' }
      return { status: statusFromTurnEnd(reason.kind), lastTurnEndReason: reason }
    }
    if (running) return undefined
    const reason = await this.readLastTurnEndReason(sessionId)
    if (reason === undefined) return { status: 'idle' }
    return { status: statusFromTurnEnd(reason.kind), lastTurnEndReason: reason }
  }

  /** Latest `turn/end` reason on the session log, or undefined if none/missing. */
  private async readLastTurnEndReason(sessionId: string): Promise<{ kind: string } | undefined> {
    const response = await this.sessions.history({ sessionId: sessionId as never })
    if (!response.result.ok && response.result.error.code === 'session-not-found') {
      return undefined
    }
    let found: { kind: string } | undefined
    for (const entry of this.unwrap(response).events) {
      const kind = turnEndKind(entry.event)
      if (kind !== undefined) found = { kind }
    }
    return found
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function statusFromTurnEnd(kind: string): 'completed' | 'failed' | 'aborted' {
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted' || kind === 'interrupted') return 'aborted'
  return 'failed'
}

function turnEndKind(event: { type: string; data?: unknown }): string | undefined {
  if (event.type !== 'turn/end') return undefined
  if (event.data === null || typeof event.data !== 'object') return undefined
  const kind = (event.data as { reason?: { kind?: unknown } }).reason?.kind
  return typeof kind === 'string' ? kind : undefined
}
