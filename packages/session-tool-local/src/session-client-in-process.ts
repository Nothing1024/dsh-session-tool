/**
 * In-process session client: create/prompt/cancel/rename/list go through
 * `ctx.sessionController` on the GUI web-app tree (BR-002 / INV-003). Wait
 * reads `running` from controller.list and the last `turn/end` from
 * `sessions.get(id).snapshotEvents()` or `sessionPersistence.inspect`.
 *
 * Do not construct this from the CLI (BR-003): that would write the CLI's
 * own store instead of the GUI process. Task 8's transport selector keeps
 * CLI on HTTP.
 * @module session-tool-local
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { invokeInProcess } from './in-process-wire.ts'
import type { DurableCreateResult, SessionListRow } from './session-client.ts'
import { lastTurnEndReason, settleWait } from './wait-settle.ts'

/** Title field on a list projection block. */
function listRowTitle(values: unknown): string | undefined {
  if (values === undefined || values === null || typeof values !== 'object') return undefined
  if (!('title' in values)) return undefined
  const title = values.title
  return typeof title === 'string' ? title : undefined
}

/** One controller list row (SessionSummary-shaped). */
export interface InProcessSessionSummary {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly cwd?: string
  readonly running: boolean
  readonly updatedAt: number
  readonly projections?: { readonly values?: unknown }
}

/** `ctx.sessionController` methods this client calls. */
export interface InProcessSessionController {
  create(request: {
    readonly workspaceId?: string
    readonly cwd?: string
    readonly sessionId?: string
  }): Promise<{ readonly sessionId: string }>
  prompt(
    request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>
  cancel(request: { readonly sessionId: string }): { readonly accepted: true } | Promise<{ readonly accepted: true }>
  rename(request: {
    readonly sessionId: string
    readonly title: string
  }): Promise<{ readonly title: string; readonly seq: number }>
  list(
    request: { readonly cursor?: string },
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly InProcessSessionSummary[] }>
}

/** Live session store used for `snapshotEvents` (wait turn/end). */
export interface InProcessSessionStore {
  get(id: SessionId): { snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[] } | undefined
}

/** Persistence used when the session is not live. */
export interface InProcessSessionPersistence {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{
    readonly events: readonly { readonly type: string; readonly data?: unknown }[]
  }>
}

/**
 * Optional `ctx.subagents` (SubagentRuntime). When present, `subagentPrompt`
 * uses the continuable Remote `prompt`; when absent the call fails loud
 * rather than HTTP-loopback.
 */
export interface InProcessSubagentRuntime {
  prompt(
    request: {
      readonly requestId: string
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly mode: 'continuable'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    },
    signal: AbortSignal,
  ): Promise<unknown>
}

/** Constructor deps: GUI-tree controller + live/cold event sources. */
export interface InProcessSessionClientDeps {
  readonly sessionController: InProcessSessionController
  readonly sessions: InProcessSessionStore
  readonly sessionPersistence: InProcessSessionPersistence
  readonly subagents?: InProcessSubagentRuntime
}

/** Poll interval for the wait substitute (`session/list` running bit). */
const WAIT_POLL_MS = 250

/**
 * Same-process session client. Callers inject `ctx.sessionController` from
 * the web-app tree; this module does not import the controller package.
 */
export class InProcessSessionClient {
  private readonly sessionController: InProcessSessionController
  private readonly sessions: InProcessSessionStore
  private readonly sessionPersistence: InProcessSessionPersistence
  private readonly subagents: InProcessSubagentRuntime | undefined

  constructor(deps: InProcessSessionClientDeps) {
    this.sessionController = deps.sessionController
    this.sessions = deps.sessions
    this.sessionPersistence = deps.sessionPersistence
    this.subagents = deps.subagents
  }

