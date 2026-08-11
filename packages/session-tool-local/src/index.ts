/**
 * Local provider for the session-tool Service Definition: implements
 * `ctx.sessionTool` over the DSH session stack — the live session store, the
 * session persistence backends (JSONL/SQLite), and the session title and tag
 * services. Zero new event types: every operation appends or folds DSH's
 * existing `user/message`, `session/title`, and `session/tags` events.
 * @module session-tool-local
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionTagsInvalidError, foldSessionTags, normalizeTags } from '@deepseek-ai/dsh-session-tags'
import { SessionTitleInvalidError, foldSessionTitle, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import {
  SessionEmptyContentError,
  SessionNotFoundError,
  SessionScopeDeniedError,
  SessionToolError,
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
  SessionToolWriteResult,
} from 'session-tool'

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
}

/** Cold persistence reads per listing; a constant bounds one read-only scan of local media. */
const COLD_READ_CONCURRENCY = 4

/** Wire code for title/tag validation failures translated from the owned services. */
const TITLE_INVALID_CODE = 'title-invalid' as const
const TAG_INVALID_CODE = 'tag-invalid' as const

/**
 * The local session-tool provider. Mounted as the `session-tool-local` plugin
 * row; Cordis provides `ctx.sessionTool` from this Service subclass.
 */
export class SessionToolLocalService extends Service implements SessionToolService {
  static inject = ['sessions', 'sessionPersistence', 'sessionTitle', 'sessionTags']

