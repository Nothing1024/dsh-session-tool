// Marks CLI: list/get read $DSH_HOME/session-tool/marks.jsonl and do not
// boot a profile or talk to a gateway. installAnchor resolves official
// @deepseek-ai/dsh (or DSH_SESSION_ANCHOR) and never the deleted
// session-tool-env tree.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProgram, dshWorktreeRoot, installAnchor, main } from 'session-tool-cli'

const homes: string[] = []

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

function writeMarks(home: string, rows: readonly { id: string; tags: readonly string[] }[]): void {
  mkdirSync(join(home, 'session-tool'), { recursive: true })
  writeFileSync(
    join(home, 'session-tool', 'marks.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )
}

async function runMain(
  argv: string[],
  home: string | undefined,
): Promise<{ code: number; out: string; err: string }> {
  const prevHome = process.env.DSH_HOME
  const prevExit = process.exitCode
  if (home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = home
  const out: string[] = []
  const err: string[] = []
  const writeOut = process.stdout.write.bind(process.stdout)
  const writeErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  process.exitCode = undefined
  try {
    const code = await main(argv)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = writeOut
    process.stderr.write = writeErr
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    process.exitCode = prevExit
  }
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

describe('installAnchor', () => {
  it('resolves official @deepseek-ai/dsh/package.json and not session-tool-env', () => {
    const prev = process.env.DSH_SESSION_ANCHOR
    delete process.env.DSH_SESSION_ANCHOR
    try {
      const anchor = installAnchor()
      expect(anchor).toMatch(/@deepseek-ai[/\\]dsh[/\\]package\.json$/)
      expect(anchor).not.toMatch(/session-tool-env/)
      expect(existsSync(anchor)).toBe(true)
      expect(dshWorktreeRoot()).not.toMatch(/session-tool-env/)
    } finally {
      if (prev === undefined) delete process.env.DSH_SESSION_ANCHOR
      else process.env.DSH_SESSION_ANCHOR = prev
    }
  })

  it('honors DSH_SESSION_ANCHOR package.json and directory forms', () => {
    const prev = process.env.DSH_SESSION_ANCHOR
    const dir = tmpDir('dsh-session-anchor-')
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n')
      process.env.DSH_SESSION_ANCHOR = join(dir, 'package.json')
      expect(installAnchor()).toBe(join(dir, 'package.json'))
      process.env.DSH_SESSION_ANCHOR = dir
      expect(installAnchor()).toBe(join(dir, 'package.json'))
      rmSync(join(dir, 'package.json'))
      mkdirSync(join(dir, 'apps', 'cli'), { recursive: true })
      writeFileSync(join(dir, 'apps', 'cli', 'package.json'), '{}\n')
      expect(installAnchor()).toBe(join(dir, 'apps', 'cli', 'package.json'))
      expect(dshWorktreeRoot()).toBe(dir)
    } finally {
      if (prev === undefined) delete process.env.DSH_SESSION_ANCHOR
      else process.env.DSH_SESSION_ANCHOR = prev
    }
  })
})

describe('marks argv/shape', () => {
  it('exposes marks list/get without profile boot options', () => {
    const program = buildProgram()
    const marks = program.commands.find(command => command.name() === 'marks')
    expect(marks).toBeDefined()
    const names = (marks?.commands ?? []).map(command => command.name())
    expect(names).toEqual(expect.arrayContaining(['list', 'get']))
    const list = marks?.commands.find(command => command.name() === 'list')
    const getCmd = marks?.commands.find(command => command.name() === 'get')
    const listFlags = (list?.options ?? []).map(option => option.long)
    const getFlags = (getCmd?.options ?? []).map(option => option.long)
    expect(listFlags).toEqual(expect.arrayContaining(['--kind', '--format']))
    expect(listFlags).not.toContain('--profile')
    expect(getFlags).toEqual(expect.arrayContaining(['--id', '--format']))
    expect(getFlags).not.toContain('--profile')
    const session = program.commands.find(command => command.name() === 'session')
    const collectCmd = session?.commands.find(command => command.name() === 'collect')
    expect(collectCmd).toBeDefined()
    const collectFlags = (collectCmd?.options ?? []).map(option => option.long)
    expect(collectFlags).toEqual(expect.arrayContaining(['--tag', '--root', '--wait', '--profile']))
  })

  it('lists and gets jsonl rows without a gateway', async () => {
    const home = tmpDir('dsh-session-marks-')
    writeMarks(home, [
      { id: 's-plain', tags: ['plan'] },
      { id: 's-vibee', tags: ['kind:vibee', 'plan'] },
    ])
    const listed = await runMain(['marks', 'list', '--kind', 'kind:vibee', '--format', 'json'], home)
    expect(listed.code).toBe(0)
    expect(listed.err).toBe('')
    expect(JSON.parse(listed.out)).toEqual([{ id: 's-vibee', tags: ['kind:vibee', 'plan'] }])
    const all = await runMain(['marks', 'list', '--format', 'json'], home)
    expect(all.code).toBe(0)
    expect(JSON.parse(all.out)).toEqual([
      { id: 's-plain', tags: ['plan'] },
      { id: 's-vibee', tags: ['kind:vibee', 'plan'] },
    ])
    const got = await runMain(['marks', 'get', '--id', 's-plain', '--format', 'json'], home)
    expect(got.code).toBe(0)
    expect(JSON.parse(got.out)).toEqual({ id: 's-plain', tags: ['plan'] })
    const text = await runMain(['marks', 'list', '--kind', 'kind:vibee'], home)
    expect(text.code).toBe(0)
    expect(text.out.trim()).toBe('s-vibee kind:vibee,plan')
  })

  it('fails loud without DSH_HOME and on missing get id', async () => {
    const missingHome = await runMain(['marks', 'list', '--format', 'json'], undefined)
    expect(missingHome.code).not.toBe(0)
    expect(missingHome.err).toMatch(/DSH_HOME/)
    const home = tmpDir('dsh-session-marks-miss-')
    writeMarks(home, [{ id: 's1', tags: ['kind:vibee'] }])
    const missingId = await runMain(['marks', 'get', '--format', 'json'], home)
    expect(missingId.code).not.toBe(0)
    expect(missingId.out).toBe('')
    expect(missingId.err).toMatch(/session-not-found|required/)
    const unknown = await runMain(['marks', 'get', '--id', 'nope', '--format', 'json'], home)
    expect(unknown.code).not.toBe(0)
    expect(unknown.out).toBe('')
    expect(unknown.err).toMatch(/session-not-found/)
  })
})
