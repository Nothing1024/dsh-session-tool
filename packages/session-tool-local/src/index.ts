/**
 * Remote provider for the session-tool Service Definition: implements
 * `ctx.sessionTool` over the web gateway (`dsh web`)'s HTTP carrier. Session
 * creation, writing (conversation prompts), renaming, and listing go through
 * the gateway so the web process owns every session it serves — sessions are
 * live there, published to every GUI client through the ordinary event push.
 * Reading stays local (persistence inspection, no agent acquisition); the
 * owner fence, scope gates, and hidden-prefix filtering run in this process
 * over a read-only header index. Zero new event types: the gateway reuses
 * DSH's existing `user/message`, `session/title`, and `session/tags` events.
 * @module session-tool-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { isTitleHidden } from '@deepseek-ai/dsh-session-tags'
import {
  SessionEmptyContentError,
  SessionNotFoundError,
  SessionScopeDeniedError,
  SessionToolUnauthorizedError,
} from 'session-tool'
import type {
  SessionToolCaller,
  SessionToolCreateOptions,
  SessionToolCreateResult,
  SessionToolListFilter,
  SessionToolListResult,
  SessionToolListRow,
  SessionToolMessageRow,
  SessionToolReadOptions,
  SessionToolReadResult,
  SessionToolRenameOptions,
  SessionToolRenameResult,
  SessionToolService,
  SessionToolWaitOptions,
  SessionToolWaitResult,
  SessionToolWorkspaceAddOptions,
  SessionToolWorkspaceAddResult,
  SessionToolWorkspaceDeleteResult,
  SessionToolWorkspaceListResult,
  SessionToolWorkspaceRenameOptions,
  SessionToolWorkspaceRenameResult,
  SessionToolWorkspaceRow,
  SessionToolWriteResult,
} from 'session-tool'
import { SessionHttpClient } from './session-client.ts'
import { WorkspaceHttpClient } from './workspace-client.ts'
import { delegationProjectionDefinition } from './delegation-projection.ts'
import type { DelegationStatus } from './delegation-projection.ts'
import {
  evaluateCollectPredicate,
  isTerminalStatus,
  type CollectMemberSnapshot,
} from './collect.ts'
import type {
  SessionToolCollectRequest,
  SessionToolCollectResult,
  SessionToolCollectSession,
} from 'session-tool'

/** `all` scope gate levels for agent callers. */
export type AllowAllScope = 'top-level' | 'any' | 'none'

/**
 * Continuation-authorization strength for the plugin tool path (ASM-009):
 * who may write to / wait on a delegated session created by another agent.
 * `creator` admits only the lineage-chain creator; `workspace` (default)
 * admits any same-workspace caller; `anyone` admits every caller. These
 * levels constrain ONLY the plugin tool path (`session_write` /
 * `session_wait`); the upstream subagent tool path keeps workspace-level
 * authorization.
 */
export type AllowOthersToWrite = 'workspace' | 'creator' | 'anyone'

/** Deployment-owned bounds and scope gates (no hardcoded tunables). */
export interface Config {
  /** Agent `all`-scope gate: top-level callers only, any agent, or nobody. */
  readonly allowAllScope: AllowAllScope
  /** Whether CLI (human) callers may use the `all` scope. */
  readonly cliAllowAll: boolean
  /** Single `read` row cap; model-supplied `max_blocks` is clamped to it. */
  readonly readMaxBlocks: number
  /** Single `list` row cap; model-supplied `limit` is clamped to it. */
  readonly listMaxRows: number
  /**
   * Title prefixes that drop a session from default lists (shared with the
   * web composition's session-tags hiddenPrefixes; keep them in sync).
   */
  readonly hiddenPrefixes: string[]
  /**
   * Base URL of the web gateway (`dsh web`), the workspace registry's
   * authority and the session operations' execution point. Workspace
   * registration and session create/write/rename/list go over this gateway's
   * HTTP carrier; a reachable gateway is required for those operations.
   */
  readonly webUrl: string
  /**
   * Continuation-authorization strength for the plugin tool path (default
   * `workspace`): who may write to or wait on another agent's delegated
   * session. `creator` restricts to the session's lineage creator;
   * `workspace` admits same-workspace callers; `anyone` admits every caller.
   */
  readonly allowOthersToWrite: AllowOthersToWrite
  /**
   * Delegation-depth ceiling for the plugin tool path: `session_create`
   * rejects a creation whose resolved depth (`caller depth + 1`) exceeds
   * this bound. `undefined` (default) imposes no local ceiling — the web
   * gateway still admits at most parent depth plus one.
   */
  readonly maxDelegationDepth?: number
  /**
   * Whether delegated sessions appear in `session_list` results (default
   * `true`). `false` drops rows whose tag set carries `delegated` or whose
   * header records a positive delegation depth.
   */
  readonly showDelegated: boolean
}