  static Config: z<Config> = z.object({
    allowAllScope: z.union([z.const('top-level'), z.const('any'), z.const('none')]).default('top-level'),
    cliAllowAll: z.boolean().default(true),
    readMaxBlocks: z.number().step(1).min(1).default(500),
    listMaxRows: z.number().step(1).min(1).default(100),
  })

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTool')
    this.config = Object.freeze({ ...config })
  }

  // ---- public contract ---------------------------------------------------

  async create(caller: SessionToolCaller, options: SessionToolCreateOptions): Promise<SessionToolCreateResult> {
    const index = await this.headerIndex()
    if (caller.kind === 'agent' && !index.has(caller.sessionId)) {
      throw new SessionNotFoundError(`caller session "${caller.sessionId}" is not in the session store`)
    }
    // Validate title/tags BEFORE the session exists, so a rejection leaves no
    // partially-initialized session behind (even in-memory).
    this.assertValidTitleTags(options.title, options.tags)
    if (options.parentSessionId !== undefined) {
      const parent = index.get(options.parentSessionId)
      if (parent === undefined) {
        throw new SessionNotFoundError(`parent session "${options.parentSessionId}" does not exist`)
      }
      this.assertCreateParent(caller, options.parentSessionId, index)
    }
    // The live store mints ids with a process-local counter, which collides
    // with persisted ids across processes; mint from the merged header index.
    // An agent caller's creations join its own tree by default (parent = the
    // caller), so the creator keeps owner-fence access and `own` scope lists
    // them; CLI creations are top-level sessions.
    const session = this.ctx.sessions.create(this.mintSessionId(index), {
      meta: {
        ...options.parentSessionId !== undefined
          ? { parentSession: options.parentSessionId }
          : caller.kind === 'agent'
            ? { parentSession: caller.sessionId }
            : {},
      },
    })
    try {
      if (options.title !== undefined) this.renameTitle(session, options.title)
      if (options.tags !== undefined) this.acceptTags(session, options.tags)
      await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      // The session stays live with whatever already committed; the caller
      // sees the failing validation loudly and may rename/tag it later.
      throw error
    }
    return { sessionId: session.id }
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
    const session = await this.materializeLive(caller, sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const event = session.append('user/message', message, { surfaceOp: 'append' })
    await this.ctx.sessions.flush(session)
    return { sessionId, seq: event.seq }
  }

  async list(caller: SessionToolCaller, filter: SessionToolListFilter): Promise<SessionToolListResult> {
    const index = await this.headerIndex()
    const scope = filter.scope ?? 'own'
    const children = indexChildren(index)
    let candidates: SessionId[]
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
      candidates = [...index.keys()]
    } else {
      assertNever(scope, 'SessionToolListScope')
    }

    const rows: SessionToolListRow[] = []
    await forEachConcurrent(candidates, COLD_READ_CONCURRENCY, async (id) => {
      const live = this.ctx.sessions.get(id)
      let events: readonly SessionEvent[]
      if (live !== undefined) {
        events = live.events
      } else {
        const inspection = await this.inspectSession(id)
        if (inspection === undefined) return
        events = inspection.events
      }
      const header = index.get(id)
      // Every candidate came from the index, so the header is present.
      /* v8 ignore next -- index and candidates are built from the same map. */
      if (header === undefined) return
      const title = foldSessionTitle(events)
      const tags = foldSessionTags(events)
      rows.push({
        sessionId: id,
        ...title === undefined ? {} : { title: title.title },
        tags: tags === undefined ? [] : [...tags.tags],
        status: live === undefined ? 'idle' : 'live',
        createdAt: header.createdAt,
      })
    })

    let visible = rows
    if (filter.includeHidden !== true) {
      visible = this.ctx.sessionTags.filterVisible(visible)
    }
    if (filter.status !== undefined) {
      visible = visible.filter(row => row.status === filter.status)
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
    // Pre-validate BOTH inputs before committing either, so an empty-title or
    // empty-tags rejection leaves the session untouched (no partial commit).
    this.assertValidTitleTags(options.title, options.tags)
    const session = await this.materializeLive(caller, sessionId)
    let title: string | undefined
    let tags: string[] | undefined
    if (options.title !== undefined) {
      const snapshot = this.renameTitle(session, options.title)
      title = snapshot.title
    }
    if (options.tags !== undefined) {
      const snapshot = this.acceptTags(session, options.tags)
      tags = [...snapshot.tags]
    }
    await this.ctx.sessions.flush(session)
    return {
      sessionId,
      ...title === undefined ? {} : { title },
      ...tags === undefined ? {} : { tags },
    }
  }

  // ---- fences ------------------------------------------------------------

  /**
   * Mint a session id absent from both the live store and persistence,
   * continuing the store's `session-<n>` series. The store's own minting is
   * process-local and would collide with persisted ids across processes.
   */
  private mintSessionId(index: Map<SessionId, SessionHeader>): SessionId {
    let max = 0
    for (const id of index.keys()) {
      const match = /^session-(\d+)$/.exec(id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    for (let n = max + 1; ; n += 1) {
      const candidate = SessionId(`session-${n}`)
      if (!index.has(candidate) && this.ctx.sessions.get(candidate) === undefined) return candidate
    }
  }

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

  /**
   * Materialize a target as LIVE (resume semantics): the live session when
   * present, otherwise persistence-prepared, entered, and announced. Cold
   * materialization publishes the session so persistence backends receive the
   * appended events through the ordinary `session/event` firehose.
   */
  private async materializeLive(caller: SessionToolCaller, id: SessionId): Promise<Session> {
    const index = await this.headerIndex()
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      await this.assertAccess(caller, id, index)
      return live
    }
    if (!index.has(id)) {
      throw new SessionNotFoundError(`session "${id}" does not exist`)
    }
    await this.assertAccess(caller, id, index)
    const preparation = await this.ctx.sessionPersistence.prepare(id)
    try {
      this.ctx.sessions.enter(preparation.session)
      this.ctx.sessions.announce(preparation.session)
      return preparation.session
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      throw error
    }
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

  // ---- owned-service adapters --------------------------------------------

  /**
   * Pre-validate title and tags input before ANY commit, so empty-title or
   * empty-tags rejections leave the target session untouched (no partial
   * commit). Limit-exceeded tags still fail inside the owned services, which
   * may leave an already-committed sibling (event sourcing has no rollback).
   */
  private assertValidTitleTags(title: string | undefined, tags: readonly string[] | undefined): void {
    if (title !== undefined && normalizeSessionTitle(title, Number.MAX_SAFE_INTEGER).length === 0) {
      throw new SessionToolError('session title must contain visible characters', TITLE_INVALID_CODE)
    }
    if (tags !== undefined) {
      try {
        normalizeTags(tags, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      } catch (error: unknown) {
        throw new SessionToolError(
          error instanceof Error ? error.message : 'invalid tag set',
          TAG_INVALID_CODE,
          { cause: error },
        )
      }
    }
  }

  /** Rename through session-title, mapping its validation failure onto the wire. */
  private renameTitle(session: Session, title: string): { title: string } {
    try {
      const snapshot = this.ctx.sessionTitle.rename(session, title)
      return { title: snapshot.title }
    } catch (error: unknown) {
      if (error instanceof SessionTitleInvalidError) {
        throw new SessionToolError(error.message, TITLE_INVALID_CODE, { cause: error })
      }
      throw error
    }
  }

  /** Accept tags through session-tags, mapping its validation failure onto the wire. */
  private acceptTags(session: Session, tags: readonly string[]): { tags: readonly string[] } {
    try {
      const snapshot = this.ctx.sessionTags.accept(session, tags)
      return { tags: snapshot.tags }
    } catch (error: unknown) {
      if (error instanceof SessionTagsInvalidError) {
        throw new SessionToolError(error.message, TAG_INVALID_CODE, { cause: error })
      }
      throw error
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

/** Run `task` over `items` with at most `limit` concurrent executions. */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push((async () => {
      while (true) {
        const index = next
        next += 1
        if (index >= items.length) return
        await task(items[index]!)
      }
    })())
  }
  await Promise.all(workers)
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
