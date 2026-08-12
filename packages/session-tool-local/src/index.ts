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

import { Context, Service } from 'cordis'
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

/** `all` scope gate levels for agent callers. */
export type AllowAllScope = 'top-level' | 'any' | 'none'

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
    // top-level sessions unless a parent is named.
    const created = await this.sessionClient.durableCreate({
      ...options.title === undefined ? {} : { title: options.title },
      ...options.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : caller.kind === 'agent'
          ? { parentSessionId: caller.sessionId }
          : {},
      ...options.tags === undefined ? {} : { tags: options.tags },
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
    await this.assertAccess(caller, sessionId, index)
    await this.sessionClient.prompt(sessionId, text)
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

  // ---- session resolution ------------------------------------------------

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