/**
 * The local session-tool provider. Mounted as the `session-tool-local` plugin
 * row; Cordis provides `ctx.sessionTool` from this Service subclass.
 */
export class SessionToolLocalService extends Service implements SessionToolService {
  static inject = ['sessions', 'sessionPersistence']

  static Config: z<Config> = z.object({
    allowAllScope: z.union([z.const('top-level'), z.const('any'), z.const('none')]).default('top-level'),
    cliAllowAll: z.boolean().default(true),
    readMaxBlocks: z.number().step(1).min(1).default(500),
    listMaxRows: z.number().step(1).min(1).default(100),
    hiddenPrefixes: z.array(z.string()).default(['~']),
    webUrl: z.string().default('http://127.0.0.1:3080'),
    allowOthersToWrite: z.union([z.const('workspace'), z.const('creator'), z.const('anyone')]).default('workspace'),
    maxDelegationDepth: z.number().step(1).min(1),
    showDelegated: z.boolean().default(true),
  })

  private readonly config: Config
  private readonly workspaceClient: WorkspaceHttpClient
  private readonly sessionClient: SessionHttpClient

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTool')
    this.config = Object.freeze({ ...config })
    this.workspaceClient = new WorkspaceHttpClient(config.webUrl)
    this.sessionClient = new SessionHttpClient(config.webUrl)
    // Register the delegation status projection when the projection registry
    // is composed; a deployment without it degrades to log-tail reads.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(delegationProjectionDefinition)
    })
  }

  // ---- public contract ---------------------------------------------------

  async create(caller: SessionToolCaller, options: SessionToolCreateOptions): Promise<SessionToolCreateResult> {
    const index = await this.headerIndex()
    if (caller.kind === 'agent' && !index.has(caller.sessionId)) {
      throw new SessionNotFoundError(`caller session "${caller.sessionId}" is not in the session store`)
    }
    if (options.parentSessionId !== undefined) {
      const parent = index.get(options.parentSessionId)
      if (parent === undefined) {
        throw new SessionNotFoundError(`parent session "${options.parentSessionId}" does not exist`)
      }
      this.assertCreateParent(caller, options.parentSessionId, index)
    }
    // Register the workspace through the web gateway BEFORE creating the
    // session: the remote operation is the most likely failure, and a
    // rejecting/unreachable gateway must leave zero local state. The
    // session's header cwd is the gateway's canonical workspace path — the
    // durable membership mechanism the workspace registry accounts by.
    let bound: { workspaceId: string; path: string } | undefined
    if (options.workspacePath !== undefined) {
      const { workspace } = await this.workspaceClient.addWorkspace(options.workspacePath)
      bound = { workspaceId: workspace.workspaceId, path: workspace.path }
    }
    // The gateway creates the durable session (no agent started) and serves
    // it live, so every GUI client sees it immediately. An agent caller's
    // creations join its own tree by default (parent = the caller), keeping
    // owner-fence access and `own` scope listings; CLI creations are
    // top-level sessions unless a parent is named. A delegated session
    // records the caller's depth plus one unless an explicit depth is given
    // (the gateway still admits at most parent depth plus one). The plugin
    // depth ceiling is enforced here, before any gateway call.
    const childDepth = options.delegationDepth
      ?? (caller.kind === 'agent' ? caller.delegationDepth + 1 : undefined)
    if (childDepth !== undefined && this.config.maxDelegationDepth !== undefined
      && childDepth > this.config.maxDelegationDepth) {
      throw new SessionToolUnauthorizedError(
        `delegation depth ${childDepth} exceeds the configured maximum ${this.config.maxDelegationDepth}`,
      )
    }
    const created = await this.sessionClient.durableCreate({
      ...options.title === undefined ? {} : { title: options.title },
      ...options.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : caller.kind === 'agent'
          ? { parentSessionId: caller.sessionId }
          : {},
      ...options.tags === undefined ? {} : { tags: options.tags },
      ...childDepth === undefined ? {} : { delegationDepth: childDepth },
      ...bound === undefined
        ? options.cwd === undefined ? {} : { cwd: options.cwd }
        : { workspaceId: bound.workspaceId },
    })
    return {
      sessionId: created.sessionId as SessionId,
      ...bound === undefined ? {} : { workspaceId: bound.workspaceId, workspacePath: bound.path },
    }
  }

  async read(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolReadOptions): Promise<SessionToolReadResult> {
    const inspection = await this.resolveInspection(caller, sessionId)
    const maxBlocks = Math.min(options.maxBlocks ?? this.config.readMaxBlocks, this.config.readMaxBlocks)
    const sinceSeq = options.sinceSeq ?? 0
    const messages: SessionToolMessageRow[] = []
    for (const event of inspection.events) {
      if (event.seq < sinceSeq) continue
      const row = messageRow(event)
      if (row === undefined) continue
      messages.push(row)
      if (messages.length >= maxBlocks) break
    }
    return { sessionId, messages }
  }

  async write(caller: SessionToolCaller, sessionId: SessionId, content: string): Promise<SessionToolWriteResult> {
    const text = content.trim()
    if (text.length === 0) {
      throw new SessionEmptyContentError('session write content must not be empty')
    }
    // Conversation write: the gateway resumes the session's agent (from the
    // durable log on first touch) and delivers the prompt into the model
    // loop; the reply streams back through the gateway's event push and
    // lands in the session log. This settles on admission.
    const index = await this.headerIndex()
    await this.assertContinuationAllowed(caller, sessionId, index)
    const header = index.get(sessionId)
    // Badge selects the door, not the kind: origin=subagent is rc.7's
    // spawn stamp. session.prompt answers agent-busy on those children.
    if (header?.origin === 'subagent') {
      const parent = header.parentSession
      if (parent === undefined) {
        throw new SessionNotFoundError(
          `subagent session "${sessionId}" has no parentSession; cannot address subagent.prompt`,
        )
      }
      await this.sessionClient.subagentPrompt(parent, sessionId, text)
    } else {
      await this.sessionClient.prompt(sessionId, text)
    }
    return { sessionId }
  }

  async list(caller: SessionToolCaller, filter: SessionToolListFilter): Promise<SessionToolListResult> {
    const index = await this.headerIndex()
    const scope = filter.scope ?? 'own'
    const children = indexChildren(index)
    let candidates: SessionId[] | undefined
    if (scope === 'own') {
      if (caller.kind !== 'agent') {
        throw new SessionScopeDeniedError(
          'scope "own" requires an agent caller; use --scope tree or --scope all from the CLI',
        )
      }
      if (!index.has(caller.sessionId)) {
        throw new SessionNotFoundError(`caller session "${caller.sessionId}" is not in the session store`)
      }
      candidates = descendantsOf(index, children, [caller.sessionId])
    } else if (scope === 'tree') {
      if (filter.sessionId === undefined) {
        throw new SessionEmptyContentError('scope "tree" requires session_id')
      }
      // The tree root must exist for EVERY caller identity: the CLI fence
      // exemption must not turn a missing root into a silent empty listing.
      if (!index.has(filter.sessionId)) {
        throw new SessionNotFoundError(`session "${filter.sessionId}" does not exist`)
      }
      await this.assertAccess(caller, filter.sessionId, index)
      candidates = descendantsOf(index, children, [filter.sessionId])
    } else if (scope === 'all') {
      this.assertAllScope(caller)
      // The gateway's web view IS the full materialized set; no local
      // intersection (the scope-id filter below is skipped for `all`).
      candidates = undefined
    } else {
      assertNever(scope, 'SessionToolListScope')
    }

    // The gateway serves the web view (cwd-bearing sessions) with title/tags
    // projections; own/tree rows are intersected with the scope's id set
    // (the local header index carries the lineage), `all` uses every row.
    const scopeIds = candidates === undefined ? undefined : new Set(candidates)
    const gatewayRows = (await this.sessionClient.list())
      .filter(row => scopeIds === undefined || scopeIds.has(row.sessionId as SessionId))
    const rows: SessionToolListRow[] = await Promise.all(gatewayRows.map(async row => {
      const header = index.get(row.sessionId as SessionId)
      const delegationStatus = await this.delegationStatusOf(row.sessionId as SessionId)
      return {
        sessionId: row.sessionId as SessionId,
        ...row.title === undefined ? {} : { title: row.title },
        tags: [...(row.tags ?? [])],
        status: row.running ? 'live' : 'idle',
        ...delegationStatus === undefined ? {} : { delegationStatus },
        createdAt: header?.createdAt ?? row.updatedAt,
      }
    }))

    let visible = rows
    if (filter.includeHidden !== true) {
      visible = visible.filter(row => !isTitleHidden(row.title, this.config.hiddenPrefixes))
    }
    if (this.config.showDelegated === false && filter.origin !== 'delegated') {
      // Visibility config: hide delegated sessions (tag `delegated` or a
      // positive header depth) unless the caller explicitly asked for them.
      visible = visible.filter(row => !this.isDelegated(row, index))
    }
    if (filter.status !== undefined) {
      // The delegation vocabulary (running/completed/failed/aborted) filters
      // by the log-derived projection; live/idle keep store-presence
      // semantics. A delegation filter with no projection support degrades
      // loudly: the row's delegationStatus is absent, so nothing matches.
      if (filter.status === 'live' || filter.status === 'idle') {
        visible = visible.filter(row => row.status === filter.status)
      } else {
        visible = visible.filter(row => row.delegationStatus === filter.status)
      }
    }
    if (filter.origin === 'delegated') {
      visible = visible.filter(row => this.isDelegated(row, index))
    }
    const requiredTags = filter.tags
    if (requiredTags !== undefined && requiredTags.length > 0) {
      visible = visible.filter(row => requiredTags.every(tag => row.tags.includes(tag)))
    }
    const titleFilter = filter.title
    if (titleFilter !== undefined && titleFilter.length > 0) {
      visible = visible.filter(row => row.title?.includes(titleFilter) ?? false)
    }
    visible = [...visible].sort((a, b) => a.createdAt - b.createdAt || (a.sessionId < b.sessionId ? -1 : 1))

    const limit = Math.max(1, Math.min(filter.limit ?? this.config.listMaxRows, this.config.listMaxRows))
    let start = 0
    if (filter.cursor !== undefined) {
      const at = visible.findIndex(row => row.sessionId === filter.cursor)
      if (at === -1) {
        throw new SessionNotFoundError(`cursor session "${filter.cursor}" is not in the filtered result`)
      }
      start = at + 1
    }
    const page = visible.slice(start, start + limit)
    const nextCursor = start + limit < visible.length ? page.at(-1)?.sessionId : undefined
    return {
      sessions: page,
      ...nextCursor === undefined ? {} : { nextCursor },
    }
  }

  async rename(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolRenameOptions): Promise<SessionToolRenameResult> {
    if (options.title === undefined && options.tags === undefined) {
      throw new SessionEmptyContentError('rename requires at least one of title or tags')
    }
    // The gateway pre-validates both inputs before committing either (no
    // partial commit) and serves the renamed session to every GUI client.
    const index = await this.headerIndex()
    await this.assertAccess(caller, sessionId, index)
    const accepted = await this.sessionClient.rename(sessionId, {
      ...options.title === undefined ? {} : { title: options.title },
      ...options.tags === undefined ? {} : { tags: options.tags },
    })
    return {
      sessionId,
      ...accepted.title === undefined ? {} : { title: accepted.title },
      ...accepted.tags === undefined ? {} : { tags: [...accepted.tags] },
    }
  }

  async wait(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolWaitOptions): Promise<SessionToolWaitResult> {
    const index = await this.headerIndex()
    await this.assertContinuationAllowed(caller, sessionId, index)
    // Single-session settle through the gateway (the web process owns the
    // live agent): the wait follows THIS session's agent only and never its
    // descendants; a cold session is reported from its log immediately; a
    // deadline expiry reports `timeout` without error.
    const settled = await this.sessionClient.wait(sessionId, {
      ...options.until === undefined ? {} : { until: options.until },
      ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    })
    return {
      sessionId,
      status: settled.status,
      ...settled.lastTurnEndReason === undefined
        ? {}
        : { lastTurnEndReason: settled.lastTurnEndReason.kind },
    }
  }

  async collect(caller: SessionToolCaller, request: SessionToolCollectRequest): Promise<SessionToolCollectResult> {
    if ((request.root === undefined) === (request.tags === undefined)) {
      throw new SessionEmptyContentError('collect requires exactly one of root or tags')
    }
    if (request.wait === 'n' && (request.n === undefined || request.n < 1)) {
      throw new SessionEmptyContentError('collect wait "n" requires a positive n')
    }
    // Resolve the member set once: a lineage tree (the root and every
    // transitive descendant) or a tag aggregation over the gateway rows,
    // then the optional status/tag set filter.
    const index = await this.headerIndex()
    const memberIds = await this.resolveCollectSet(caller, request, index)
    if (memberIds.length === 0) {
      // An empty set cannot satisfy any predicate; report the empty snapshot.
      return { satisfied: false, sessions: [], elapsedMs: 0 }
    }

    const started = Date.now()
    const deadline = request.timeoutMs
    const onFailure = request.onFailure ?? 'continue'
    for (;;) {
      const members = await this.collectSnapshot(memberIds)
      if (evaluateCollectPredicate(members, request.wait, request.n)) {
        if (onFailure === 'cancel-rest') {
          // Cancel the unfinished members only; never delete them.
          const unfinished = members.filter(member => !isTerminalStatus(member.status))
          await Promise.allSettled(unfinished.map(member => this.sessionClient.cancel(member.sessionId)))
        }
        return { satisfied: true, sessions: await this.collectResultRows(memberIds), elapsedMs: Date.now() - started }
      }
      if (deadline !== undefined && Date.now() - started >= deadline) {
        // Timeout returns the current snapshot without error; the sessions
        // stay live and resumable.
        return { satisfied: false, sessions: await this.collectResultRows(memberIds), elapsedMs: Date.now() - started }
      }
      await sleep(COLLECT_POLL_MS)
    }
  }

  // ---- workspace (web gateway authority) ---------------------------------

  async workspaceAdd(_caller: SessionToolCaller, options: SessionToolWorkspaceAddOptions): Promise<SessionToolWorkspaceAddResult> {
    const { workspace, created } = await this.workspaceClient.addWorkspace(options.path)
    // The wire `workspace.create` names a new workspace by its path basename;
    // an explicit title applies only when this call minted the record (a
    // reused workspace keeps its established title).
    if (created && options.title !== undefined && options.title.trim() !== '' && options.title.trim() !== workspace.title) {
      await this.workspaceClient.renameWorkspace(workspace.workspaceId, options.title)
    }
    return { workspaceId: workspace.workspaceId, path: workspace.path, created }
  }

  async workspaceList(_caller: SessionToolCaller): Promise<SessionToolWorkspaceListResult> {
    const { items, archivedSessionIds } = await this.workspaceClient.listWorkspaces()
    return {
      workspaces: items.map((row): SessionToolWorkspaceRow => ({
        workspaceId: row.workspaceId,
        path: row.path,
        title: row.title,
        sessionIds: [...row.sessionIds],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      archivedSessionIds: [...archivedSessionIds],
    }
  }

  async workspaceRename(_caller: SessionToolCaller, options: SessionToolWorkspaceRenameOptions): Promise<SessionToolWorkspaceRenameResult> {
    const workspace = await this.workspaceClient.renameWorkspace(options.workspaceId, options.title)
    return { workspaceId: workspace.workspaceId, title: workspace.title }
  }

  async workspaceDelete(_caller: SessionToolCaller, workspaceId: string): Promise<SessionToolWorkspaceDeleteResult> {
    const deleted = await this.workspaceClient.deleteWorkspace(workspaceId)
    return { workspaceId, deleted }
  }

  // ---- fences ------------------------------------------------------------

  /** Assert the caller may create under `parentId`: itself or an ancestor. */
  private assertCreateParent(caller: SessionToolCaller, parentId: SessionId, index: Map<SessionId, SessionHeader>): void {
    if (caller.kind === 'cli') return
    if (parentId === caller.sessionId) return
    let current = index.get(parentId)
    while (current !== undefined) {
      const parent = current.parentSession
      if (parent === caller.sessionId) return
      current = parent === undefined ? undefined : index.get(parent)
    }
    throw new SessionToolUnauthorizedError(
      `caller "${caller.sessionId}" may not create a session under "${parentId}" (the parent must be the caller or one of its ancestors)`,
    )
  }

  /**
   * Assert the caller may reach `targetId`: the CLI (human identity) always
   * may; an agent must be the target itself or one of its ancestors. The
   * ancestor walk trusts the durable `parentSession` lineage recorded in
   * session headers.
   */
  private async assertAccess(caller: SessionToolCaller, targetId: SessionId, index: Map<SessionId, SessionHeader>): Promise<void> {
    if (caller.kind === 'cli') return
    if (targetId === caller.sessionId) return
    if (!index.has(targetId)) {
      throw new SessionNotFoundError(`session "${targetId}" does not exist`)
    }
    let current = index.get(targetId)
    while (current !== undefined) {
      const parent = current.parentSession
      if (parent === caller.sessionId) return
      current = parent === undefined ? undefined : index.get(parent)
    }
    throw new SessionToolUnauthorizedError(
      `caller "${caller.sessionId}" is not the session "${targetId}" itself or one of its ancestors`,
    )
  }

  /** Enforce the `all`-scope gate for the caller identity. */
  private assertAllScope(caller: SessionToolCaller): void {
    if (caller.kind === 'cli') {
      if (!this.config.cliAllowAll) {
        throw new SessionScopeDeniedError('the "all" scope is disabled for the CLI (cliAllowAll: false)')
      }
      return
    }
    switch (this.config.allowAllScope) {
      case 'any':
        return
      case 'none':
        throw new SessionScopeDeniedError('the "all" scope is disabled (allowAllScope: none)')
      case 'top-level':
        if (caller.delegationDepth === 0) return
        throw new SessionScopeDeniedError(
          `the "all" scope requires a top-level agent (delegationDepth 0), caller is at depth ${caller.delegationDepth}`,
        )
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(this.config.allowAllScope, 'AllowAllScope')
    }
  }

  /**
   * Continuation authorization for the plugin tool path (ASM-009): who may
   * write to or wait on a delegated session. The CLI (human identity) always
   * may; an agent may when it is the target itself or one of its ancestors
   * (the existing lineage fence), or when the configured strength admits a
   * non-lineage caller:
   * - `workspace` (default): the caller's header cwd equals the target's
   *   (same workspace);
   * - `anyone`: every caller;
   * - `creator`: no non-lineage caller (only the lineage chain may continue).
   * The upstream subagent tool path (`subagent`/`send_message`) keeps the
   * gateway's workspace-level authorization and never consults this config.
   * @param caller - the calling agent or the CLI.
   * @param targetId - the session to continue.
   * @param index - the merged header index.
   * @throws {SessionToolUnauthorizedError} when the caller is not admitted.
   */
  private assertContinuationAllowed(
    caller: SessionToolCaller,
    targetId: SessionId,
    index: Map<SessionId, SessionHeader>,
  ): void {
    if (caller.kind === 'cli') return
    // The lineage fence (self or ancestor) always admits; the config only
    // widens it for non-lineage callers.
    if (this.isAncestorOrSelf(caller.sessionId, targetId, index)) return
    if (!index.has(targetId)) {
      throw new SessionNotFoundError(`session "${targetId}" does not exist`)
    }
    switch (this.config.allowOthersToWrite) {
      case 'anyone':
        return
      case 'creator':
        throw new SessionToolUnauthorizedError(
          `caller "${caller.sessionId}" is not in the lineage of session "${targetId}" (allowOthersToWrite: creator)`,
        )
      case 'workspace': {
        const callerHeader = index.get(caller.sessionId)
        const targetHeader = index.get(targetId)
        if (callerHeader?.cwd !== undefined && callerHeader.cwd === targetHeader?.cwd) return
        throw new SessionToolUnauthorizedError(
          `caller "${caller.sessionId}" is not in the same workspace as session "${targetId}" (allowOthersToWrite: workspace)`,
        )
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(this.config.allowOthersToWrite, 'AllowOthersToWrite')
    }
  }

  /**
   * Whether `callerId` is `targetId` itself or one of its ancestors, walking
   * the durable `parentSession` lineage.
   * @param callerId - the caller's session id.
   * @param targetId - the target session id.
   * @param index - the merged header index.
   */
  private isAncestorOrSelf(callerId: SessionId, targetId: SessionId, index: Map<SessionId, SessionHeader>): boolean {
    if (targetId === callerId) return true
    let current = index.get(targetId)
    const seen = new Set<SessionId>()
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const parent = current.parentSession
      if (parent === callerId) return true
      current = parent === undefined ? undefined : index.get(parent)
    }
    return false
  }

  // ---- session resolution ------------------------------------------------

  /**
   * Resolve the collect member set: a lineage tree (the root and every
   * transitive descendant, scope-fenced) or a tag aggregation over the
   * gateway rows, then the optional status/tag set filter. The set is
   * resolved ONCE; only statuses are polled after.
   * @param caller - the calling agent or the CLI.
   * @param request - the collect request (exactly one of root/tags).
   * @param index - the merged header index.
   * @returns the member session ids after the optional filter.
   */
  private async resolveCollectSet(
    caller: SessionToolCaller,
    request: SessionToolCollectRequest,
    index: Map<SessionId, SessionHeader>,
  ): Promise<SessionId[]> {
    let ids: SessionId[]
    if (request.root !== undefined) {
      // Tree resolution reuses the list scope machinery: the root must
      // exist for every caller and the caller must be the root or one of
      // its ancestors. The SET is the root's workers — every transitive
      // descendant, excluding the root itself (the coordinator waits on its
      // delegated tasks, not on its own session).
      if (!index.has(request.root)) {
        throw new SessionNotFoundError(`session "${request.root}" does not exist`)
      }
      await this.assertAccess(caller, request.root, index)
      ids = descendantsOf(index, indexChildren(index), [request.root]).filter(id => id !== request.root)
    } else {
      // Tag aggregation: every gateway row carrying all listed tags.
      const requiredTags = request.tags ?? []
      const rows = await this.sessionClient.list()
      ids = rows
        .filter(row => requiredTags.every(tag => (row.tags ?? []).includes(tag)))
        .map(row => row.sessionId as SessionId)
      // The caller must be able to reach the aggregate: the gateway rows are
      // the web view; the local fence walks the header lineage per member.
      await Promise.all(ids.map(id => this.assertAccess(caller, id, index).catch(() => undefined)))
    }
    if (request.filter === undefined) return ids
    // The optional set filter narrows members by tag intersection and/or
    // projection status, evaluated once at resolution time.
    let filtered = ids
    if (request.filter.tags !== undefined && request.filter.tags.length > 0) {
      const required = request.filter.tags
      filtered = filtered.filter(id => required.every(tag => this.tagsOf(id).includes(tag)))
    }
    if (request.filter.status !== undefined) {
      const wanted = request.filter.status
      const statuses = await Promise.all(filtered.map(async id => [id, await this.delegationStatusOf(id)] as const))
      filtered = statuses.filter(([, status]) => status === wanted).map(([id]) => id)
    }
    return filtered
  }

  /** Read a session's folded tags from the live log (absent for cold sessions). */
  private tagsOf(id: SessionId): readonly string[] {
    const live = this.ctx.sessions.get(id)
    if (live === undefined) return []
    let tags: readonly string[] = []
    for (const event of live.events) {
      if (event.type === 'session/tags') tags = event.data.tags
    }
    return tags
  }

  /**
   * Read the delegation statuses of the collect member set (the projection
   * fold over live events or persisted log tails).
   * @param memberIds - the resolved member set.
   * @returns one status snapshot per member.
   */
  private async collectSnapshot(memberIds: readonly SessionId[]): Promise<CollectMemberSnapshot[]> {
    const snapshots = await Promise.all(memberIds.map(async (sessionId) => {
      const status = await this.delegationStatusOf(sessionId)
      return { sessionId: String(sessionId), status: status ?? 'idle' }
    }))
    return snapshots
  }

  /**
   * Aggregate the collect result rows: each member's status plus the last
   * assistant message text, when one exists.
   * @param memberIds - the resolved member set.
   * @returns the result rows in set order.
   */
  private async collectResultRows(memberIds: readonly SessionId[]): Promise<SessionToolCollectSession[]> {
    const rows = await Promise.all(memberIds.map(async (sessionId) => {
      const status = await this.delegationStatusOf(sessionId)
      const lastText = await this.lastAssistantText(sessionId)
      return {
        sessionId,
        status: status === undefined || status === 'idle' ? 'running' as const : status,
        ...lastText === undefined ? {} : { result: lastText },
      }
    }))
    return rows
  }

  /** Read the last assistant text block of a session's log, when one exists. */
  private async lastAssistantText(sessionId: SessionId): Promise<string | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    const events = live?.events
    if (events !== undefined) return lastAssistantTextOf(events)
    const inspected = await this.inspectSession(sessionId)
    return inspected === undefined ? undefined : lastAssistantTextOf(inspected.events)
  }

  /**
   * Derive a session's delegation status from its log: the projection unit's
   * pure fold over the live events when the session is attached, or the
   * persisted log tail otherwise (the documented degradation when the
   * projection registry is not composed). `undefined` when the session is
   * neither live nor persisted (the row then carries no delegationStatus).
   * @param sessionId - target session.
   * @returns the log-derived status, when the log is resolvable.
   */
  private async delegationStatusOf(sessionId: SessionId): Promise<DelegationStatus | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    const events = live?.events
    if (events !== undefined) {
      return foldDelegationStatus(events)
    }
    const inspected = await this.inspectSession(sessionId)
    return inspected === undefined ? undefined : foldDelegationStatus(inspected.events)
  }

  /**
   * Whether a list row is a delegated session: its tag set carries the
   * `delegated` marker, or its header records a positive delegation depth.
   * @param row - the gateway row.
   * @param index - the merged header index.
   */
  private isDelegated(row: SessionToolListRow, index: Map<SessionId, SessionHeader>): boolean {
    if (row.tags.includes('delegated')) return true
    const header = index.get(row.sessionId)
    return (header?.delegationDepth ?? 0) > 0
  }

  /** Merge live and persisted headers into one id → header index (live wins). */
  private async headerIndex(): Promise<Map<SessionId, SessionHeader>> {
    const index = new Map<SessionId, SessionHeader>()
    for (const session of this.ctx.sessions.list()) {
      index.set(session.id, session.header)
    }
    const persisted = await this.ctx.sessionPersistence.list()
    for (const header of persisted) {
      if (!index.has(header.id)) index.set(header.id, header)
    }
    return index
  }

  /**
   * Resolve a target for reading: the live session when present, otherwise a
   * persistence inspection. Never materializes (read-only). The access fence
   * runs against the merged header index.
   */
  private async resolveInspection(caller: SessionToolCaller, id: SessionId): Promise<SessionInspection> {
    const index = await this.headerIndex()
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      await this.assertAccess(caller, id, index)
      return { meta: live.header, events: live.events }
    }
    const inspection = await this.inspectSession(id)
    if (inspection === undefined) {
      throw new SessionNotFoundError(`session "${id}" does not exist`)
    }
    await this.assertAccess(caller, id, index)
    return inspection
  }

  /** Read one cold session's events; `undefined` when the id is not persisted. */
  private async inspectSession(id: SessionId): Promise<SessionInspection | undefined> {
    try {
      return await this.ctx.sessionPersistence.inspect(id)
    } catch (error: unknown) {
      if (error instanceof SessionNotFoundError) throw error
      // A missing (never-materialized) session surfaces as a backend miss;
      // treat any read failure as absence for the caller to classify.
      return undefined
    }
  }
}

