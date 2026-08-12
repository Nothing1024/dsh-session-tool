/**
 * The collection-constraint evaluator: a pure, declarative "may I return
 * yet" predicate over a snapshot of delegation statuses (ASM-007). It never
 * builds dependency graphs, schedules work, or retries — those belong to the
 * future flow ecosystem. `session_collect` polls session statuses and feeds
 * each snapshot to {@link evaluateCollectPredicate}; only the poll loop (in
 * the service) owns waiting and cancellation.
 *
 * @module session-tool-local
 */

import type { SessionToolCollectWait } from 'session-tool'

/** One member's status snapshot for the predicate. */
export interface CollectMemberSnapshot {
  /** The member session id. */
  readonly sessionId: string
  /** Log-derived delegation status; `running` while a turn is open. */
  readonly status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted' | 'max-tokens'
}

/** Whether a status is terminal (the predicate counts only terminal members). */
export function isTerminalStatus(status: CollectMemberSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted' || status === 'max-tokens'
}

/**
 * Evaluate one completion predicate over a status snapshot. Pure and
 * synchronous: same snapshot + same predicate → same decision.
 * @param members - the current status snapshot of the collected set.
 * @param wait - the completion predicate.
 * @param n - member count required by `wait: 'n'` (ignored otherwise).
 * @returns whether the predicate holds on this snapshot.
 */
export function evaluateCollectPredicate(
  members: readonly CollectMemberSnapshot[],
  wait: SessionToolCollectWait,
  n: number | undefined,
): boolean {
  const terminal = members.filter(member => isTerminalStatus(member.status))
  switch (wait) {
    case 'all':
      return members.length > 0 && terminal.length === members.length
    case 'any':
      return terminal.length >= 1
    case 'n':
      // An absent or invalid n never satisfies: the caller must name a
      // positive count for the n predicate.
      return n !== undefined && n >= 1 && terminal.length >= n
    case 'first-failed':
      return terminal.some(member => member.status === 'failed')
  }
}
