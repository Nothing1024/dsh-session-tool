/**
 * Live session event access across dsh-session 0.1.2 (`snapshotEvents`) and
 * rc.7 (`events` getter).
 * @module session-tool-local
 */

/** One log event used by wait / read / collect. */
export interface LiveLogEvent {
  readonly type: string
  readonly seq?: number
  readonly data?: unknown
}

/**
 * Read the live log. 0.1.2 exposes `snapshotEvents()`; rc.7 exposes `events`.
 * Missing both yields an empty log so callers fall through to persistence.
 */
export function eventsOfLive(live: unknown): readonly LiveLogEvent[] {
  if (live === undefined || live === null || typeof live !== 'object') return []
  const rec = live as { snapshotEvents?: unknown; events?: unknown }
  if (typeof rec.snapshotEvents === 'function') {
    return rec.snapshotEvents.call(live) as readonly LiveLogEvent[]
  }
  if (Array.isArray(rec.events)) return rec.events as readonly LiveLogEvent[]
  return []
}

/** Seed-event count: 0.1.2 `inheritedEventCount`, rc.7 `firstLiveSeq`. */
export function inheritedOfLive(live: unknown): number {
  if (live === undefined || live === null || typeof live !== 'object') return 0
  const rec = live as { inheritedEventCount?: unknown; firstLiveSeq?: unknown }
  if (typeof rec.inheritedEventCount === 'number' && Number.isFinite(rec.inheritedEventCount)) {
    return rec.inheritedEventCount
  }
  if (typeof rec.firstLiveSeq === 'number' && Number.isFinite(rec.firstLiveSeq)) {
    return rec.firstLiveSeq
  }
  return 0
}