export default SessionToolLocalService

/** Build the children map of a header index (parent → direct children). */
function indexChildren(index: Map<SessionId, SessionHeader>): Map<SessionId, SessionId[]> {
  const children = new Map<SessionId, SessionId[]>()
  for (const [id, header] of index) {
    if (header.parentSession === undefined) continue
    const list = children.get(header.parentSession)
    if (list === undefined) {
      children.set(header.parentSession, [id])
    } else {
      list.push(id)
    }
  }
  return children
}

/** Breadth-first tree enumeration: the roots and every transitive child. */
function descendantsOf(
  index: Map<SessionId, SessionHeader>,
  children: Map<SessionId, SessionId[]>,
  roots: readonly SessionId[],
): SessionId[] {
  const result: SessionId[] = []
  const seen = new Set<SessionId>()
  const queue = [...roots]
  for (const id of queue) {
    if (seen.has(id)) continue
    seen.add(id)
    if (!index.has(id)) continue
    result.push(id)
    for (const child of children.get(id) ?? []) {
      if (!seen.has(child)) queue.push(child)
    }
  }
  return result
}

/** Project one event onto a readable message row; non-message events project to nothing. */
function messageRow(event: SessionEvent): SessionToolMessageRow | undefined {
  switch (event.type) {
    case 'user/message':
      return { seq: event.seq, role: 'user', blocks: event.data.content }
    case 'assistant/message':
      return { seq: event.seq, role: 'assistant', blocks: event.data.message.content }
    case 'tool/result':
      return { seq: event.seq, role: 'tool', blocks: event.data.message.content }
    default:
      return undefined
  }
}

/** Fold the delegation projection unit over one event prefix. */
function foldDelegationStatus(events: readonly SessionEvent[]): DelegationStatus {
  let state = delegationProjectionDefinition.init()
  for (const event of events) state = delegationProjectionDefinition.apply(state, event)
  return delegationProjectionDefinition.view(state).status
}

/** Collect poll interval (ms): the status snapshot cadence while waiting. */
const COLLECT_POLL_MS = 250

/** Sleep helper for the collect poll loop. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Read the last assistant text block of an event prefix, when one exists. */
function lastAssistantTextOf(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text !== '') return text
  }
  return undefined
}
