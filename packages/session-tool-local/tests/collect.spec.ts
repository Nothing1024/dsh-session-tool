// Collect constraint evaluator: the pure predicate matrix (all/any/n/
// first-failed), terminal-status classification, and the declarative
// boundary — same snapshot + same predicate → same decision, no scheduling.
import { describe, expect, it } from 'vitest'
import { evaluateCollectPredicate, isTerminalStatus } from '../src/collect.ts'
import type { CollectMemberSnapshot } from '../src/collect.ts'

const running: CollectMemberSnapshot = { sessionId: 'a', status: 'running' }
const idle: CollectMemberSnapshot = { sessionId: 'b', status: 'idle' }
const done: CollectMemberSnapshot = { sessionId: 'c', status: 'completed' }
const failed: CollectMemberSnapshot = { sessionId: 'd', status: 'failed' }
const aborted: CollectMemberSnapshot = { sessionId: 'e', status: 'aborted' }
const maxTokens: CollectMemberSnapshot = { sessionId: 'f', status: 'max-tokens' }

describe('isTerminalStatus', () => {
  it('classifies terminal and transitional statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('aborted')).toBe(true)
    expect(isTerminalStatus('max-tokens')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('idle')).toBe(false)
  })
})

describe('evaluateCollectPredicate', () => {
  it('all: every member terminal, empty set never satisfied', () => {
    expect(evaluateCollectPredicate([done, failed, aborted, maxTokens], 'all', undefined)).toBe(true)
    expect(evaluateCollectPredicate([done, running], 'all', undefined)).toBe(false)
    expect(evaluateCollectPredicate([], 'all', undefined)).toBe(false)
  })

  it('any: at least one terminal member', () => {
    expect(evaluateCollectPredicate([running, done], 'any', undefined)).toBe(true)
    expect(evaluateCollectPredicate([running, idle], 'any', undefined)).toBe(false)
  })

  it('n: at least n terminal members; absent or non-positive n never satisfies', () => {
    expect(evaluateCollectPredicate([done, failed, running], 'n', 2)).toBe(true)
    expect(evaluateCollectPredicate([done, running], 'n', 2)).toBe(false)
    expect(evaluateCollectPredicate([done], 'n', undefined)).toBe(false)
    expect(evaluateCollectPredicate([done, failed], 'n', 0)).toBe(false)
    expect(evaluateCollectPredicate([done, failed], 'n', -1)).toBe(false)
  })

  it('first-failed: any failed member satisfies', () => {
    expect(evaluateCollectPredicate([done, failed], 'first-failed', undefined)).toBe(true)
    expect(evaluateCollectPredicate([done, aborted], 'first-failed', undefined)).toBe(false)
    expect(evaluateCollectPredicate([running], 'first-failed', undefined)).toBe(false)
  })

  it('is pure: the same snapshot yields the same decision every time', () => {
    const snapshot = [running, done, failed]
    const first = evaluateCollectPredicate(snapshot, 'all', undefined)
    const second = evaluateCollectPredicate(snapshot, 'all', undefined)
    expect(second).toBe(first)
  })
})
