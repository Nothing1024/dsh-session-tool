/**
 * The `dsh-session` CLI: an auxiliary operator for the DSH session store.
 *
 * Each invocation boots a profile (default `headless`, like `dsh run`; the
 * one-shot runner row is stripped so the tree boots as a session store rather
 * than running a task), resolves `ctx.sessionTool`, runs one verb, prints, and
 * disposes the tree. The CLI is a thin shell over the same service layer the
 * agent tools use — `--format json` prints the tool-shaped value verbatim.
 *
 * The installation anchor points at the linked dsh worktree's `apps/cli`
 * package (override with `DSH_SESSION_ANCHOR`), so bundle resolution and the
 * healed profile module fallback behave exactly like `dsh run` from that
 * checkout.
 * @module session-tool-cli
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import type { Context } from 'cordis'
import type { PatchOptions } from '@cordisjs/plugin-include'
import {
  boot,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { DSH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-environment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionToolError } from 'session-tool'
import type {
  SessionToolCaller,
  SessionToolCreateResult,
  SessionToolListResult,
  SessionToolReadResult,
  SessionToolRenameResult,
  SessionToolWorkspaceAddResult,
  SessionToolWorkspaceDeleteResult,
  SessionToolWorkspaceListResult,
  SessionToolWorkspaceRenameResult,
  SessionToolWriteResult,
} from 'session-tool'

const NAME = 'dsh-session'

/** The one-shot runner row the headless profile mounts; stripped by this CLI. */
const HEADLESS_RUNNER_ROW_ID = 'headless-runner'

/** Profile root config filename (an empty entry list every patch composes over). */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The empty profile root config, rewritten at every boot like `dsh` does. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** The booted context, retained for signal-time disposal. */
let liveCtx: Context | undefined

/**
 * The linked dsh worktree checkout this project develops against.
 * @returns the worktree root, or the `DSH_SESSION_ANCHOR` override.
 */
export function dshWorktreeRoot(): string {
  return process.env.DSH_SESSION_ANCHOR ?? fileURLToPath(new URL('../../../../env/session-tool-env', import.meta.url))
}

/**
 * The installation anchor for profile bundle resolution: the worktree's
 * `apps/cli` package.json, so bundle resolution and the healed profile module
 * fallback match `dsh run` from that checkout.
 * @returns the anchor package.json path.
 */
export function installAnchor(): string {
  return join(dshWorktreeRoot(), 'apps', 'cli', 'package.json')
}

/** The home-level user patch layer, applied over every profile's own layer. */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** One composed profile: its layers and the effective patch stack. */
interface ComposedProfile {
  readonly profile: Profile
  readonly patches: PatchOptions[]
}

/**
 * Load `name` and stack its patch layers: bundle layers in `dsh.profile.bundles`
 * order, the profile's user layer, the home-level user layer, then `--patch`
 * overlays. Missing profiles auto-initialize from the shipped templates.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile and its effective patch stack.
 */
export function composeProfile(name: string, patchFiles: readonly string[]): ComposedProfile {
  healProfilesModuleFallback(installAnchor())
  const profile = loadProfile(NAME, name, installAnchor())
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  return { profile, patches: [...bundlePatches, ...profile.patches, ...homePatches, ...overlays] }
}

/**
 * Remove the one-shot runner from a patch stack: id-targeted patches and
 * insert rows naming `headless-runner`. The CLI boots profiles as a session
 * store, never to run a task.
 * @param patches - the composed patch stack.
 * @returns the stack without the headless runner.
 */
export function stripOneShotRunner(patches: readonly PatchOptions[]): PatchOptions[] {
  const stripped: PatchOptions[] = []
  for (const patch of patches) {
    if (patch.id === HEADLESS_RUNNER_ROW_ID) continue
    if (patch.insert !== undefined) {
      stripped.push({ ...patch, insert: patch.insert.filter(row => row.id !== HEADLESS_RUNNER_ROW_ID) })
    } else {
      stripped.push(patch)
    }
  }
  return stripped
}

