/**
 * Session management Service Definition: the `ctx.sessionTool` contract shared
 * by the model-facing tools (`tool-session`), the `dsh-session` CLI, and every
 * provider implementation (`session-tool-local`).
 *
 * The capability follows the Codex session model as methodology only: durable
 * addressable sessions, append-only transcripts, fork lineage, and list-based
 * resume — all built on DSH's existing session stack (event-sourced
 * `Session` logs, session persistence, title and tag services) with zero new
 * event types.
 * @module session-tool
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Identity of one service caller. Agent callers carry the exact session id of
 * the calling agent (`Agent.id`) and the delegation depth recorded in that
 * session's header; the CLI calls as `cli` (human identity) and is exempt from
 * the owner fence.
 */
export type SessionToolCaller =
  | { readonly kind: 'agent'; readonly sessionId: SessionId; readonly delegationDepth: number }
  | { readonly kind: 'cli' }

/** Options for {@link SessionToolService.create}. */
export interface SessionToolCreateOptions {
  /** Explicit title; pins the title and stops automatic generation. */
  readonly title?: string
  /**
   * Durable parent lineage recorded in the new header (`parentSession`). The
   * parent must be the caller itself or one of its ancestors.
   */
  readonly parentSessionId?: SessionId
  /** Tag set accepted immediately after creation (last-wins replace). */
  readonly tags?: readonly string[]
  /**
   * Register (or reuse) the workspace at this directory through the web
   * gateway and bind the new session to it. The session's header `cwd` is set
   * to the workspace's canonical path (the durable membership mechanism the
   * workspace registry accounts by). The web process must be reachable at
   * `Config.webUrl`; a missing or rejecting gateway fails the call loudly
   * (`web-unreachable` / workspace wire codes).
   */
  readonly workspacePath?: string
  /**
   * Working directory for the session header, used when no `workspacePath`
   * is given (a cwd-bearing session is served by the web process's session
   * list; a cwd-less session stays a local durable log).
   */
  readonly cwd?: string
  /**
   * Delegation depth recorded in the new header. The web gateway admits at
   * most the caller's own depth plus one; a delegated session created by an
   * agent without an explicit value inherits `caller.depth + 1`.
   */
  readonly delegationDepth?: number
}

/** Result of {@link SessionToolService.create}. */
export interface SessionToolCreateResult {
  /** The minted session id. */
  readonly sessionId: SessionId
  /** The bound workspace id, when `workspacePath` was requested. */
  readonly workspaceId?: string
  /** The workspace's canonical path (the session header `cwd`), when bound. */
  readonly workspacePath?: string
}

/** One readable message row of a session transcript. */
export interface SessionToolMessageRow {
  /** Source event sequence number. */
  readonly seq: number
  /** `tool` covers `tool/result` events; user-role injected context stays `user`. */
  readonly role: 'user' | 'assistant' | 'tool'
  /** The message's model-facing content blocks, exactly as logged. */
  readonly blocks: readonly ContentBlock[]
}

/** Options for {@link SessionToolService.read}. */
export interface SessionToolReadOptions {
  /** First event seq to include (incremental read). */
  readonly sinceSeq?: number
  /** Row cap, clamped to the provider's configured maximum. */
  readonly maxBlocks?: number
}

/** Result of {@link SessionToolService.read}. */
export interface SessionToolReadResult {
  /** The read session id. */
  readonly sessionId: SessionId
  /** Message rows in log order. */
  readonly messages: readonly SessionToolMessageRow[]
}

/** Result of {@link SessionToolService.write}. */
export interface SessionToolWriteResult {
  /** The written session id. */
  readonly sessionId: SessionId
}

/** Terminal delegation statuses reported by {@link SessionToolService.wait}. */
export type SessionToolWaitStatus = 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout'

/** Options for {@link SessionToolService.wait}. */
export interface SessionToolWaitOptions {
  /**
   * Settle point: `idle` (the default) waits for the session's agent to go
   * idle; `turn-end` waits for the open turn to close. Single-session
   * semantics: descendants are never awaited.
   */
  readonly until?: 'idle' | 'turn-end'
  /** Deadline in milliseconds; on expiry the call reports `timeout` without error. */
  readonly timeoutMs?: number
}

