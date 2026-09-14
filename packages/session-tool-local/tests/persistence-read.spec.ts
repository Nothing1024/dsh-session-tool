import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  headerOfListItem,
  inspectPersistedSession,
  listPersistedHeaders,
} from '../src/persistence-read.ts'

const HEADER: SessionHeader = {
  version: 0 as SessionHeader['version'],
  id: SessionId('session-1'),
  createdAt: 1,
  isSeeded: false,
}

const EVENTS = [{ type: 'turn/end', seq: 0, data: { reason: { kind: 'completed' } } }] as unknown as SessionEvent[]

describe('headerOfListItem', () => {
  it('accepts a bare header and a 0.1.5 snapshot', () => {
    expect(headerOfListItem(HEADER)?.id).toBe('session-1')
    expect(headerOfListItem({ header: HEADER, revision: 'r1' })?.id).toBe('session-1')
    expect(headerOfListItem({ revision: 'r1' })).toBeUndefined()
    expect(headerOfListItem(undefined)).toBeUndefined()
  })
})

describe('listPersistedHeaders', () => {
  it('returns empty when list is missing', async () => {
    expect(await listPersistedHeaders({})).toEqual([])
    expect(await listPersistedHeaders(undefined)).toEqual([])
  })

  it('unwraps mixed list rows', async () => {
    const persistence = {
      list: async () => [HEADER, { header: { ...HEADER, id: SessionId('session-2') } }, { revision: 'x' }],
    }
    const headers = await listPersistedHeaders(persistence)
    expect(headers.map(row => String(row.id))).toEqual(['session-1', 'session-2'])
  })
})

describe('inspectPersistedSession', () => {
  it('prefers inspect when present', async () => {
    const open = vi.fn()
    const persistence = {
      inspect: async () => ({ meta: HEADER, events: EVENTS, inheritedEventCount: 0 }),
      open,
    }
    const inspected = await inspectPersistedSession(persistence, SessionId('session-1'))
    expect(inspected?.events).toEqual(EVENTS)
    expect(open).not.toHaveBeenCalled()
  })

  it('treats inspect failure as absence', async () => {
    const persistence = {
      inspect: async () => {
        throw new Error('not found')
      },
    }
    expect(await inspectPersistedSession(persistence, SessionId('missing'))).toBeUndefined()
  })

  it('reads and closes a 0.1.5 handle when inspect is absent', async () => {
    const close = vi.fn(async () => undefined)
    const persistence = {
      open: async () => ({
        header: HEADER,
        inheritedEventCount: 2,
        read: async () => ({ events: EVENTS }),
        close,
      }),
    }
    const inspected = await inspectPersistedSession(persistence, SessionId('session-1'))
    expect(inspected).toEqual({ meta: HEADER, events: EVENTS, inheritedEventCount: 2 })
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the handle when read throws', async () => {
    const close = vi.fn(async () => undefined)
    const persistence = {
      open: async () => ({
        header: HEADER,
        inheritedEventCount: 0,
        read: async () => {
          throw new Error('torn log')
        },
        close,
      }),
    }
    expect(await inspectPersistedSession(persistence, SessionId('session-1'))).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns undefined when open refuses the id', async () => {
    const persistence = {
      open: async () => {
        throw new Error('SessionPersistenceNotFoundError')
      },
    }
    expect(await inspectPersistedSession(persistence, SessionId('missing'))).toBeUndefined()
  })
})
