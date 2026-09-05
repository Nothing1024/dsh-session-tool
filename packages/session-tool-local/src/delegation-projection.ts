/**
 * Delegation projection unit: the durable status of a delegated session,
 * folded from its log. This is the peer-session replacement for the subagent
 * Activation three-state: `running` while a turn is open, then the terminal
 * mapping of its `turn/end` reason, with the last assistant seq and prompt
 * count for result aggregation. Purely log-derived (BR-004): a restarted
 * process refolds the same events to the same state, so `session_list`
 * status filters and `session_collect` predicates survive restarts.
 *
 * The unit registers on `ctx.sessionProjections` when that service is
 * composed; a deployment without the registry simply has no projection cells
 * (callers degrade to log-tail reads).
 * @module session-tool-local
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Side-effect type import: carries the merge-extensible SessionProjectionMap
// table the `declare module` below augments.
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Terminal and transitional delegation statuses, derived from the log. */
export type DelegationStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'max-tokens'

/** The delegation projection's whole value (schema-validated wire payload). */
export interface DelegationProjection {
  /** Derived lifecycle status. */
  readonly status: DelegationStatus
  /** Kind of the last `turn/end` reason; absent before any turn ends. */
  readonly lastTurnEnd?: string
  /** Number of prompts (user-message turns) admitted so far. */
  readonly promptCount: number
  /** Seq of the last folded assistant message; absent before any reply. */
  readonly lastAssistantSeq?: number
}

/** Host fold state for the delegation projection (plain JSON, cacheable). */
export interface DelegationState {
  status: DelegationStatus
  lastTurnEnd?: string
  promptCount: number
  lastAssistantSeq?: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold state for {@link SessionProjectionMap.delegation}. */
    delegation: DelegationState
  }
  interface SessionProjectionMap {
    /** Log-derived delegation status of a session (BR-003/BR-004). */
    delegation: DelegationProjection
  }
}

const projectionSchema = z.object({
  status: z.union([
    z.literal('idle'), z.literal('running'), z.literal('completed'),
    z.literal('failed'), z.literal('aborted'), z.literal('max-tokens'),
  ]),
  lastTurnEnd: z.string().optional(),
  promptCount: z.number().int().nonnegative(),
  lastAssistantSeq: z.number().int().nonnegative().optional(),
}).strict() as unknown as z.ZodType<DelegationProjection>

const stateSchema = projectionSchema as unknown as z.ZodType<DelegationState>

/** State → wire payload; used by the unit, the log-tail fallback, and tests. */
export function viewDelegation(state: DelegationState): DelegationProjection {
  return {
    status: state.status,
    ...state.lastTurnEnd === undefined ? {} : { lastTurnEnd: state.lastTurnEnd },
    promptCount: state.promptCount,
    ...state.lastAssistantSeq === undefined ? {} : { lastAssistantSeq: state.lastAssistantSeq },
  }
}

/** Map a `turn/end` reason kind onto the delegation status vocabulary. */
function statusOfReason(kind: string): DelegationStatus {
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    default:
      // error, blocked, and unknown merge-extensible kinds: the turn did not
      // complete cleanly, so the delegation reports failure.
      return 'failed'
  }
}

/**
 * The delegation projection unit. `apply` is a pure synchronous fold: an
 * event it does not own returns the same state reference (zero downstream
 * work), and a changed status returns a new reference.
 */
export const delegationProjectionDefinition = {
  key: 'delegation' as const,
  // rc.7 `sessionProjections.snapshot` reads `schema.parse(view(state))`.
  // 0.1.1+ reads `stateSchema` + `wire.viewSchema`. Serve both so a mixed
  // profile (vibee on rc.7, this package on 0.1.1 types) does not 500 every
  // cold history page with `Cannot read properties of undefined (reading 'parse')`.
  schema: projectionSchema,
  view: viewDelegation,
  stateSchema,
  init: (_header, _inheritedEventCount): DelegationState => ({ status: 'idle', promptCount: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return state.status === 'running' ? state : { ...state, status: 'running' }
    }
    if (event.type === 'turn/end') {
      const status = statusOfReason(event.data.reason.kind)
      return state.status === status && state.lastTurnEnd === event.data.reason.kind
        ? state
        : { ...state, status, lastTurnEnd: event.data.reason.kind }
    }
    if (event.type === 'user/message') {
      return { ...state, promptCount: state.promptCount + 1 }
    }
    if (event.type === 'assistant/message') {
      const lastAssistantSeq = Number(event.seq)
      return state.lastAssistantSeq === lastAssistantSeq
        ? state
        : { ...state, lastAssistantSeq }
    }
    // Compaction is append-only in this codebase (`compact/start` /
    // `compact/end` enclose the summarized span; the log is never replaced),
    // so the fold needs no reset arm — the open turn stays `running` until
    // its own `turn/end`, exactly as before the compaction.
    return state
  },
  wire: { viewSchema: projectionSchema, view: viewDelegation },
  stateVersion: 1,
} satisfies ProjectionDefinition<'delegation', DelegationState> & {
  schema: typeof projectionSchema
  view: typeof viewDelegation
}
