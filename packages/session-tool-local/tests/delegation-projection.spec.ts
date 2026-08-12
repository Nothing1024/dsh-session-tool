// Delegation projection unit: log-fold status derivation, terminal reason
// mapping, prompt/assistant tracking, identity-preserving no-op events, and
// restart replay (the same fold over the same events yields the same state).
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { delegationProjectionDefinition } from '../src/delegation-projection.ts'
import type { DelegationProjection } from '../src/delegation-projection.ts'

const sid = (id: string): SessionId => id as SessionId

let nextSeq = 0
function event(type: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}): SessionEvent {
  const base = { type, seq: nextSeq++, time: nextSeq, data }
  return { ...base, ...overrides } as SessionEvent
}

function turnStart(turn: number): SessionEvent {
  return event('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
}

function turnEnd(turn: number, reasonKind: string, extra: Record<string, unknown> = {}): SessionEvent {
  return event('turn/end', { turn, reason: { kind: reasonKind, ...extra } })
}

function userMessage(): SessionEvent {
  return event('user/message', { content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
}

function assistantMessage(seq: number): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } },
  }, { surfaceOp: 'append', seq })
}

function fold(events: readonly SessionEvent[]): DelegationProjection {
  let state = delegationProjectionDefinition.init()
  for (const item of events) state = delegationProjectionDefinition.apply(state, item)
  return delegationProjectionDefinition.view(state)
}

describe('delegation projection', () => {
  it('starts idle with zero prompts and no turn end', () => {
    expect(fold([])).toEqual({ status: 'idle', promptCount: 0 })
  })

  it('moves to running on turn/start and completes on a completed turn/end', () => {
    const events = [turnStart(1), userMessage(), assistantMessage(3), turnEnd(1, 'completed')]
    const value = fold(events)
    expect(value).toEqual({
      status: 'completed',
      lastTurnEnd: 'completed',
      promptCount: 1,
      lastAssistantSeq: 3,
    })
  })

  it('maps error to failed and aborted to aborted', () => {
    expect(fold([turnStart(1), turnEnd(1, 'error', { error: { message: 'boom', code: 'X' } })])).toMatchObject({
      status: 'failed',
      lastTurnEnd: 'error',
    })
    expect(fold([turnStart(1), turnEnd(1, 'aborted', { reason: { kind: 'user' } })])).toMatchObject({
      status: 'aborted',
      lastTurnEnd: 'aborted',
    })
    expect(fold([turnStart(1), turnEnd(1, 'max-tokens')])).toMatchObject({
      status: 'max-tokens',
      lastTurnEnd: 'max-tokens',
    })
  })

  it('counts prompts across turns and tracks the latest assistant seq', () => {
    const events = [
      turnStart(1), userMessage(), assistantMessage(3), turnEnd(1, 'completed'),
      turnStart(2), userMessage(), assistantMessage(9), turnEnd(2, 'completed'),
    ]
    const value = fold(events)
    expect(value.promptCount).toBe(2)
    expect(value.lastAssistantSeq).toBe(9)
    expect(value.status).toBe('completed')
  })

  it('returns the same state reference for unrelated events (zero downstream work)', () => {
    const state = delegationProjectionDefinition.init()
    const unrelated = event('session/tags', { tags: ['a'] })
    expect(delegationProjectionDefinition.apply(state, unrelated)).toBe(state)
    const title = event('session/title', { title: 't' })
    expect(delegationProjectionDefinition.apply(state, title)).toBe(state)
  })

  it('does not double-count a repeated assistant seq', () => {
    const state = delegationProjectionDefinition.init()
    const running = delegationProjectionDefinition.apply(state, turnStart(1))
    const first = delegationProjectionDefinition.apply(running, assistantMessage(5))
    const again = delegationProjectionDefinition.apply(first, assistantMessage(5))
    expect(again).toBe(first)
  })

  it('replays the same events to the same state after a restart (BR-004)', () => {
    const events = [
      turnStart(1), userMessage(), assistantMessage(3), turnEnd(1, 'completed'),
    ]
    const first = fold(events)
    // A restarted process refolds from the same durable events.
    const second = fold(events)
    expect(second).toEqual(first)
    expect(second.status).toBe('completed')
    expect(second.promptCount).toBe(1)
  })

  it('keeps running through append-only compaction events until turn/end', () => {
    const events = [
      turnStart(1), userMessage(), assistantMessage(2),
      event('compact/start', { compactionId: 'c1', turn: 1 }),
      event('compact/end', { compactionId: 'c1', turn: 1 }),
      turnEnd(1, 'completed'),
    ]
    expect(fold(events).status).toBe('completed')
  })
})