/** Result of {@link SessionToolService.wait}. */
export interface SessionToolWaitResult {
  /** The waited session id. */
  readonly sessionId: SessionId
  /** The terminal status once the wait settled, or `timeout`. */
  readonly status: SessionToolWaitStatus
  /** Kind of the last `turn/end` reason, when one has ended. */
  readonly lastTurnEndReason?: string
}

/** Listing scopes: the caller's own tree, one named tree, or every materialized session. */
export type SessionToolListScope = 'own' | 'tree' | 'all'

/** Filter for {@link SessionToolService.list}. */
export interface SessionToolListFilter {
  /** Listing scope; defaults to `own`. */
  readonly scope?: SessionToolListScope
  /** Tree root for scope `tree`; the caller must be the root or one of its ancestors. */
  readonly sessionId?: SessionId
  /** Rows must carry every listed tag (intersection against the folded tag set). */
  readonly tags?: readonly string[]
  /** Case-sensitive substring filter on the durable title. */
  readonly title?: string
  /**
   * Only sessions in one lifecycle bucket: `live` / `idle` keep the
   * store-presence semantics, while the delegation vocabulary
   * (`running` / `completed` / `failed` / `aborted`) filters by the
   * log-derived delegation projection.
   */
  readonly status?: 'live' | 'idle' | 'running' | 'completed' | 'failed' | 'aborted'
  /**
   * Only delegated sessions: those whose tag set includes `delegated` or
   * whose header records a positive delegation depth.
   */
  readonly origin?: 'delegated'
  /** Exemption from the hidden-prefix filter (default `false`: hidden rows are excluded). */
  readonly includeHidden?: boolean
  /** Opaque pagination cursor returned by a previous call. */
  readonly cursor?: string
  /** Row cap, clamped to the provider's configured maximum. */
  readonly limit?: number
}

/** One session list row. */
export interface SessionToolListRow {
  /** The session id. */
  readonly sessionId: SessionId
  /** Durable title, when one has been accepted. */
  readonly title?: string
  /** Folded tag set (empty before any accepted set). */
  readonly tags: readonly string[]
  /** `live` while the session is in this process's store, `idle` otherwise. */
  readonly status: 'live' | 'idle'
  /**
   * Log-derived delegation status, when the projection is resolvable:
   * `running` while a turn is open, then the terminal mapping of its
   * `turn/end` reason. Absent when no projection support is composed.
   */
  readonly delegationStatus?: 'idle' | 'running' | 'completed' | 'failed' | 'aborted' | 'max-tokens'
  /** Creation timestamp from the session header. */
  readonly createdAt: number
}

/** Result of {@link SessionToolService.list}. */
export interface SessionToolListResult {
  /** Visible rows in creation order (ties broken on id). */
  readonly sessions: readonly SessionToolListRow[]
  /** Opaque cursor for the next page, present when more rows remain. */
  readonly nextCursor?: string
}

/** Options for {@link SessionToolService.rename}. */
export interface SessionToolRenameOptions {
  /** Explicit title; pins the title and stops automatic generation. */
  readonly title?: string
  /** Tag set (last-wins replace of the folded set). */
  readonly tags?: readonly string[]
}

/** Result of {@link SessionToolService.rename}. */
export interface SessionToolRenameResult {
  /** The renamed session id. */
  readonly sessionId: SessionId
  /** The accepted title, when a title was requested. */
  readonly title?: string
  /** The accepted tag set, when tags were requested. */
  readonly tags?: readonly string[]
}

/** One workspace row served by the web gateway. */
export interface SessionToolWorkspaceRow {
  /** The workspace id. */
  readonly workspaceId: string
  /** The canonical directory the workspace owns. */
  readonly path: string
  /** The display title. */
  readonly title: string
  /** Sessions accounted by the workspace, in registry order. */
  readonly sessionIds: readonly string[]
  /** Creation timestamp (ISO). */
  readonly createdAt: string
  /** Last mutation timestamp (ISO). */
  readonly updatedAt: string
}

