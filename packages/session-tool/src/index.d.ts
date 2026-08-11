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
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
/**
 * Identity of one service caller. Agent callers carry the exact session id of
 * the calling agent (`Agent.id`) and the delegation depth recorded in that
 * session's header; the CLI calls as `cli` (human identity) and is exempt from
 * the owner fence.
 */
export type SessionToolCaller = {
    readonly kind: 'agent';
    readonly sessionId: SessionId;
    readonly delegationDepth: number;
} | {
    readonly kind: 'cli';
};
/** Options for {@link SessionToolService.create}. */
export interface SessionToolCreateOptions {
    /** Explicit title; pins the title and stops automatic generation. */
    readonly title?: string;
    /**
     * Durable parent lineage recorded in the new header (`parentSession`). The
     * parent must be the caller itself or one of its ancestors.
     */
    readonly parentSessionId?: SessionId;
    /** Tag set accepted immediately after creation (last-wins replace). */
    readonly tags?: readonly string[];
}
/** Result of {@link SessionToolService.create}. */
export interface SessionToolCreateResult {
    /** The minted session id. */
    readonly sessionId: SessionId;
}
/** One readable message row of a session transcript. */
export interface SessionToolMessageRow {
    /** Source event sequence number. */
    readonly seq: number;
    /** `tool` covers `tool/result` events; user-role injected context stays `user`. */
    readonly role: 'user' | 'assistant' | 'tool';
    /** The message's model-facing content blocks, exactly as logged. */
    readonly blocks: readonly ContentBlock[];
}
/** Options for {@link SessionToolService.read}. */
export interface SessionToolReadOptions {
    /** First event seq to include (incremental read). */
    readonly sinceSeq?: number;
    /** Row cap, clamped to the provider's configured maximum. */
    readonly maxBlocks?: number;
}
/** Result of {@link SessionToolService.read}. */
export interface SessionToolReadResult {
    /** The read session id. */
    readonly sessionId: SessionId;
    /** Message rows in log order. */
    readonly messages: readonly SessionToolMessageRow[];
}
/** Result of {@link SessionToolService.write}. */
export interface SessionToolWriteResult {
    /** The written session id. */
    readonly sessionId: SessionId;
    /** Sequence number of the appended `user/message` event. */
    readonly seq: number;
}
/** Listing scopes: the caller's own tree, one named tree, or every materialized session. */
export type SessionToolListScope = 'own' | 'tree' | 'all';
/** Filter for {@link SessionToolService.list}. */
export interface SessionToolListFilter {
    /** Listing scope; defaults to `own`. */
    readonly scope?: SessionToolListScope;
    /** Tree root for scope `tree`; the caller must be the root or one of its ancestors. */
    readonly sessionId?: SessionId;
    /** Rows must carry every listed tag (intersection against the folded tag set). */
    readonly tags?: readonly string[];
    /** Case-sensitive substring filter on the durable title. */
    readonly title?: string;
    /** Only live or only idle sessions. */
    readonly status?: 'live' | 'idle';
    /** Exemption from the hidden-prefix filter (default `false`: hidden rows are excluded). */
    readonly includeHidden?: boolean;
    /** Opaque pagination cursor returned by a previous call. */
    readonly cursor?: string;
    /** Row cap, clamped to the provider's configured maximum. */
    readonly limit?: number;
}
/** One session list row. */
export interface SessionToolListRow {
    /** The session id. */
    readonly sessionId: SessionId;
    /** Durable title, when one has been accepted. */
    readonly title?: string;
    /** Folded tag set (empty before any accepted set). */
    readonly tags: readonly string[];
    /** `live` while the session is in this process's store, `idle` otherwise. */
    readonly status: 'live' | 'idle';
    /** Creation timestamp from the session header. */
    readonly createdAt: number;
}
/** Result of {@link SessionToolService.list}. */
export interface SessionToolListResult {
    /** Visible rows in creation order (ties broken on id). */
    readonly sessions: readonly SessionToolListRow[];
    /** Opaque cursor for the next page, present when more rows remain. */
    readonly nextCursor?: string;
}
/** Options for {@link SessionToolService.rename}. */
export interface SessionToolRenameOptions {
    /** Explicit title; pins the title and stops automatic generation. */
    readonly title?: string;
    /** Tag set (last-wins replace of the folded set). */
    readonly tags?: readonly string[];
}
/** Result of {@link SessionToolService.rename}. */
export interface SessionToolRenameResult {
    /** The renamed session id. */
    readonly sessionId: SessionId;
    /** The accepted title, when a title was requested. */
    readonly title?: string;
    /** The accepted tag set, when tags were requested. */
    readonly tags?: readonly string[];
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
    create(caller: SessionToolCaller, options: SessionToolCreateOptions): Promise<SessionToolCreateResult>;
    /**
     * Read a session's transcript.
     * @param caller - the calling agent or the CLI.
     * @param sessionId - target session; the caller must be the session itself
     *   or one of its ancestors.
     * @param options - incremental boundary and row cap.
     * @returns the message rows in log order.
     */
    read(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolReadOptions): Promise<SessionToolReadResult>;
    /**
     * Append one user prompt to a session's log.
     * @param caller - the calling agent or the CLI.
     * @param sessionId - target session; the caller must be the session itself
     *   or one of its ancestors.
     * @param content - non-empty prompt text.
     * @returns the session id and the appended event's seq.
     */
    write(caller: SessionToolCaller, sessionId: SessionId, content: string): Promise<SessionToolWriteResult>;
    /**
     * List sessions under a scope, filtered and paginated.
     * @param caller - the calling agent or the CLI.
     * @param filter - scope, tree root, tag/title/status filters, hidden
     *   exemption, cursor, and limit.
     * @returns the visible rows and the next cursor.
     */
    list(caller: SessionToolCaller, filter: SessionToolListFilter): Promise<SessionToolListResult>;
    /**
     * Rename a session and/or replace its tag set.
     * @param caller - the calling agent or the CLI.
     * @param sessionId - target session; the caller must be the session itself
     *   or one of its ancestors.
     * @param options - at least one of title or tags.
     * @returns the accepted title and/or tags.
     */
    rename(caller: SessionToolCaller, sessionId: SessionId, options: SessionToolRenameOptions): Promise<SessionToolRenameResult>;
}
declare module 'cordis' {
    interface Context {
        sessionTool: SessionToolService;
    }
}
/** Wire codes carried by {@link SessionToolError} instances. */
export type SessionToolErrorCode = 'session-not-found' | 'unauthorized' | 'scope-denied' | 'empty-content' | 'limit-exceeded' | 'title-invalid' | 'tag-invalid';
/**
 * Typed failure for the session-tool seam. The code is the stable
 * machine-routable wire value (mirrors `HarnessError.code`); subclass names
 * come from `HarnessError`'s `new.target` naming.
 */
export declare class SessionToolError extends HarnessError {
    constructor(message: string, code: SessionToolErrorCode, options?: ErrorOptions);
}
/** The target session does not exist (live store or persistence). */
export declare class SessionNotFoundError extends SessionToolError {
    constructor(message: string, options?: ErrorOptions);
}
/** The caller is not the target session itself or one of its ancestors. */
export declare class SessionToolUnauthorizedError extends SessionToolError {
    constructor(message: string, options?: ErrorOptions);
}
/** A scope gate (or a scope/caller mismatch) rejected the call. */
export declare class SessionScopeDeniedError extends SessionToolError {
    constructor(message: string, options?: ErrorOptions);
}
/** The caller supplied empty content where non-empty input is required. */
export declare class SessionEmptyContentError extends SessionToolError {
    constructor(message: string, options?: ErrorOptions);
}
/** A configured bound (read rows, list rows) was exceeded or rejected. */
export declare class SessionLimitError extends SessionToolError {
    constructor(message: string, options?: ErrorOptions);
}
//# sourceMappingURL=index.d.ts.map