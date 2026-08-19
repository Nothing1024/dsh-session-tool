/**
 * Plugin-owned session mark table stored at `$DSH_HOME/session-tool/marks.jsonl`.
 * Last-wins per session id; put rewrites the table with tmp+rename. Reserved
 * names (`kind:vibee`, `kind:delegated`, `kind:hidden`, `ui:aux`) are ordinary
 * tokens. Never writes official `session/tags` events.
 * @module session-marks
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Default cap on a mark set (vendor session-tags maxTags). */
export const DEFAULT_MAX_TAGS = 20
/** Default cap on one mark's UTF-8 byte length. */
export const DEFAULT_MAX_TAG_BYTES = 128

/** Reserved mark names. They normalize as ordinary legal tokens. */
export const RESERVED_MARKS = ['kind:vibee', 'kind:delegated', 'kind:hidden', 'ui:aux'] as const

/** One last-wins row in the mark table. */
export interface SessionMarksRow {
  readonly id: string
  readonly tags: readonly string[]
}

/** Optional home override; default is `process.env.DSH_HOME`. */
export interface MarksOptions {
  readonly dshHome?: string
}

/** Limits applied by {@link normalizeMarks}. */
export interface NormalizeMarksLimits {
  readonly maxTags?: number
  readonly maxTagBytes?: number
}

/** Rejection of an empty, overlong, or over-count mark set. */
export class TagInvalidError extends Error {
  override readonly name = 'TagInvalidError'
  readonly code = 'tag-invalid' as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** In-process write queue so concurrent put/gc on one path cannot drop rows. */
const writeLocks = new Map<string, Promise<void>>()

/**
 * Absolute path of the mark table.
 * @param dshHome - DSH home; default `process.env.DSH_HOME`.
 */
export function marksPath(dshHome?: string): string {
  return join(resolveHome(dshHome), 'session-tool', 'marks.jsonl')
}

/**
 * Trim, drop empties, reject overlong tokens, dedupe, sort. Empty sets fail.
 * @throws {@link TagInvalidError} with code `tag-invalid`.
 */
export function normalizeMarks(
  tags: readonly string[],
  limits: NormalizeMarksLimits = {},
): string[] {
  const maxTags = limits.maxTags ?? DEFAULT_MAX_TAGS
  const maxTagBytes = limits.maxTagBytes ?? DEFAULT_MAX_TAG_BYTES
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag === '') {
      throw new TagInvalidError('tag-invalid: empty tag after normalization')
    }
    if (Buffer.byteLength(tag, 'utf8') > maxTagBytes) {
      throw new TagInvalidError(`tag-invalid: tag exceeds maxTagBytes (${maxTagBytes})`)
    }
    if (seen.has(tag)) continue
    seen.add(tag)
    cleaned.push(tag)
  }
  cleaned.sort()
  if (cleaned.length === 0) {
    throw new TagInvalidError('tag-invalid: empty tag set is rejected')
  }
  if (cleaned.length > maxTags) {
    throw new TagInvalidError(`tag-invalid: tag count exceeds maxTags (${maxTags})`)
  }
  return cleaned
}

/**
 * Replace the mark set for one session (last-wins) and persist atomically.
 * @returns the normalized set that was stored.
 */
export async function put(
  sessionId: string,
  tags: readonly string[],
  options?: MarksOptions,
): Promise<string[]> {
  const id = requireId(sessionId)
  const normalized = normalizeMarks(tags)
  const path = marksPath(options?.dshHome)
  await withLock(path, async () => {
    const table = await loadTable(path)
    table.set(id, normalized)
    await saveTable(path, table)
  })
  return normalized
}

/**
 * Read the current mark set for one session.
 * @returns the tags, or `undefined` when the id has no row.
 */
export async function get(
  sessionId: string,
  options?: MarksOptions,
): Promise<string[] | undefined> {
  const id = requireId(sessionId)
  const table = await loadTable(marksPath(options?.dshHome))
  const tags = table.get(id)
  return tags === undefined ? undefined : [...tags]
}

/**
 * List rows whose current set contains `kind`.
 * @param kind - exact token, e.g. `kind:vibee`.
 */
export async function listByKind(
  kind: string,
  options?: MarksOptions,
): Promise<SessionMarksRow[]> {
  const token = kind.trim()
  if (token === '') {
    throw new TagInvalidError('tag-invalid: empty kind')
  }
  const table = await loadTable(marksPath(options?.dshHome))
  const rows: SessionMarksRow[] = []
  for (const [id, tags] of table) {
    if (tags.includes(token)) rows.push({ id, tags: [...tags] })
  }
  return rows
}

/**
 * Drop rows whose session id is not in `knownIds` (lazy GC).
 * @returns the number of removed ids.
 */
export async function gc(
  knownIds: Iterable<string>,
  options?: MarksOptions,
): Promise<number> {
  const keep = new Set([...knownIds].map(requireId))
  const path = marksPath(options?.dshHome)
  return withLock(path, async () => {
    const table = await loadTable(path)
    let removed = 0
    for (const id of [...table.keys()]) {
      if (keep.has(id)) continue
      table.delete(id)
      removed += 1
    }
    if (removed > 0) await saveTable(path, table)
    return removed
  })
}

function resolveHome(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME
  if (home === undefined || home === '') {
    throw new Error('DSH_HOME is not set')
  }
  return home
}

function requireId(sessionId: string): string {
  const id = sessionId.trim()
  if (id === '') throw new TagInvalidError('tag-invalid: empty session id')
  return id
}

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(path, next.then(() => undefined, () => undefined))
  return next
}

async function loadTable(path: string): Promise<Map<string, string[]>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return new Map()
    throw error
  }
  const table = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (row === undefined) continue
    table.set(row.id, row.tags)
  }
  return table
}

function parseRow(line: string): { id: string; tags: string[] } | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { id?: unknown; sessionId?: unknown; tags?: unknown }
  const id = typeof record.id === 'string'
    ? record.id
    : typeof record.sessionId === 'string'
      ? record.sessionId
      : undefined
  if (id === undefined || id.trim() === '') return undefined
  if (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== 'string')) return undefined
  try {
    return { id: id.trim(), tags: normalizeMarks(record.tags) }
  } catch {
    return undefined
  }
}

async function saveTable(path: string, table: Map<string, string[]>): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const body = [...table.entries()]
    .map(([id, tags]) => JSON.stringify({ id, tags }))
    .join('\n')
  const suffix = body.length === 0 ? '' : '\n'
  const tmp = join(dir, `.marks.${randomBytes(8).toString('hex')}.tmp`)
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
