/**
 * Wait settle from list `running` plus the last `turn/end` on a local
 * snapshot or persistence inspect. Shared by HTTP and in-process clients
 * (BR-005). A cold session with no turn/end is idle.
 * @module session-tool-local
 */

/** Wait-until vocabulary used by session wait. */
export type WaitUntil = 'idle' | 'turn-end'

/** Terminal wait status (timeout is owned by the poll loop). */
export type WaitSettleStatus = 'idle' | 'completed' | 'failed' | 'aborted'

/** One settle cut; `undefined` means the wait should keep polling. */
export interface WaitSettle {
  readonly status: WaitSettleStatus
  readonly lastTurnEndReason?: { readonly kind: string }
}

/** Event shape wait reads (`turn/end` reason.kind). */
export interface WaitEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * Last `turn/end` reason on an event prefix. `undefined` when none has
 * ended (cold session / empty inspect).
 */
export function lastTurnEndReason(events: readonly WaitEvent[]): { kind: string } | undefined {
  let found: { kind: string } | undefined
  for (const event of events) {
    const kind = turnEndKind(event)
    if (kind !== undefined) found = { kind }
  }
  return found
}

/**
 * One list/event cut. `until: 'idle'` waits while `running`; `turn-end`
 * returns as soon as a reason exists, else idle when not running.
 */
export function settleWait(input: {
  readonly running: boolean
  readonly lastTurnEndReason: { readonly kind: string } | undefined
  readonly until: WaitUntil
}): WaitSettle | undefined {
  const reason = input.lastTurnEndReason
  if (input.until === 'turn-end') {
    if (reason === undefined) return input.running ? undefined : { status: 'idle' }
    return { status: statusFromTurnEnd(reason.kind), lastTurnEndReason: reason }
  }
  if (input.running) return undefined
  if (reason === undefined) return { status: 'idle' }
  return { status: statusFromTurnEnd(reason.kind), lastTurnEndReason: reason }
}

/** Map a `turn/end` reason kind onto the wait status vocabulary. */
export function statusFromTurnEnd(kind: string): Exclude<WaitSettleStatus, 'idle'> {
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted' || kind === 'interrupted') return 'aborted'
  return 'failed'
}

function turnEndKind(event: WaitEvent): string | undefined {
  if (event.type !== 'turn/end') return undefined
  if (event.data === null || typeof event.data !== 'object') return undefined
  const kind = (event.data as { reason?: { kind?: unknown } }).reason?.kind
  return typeof kind === 'string' ? kind : undefined
}
