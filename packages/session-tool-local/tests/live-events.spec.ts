import { describe, expect, it } from 'vitest'
import { eventsOfLive, inheritedOfLive } from '../src/live-events.ts'

describe('eventsOfLive', () => {
  it('prefers snapshotEvents when present', () => {
    const events = [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
    expect(eventsOfLive({ snapshotEvents: () => events, events: [] })).toEqual(events)
  })

  it('reads rc.7 events getter when snapshotEvents is missing', () => {
    const events = [{ type: 'assistant/message' }]
    expect(eventsOfLive({ events })).toEqual(events)
  })

  it('returns empty when neither API exists', () => {
    expect(eventsOfLive({})).toEqual([])
    expect(eventsOfLive(undefined)).toEqual([])
  })
})

describe('inheritedOfLive', () => {
  it('prefers inheritedEventCount then firstLiveSeq', () => {
    expect(inheritedOfLive({ inheritedEventCount: 2, firstLiveSeq: 9 })).toBe(2)
    expect(inheritedOfLive({ firstLiveSeq: 4 })).toBe(4)
    expect(inheritedOfLive({})).toBe(0)
  })
})
