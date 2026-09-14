/**
 * Cold persistence reads across DSH 0.1.2 (`inspect` + `list(): SessionHeader[]`)
 * and 0.1.5 (`open(id, 'read')` + `list(): SessionPersistenceSnapshot[]`).
 *
 * Dependents (vibee rc.7, dsh-bot 0.1.2) still compile: this module never
 * names the deleted `inspect` method on the official type.
 * @module session-tool-local
 */

import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { LiveLogEvent } from './live-events.ts'

/** One cold-session log used by read / wait / collect. */
export interface PersistedInspection {
  readonly meta?: SessionHeader
  readonly events: readonly LiveLogEvent[]
  readonly inheritedEventCount?: number
}

/** 0.1.5 write/read handle subset used for cold inspect. */
interface PersistenceHandle {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  read(offset?: number, length?: number): Promise<{ readonly events: readonly LiveLogEvent[] }>
  close(): Promise<void>
}

/** Duck-typed persistence service: old inspect, new open, list of either shape. */
interface PersistenceSurface {
  inspect?: (id: SessionId, signal?: AbortSignal) => Promise<PersistedInspection>
  open?: (id: SessionId, access: 'read' | 'write') => Promise<PersistenceHandle>
  list?: (arg?: unknown) => Promise<readonly unknown[]>
}

/** Unwrap a `list()` row: a header, or a 0.1.5 `{ header }` snapshot. */
export function headerOfListItem(item: unknown): SessionHeader | undefined {
  if (item === undefined || item === null || typeof item !== 'object' || Array.isArray(item)) {
    return undefined
  }
  const record = item as { id?: unknown; header?: unknown }
  const nested = record.header
  if (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const header = nested as { id?: unknown }
    if (typeof header.id === 'string') return nested as SessionHeader
  }
  if (typeof record.id === 'string') return item as SessionHeader
  return undefined
}

/** Every persisted header visible to this process (live store is merged by the caller). */
export async function listPersistedHeaders(persistence: unknown): Promise<readonly SessionHeader[]> {
  const list = (persistence as PersistenceSurface | undefined)?.list
  if (typeof list !== 'function') return []
  const listed = await list.call(persistence)
  const headers: SessionHeader[] = []
  for (const item of listed) {
    const header = headerOfListItem(item)
    if (header !== undefined) headers.push(header)
  }
  return headers
}

/**
 * Read one cold session. Prefer `inspect` (0.1.2 / test fakes); else a
 * read-only handle (0.1.5). Missing ids and backend refusals are `undefined`
 * so the caller can classify not-found vs unauthorized.
 */
export async function inspectPersistedSession(
  persistence: unknown,
  id: SessionId,
): Promise<PersistedInspection | undefined> {
  const surface = persistence as PersistenceSurface | undefined
  if (typeof surface?.inspect === 'function') {
    try {
      return await surface.inspect(id)
    } catch {
      return undefined
    }
  }
  if (typeof surface?.open !== 'function') return undefined
  let handle: PersistenceHandle | undefined
  try {
    handle = await surface.open(id, 'read')
    const { events } = await handle.read()
    return {
      meta: handle.header,
      events,
      inheritedEventCount: handle.inheritedEventCount,
    }
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Already closed, or the backend refused teardown.
      }
    }
  }
}
