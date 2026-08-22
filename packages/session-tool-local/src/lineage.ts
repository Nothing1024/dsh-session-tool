/**
 * rc.7 `session.create` does not persist `parentSession` / `delegationDepth`.
 * Remember the intended lineage locally so owner fences (read/write/wait/list
 * tree) still walk parent → child after the gateway drops those fields.
 * Last-wins JSONL at `$DSH_HOME/session-tool/lineage.jsonl`.
 * @module session-tool-local/lineage
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One last-wins lineage row. */
export interface LineageRecord {
  readonly id: string
  readonly parentSession: string
  readonly delegationDepth?: number
}

const writeLocks = new Map<string, Promise<void>>()

/** Absolute path of the lineage table. */
export function lineagePath(dshHome?: string): string {
  return join(resolveHome(dshHome), 'session-tool', 'lineage.jsonl')
}

/** Load the last-wins table. Missing file is an empty table. */
export async function loadLineage(dshHome?: string): Promise<Map<string, LineageRecord>> {
  const path = lineagePath(dshHome)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return new Map()
    throw error
  }
  const table = new Map<string, LineageRecord>()
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (row === undefined) continue
    table.set(row.id, row)
  }
  return table
}

/** Insert or replace one row and persist atomically. */
export async function putLineage(record: LineageRecord, dshHome?: string): Promise<void> {
  const path = lineagePath(dshHome)
  await withLock(path, async () => {
    const table = await loadLineage(dshHome)
    table.set(record.id, record)
    await saveTable(path, table)
  })
}

function resolveHome(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME
  if (home === undefined || home === '') {
    throw new Error('DSH_HOME is not set')
  }
  return home
}

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(path, next.then(() => undefined, () => undefined))
  return next
}

function parseRow(line: string): LineageRecord | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { id?: unknown; parentSession?: unknown; delegationDepth?: unknown }
  if (typeof record.id !== 'string' || record.id.trim() === '') return undefined
  if (typeof record.parentSession !== 'string' || record.parentSession.trim() === '') return undefined
  const depth = record.delegationDepth
  if (depth !== undefined && (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0)) {
    return undefined
  }
  return {
    id: record.id.trim(),
    parentSession: record.parentSession.trim(),
    ...depth === undefined ? {} : { delegationDepth: depth },
  }
}

async function saveTable(path: string, table: Map<string, LineageRecord>): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const body = [...table.values()]
    .map((row) => JSON.stringify(row))
    .join('\n')
  const suffix = body.length === 0 ? '' : '\n'
  const tmp = join(dir, `.lineage.${randomBytes(8).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, `${body}${suffix}`, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
