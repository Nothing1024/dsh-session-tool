// dsh-session CLI end-to-end: boots a real headless profile (with the
// tool-session bundle installed) and drives the full create → write → read →
// rename → list flow, comparing the transcript against a recorded fixture.
//
// Requires the built CLI (pnpm -r run build) and the worktree's built dsh
// bin. Re-record the fixture with: DSH_SNAPSHOT=record npx vitest run
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { dshWorktreeRoot } from 'session-tool-cli'

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_BIN = join(PROJECT_ROOT, 'packages', 'session-tool-cli', 'lib', 'bin.js')
const DSH_BIN = join(dshWorktreeRoot(), 'apps', 'cli', 'lib', 'bin.js')
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'e2e.txt')

const BUNDLES = [
  join(PROJECT_ROOT, 'packages', 'tool-session'),
  join(PROJECT_ROOT, 'packages', 'session-tool-local'),
  join(PROJECT_ROOT, 'packages', 'session-tool'),
  join(dshWorktreeRoot(), 'packages', 'session', 'session-tags'),
]

/** Run one CLI invocation and return its stdout, stderr, and exit code. */
function runCli(home: string, args: readonly string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? -1 }
}

describe('dsh-session CLI e2e', () => {
  const skip = !existsSync(CLI_BIN) || !existsSync(DSH_BIN)
  // The flow boots the profile once per verb (~1s each); allow a generous budget.
  // The flow boots the profile once per verb (~1s each); allow a generous budget.
  it.skipIf(skip)('replays the full session flow against the recorded fixture', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-session-e2e-'))
    try {
      // Initialize the headless profile and install the bundle stack.
      const init = spawnSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'headless', 'add', ...BUNDLES], {
        cwd: home,
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8',
      })
      expect(init.status, init.stderr ?? '').toBe(0)

      const lines: string[] = []
      const record = (label: string, args: readonly string[]) => {
        const { stdout, stderr, code } = runCli(home, args)
        lines.push(`## ${label}`)
        lines.push(`exit ${code}`)
        if (stdout.length > 0) lines.push(stdout.replace(/\n$/, ''))
        if (stderr.length > 0) lines.push(stderr.replace(/\n$/, ''))
      }

      record('create', ['session', 'create', '--title', 'test session', '--tag', 'demo'])
      record('write', ['session', 'write', 'session-1', 'hello world'])
      record('read', ['session', 'read', 'session-1'])
      record('rename', ['session', 'rename', 'session-1', '--title', 'renamed title', '--tag', 'alpha', '--tag', 'beta'])
      record('list default (all)', ['session', 'list'])
      record('hidden rename', ['session', 'rename', 'session-1', '--title', '~internal'])
      record('list without hidden', ['session', 'list'])
      record('list include hidden', ['session', 'list', '--include-hidden'])
      record('create child under parent', ['session', 'create', '--title', 'child', '--parent', 'session-1'])
      record('tree scope', ['session', 'list', '--scope', 'tree', '--root', 'session-1'])
      record('read missing', ['session', 'read', 'session-999'])
      record('own scope from CLI', ['session', 'list', '--scope', 'own'])
      const transcript = `${lines.join('\n')}\n`

      if (process.env.DSH_SNAPSHOT === 'record') {
        mkdirSync(dirname(FIXTURE), { recursive: true })
        writeFileSync(FIXTURE, transcript)
      } else {
        expect(transcript).toBe(readFileSync(FIXTURE, 'utf8'))
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})