/**
 * Boot a profile as a session store.
 * @param profileName - the profile to boot.
 * @param patchFiles - `--patch` overlay paths.
 * @returns the settled root context.
 */
export async function bootProfile(profileName: string, patchFiles: readonly string[]): Promise<Context> {
  const composed = composeProfile(profileName, patchFiles)
  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  const ctx = await boot(NAME, rootConfig, structuredClone(stripOneShotRunner(composed.patches)), async (hostCtx) => {
    hostCtx.provide(DSH_ENVIRONMENT_KEY, loadLayeredEnv(NAME))
  })
  liveCtx = ctx
  return ctx
}

/** CLI caller identity: the human operator, exempt from the owner fence. */
const CLI_CALLER: SessionToolCaller = { kind: 'cli' }

/**
 * Print one service result: plain text by default, or the tool-shaped JSON
 * projection (`--format json` mirrors the session_* tool output schemas, so
 * CLI and tool outputs are interchangeable — one shared service layer, no
 * schema rewrite).
 */
function printResult(
  format: string,
  renderText: () => string,
  toToolShape: () => unknown,
): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(toToolShape(), null, 2)}\n`)
  } else {
    process.stdout.write(`${renderText()}\n`)
  }
}

/** Tool-shaped create result (session_create schema). */
function createToolShape(value: SessionToolCreateResult): {
  session_id: string
  workspace_id?: string
  workspace_path?: string
} {
  return {
    session_id: value.sessionId,
    ...value.workspaceId === undefined ? {} : { workspace_id: value.workspaceId },
    ...value.workspacePath === undefined ? {} : { workspace_path: value.workspacePath },
  }
}

/** CLI-shaped workspace add result (no agent tool carries this shape). */
function workspaceAddShape(value: SessionToolWorkspaceAddResult): {
  workspace_id: string
  path: string
  created: boolean
} {
  return { workspace_id: value.workspaceId, path: value.path, created: value.created }
}

/** CLI-shaped workspace list result. */
function workspaceListShape(value: SessionToolWorkspaceListResult): {
  workspaces: {
    workspace_id: string
    path: string
    title: string
    session_ids: string[]
    created_at: string
    updated_at: string
  }[]
  archived_session_ids: string[]
} {
  return {
    workspaces: value.workspaces.map(row => ({
      workspace_id: row.workspaceId,
      path: row.path,
      title: row.title,
      session_ids: [...row.sessionIds],
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
    archived_session_ids: [...value.archivedSessionIds],
  }
}

/** CLI-shaped workspace rename result. */
function workspaceRenameShape(value: SessionToolWorkspaceRenameResult): {
  workspace_id: string
  title: string
} {
  return { workspace_id: value.workspaceId, title: value.title }
}

/** CLI-shaped workspace delete result. */
function workspaceDeleteShape(value: SessionToolWorkspaceDeleteResult): {
  workspace_id: string
  deleted: boolean
} {
  return { workspace_id: value.workspaceId, deleted: value.deleted }
}

/** Tool-shaped write result (session_write schema). */
function writeToolShape(value: SessionToolWriteResult): { session_id: string } {
  return { session_id: value.sessionId }
}

/** Tool-shaped read result (session_read schema). */
function readToolShape(value: SessionToolReadResult): {
  session_id: string
  messages: { seq: number; role: 'user' | 'assistant' | 'tool'; blocks: unknown[] }[]
} {
  return {
    session_id: value.sessionId,
    messages: value.messages.map(row => ({ seq: row.seq, role: row.role, blocks: [...row.blocks] })),
  }
}

/** Tool-shaped list result (session_list schema). */
function listToolShape(value: SessionToolListResult): {
  sessions: { session_id: string; title?: string; tags: string[]; status: 'live' | 'idle'; created_at: number }[]
  next_cursor?: string
} {
  return {
    sessions: value.sessions.map(row => ({
      session_id: row.sessionId,
      ...row.title === undefined ? {} : { title: row.title },
      tags: [...row.tags],
      status: row.status,
      created_at: row.createdAt,
    })),
    ...value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor },
  }
}

/** Tool-shaped rename result (session_rename schema). */
function renameToolShape(value: SessionToolRenameResult): {
  session_id: string
  title?: string
  tags?: string[]
} {
  return {
    session_id: value.sessionId,
    ...value.title === undefined ? {} : { title: value.title },
    ...value.tags === undefined ? {} : { tags: [...value.tags] },
  }
}

/** Render a read result as text lines. */
function renderReadText(value: SessionToolReadResult): string {
  if (value.messages.length === 0) return `session ${value.sessionId}: (no messages)`
  return value.messages
    .map(row => `[${row.seq} ${row.role}] ${row.blocks
      .map(block => block.type === 'text' ? block.text : `<${block.type}>`)
      .join(' ')}`)
    .join('\n')
}

/** Render a list result as text lines. */
function renderListText(value: SessionToolListResult): string {
  if (value.sessions.length === 0) return '(no sessions)'
  const rows = value.sessions
    .map(row => `${row.sessionId} [${row.status}]${row.title === undefined ? '' : ` ${row.title}`}`)
  return value.nextCursor === undefined ? rows.join('\n') : [...rows, `(next: ${value.nextCursor})`].join('\n')
}

/** Render a rename result as text lines. */
function renderRenameText(value: SessionToolRenameResult): string {
  const parts: string[] = []
  if (value.title !== undefined) parts.push(`title: ${value.title}`)
  if (value.tags !== undefined) parts.push(`tags: ${value.tags.join(',')}`)
  return parts.join('\n')
}

/** Render a workspace add result as text. */
function renderWorkspaceAddText(value: SessionToolWorkspaceAddResult): string {
  return `workspace ${value.workspaceId} (${value.path})${value.created ? '' : ' (reused)'}`
}

/** Render a workspace list result as text lines. */
function renderWorkspaceListText(value: SessionToolWorkspaceListResult): string {
  if (value.workspaces.length === 0) return '(no workspaces)'
  return value.workspaces
    .map(row => `${row.workspaceId} ${row.path}${row.title === row.path ? '' : ` ${row.title}`}`)
    .join('\n')
}

/** Render a workspace rename result as text. */
function renderWorkspaceRenameText(value: SessionToolWorkspaceRenameResult): string {
  return `workspace ${value.workspaceId}: ${value.title}`
}

/** Render a workspace delete result as text. */
function renderWorkspaceDeleteText(value: SessionToolWorkspaceDeleteResult): string {
  return value.deleted ? `deleted workspace ${value.workspaceId}` : `workspace ${value.workspaceId} not found`
}

/** Collect repeated option values. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** Parse a non-negative integer option value. */
function parseNonNegativeInt(value: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/** Validate a `--format` value. */
function parseFormat(value: string): string {
  if (value !== 'text' && value !== 'json') {
    throw new Error(`expected --format text|json, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Wrap one verb body: run it, report failures, and settle the exit code. */
