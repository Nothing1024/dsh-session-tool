/**
 * Model-facing `session_create`, `session_read`, `session_write`,
 * `session_list`, and `session_rename` tools over `ctx.sessionTool`. The
 * bundle patch also mounts the service provider (`session-tool-local`) and the
 * session-tags service the visibility rules depend on, so loading this bundle
 * in a profile is the whole session-management surface.
 *
 * Render intent is fixed up front per the tool presentation contract: none of
 * the five touches a terminal or a file, so every call is a `generic` card
 * with no `locations`.
 * @module tool-session
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolExecution } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionToolCaller } from 'session-tool'

export const name = 'tool-session'
export const inject = ['tools', 'sessionTool']

/**
 * Resolve the calling agent identity for the service fence.
 * @param exec - the tool execution context.
 * @returns the agent caller, or throws when no agent is attached.
 */
function callerOf(exec: ToolExecution): SessionToolCaller {
  const agent = exec.agent
  if (agent === undefined) {
    // Parent authority requires an exact live calling agent.
    throw new Error('session_* tools require a calling agent (exec.agent was undefined)')
  }
  return {
    kind: 'agent',
    sessionId: agent.id,
    delegationDepth: agent.session.header.delegationDepth ?? 0,
  }
}

/** One-line title for a session card. */
function sessionCard(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'execute', ...rawInput !== undefined ? { rawInput } : {} }
}

/** Shared schema for a session id reference. */
const SESSION_ID_SCHEMA = { type: 'string', required: true, description: 'The session id to operate on.' } as const

