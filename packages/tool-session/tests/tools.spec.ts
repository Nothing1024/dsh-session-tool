// tool-session: the five session_* tools register with the documented
// schemas, generic render intent, and execute mapping onto ctx.sessionTool.
import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionToolError, SessionNotFoundError } from 'session-tool'
import { apply } from 'tool-session'

/** A tool execution stub with a fake calling agent. */
function stubExec() {
  return {
    agent: {
      id: SessionId('caller'),
      session: { header: { delegationDepth: 0 } },
    },
    signal: new AbortController().signal,
  }
}

/** Register the tools against a mock context and capture the definitions. */
function register(): { defs: Map<string, ToolDefinition>; sessionTool: Record<string, ReturnType<typeof vi.fn>> } {
  const sessionTool = {
    create: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    list: vi.fn(),
    rename: vi.fn(),
  }
  const defs = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: vi.fn((definition: ToolDefinition) => { defs.set(definition.name, definition) }) },
    sessionTool,
  } as unknown as Context
  apply(ctx)
  return { defs, sessionTool }
}

/** Assert one execute result is schema-valid and return it. */
async function run(definition: ToolDefinition, args: unknown, sessionTool: unknown) {
  const value = await (definition.execute as (a: unknown, e: unknown) => Promise<unknown>)(args, stubExec())
  validateJsonSchemaValue(definition.output.schema, value)
  void sessionTool
  return value
}

