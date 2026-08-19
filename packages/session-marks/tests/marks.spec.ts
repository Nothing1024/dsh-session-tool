import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TagInvalidError,
  gc,
  get,
  listByKind,
  marksPath,
  normalizeMarks,
  put,
} from '../src/index.ts'

const homes: string[] = []

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'session-marks-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

describe('normalizeMarks', () => {
  it('trims, dedupes, and sorts', () => {
    expect(normalizeMarks([' plan', 'kind:vibee', 'plan', 'kind:vibee '])).toEqual([
      'kind:vibee',
      'plan',
    ])
  })

  it('rejects empty tokens and empty sets with tag-invalid', () => {
    try {
      normalizeMarks([''])
      expect.unreachable('empty token should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TagInvalidError)
      expect((error as TagInvalidError).code).toBe('tag-invalid')
    }
    try {
      normalizeMarks([])
      expect.unreachable('empty set should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TagInvalidError)
      expect((error as TagInvalidError).code).toBe('tag-invalid')
    }
  })

  it('rejects overlong tokens and over-count sets', () => {
    const tooLong = 'a'.repeat(129)
    try {
      normalizeMarks([tooLong])
      expect.unreachable('overlong tag should throw')
    } catch (error) {
      expect((error as TagInvalidError).code).toBe('tag-invalid')
    }
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`)
    try {
      normalizeMarks(tooMany)
      expect.unreachable('over-count set should throw')
    } catch (error) {
      expect((error as TagInvalidError).code).toBe('tag-invalid')
    }
  })
})

describe('put/get/listByKind', () => {
  it('writes last-wins rows that get and listByKind can read', async () => {
    const home = tmpHome()
    const opts = { dshHome: home }
    await put('s1', ['plan', 'kind:vibee'], opts)
    await put('s2', ['kind:hidden'], opts)
    await put('s1', ['kind:vibee'], opts)
    expect(await get('s1', opts)).toEqual(['kind:vibee'])
    expect(await get('s2', opts)).toEqual(['kind:hidden'])
    expect(await get('missing', opts)).toBeUndefined()
    const vibee = await listByKind('kind:vibee', opts)
    expect(vibee.map(row => row.id)).toEqual(['s1'])
    expect(vibee[0]!.tags).toEqual(['kind:vibee'])
    const text = readFileSync(marksPath(home), 'utf8')
    expect(text).toContain('"id":"s1"')
    expect(text).not.toContain('plan')
  })

  it('skips bad jsonl lines and still returns last-wins', async () => {
    const home = tmpHome()
    const path = marksPath(home)
    mkdirSync(join(home, 'session-tool'), { recursive: true })
    writeFileSync(path, [
      '{not json',
      JSON.stringify({ id: 's1', tags: ['kind:vibee'] }),
      JSON.stringify({ id: 'bad', tags: [1, 2] }),
      '',
      JSON.stringify({ id: 's2', tags: ['kind:delegated'] }),
    ].join('\n'), 'utf8')
    expect(await get('s1', { dshHome: home })).toEqual(['kind:vibee'])
    expect(await get('bad', { dshHome: home })).toBeUndefined()
    const rows = await listByKind('kind:delegated', { dshHome: home })
    expect(rows.map(row => row.id)).toEqual(['s2'])
  })

  it('gc drops unknown ids and keeps known ones', async () => {
    const home = tmpHome()
    const opts = { dshHome: home }
    await put('keep', ['kind:vibee'], opts)
    await put('drop', ['kind:hidden'], opts)
    expect(await gc(['keep'], opts)).toBe(1)
    expect(await get('keep', opts)).toEqual(['kind:vibee'])
    expect(await get('drop', opts)).toBeUndefined()
  })

  it('serializes concurrent puts so both ids survive', async () => {
    const home = tmpHome()
    const opts = { dshHome: home }
    await Promise.all([
      put('a', ['kind:vibee'], opts),
      put('b', ['kind:delegated'], opts),
    ])
    expect(await get('a', opts)).toEqual(['kind:vibee'])
    expect(await get('b', opts)).toEqual(['kind:delegated'])
  })

  it('throws when DSH_HOME is missing and no override is given', async () => {
    const previous = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      await get('x')
      expect.unreachable('get should throw without DSH_HOME')
    } catch (error) {
      expect(String(error)).toMatch(/DSH_HOME/)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
