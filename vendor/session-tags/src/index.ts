/**
 * Log-backed session tags and shared visibility rules.
 * Official `@deepseek-ai/dsh-session-tags` is unpublished on npm; this
 * vendor copy is the in-tree stand-in (peers pinned to 0.1.0-rc.7).
 * @module @deepseek-ai/dsh-session-tags
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { z as zod } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import './types.ts'

/** Payload of the log-only `session/tags` event. */
export interface SessionTagsEventData {
  /** Canonical tag set (trimmed, deduplicated, sorted). */
  readonly tags: readonly string[]
  /** How the set was accepted. */
  readonly source?: { readonly kind: 'user' }
}

/** Latest folded tag set plus the event's durable envelope facts. */
export interface SessionTagsSnapshot {
  readonly tags: readonly string[]
  readonly eventSeq: number
  readonly updatedAt: number
}

/** Required tag-set and visibility limits. */
export interface Config {
  readonly maxTags: number
  readonly maxTagBytes: number
  readonly hiddenPrefixes: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTags: SessionTagsService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Latest-wins session tag set. Log-only: never enters the model surface. */
    'session/tags': SessionTagsEventData
  }
}

/** Rejection of a tag set that fails normalization or configured limits. */
export class SessionTagsInvalidError extends Error {
  readonly name = 'SessionTagsInvalidError'
}

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu

/** Strip terminal controls and collapse surrounding whitespace on one tag. */
export function normalizeTagText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .trim()
}

/** Trim, deduplicate, and sort hidden prefixes. */
export function normalizeHiddenPrefixes(prefixes: readonly string[]): string[] {
  return [...new Set(prefixes.map(prefix => prefix.trim()).filter(prefix => prefix !== ''))].sort()
}

/**
 * Whether a durable title starts with any configured hidden prefix.
 * @param title - durable title, when one has been accepted.
 * @param prefixes - hidden-prefix rules (already normalized or raw).
 */
export function isTitleHidden(title: string | undefined, prefixes: readonly string[]): boolean {
  if (title === undefined || title === '') return false
  return prefixes.some(prefix => prefix !== '' && title.startsWith(prefix))
}

/** Filter list rows through {@link isTitleHidden}, preserving input order. */
export function filterVisibleByRules<T extends { readonly title?: string }>(
  rows: readonly T[],
  prefixes: readonly string[],
): T[] {
  return rows.filter(row => !isTitleHidden(row.title, prefixes))
}

/** Fold the latest accepted tag set from a live or replayed log. */
export function foldSessionTags(events: readonly SessionEvent[]): SessionTagsSnapshot | undefined {
  let found: SessionTagsSnapshot | undefined
  for (const event of events) {
    if (event.type !== 'session/tags') continue
    found = { tags: event.data.tags, eventSeq: event.seq, updatedAt: event.time }
  }
  return found
}

const tagsSchema = zod.union([
  zod.array(zod.string()),
  zod.null(),
]) as unknown as zod.ZodType<readonly string[] | null>

interface TagsState {
  tags: readonly string[] | null
}

const tagsProjectionDefinition: ProjectionDefinition<'tags', TagsState> = {
  key: 'tags',
  schema: tagsSchema,
  init: () => ({ tags: null }),
  apply: (state, event) => {
    if (event.type !== 'session/tags') return state
    return { tags: event.data.tags }
  },
  view: state => state.tags,
  stateVersion: 1,
}

/** Normalize and validate one incoming tag set against configured limits. */
export function normalizeSessionTags(
  tags: readonly string[],
  config: Pick<Config, 'maxTags' | 'maxTagBytes'>,
): string[] {
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = normalizeTagText(raw)
    if (tag === '') throw new SessionTagsInvalidError('session-tags: empty tag after normalization')
    if (Buffer.byteLength(tag, 'utf8') > config.maxTagBytes) {
      throw new SessionTagsInvalidError(`session-tags: tag exceeds maxTagBytes (${config.maxTagBytes})`)
    }
    if (seen.has(tag)) continue
    seen.add(tag)
    cleaned.push(tag)
  }
  cleaned.sort()
  if (cleaned.length === 0) throw new SessionTagsInvalidError('session-tags: empty tag set is rejected')
  if (cleaned.length > config.maxTags) {
    throw new SessionTagsInvalidError(`session-tags: tag count exceeds maxTags (${config.maxTags})`)
  }
  return cleaned
}

/** Log-backed tag fold plus last-wins accept. */
export class SessionTagsService extends Service {
  static inject = ['sessions']
  static Config: z<Config> = z.object({
    maxTags: z.number().step(1).min(1).required(),
    maxTagBytes: z.number().step(1).min(1).required(),
    hiddenPrefixes: z.array(z.string()).required(),
  })

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTags')
    this.config = Object.freeze({
      maxTags: config.maxTags,
      maxTagBytes: config.maxTagBytes,
      hiddenPrefixes: normalizeHiddenPrefixes(config.hiddenPrefixes),
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(tagsProjectionDefinition)
    })
  }

  /** Read the latest folded tag set from one live or replayed session. */
  get(session: Session): SessionTagsSnapshot | undefined {
    return foldSessionTags(session.events)
  }

  /**
   * Accept an explicit tag set (last-wins replace) and append `session/tags`.
   * @throws {SessionTagsInvalidError} when the set fails normalization or limits.
   */
  accept(session: Session, tags: readonly string[]): SessionTagsSnapshot {
    const normalized = normalizeSessionTags(tags, this.config)
    const event = session.append('session/tags', { tags: normalized, source: { kind: 'user' } })
    return { tags: normalized, eventSeq: event.seq, updatedAt: event.time }
  }

  /** Whether a durable title is hidden by this deployment's prefixes. */
  isHidden(title: string | undefined): boolean {
    return isTitleHidden(title, this.config.hiddenPrefixes)
  }

  /** Filter list rows through this deployment's hidden-prefix rules. */
  filterVisible<T extends { readonly title?: string }>(rows: readonly T[]): T[] {
    return filterVisibleByRules(rows, this.config.hiddenPrefixes)
  }
}

export default SessionTagsService
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