/** Options for {@link SessionToolService.workspaceAdd}. */
export interface SessionToolWorkspaceAddOptions {
  /** Existing directory to adopt; canonicalized and reused when already registered. */
  readonly path: string
  /** Display title, used only when a new record is created. */
  readonly title?: string
}

/** Result of {@link SessionToolService.workspaceAdd}. */
export interface SessionToolWorkspaceAddResult {
  /** The registered (or reused) workspace id. */
  readonly workspaceId: string
  /** The workspace's canonical path. */
  readonly path: string
  /** Whether this call minted the record (`false` = reused). */
  readonly created: boolean
}

/** Result of {@link SessionToolService.workspaceList}. */
export interface SessionToolWorkspaceListResult {
  /** Workspaces in durable registry order. */
  readonly workspaces: readonly SessionToolWorkspaceRow[]
  /** The registry-global archived session id set. */
  readonly archivedSessionIds: readonly string[]
}

/** Options for {@link SessionToolService.workspaceRename}. */
export interface SessionToolWorkspaceRenameOptions {
  /** The workspace to rename. */
  readonly workspaceId: string
  /** The new display title; must be non-blank and unique. */
  readonly title: string
}

/** Result of {@link SessionToolService.workspaceRename}. */
export interface SessionToolWorkspaceRenameResult {
  /** The renamed workspace id. */
  readonly workspaceId: string
  /** The accepted title. */
  readonly title: string
}

/** Result of {@link SessionToolService.workspaceDelete}. */
export interface SessionToolWorkspaceDeleteResult {
  /** The deleted workspace id. */
  readonly workspaceId: string
  /** Whether a record was removed (`false` = unknown id, idempotent no-op). */
  readonly deleted: boolean
}

/**
 * The session-management capability: create, read, write, list, and rename
 * sessions over DSH's durable session stack. `write` appends a `user/message`
 * text block (an input prompt) — durable via session persistence, never
 * delivered: delivery stays `send_message` (delivery owns the live agent,
 * write owns the log). Cold sessions are materialized on first touch (resume
 * semantics).
 */
export interface SessionToolService {
  /**
   * Create a persistent session.
   * @param caller - the calling agent or the CLI.
   * @param options - optional title, parent lineage, and initial tags.
   * @returns the minted session id.
   */
  create(caller: SessionToolCaller, options: SessionToolCreateOptions): Promise<SessionToolCreateResult>

  /**
   * Read a session's transcript.
   * @param caller - the calling agent or the CLI.
   * @param sessionId - target session; the caller must be the session itself
   *   or one of its ancestors.
   * @param options - incremental boundary and row cap.
   * @returns the message rows in log order.
   */
  read(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolReadOptions): Promise<SessionToolReadResult>

  /**
   * Send one user prompt into a session's conversation: the web gateway
   * resumes the session's agent (from the durable log on first touch) and
   * delivers the message into the model loop; the reply streams back through
   * the gateway's event push and lands in the session log. This settles when
   * the message is admitted, not when the turn completes.
   * @param caller - the calling agent or the CLI.
   * @param sessionId - target session; the caller must be the session itself
   *   or one of its ancestors.
   * @param content - non-empty prompt text.
   * @returns the written session id.
   */
  write(caller: SessionToolCaller, sessionId: SessionId, content: string): Promise<SessionToolWriteResult>

  /**
   * List sessions under a scope, filtered and paginated.
   * @param caller - the calling agent or the CLI.
   * @param filter - scope, tree root, tag/title/status filters, hidden
   *   exemption, cursor, and limit.
   * @returns the visible rows and the next cursor.
   */
  list(caller: SessionToolCaller, filter: SessionToolListFilter): Promise<SessionToolListResult>