describe('tool-session', () => {
  it('registers exactly the five session tools with generic call views', () => {
    const { defs } = register()
    expect([...defs.keys()].sort()).toEqual(
      ['session_create', 'session_list', 'session_read', 'session_rename', 'session_write'],
    )
    const validArgs: Record<string, Record<string, unknown>> = {
      session_create: {},
      session_read: { session_id: 's1' },
      session_write: { session_id: 's1', content: 'x' },
      session_list: {},
      session_rename: { session_id: 's1' },
    }
    for (const [name, definition] of defs) {
      const view = definition.presentCall?.(validArgs[name]!)
      expect(view?.card, name).toBe('generic')
      expect('locations' in (view ?? {}) ? view?.locations : undefined, name).toBeUndefined()
    }
  })

  it('session_create maps title, parent, and tags onto the service', async () => {
    const { defs, sessionTool } = register()
    sessionTool.create.mockResolvedValue({ sessionId: SessionId('session-9') })
    const value = await run(defs.get('session_create')!, {
      title: 't',
      parent_session_id: 'caller',
      tags: ['a', 'b'],
    }, sessionTool)
    expect(sessionTool.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent', sessionId: 'caller' }),
      { title: 't', parentSessionId: 'caller', tags: ['a', 'b'] },
    )
    expect(value).toEqual({ session_id: 'session-9' })
  })

  it('session_create maps workspace_path onto the service and echoes the binding', async () => {
    const { defs, sessionTool } = register()
    sessionTool.create.mockResolvedValue({
      sessionId: SessionId('session-9'),
      workspaceId: 'ws-1',
      workspacePath: '/canonical/ws',
    })
    const value = await run(defs.get('session_create')!, {
      workspace_path: '/some/path',
    }, sessionTool)
    expect(sessionTool.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent', sessionId: 'caller' }),
      { workspacePath: '/some/path' },
    )
    expect(value).toEqual({ session_id: 'session-9', workspace_id: 'ws-1', workspace_path: '/canonical/ws' })
  })

  it('session_create output schema accepts a binding-free result', async () => {
    const { defs, sessionTool } = register()
    sessionTool.create.mockResolvedValue({ sessionId: SessionId('session-9') })
    const value = await run(defs.get('session_create')!, {}, sessionTool)
    expect(value).toEqual({ session_id: 'session-9' })
  })

  it('session_write forwards content and returns the session id', async () => {
    const { defs, sessionTool } = register()
    sessionTool.write.mockResolvedValue({ sessionId: SessionId('session-9') })
    const value = await run(defs.get('session_write')!, { session_id: 'session-9', content: 'hello' }, sessionTool)
    expect(sessionTool.write).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' }),
      'session-9',
      'hello',
    )
    expect(value).toEqual({ session_id: 'session-9' })
  })

  it('session_read forwards since_seq and max_blocks and projects rows', async () => {
    const { defs, sessionTool } = register()
    sessionTool.read.mockResolvedValue({
      sessionId: SessionId('session-9'),
      messages: [
        { seq: 0, role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        { seq: 1, role: 'tool', blocks: [{ type: 'text', text: 'out' }] },
      ],
    })
    const value = await run(defs.get('session_read')!, {
      session_id: 'session-9',
      since_seq: 1,
      max_blocks: 10,
    }, sessionTool)
    expect(sessionTool.read).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' }),
      'session-9',
      { sinceSeq: 1, maxBlocks: 10 },
    )
    expect(value).toMatchObject({
      session_id: 'session-9',
      messages: [{ seq: 0, role: 'user' }, { seq: 1, role: 'tool' }],
    })
  })

  it('session_list forwards filters and projects rows', async () => {
    const { defs, sessionTool } = register()
    sessionTool.list.mockResolvedValue({
      sessions: [{ sessionId: SessionId('session-9'), title: 't', tags: ['a'], status: 'idle', createdAt: 1 }],
      nextCursor: 'session-9',
    })
    const value = await run(defs.get('session_list')!, {
      scope: 'tree',
      session_id: 'root',
      tags: ['a'],
      title: 't',
      status: 'idle',
      include_hidden: true,
      limit: 5,
    }, sessionTool)
    expect(sessionTool.list).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' }),
      {
        scope: 'tree',
        sessionId: 'root',
        tags: ['a'],
        title: 't',
        status: 'idle',
        includeHidden: true,
        limit: 5,
      },
    )
    expect(value).toEqual({
      sessions: [{ session_id: 'session-9', title: 't', tags: ['a'], status: 'idle', created_at: 1 }],
      next_cursor: 'session-9',
    })
  })

  it('session_rename forwards title and tags', async () => {
    const { defs, sessionTool } = register()
    sessionTool.rename.mockResolvedValue({
      sessionId: SessionId('session-9'),
      title: 'new',
      tags: ['x'],
    })
    const value = await run(defs.get('session_rename')!, {
      session_id: 'session-9',
      title: 'new',
      tags: ['x'],
    }, sessionTool)
    expect(sessionTool.rename).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' }),
      'session-9',
      { title: 'new', tags: ['x'] },
    )
    expect(value).toEqual({ session_id: 'session-9', title: 'new', tags: ['x'] })
  })

  it('propagates service errors unchanged for the registry to map', async () => {
    const { defs, sessionTool } = register()
    sessionTool.read.mockRejectedValue(new SessionNotFoundError('nope'))
    await expect(
      (defs.get('session_read')!.execute as (a: unknown, e: unknown) => Promise<unknown>)(
        { session_id: 'missing' },
        stubExec(),
      ),
    ).rejects.toThrow(SessionNotFoundError)
  })

  it('rejects a missing calling agent', async () => {
    const { defs, sessionTool } = register()
    await expect(
      (defs.get('session_read')!.execute as (a: unknown, e: unknown) => Promise<unknown>)(
        { session_id: 'x' },
        { agent: undefined, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/calling agent/)
  })

  it('renders readable text for each output shape', () => {
    const { defs } = register()
    const read = defs.get('session_read')!
    const text = read.output.render({}, {
      session_id: 's1',
      messages: [{ seq: 0, role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
    })
    expect(text[0]?.type).toBe('text')
    expect(String(text[0] && 'text' in text[0] ? text[0].text : '')).toContain('[0 user] hi')
    const list = defs.get('session_list')!
    const listText = list.output.render({}, {
      sessions: [{ session_id: 's1', title: 't', tags: [], status: 'live', created_at: 1 }],
    })
    expect(String(listText[0] && 'text' in listText[0] ? listText[0].text : '')).toContain('s1 [live] t')
  })

  it('carries typed error codes through the seam', () => {
    expect(new SessionToolError('x', 'session-not-found').code).toBe('session-not-found')
  })
})
