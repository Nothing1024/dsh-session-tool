import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionToolService, SessionToolListFilter } from 'session-tool'
import { endpoints, prefix } from './contract.ts'

export const name = 'ui-session-tool'
export const inject = ['sessionTool']

const caller = { kind: 'web' } as const
const owned = new Set<string>(endpoints.map(method => prefix + method))

function record(payload: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('Invalid request fields')
  return payload as Record<string, unknown>
}

function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text')
  return value
}

export function createHandler(service: SessionToolService): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (!owned.has(endpoint)) return { ok: false, error: { code: 'not-found', message: 'Unknown endpoint', details: {} } }
    let execute: () => Promise<unknown>
    try {
      if (signal.aborted) throw new Error('Request cancelled')
      const method = endpoint.slice(prefix.length)
      if (method === 'list') {
        const p = record(payload, ['title', 'origin', 'includeHidden', 'cursor', 'status'])
        if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 4096)) throw new Error('Invalid title')
        if (p.origin !== undefined && p.origin !== 'delegated') throw new Error('Invalid origin')
        if (p.includeHidden !== undefined && typeof p.includeHidden !== 'boolean') throw new Error('Invalid visibility')
        if (p.status !== undefined && (typeof p.status !== 'string' || !['live', 'idle', 'running', 'completed', 'failed', 'aborted'].includes(p.status))) throw new Error('Invalid status')
        const filter = {
          scope: 'all' as const, limit: 50,
          ...(p.title === undefined ? {} : { title: p.title as string }),
          ...(p.origin === undefined ? {} : { origin: 'delegated' as const }),
          ...(p.includeHidden === undefined ? {} : { includeHidden: p.includeHidden as boolean }),
          ...(p.cursor === undefined ? {} : { cursor: string(p.cursor) }),
          ...(p.status === undefined ? {} : { status: p.status as NonNullable<SessionToolListFilter['status']> }),
        }
        execute = () => service.list(caller, filter)
      } else {
        const extra = method === 'read' ? ['sinceSeq'] : method === 'write' ? ['content'] : method === 'rename' ? ['title'] : []
        const p = record(payload, ['sessionId', ...extra])
        const id = SessionId(string(p.sessionId, 256))
        switch (method) {
          case 'read': {
            if (p.sinceSeq !== undefined && (!Number.isSafeInteger(p.sinceSeq) || Number(p.sinceSeq) < 0)) throw new Error('Invalid sequence')
            const sinceSeq = Number(p.sinceSeq ?? 0)
            execute = async () => {
              const [result, visibility] = await Promise.all([
                service.read(caller, id, { sinceSeq, maxBlocks: 100, includeDelegationStatus: true }), service.getVisibility(caller, id),
              ])
              return { ...result, visibility }
            }
            break
          }
          case 'write': {
            const content = string(p.content, 100_000)
            execute = () => service.write(caller, id, content)
            break
          }
          case 'rename': {
            const title = string(p.title)
            execute = () => service.rename(caller, id, { title })
            break
          }
          case 'cancel': execute = () => service.cancel(caller, id); break
          case 'hide': execute = () => service.hide(caller, id, { syncToArchived: false }); break
          case 'unhide': execute = () => service.unhide(caller, id, { syncToArchived: false }); break
          default: throw new Error('Unknown method')
        }
      }
    } catch (error) {
      return { ok: false, error: { code: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid request', details: {} } }
    }
    try {
      return { ok: true, value: await execute() ?? null }
    } catch (error) {
      return { ok: false, error: {
        code: 'session-tool-error', message: error instanceof Error ? error.message : 'Session operation failed', details: {},
      } }
    }
  }
}

export function apply(ctx: Context): void {
  ctx.inject(['connection'], ctx => {
    const handler = createHandler(ctx.sessionTool)
    for (const endpoint of owned) ctx.connection.fetch.register({
      path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return new Response('Expected JSON', { status: 415 })
        let body: unknown
        try { body = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
        const parsed = clientRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.method !== endpoint) return new Response('Invalid RPC envelope', { status: 400 })
        return Response.json({
          type: 'server-response', rpcId: parsed.data.rpcId,
          result: await handler(endpoint, parsed.data.payload, request.signal),
        })
      },
    })
  })
}