function verb<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args)
    } catch (error: unknown) {
      reportError(error)
    }
  }
}

/** Report one failure to stderr and set the exit code. */
function reportError(error: unknown): void {
  if (process.env.DSH_SESSION_DEBUG !== undefined && error instanceof Error) {
    let current: unknown = error
    while (current instanceof Error) {
      process.stderr.write(`${current.stack ?? String(current)}\n`)
      if (current instanceof AggregateError) {
        for (const cause of current.errors) process.stderr.write(`aggregate cause: ${String(cause)}\n`)
      }
      current = (current as Error & { cause?: unknown }).cause
    }
  } else if (error instanceof SessionToolError) {
    process.stderr.write(`${NAME}: [${error.code}] ${error.message}\n`)
  } else {
    // Some failures (profile boot) already carry the `${NAME}: ` prefix.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message.startsWith(`${NAME}: `) ? '' : `${NAME}: `}${message}\n`)
  }
  process.exitCode = 1
}

/** Build the CLI grammar. */
function buildProgram(): Command {
  const program = new Command()
  program
    .name('dsh-session')
    .description('Operate the DSH session store: create, read, write, list, and rename sessions.')

  const session = program
    .command('session')
    .description('Session store operations (boots a profile; default headless).')

  // Boot options live on every verb (commander does not propagate parent
  // option values into child actions), matching `dsh run --profile <name>`.
  const bootOptions = (command: Command): Command => command
    .option('--profile <name>', 'profile under $DSH_HOME/profiles to boot (default headless)', 'headless')
    .option('--patch <file>', 'additional patch overlay', collect, [])

  bootOptions(session
    .command('create')
    .description('Create a persistent session.')
    .option('--title <title>', 'explicit title; pins the title and stops automatic generation')
    .option('--tag <tag>', 'initial tag (repeatable)', collect, [])
    .option('--parent <id>', 'durable parent lineage (you or one of your ancestors)')
    .option('--workspace <path>', 'register (or reuse) the workspace at this directory and bind the session to it')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.create(CLI_CALLER, {
          ...opts.title !== undefined ? { title: opts.title } : {},
          ...opts.parent !== undefined ? { parentSessionId: SessionId(opts.parent) } : {},
          ...opts.tag.length > 0 ? { tags: opts.tag } : {},
          ...opts.workspace !== undefined ? { workspacePath: opts.workspace } : {},
          // The invoking directory becomes the session cwd so the web
          // process serves the new session to every GUI client.
          cwd: process.cwd(),
        })
        printResult(opts.format, () => result.sessionId, () => createToolShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(session
    .command('read <session_id>')
    .description('Read a session transcript.')
    .option('--since-seq <n>', 'first event seq to include', parseNonNegativeInt)
    .option('--max-blocks <n>', 'row cap (clamped to the configured maximum)', parseNonNegativeInt)
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (sessionId, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.read(CLI_CALLER, SessionId(sessionId), {
          ...opts.sinceSeq !== undefined ? { sinceSeq: opts.sinceSeq } : {},
          ...opts.maxBlocks !== undefined ? { maxBlocks: opts.maxBlocks } : {},
        })
        printResult(opts.format, () => renderReadText(result), () => readToolShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(session
    .command('write <session_id> <content...>')
    .description('Send one prompt into a session conversation (the gateway resumes the agent; reply streams back).')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (sessionId, content, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.write(CLI_CALLER, SessionId(sessionId), content.join(' '))
        printResult(opts.format, () => result.sessionId, () => writeToolShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(session
    .command('list')
    .description('List sessions under a scope (default all; "own" needs an agent caller).')
    .option('--scope <own|tree|all>', 'listing scope', 'all')
    .option('--root <id>', 'tree root for --scope tree')
    .option('--tag <tag>', 'rows must carry this tag (repeatable)', collect, [])
    .option('--title <text>', 'case-sensitive substring filter on the durable title')
    .option('--status <live|idle>', 'only live or only idle sessions')
    .option('--include-hidden', 'include hidden-prefix sessions')
    .option('--cursor <cursor>', 'opaque pagination cursor from a previous result')
    .option('--limit <n>', 'row cap (clamped to the configured maximum)', parseNonNegativeInt)
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.list(CLI_CALLER, {
          scope: opts.scope,
          ...opts.root !== undefined ? { sessionId: SessionId(opts.root) } : {},
          ...opts.tag.length > 0 ? { tags: opts.tag } : {},
          ...opts.title !== undefined ? { title: opts.title } : {},
          ...opts.status !== undefined ? { status: opts.status } : {},
          ...opts.includeHidden === true ? { includeHidden: true } : {},
          ...opts.cursor !== undefined ? { cursor: opts.cursor } : {},
          ...opts.limit !== undefined ? { limit: opts.limit } : {},
        })
        printResult(opts.format, () => renderListText(result), () => listToolShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(session
    .command('rename <session_id>')
    .description('Rename a session and/or replace its tag set.')
    .option('--title <title>', 'explicit title; pins the title and stops automatic generation')
    .option('--tag <tag>', 'replacement tag (repeatable; last-wins replace)', collect, [])
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (sessionId, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.rename(CLI_CALLER, SessionId(sessionId), {
          ...opts.title !== undefined ? { title: opts.title } : {},
          ...opts.tag.length > 0 ? { tags: opts.tag } : {},
        })
        printResult(opts.format, () => renderRenameText(result), () => renameToolShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  // ── workspace (web gateway authority) ────────────────────────────────────
  //
  // The web process (`dsh web`) owns the workspace registry; every workspace
  // verb talks to it over the gateway's HTTP carrier through the shared
  // service layer (`ctx.sessionTool.workspace*`). `Config.webUrl` (default
  // http://127.0.0.1:3080) names the gateway; a `--patch` overlay or the
  // profile's cordis.patch.yml can point elsewhere.
  const workspace = program
    .command('workspace')
    .description('Workspace registry operations through the web gateway (boots a profile; default headless).')

  bootOptions(workspace
    .command('add <path>')
    .description('Register (or reuse) the workspace at an existing directory.')
    .option('--title <title>', 'display title (used only when a new record is created)')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (path, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.workspaceAdd(CLI_CALLER, {
          path,
          ...opts.title !== undefined ? { title: opts.title } : {},
        })
        printResult(opts.format, () => renderWorkspaceAddText(result), () => workspaceAddShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(workspace
    .command('list')
    .description('List workspaces in durable registry order.')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.workspaceList(CLI_CALLER)
        printResult(opts.format, () => renderWorkspaceListText(result), () => workspaceListShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(workspace
    .command('rename <workspace_id>')
    .description('Rename a workspace (the title must be non-blank and unique).')
    .requiredOption('--title <title>', 'new display title')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (workspaceId, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.workspaceRename(CLI_CALLER, {
          workspaceId,
          title: opts.title,
        })
        printResult(opts.format, () => renderWorkspaceRenameText(result), () => workspaceRenameShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  bootOptions(workspace
    .command('delete <workspace_id>')
    .description('Delete a workspace registration (its directory and session logs are retained).')
    .option('--format <text|json>', 'output format (default text)', parseFormat, 'text')
    .action(verb(async (workspaceId, opts) => {
      const ctx = await bootProfile(opts.profile, opts.patch)
      try {
        const result = await ctx.sessionTool.workspaceDelete(CLI_CALLER, workspaceId)
        printResult(opts.format, () => renderWorkspaceDeleteText(result), () => workspaceDeleteShape(result),)
      } finally {
        await disposeTree()
      }
    })))

  return program
}

/** Dispose the booted tree after one verb settles. */
async function disposeTree(): Promise<void> {
  const ctx = liveCtx
  liveCtx = undefined
  if (ctx !== undefined) await ctx.fiber.dispose()
}

/**
 * Run the CLI end to end: parse argv, boot the profile, execute one verb,
 * print, and dispose.
 * @param argv - process arguments (excluding node and the script path).
 * @returns the process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  installFailLoud(NAME, process, async () => { await disposeTree() })
  process.on('SIGINT', () => { void disposeTree().then(() => process.exit(130)) })
  process.on('SIGTERM', () => { void disposeTree().then(() => process.exit(143)) })
  try {
    const program = buildProgram()
    await program.parseAsync(argv, { from: 'user' })
    return typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (error: unknown) {
    reportError(error)
    return typeof process.exitCode === 'number' ? process.exitCode : 1
  }
}