/**
 * Register the five session tools.
 * @param ctx - context carrying the tool registry and the session tool service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_create',
    description:
      'Create a persistent, addressable session. Optionally fork under a parent session (you or one of your '
      + 'ancestors) for lineage, pin an explicit title, and attach an initial tag set. Pass workspace_path to '
      + 'register (or reuse) the workspace at that directory through the web gateway and bind the session to it '
      + '(the session header cwd becomes the workspace\'s canonical path; the web process accounts it on its next '
      + 'index rebuild). The session stays durable across processes; write prompts into it with session_write and '
      + 'read them back with session_read.',
    parameters: {
      title: {
        type: 'string',
        description: 'Optional explicit title; pins the session title and stops automatic generation.',
      },
      parent_session_id: {
        type: 'string',
        description: 'Optional durable parent lineage; the parent must be you or one of your ancestors.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional initial tag set (last-wins replace if accepted again later).',
      },
      workspace_path: {
        type: 'string',
        description: 'Optional existing directory to register as a workspace (idempotent) and bind this session to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          workspace_id: { type: 'string' },
          workspace_path: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `created session ${value.session_id}`
          + (value.workspace_id === undefined ? '' : ` (workspace ${value.workspace_id})`),
      }],
    },
    async execute(args, exec) {
      const caller = callerOf(exec)
      const result = await ctx.sessionTool.create(caller, {
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.parent_session_id !== undefined ? { parentSessionId: SessionId(args.parent_session_id) } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
        ...args.workspace_path !== undefined ? { workspacePath: args.workspace_path } : {},
        // Bind the new session to the calling agent's working directory so
        // the web process serves it (cwd-less sessions stay invisible to the
        // GUI). callerOf above guarantees the agent is attached.
        ...(exec.agent?.session.header.cwd ?? undefined) === undefined ? {} : { cwd: exec.agent!.session.header.cwd },
      })
      return {
        session_id: result.sessionId,
        ...result.workspaceId === undefined ? {} : { workspace_id: result.workspaceId },
        ...result.workspacePath === undefined ? {} : { workspace_path: result.workspacePath },
      }
    },
    presentCall: args => sessionCard('Create a persistent session', args.title ?? args.parent_session_id ?? args.workspace_path),
  }))

  ctx.tools.register(defineTool({
    name: 'session_read',
    description:
      'Read a session transcript (yours or a descendant\'s) as message rows in log order. Each row carries the '
      + 'source event seq, the role (user/assistant/tool), and the model-facing content blocks. Use since_seq for '
      + 'incremental reads; max_blocks caps the rows returned (clamped to the configured maximum).',
    parameters: {
      session_id: SESSION_ID_SCHEMA,
      since_seq: { type: 'number', description: 'First event seq to include; omit to read from the beginning.' },
      max_blocks: { type: 'number', description: 'Row cap; clamped to the configured maximum.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                role: { type: 'string', required: true, enum: ['user', 'assistant', 'tool'] },
                blocks: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `session ${value.session_id}: (no messages)`
          : value.messages.map(row => `[${row.seq} ${row.role}] ${renderBlocks(row.blocks)}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const result = await ctx.sessionTool.read(callerOf(exec), SessionId(args.session_id), {
        ...args.since_seq !== undefined ? { sinceSeq: args.since_seq } : {},
        ...args.max_blocks !== undefined ? { maxBlocks: args.max_blocks } : {},
      })
      return {
        session_id: result.sessionId,
        messages: result.messages.map(row => ({
          seq: row.seq,
          role: row.role,
          // Content blocks are lossless JSON by contract (they are logged as
          // such), so the schema-shaped JsonValue projection is exact.
          blocks: row.blocks as unknown as JsonValue[],
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read session ${args.session_id}`, kind: 'read', rawInput: args.session_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'session_wait',
    description:
      'Wait for a session\'s agent to settle and report its terminal status — the completion detection for a '
      + 'delegated task (a coordinator waiting on its workers). The wait follows THIS session\'s agent only and '
      + 'never its descendants; a session with no live agent is reported from its log immediately; a deadline '
      + 'expiry reports "timeout" without error and the session stays resumable. Poll with session_list '
      + '(status running/completed/failed/aborted) as an alternative to blocking.',
    parameters: {
      session_id: SESSION_ID_SCHEMA,
      timeout_ms: {
        type: 'number',
        description: 'Deadline in milliseconds; on expiry the call reports status "timeout" without error.',
      },
      until: {
        type: 'string',
        enum: ['idle', 'turn-end'],
        description: 'Settle point: "idle" (default) waits for the agent to go idle; "turn-end" waits for the open turn to close.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['idle', 'completed', 'failed', 'aborted', 'timeout'],
          },
          last_turn_end_reason: {
            type: 'string',
            description: 'Kind of the last turn/end reason, when one has ended.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `session ${value.session_id}: ${value.status}`
          + (value.last_turn_end_reason === undefined ? '' : ` (${value.last_turn_end_reason})`),
      }],
    },
    async execute(args, exec) {
      const result = await ctx.sessionTool.wait(callerOf(exec), SessionId(args.session_id), {
        ...args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {},
        ...args.until !== undefined ? { until: args.until } : {},
      })
      return {
        session_id: result.sessionId,
        status: result.status,
        ...result.lastTurnEndReason === undefined ? {} : { last_turn_end_reason: result.lastTurnEndReason },
      }
    },
    presentCall: args => sessionCard(`Wait for session ${args.session_id}`, args.timeout_ms),
  }))

  ctx.tools.register(defineTool({
    name: 'session_write',
    description:
      'Send one prompt into a session conversation (yours or a descendant\'s). The web gateway resumes the '
      + 'session\'s agent — creating it from the durable log on first touch — and delivers the message into the '
      + 'model loop; the reply streams back through the gateway\'s event push and lands in the session log. '
      + 'This settles when the message is admitted, not when the turn completes; read the reply back with '
      + 'session_read.',
    parameters: {
      session_id: SESSION_ID_SCHEMA,
      content: {
        type: 'string',
        required: true,
        description: 'Non-empty prompt text to send into the conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `prompt sent to ${value.session_id}` }],
    },
    async execute(args, exec) {
      const result = await ctx.sessionTool.write(callerOf(exec), SessionId(args.session_id), args.content)
      return { session_id: result.sessionId }
    },
    presentCall: args => sessionCard(`Write to session ${args.session_id}`, args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'session_list',
    description:
      'List sessions. Scope "own" (default) lists you and your descendants; scope "tree" lists the subtree rooted '
      + 'at session_id (you must be the root or one of its ancestors); scope "all" lists every materialized session '
      + 'and is gated by deployment policy. Hidden-prefix titles are excluded unless include_hidden is set. '
      + 'Filter by tag intersection, title substring, delegation status (running/completed/failed/aborted), and '
      + 'origin "delegated"; paginate with cursor/limit.',
    parameters: {
      scope: { type: 'string', enum: ['own', 'tree', 'all'], description: 'Listing scope; defaults to own.' },
      session_id: { type: 'string', description: 'Tree root for scope "tree".' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Rows must carry every listed tag.' },
      title: { type: 'string', description: 'Case-sensitive substring filter on the durable title.' },
      status: {
        type: 'string',
        enum: ['live', 'idle', 'running', 'completed', 'failed', 'aborted'],
        description: 'live/idle filter store presence; running/completed/failed/aborted filter the log-derived delegation status.',
      },
      origin: { type: 'string', enum: ['delegated'], description: 'Only delegated sessions (tag "delegated" or positive delegation depth).' },
      include_hidden: { type: 'boolean', description: 'Include hidden-prefix sessions (default false).' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous result.' },
      limit: { type: 'number', description: 'Row cap; clamped to the configured maximum.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string', required: true },
                title: { type: 'string' },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                status: { type: 'string', required: true, enum: ['live', 'idle'] },
                delegation_status: {
                  type: 'string',
                  enum: ['idle', 'running', 'completed', 'failed', 'aborted', 'max-tokens'],
                  description: 'Log-derived delegation status, when the log is resolvable.',
                },
                created_at: { type: 'integer', required: true },
              },
            },
          },
          next_cursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '(no sessions)'
          : value.sessions.map(row => `${row.session_id} [${row.status}]${row.delegation_status === undefined ? '' : `/${row.delegation_status}`}${row.title === undefined ? '' : ` ${row.title}`}`).join('\n')
          + (value.next_cursor === undefined ? '' : `\n(next: ${value.next_cursor})`),
      }],
    },
    async execute(args, exec) {
      const result = await ctx.sessionTool.list(callerOf(exec), {
        ...args.scope !== undefined ? { scope: args.scope } : {},
        ...args.session_id !== undefined ? { sessionId: SessionId(args.session_id) } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.status !== undefined ? { status: args.status } : {},
        ...args.origin !== undefined ? { origin: args.origin } : {},
        ...args.include_hidden !== undefined ? { includeHidden: args.include_hidden } : {},
        ...args.cursor !== undefined ? { cursor: args.cursor } : {},
        ...args.limit !== undefined ? { limit: args.limit } : {},
      })
      return {
        sessions: result.sessions.map(row => ({
          session_id: row.sessionId,
          ...row.title !== undefined ? { title: row.title } : {},
          tags: [...row.tags],
          status: row.status,
          ...row.delegationStatus === undefined ? {} : { delegation_status: row.delegationStatus },
          created_at: row.createdAt,
        })),
        ...result.nextCursor === undefined ? {} : { next_cursor: result.nextCursor },
      }
    },
    presentCall: args => sessionCard(`List sessions (${args.scope ?? 'own'})`, args.scope ?? 'own'),
  }))

  ctx.tools.register(defineTool({
    name: 'session_rename',
    description:
      'Rename a session and/or replace its tag set (yours or a descendant\'s). An explicit title pins the session '
      + 'title — automatic generation stops. Tags are last-wins replace. Hidden-prefix titles drop the session '
      + 'from default lists.',
    parameters: {
      session_id: SESSION_ID_SCHEMA,
      title: { type: 'string', description: 'Explicit title; pins the title and stops automatic generation.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag set.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `renamed ${value.session_id}${value.title === undefined ? '' : ` to "${value.title}"`}`
          + (value.tags === undefined ? '' : ` tags=${value.tags.join(',')}`),
      }],
    },
    async execute(args, exec) {
      const result = await ctx.sessionTool.rename(callerOf(exec), SessionId(args.session_id), {
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
      })
      return {
        session_id: result.sessionId,
        ...result.title !== undefined ? { title: result.title } : {},
        ...result.tags !== undefined ? { tags: [...result.tags] } : {},
      }
    },
    presentCall: args => sessionCard(`Rename session ${args.session_id}`, args.title ?? args.tags),
  }))
}

/** Render content blocks as a compact text line (text blocks verbatim, others as their type). */
function renderBlocks(blocks: readonly unknown[]): string {
  return blocks.map(block => {
    if (typeof block !== 'object' || block === null) return String(block)
    const record = block as { type?: unknown; text?: unknown }
    return record.type === 'text' ? String(record.text) : `<${String(record.type)}>`
  }).join(' ')
}