  /**
   * Create a durable session WITHOUT starting a turn. A requested title is
   * applied by a follow-up controller rename. Lineage fields are not sent
   * (0.1.2 create has no parentSession / delegationDepth).
   */
  async durableCreate(options: {
    sessionId?: string
    title?: string
    parentSessionId?: string
    workspaceId?: string
    cwd?: string
    delegationDepth?: number
  }): Promise<DurableCreateResult> {
    return await invokeInProcess(async () => {
      const created = await this.sessionController.create({
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId as never },
        ...options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId as never },
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
      })
      if (options.title === undefined) return { sessionId: String(created.sessionId) }
      const renamed = await this.sessionController.rename({
        sessionId: created.sessionId as never,
        title: options.title,
      })
      return { sessionId: String(created.sessionId), title: renamed.title }
    })
  }

  /**
   * Admit one queued text prompt. Settles when the controller accepts the
   * message; the reply streams through the ordinary session event push.
   */
  async prompt(sessionId: string, content: string): Promise<{ accepted: true }> {
    return await invokeInProcess(async () => {
      return await this.sessionController.prompt({
        requestId: randomUUID() as never,
        sessionId: sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      }, new AbortController().signal)
    })
  }

  /**
   * Deliver a prompt to a continuable subagent child via `ctx.subagents`
   * when injected. Missing SubagentRuntime fails loud (no HTTP fallback).
   */
  async subagentPrompt(parentSessionId: string, childSessionId: string, content: string): Promise<{ accepted: true }> {
    return await invokeInProcess(async () => {
      const subagents = this.subagents
      if (subagents === undefined) {
        throw new Error(
          'in-process subagent.prompt requires ctx.subagents (SubagentRuntime); not injected — no HTTP fallback',
        )
      }
      await subagents.prompt({
        requestId: randomUUID() as never,
        parentSessionId: parentSessionId as never,
        childSessionId: childSessionId as never,
        mode: 'continuable',
        content: [{ type: 'text', text: content }],
      }, new AbortController().signal)
      return { accepted: true }
    })
  }

  /**
   * Wait for a session's agent to settle. Polls controller.list `running`
   * and reads the last `turn/end` from the live snapshot or persistence.
   * A cold session with no turn/end is `idle`. `timeoutMs` reports `timeout`
   * without error.
   */
  async wait(sessionId: string, options: {
    until?: 'idle' | 'turn-end'
    timeoutMs?: number
  } = {}): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout'
    lastTurnEndReason?: { kind: string }
  }> {
    return await invokeInProcess(async () => {
      const deadline = options.timeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() + options.timeoutMs
      const until = options.until ?? 'idle'
      for (;;) {
        const settled = await this.settleFromController(sessionId, until)
        if (settled !== undefined) return settled
        if (Date.now() >= deadline) return { status: 'timeout' }
        await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())))
        if (Date.now() >= deadline) return { status: 'timeout' }
      }
    })
  }

  /** Cancel a session's active turn; pending inbox work is preserved. */
  async cancel(sessionId: string): Promise<{ accepted: true }> {
    return await invokeInProcess(async () => {
      return await this.sessionController.cancel({ sessionId: sessionId as never })
    })
  }

  /** List every served session with title projection. */
  async list(): Promise<readonly SessionListRow[]> {
    return await invokeInProcess(async () => {
      const { items } = await this.sessionController.list({}, new AbortController().signal)
      return items.map((item): SessionListRow => {
        const title = listRowTitle(item.projections?.values)
        return {
          sessionId: String(item.sessionId),
          ...item.parentSessionId === undefined ? {} : { parentSessionId: String(item.parentSessionId) },
          ...item.cwd === undefined ? {} : { cwd: item.cwd },
          ...title === undefined ? {} : { title },
          running: item.running,
          updatedAt: item.updatedAt,
        }
      })
    })
  }

  /** Rename a session via controller.rename (title only). */
  async rename(sessionId: string, options: { title: string }): Promise<{
    title?: string
    seq: number
  }> {
    return await invokeInProcess(async () => {
      const value = await this.sessionController.rename({
        sessionId: sessionId as never,
        title: options.title,
      })
      return { title: value.title, seq: Number(value.seq) }
    })
  }

  /** One list/event cut: undefined means the wait should keep polling. */
  private async settleFromController(sessionId: string, until: 'idle' | 'turn-end'): Promise<{
    status: 'idle' | 'completed' | 'failed' | 'aborted'
    lastTurnEndReason?: { kind: string }
  } | undefined> {
    const { items } = await this.sessionController.list({}, new AbortController().signal)
    const running = items.find(item => String(item.sessionId) === sessionId)?.running === true
    return settleWait({
      running,
      lastTurnEndReason: await this.readLastTurnEndReason(sessionId),
      until,
    })
  }

  /** Latest `turn/end` reason on the live snapshot or persisted log. */
  private async readLastTurnEndReason(sessionId: string): Promise<{ kind: string } | undefined> {
    const live = this.sessions.get(SessionId(sessionId))
    const events = live !== undefined
      ? live.snapshotEvents()
      : await this.inspectEvents(sessionId)
    if (events === undefined) return undefined
    return lastTurnEndReason(events)
  }

  /** Cold log when the session is not attached; missing id is no turn/end. */
  private async inspectEvents(sessionId: string): Promise<readonly { readonly type: string; readonly data?: unknown }[] | undefined> {
    try {
      const inspection = await this.sessionPersistence.inspect(SessionId(sessionId))
      return inspection.events
    } catch {
      return undefined
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
