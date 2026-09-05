// Wait settle: list.running + last turn/end from inspect / snapshotEvents.
// HTTP never posts a history RPC. Cold sessions with no turn/end stay idle.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionHttpClient } from '../src/session-client.ts'
import { InProcessSessionClient } from '../src/session-client-in-process.ts'
import { lastTurnEndReason, settleWait } from '../src/wait-settle.ts'
import type { InProcessSessionController, InProcessSessionPersistence, InProcessSessionStore } from '../src/session-client-in-process.ts'

const BASE = 'http://127.0.0.1:3180'

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    updatedAt: 1_700_000_000_000,
    running: false,
    blank: false,
    ...overrides,
  }
}

function stubFetch(handler: (
  url: URL,
  body: { rpcId: string; method: string; payload: unknown },
) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const raw = init?.body === undefined ? undefined : String(init.body)
    const body = raw === undefined
      ? { rpcId: '', method: '', payload: null }
      : JSON.parse(raw) as { rpcId: string; method: string; payload: unknown }
    return await handler(url, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function okResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const completedEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

describe('settleWait', () => {
  it('keeps polling while running for until idle', () => {
    expect(settleWait({
      running: true,
      lastTurnEndReason: undefined,
      until: 'idle',
    })).toBeUndefined()
  })

  it('reports idle for a cold session with no turn/end', () => {
    expect(settleWait({
      running: false,
      lastTurnEndReason: undefined,
      until: 'idle',
    })).toEqual({ status: 'idle' })
    expect(settleWait({
      running: false,
      lastTurnEndReason: undefined,
      until: 'turn-end',
    })).toEqual({ status: 'idle' })
  })

  it('maps the last turn/end once not running', () => {
    expect(settleWait({
      running: false,
      lastTurnEndReason: { kind: 'completed' },
      until: 'idle',
    })).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
    expect(settleWait({
      running: false,
      lastTurnEndReason: { kind: 'error' },
      until: 'idle',
    })).toEqual({ status: 'failed', lastTurnEndReason: { kind: 'error' } })
    expect(settleWait({
      running: false,
      lastTurnEndReason: { kind: 'interrupted' },
      until: 'idle',
    })).toEqual({ status: 'aborted', lastTurnEndReason: { kind: 'interrupted' } })
  })

  it('turn-end returns as soon as a reason exists', () => {
    expect(settleWait({
      running: true,
      lastTurnEndReason: { kind: 'completed' },
      until: 'turn-end',
    })).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
  })

  it('reads the last turn/end kind from an event prefix', () => {
    expect(lastTurnEndReason([
      { type: 'turn/start' },
      { type: 'turn/end', data: { reason: { kind: 'failed' } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])).toEqual({ kind: 'completed' })
    expect(lastTurnEndReason([{ type: 'user/message' }])).toBeUndefined()
  })
})

describe('SessionHttpClient.wait (list.running + inspect)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports completed from persistence inspect without a history RPC', async () => {
    const methods: string[] = []
    const fetchMock = stubFetch((url, body) => {
      methods.push(body.method)
      expect(url.pathname).not.toContain('history')
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const inspectEvents = vi.fn(async () => [completedEnd])
    const client = new SessionHttpClient(BASE, { inspectEvents })
    const result = await client.wait('session-1', { until: 'idle', timeoutMs: 5000 })
    expect(result).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
    expect(inspectEvents).toHaveBeenCalledWith('session-1')
    expect(methods).toEqual(['session/list'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports idle when inspect finds no turn/end on a cold session', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: false })] })
    })
    const client = new SessionHttpClient(BASE, { inspectEvents: async () => [] })
    const result = await client.wait('session-1', { until: 'turn-end', timeoutMs: 0 })
    expect(result).toEqual({ status: 'idle' })
  })

  it('times out while running even if inspect is empty', async () => {
    stubFetch((_url, body) => {
      expect(body.method).toBe('session/list')
      return okResponse(body.rpcId, { items: [summary({ running: true })] })
    })
    const client = new SessionHttpClient(BASE, { inspectEvents: async () => [] })
    const result = await client.wait('session-1', { timeoutMs: 0 })
    expect(result).toEqual({ status: 'timeout' })
  })
})

describe('InProcessSessionClient.wait (snapshotEvents)', () => {
  function controller(running: boolean): InProcessSessionController {
    return {
      create: async () => ({ sessionId: 'session-1' }),
      prompt: async () => ({ accepted: true }),
      cancel: () => ({ accepted: true }),
      rename: async ({ title }) => ({ title, seq: 1 }),
      list: async () => ({
        items: [{ sessionId: 'session-1', running, updatedAt: 1 }],
      }),
    }
  }

  it('reads turn/end from snapshotEvents without fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const sessions: InProcessSessionStore = {
      get: (id) => id === SessionId('session-1')
        ? { snapshotEvents: () => [completedEnd] }
        : undefined,
    }
    const persistence: InProcessSessionPersistence = {
      inspect: async () => ({ events: [] }),
    }
    const client = new InProcessSessionClient({
      sessionController: controller(false),
      sessions,
      sessionPersistence: persistence,
    })
    const result = await client.wait('session-1', { until: 'idle' })
    expect(result).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('falls back to persistence inspect when the session is not live', async () => {
    const persistence: InProcessSessionPersistence = {
      inspect: async () => ({ events: [completedEnd] }),
    }
    const client = new InProcessSessionClient({
      sessionController: controller(false),
      sessions: { get: () => undefined },
      sessionPersistence: persistence,
    })
    const result = await client.wait('session-1')
    expect(result).toEqual({ status: 'completed', lastTurnEndReason: { kind: 'completed' } })
  })

  it('reports idle for a cold session with no turn/end', async () => {
    const client = new InProcessSessionClient({
      sessionController: controller(false),
      sessions: { get: () => undefined },
      sessionPersistence: { inspect: async () => ({ events: [] }) },
    })
    const result = await client.wait('session-1', { until: 'turn-end' })
    expect(result).toEqual({ status: 'idle' })
  })
})
