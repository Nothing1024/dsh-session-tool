// dsh-session CLI end-to-end: boots a real headless profile (with the
// tool-session bundle installed) with NO web gateway reachable, and drives
// every verb against the fail-loud path — the web-dependent operations
// (create/write/rename/list/workspace) report `web-unreachable`, the local
// read reports `session-not-found`. The transcript compares against a
// recorded fixture.
//
// The full create → prompt → reply → GUI-visibility chain needs a running
// `dsh web` with model credentials and is exercised as an integration
// verification (see docs/design.md §14), not in this fixture.
//
// Requires the built CLI (pnpm -r run build) and a dsh bin at
// `<install>/apps/cli/lib/bin.js`. Official `@deepseek-ai/dsh` has no
// apps/cli tree, so this spec skipIfs. Re-record with: DSH_SNAPSHOT=record npx vitest run
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
]

/** The web gateway address the fixture guarantees to be unreachable. */
const DEAD_WEB_URL = 'http://127.0.0.1:3999'

/** Run one CLI invocation and return its stdout, stderr, and exit code. */
function runCli(home: string, args: readonly string[]): { stdout: string; stderr: string; code: number } {
  // Every verb carries the dead-gateway overlay so the fixture never depends
  // on a real `dsh web` (a developer's running GUI on the default port would
  // otherwise leak its environment into the transcript).
  const result = spawnSync(process.execPath, [CLI_BIN, ...args, '--patch', join(home, 'dead-web.patch.yml')], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? -1 }
}

describe('dsh-session CLI e2e', () => {
  const skip = !existsSync(CLI_BIN) || !existsSync(DSH_BIN)

  it('keeps the no-gateway fixture on web-unreachable for every web-dependent verb', () => {
    const transcript = readFileSync(FIXTURE, 'utf8')
    const labels = [
      'create (web unreachable)',
      'write (web unreachable)',
      'rename (web unreachable)',
      'list (web unreachable)',
      'workspace list (web unreachable)',
    ]
    for (const label of labels) {
      const block = transcript.split('## ').find(chunk => chunk.startsWith(label))
      expect(block, label).toBeDefined()
      expect(block, label).toContain('[web-unreachable]')
      expect(block, label).toMatch(/^exit [^0]/m)
    }
    expect(transcript).toContain('## read local (no session)')
    expect(transcript).toContain('## read local missing')
    expect(transcript).toContain('[session-not-found]')
    expect(transcript).not.toMatch(/session_hide|session hide/)
  })

  it.skipIf(skip)('replays the fail-loud flow (no web gateway) against the recorded fixture', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-session-e2e-'))
    try {
      // Initialize the headless profile and install the bundle stack. The
      // fixture environment has no `dsh web` on the default webUrl, so every
      // web-dependent verb must fail loudly with `web-unreachable`.
      const init = spawnSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'headless', 'add', ...BUNDLES], {
        cwd: home,
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8',
      })
      expect(init.status, init.stderr ?? '').toBe(0)
      // Point session-tool-local at a port nothing listens on.
      writeFileSync(join(home, 'dead-web.patch.yml'), `- id: session-tool-local
  config:
    allowAllScope: 'top-level'
    cliAllowAll: true
    readMaxBlocks: 500
    listMaxRows: 100
    hiddenPrefixes:
      - '~'
    webUrl: '${DEAD_WEB_URL}'
`)

      const lines: string[] = []
      const record = (label: string, args: readonly string[]) => {
        const { stdout, stderr, code } = runCli(home, args)
        lines.push(`## ${label}`)
        lines.push(`exit ${code}`)
        if (stdout.length > 0) lines.push(stdout.replace(/\n$/, ''))
        if (stderr.length > 0) lines.push(stderr.replace(/\n$/, ''))
      }

      record('create (web unreachable)', ['session', 'create', '--title', 'test session', '--tag', 'demo'])
      record('write (web unreachable)', ['session', 'write', 'session-1', 'hello world'])
      record('read local (no session)', ['session', 'read', 'session-1'])
      record('read local missing', ['session', 'read', 'session-999'])
      record('rename (web unreachable)', ['session', 'rename', 'session-1', '--title', 'renamed title'])
      record('list (web unreachable)', ['session', 'list'])
      record('workspace list (web unreachable)', ['workspace', 'list'])
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