  /**
   * Wait for a session's agent to settle and report its terminal status —
   * the model-side completion detection for delegated tasks. Single-session
   * semantics: the wait follows THIS session's agent only and never its
   * descendants. A cold session (no live agent) is reported from its log and
   * settles immediately; a deadline expiry reports `timeout` without error
   * and the session stays live and resumable.
   * @param caller - the calling agent or the CLI.
   * @param sessionId - target session; the caller must be the session itself
   *   or one of its ancestors.
   * @param options - settle point and deadline.
   * @returns the terminal status and the last turn-end reason kind.
   */
  wait(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolWaitOptions): Promise<SessionToolWaitResult>

  /**
   * Rename a session and/or replace its tag set.
   * @param caller - the calling agent or the CLI.
   * @param sessionId - target session; the caller must be the session itself
   *   or one of its ancestors.
   * @param options - at least one of title or tags.
   * @returns the accepted title and/or tags.
   */
  rename(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolRenameOptions): Promise<SessionToolRenameResult>

  /**
   * Register (or reuse) a workspace through the web gateway. The gateway is
   * the workspace registry's authority; this provider holds no workspace
   * state of its own.
   * @param caller - the calling agent or the CLI.
   * @param options - the existing directory to adopt and an optional title.
   * @returns the workspace id, its canonical path, and whether it was minted.
   */
  workspaceAdd(caller: SessionToolCaller, options: SessionToolWorkspaceAddOptions): Promise<SessionToolWorkspaceAddResult>

  /**
   * List workspaces through the web gateway, in durable registry order.
   * @param caller - the calling agent or the CLI.
   * @returns the workspace rows and the archived session id set.
   */
  workspaceList(caller: SessionToolCaller): Promise<SessionToolWorkspaceListResult>

  /**
   * Rename a workspace through the web gateway.
   * @param caller - the calling agent or the CLI.
   * @param options - the workspace and its new title.
   * @returns the accepted title.
   */
  workspaceRename(caller: SessionToolCaller, options: SessionToolWorkspaceRenameOptions): Promise<SessionToolWorkspaceRenameResult>

  /**
   * Delete a workspace registration through the web gateway (the directory
   * and every session log are retained).
   * @param caller - the calling agent or the CLI.
   * @param workspaceId - the registration to remove.
   * @returns whether a record was removed.
   */
  workspaceDelete(caller: SessionToolCaller, workspaceId: string): Promise<SessionToolWorkspaceDeleteResult>
}

declare module 'cordis' {
  interface Context {
    sessionTool: SessionToolService
  }
}

/** Wire codes carried by {@link SessionToolError} instances. */
export type SessionToolErrorCode =
  | 'session-not-found'
  | 'unauthorized'
  | 'scope-denied'
  | 'empty-content'
  | 'limit-exceeded'
  // Translated from the owned session-title / session-tags services.
  | 'title-invalid'
  | 'tag-invalid'
  // The web gateway was unreachable or refused the request at the carrier layer.
  | 'web-unreachable'
  // Translated from the web gateway's workspace wire codes.
  | 'workspace-not-found'
  | 'workspace-name-conflict'
  | 'workspace-invalid-path'

/**
 * Typed failure for the session-tool seam. The code is the stable
 * machine-routable wire value (mirrors `HarnessError.code`); subclass names
 * come from `HarnessError`'s `new.target` naming.
 */
export class SessionToolError extends HarnessError {
  constructor(message: string, code: SessionToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** The target session does not exist (live store or persistence). */
export class SessionNotFoundError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'session-not-found', options)
  }
}

/** The caller is not the target session itself or one of its ancestors. */
export class SessionToolUnauthorizedError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'unauthorized', options)
  }
}

/** A scope gate (or a scope/caller mismatch) rejected the call. */
export class SessionScopeDeniedError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'scope-denied', options)
  }
}

/** The caller supplied empty content where non-empty input is required. */
export class SessionEmptyContentError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'empty-content', options)
  }
}

/** A configured bound (read rows, list rows) was exceeded or rejected. */
export class SessionLimitError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'limit-exceeded', options)
  }
}

/**
 * The web gateway (workspace registry authority) was unreachable or rejected
 * the request at the transport/carrier layer (connection refused, timeout,
 * non-JSON envelope, non-2xx HTTP status).
 */
export class SessionWebUnreachableError extends SessionToolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'web-unreachable', options)
  }
}
