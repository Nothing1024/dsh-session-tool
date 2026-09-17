import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { SessionToolService } from 'session-tool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

describe('official Connection integration', () => {
  let ctx: Context | undefined
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await ctx?.fiber.dispose()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  })

  async function setup() {
    ctx = new Context()
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
    ctx.provide('credentials', {
      modifyRecord: async (_key: unknown, update: (value: undefined) => Promise<unknown>) => update(undefined),
    })
    ctx.provide('webServer', { register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    } })
    const service = {
      list: vi.fn().mockResolvedValue({ sessions: [] }),
      read: vi.fn().mockResolvedValue({ sessionId: 'session-1', messages: [] }),
      getVisibility: vi.fn().mockResolvedValue({ hasHiddenMark: false, archived: false, isHidden: false }),
      readMarks: vi.fn().mockResolvedValue({ sessionId: 'session-1', tags: ['form:plugin'], hiddenPrefixes: ['~'] }),
      write: vi.fn().mockResolvedValue({ sessionId: 'session-1' }), cancel: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      hide: vi.fn().mockResolvedValue(undefined), unhide: vi.fn().mockResolvedValue(undefined),
    }
    ctx.provide('sessionTool', service)
    await ctx.plugin(Connection)
    ctx.connection.rpc.intercept('/api', endpoint => endpoint === 'official/list', async () => ({ ok: true, value: 'official' }))
    const fiber = await ctx.plugin(plugin)
    await vi.waitFor(() => expect(routes.has('/api')).toBe(true))
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/')) void routes.get('/api')!(req, res)
      else if (ctx!.connection.authorizeIndex(req, res)) res.end('ready')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing test port')
    const origin = `http://127.0.0.1:${address.port}`
    const response = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const rpc = (endpoint: string, payload: unknown, headers: Record<string, string> = { cookie }) => fetch(`${origin}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: endpoint, payload }),
    })
    return { service, rpc, cookie, fiber, origin }
  }

  it('uses the authenticated carrier and coexists with the official RPC interceptor', async () => {
    const { service, rpc, cookie } = await setup()
    expect((await rpc('session-tool/list', {}, {})).status).toBe(401)
    expect((await rpc('session-tool/list', {}, { cookie, origin: 'https://untrusted.example' })).status).toBe(403)
    expect(service.list).not.toHaveBeenCalled()
    expect(await (await rpc('official/list', {})).json()).toMatchObject({ result: { ok: true, value: 'official' } })
    expect(await (await rpc('session-tool/list', { origin: 'delegated' })).json()).toMatchObject({ result: { ok: true, value: { sessions: [] } } })
    expect(service.list).toHaveBeenCalledWith({ kind: 'web' }, { scope: 'all', limit: 50, origin: 'delegated' })
  })

  it('rejects identity injection and invalid payloads before service calls', async () => {
    const { service, rpc } = await setup()
    for (const payload of [{ caller: { kind: 'cli' } }, { scope: 'all' }, { includeHidden: 'true' }, { status: {} }, { status: ['running'] }]) {
      expect(await (await rpc('session-tool/list', payload)).json()).toMatchObject({ result: { ok: false, error: { code: 'invalid-input' } } })
    }
    expect(service.list).not.toHaveBeenCalled()
    for (const payload of [{ sessionId: 'x', sinceSeq: -1 }, { sessionId: '../x', sinceSeq: 1.5 }]) {
      expect(await (await rpc('session-tool/read', payload)).json()).toMatchObject({ result: { ok: false } })
    }
    expect(service.read).not.toHaveBeenCalled()
  })
  it('bounds message reads and hides by archiving the official session', async () => {
    const { service, rpc } = await setup()
    await rpc('session-tool/read', { sessionId: 'session-1', sinceSeq: 20 })
    expect(service.read).toHaveBeenCalledWith({ kind: 'web' }, 'session-1', { sinceSeq: 20, maxBlocks: 100, includeDelegationStatus: true })
    for (const method of ['hide', 'unhide'] as const) {
      expect(await (await rpc(`session-tool/${method}`, { sessionId: 'session-1' })).json()).toMatchObject({ result: { ok: true, value: null } })
      expect(service[method]).toHaveBeenCalledWith({ kind: 'web' }, 'session-1')
    }
  })

  it('forwards marks reads for the authenticated web caller', async () => {
    const { service, rpc } = await setup()
    expect(await (await rpc('session-tool/marks', { sessionId: 'session-1' })).json()).toMatchObject({
      result: { ok: true, value: { sessionId: 'session-1', tags: ['form:plugin'], hiddenPrefixes: ['~'] } },
    })
    expect(service.readMarks).toHaveBeenCalledWith({ kind: 'web' }, 'session-1')
  })


  it('reports rejected writes and unregisters routes on unload', async () => {
    const { service, rpc, fiber } = await setup()
    service.write.mockRejectedValue(new Error('agent busy'))
    expect(await (await rpc('session-tool/write', { sessionId: 'session-1', content: '继续' })).json()).toMatchObject({ result: { ok: false, error: { message: 'agent busy' } } })
    await fiber.dispose()
    expect((await rpc('session-tool/list', {})).status).toBe(404)
    expect((await rpc('official/list', {})).status).toBe(200)
  })
})

describe('dispatch validation', () => {
  it('never dispatches unknown methods, blank prompts or mismatched fields', async () => {
    const service = { write: vi.fn() } as unknown as SessionToolService
    const handler = plugin.createHandler(service)
    const signal = new AbortController().signal
    for (const [method, payload] of [
      ['delete', { sessionId: 'x' }], ['write', { sessionId: 'x', content: ' ' }],
      ['write', { sessionId: 'x', content: 'ok', syncToArchived: true }],
    ] as const) expect((await handler(`session-tool/${method}`, payload, signal)).ok).toBe(false)
    expect(service.write).not.toHaveBeenCalled()
  })
})
