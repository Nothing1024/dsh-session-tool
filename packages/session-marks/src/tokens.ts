/**
 * Shared mark-token vocabulary. Pure: no filesystem, no Node builtins.
 * {@link ./index.ts} owns the jsonl table; {@link ./project.ts} owns the
 * human-facing projection.
 */

/** Default cap on a mark set (historical maxTags). */
export const DEFAULT_MAX_TAGS = 20
/** Default cap on one mark's UTF-8 byte length. */
export const DEFAULT_MAX_TAG_BYTES = 128

/**
 * Historical closed names. They still normalize as ordinary legal tokens
 * and remain readable aliases; new writes use {@link MARK_PREFIXES},
 * {@link HIDDEN_MARKS}, and {@link CHILD_MARKS}.
 */
export const RESERVED_MARKS = ['kind:vibee', 'kind:delegated', 'kind:hidden', 'ui:aux'] as const

/** Platform prefixes. The name after the colon is an open set. */
export const MARK_PREFIXES = {
  app: 'app:',
  form: 'form:',
  parent: 'parent:',
} as const

/** Visibility tokens. `kind:hidden` is the historical spelling. */
export const HIDDEN_MARKS = ['hidden', 'kind:hidden'] as const

/**
 * Child-session tokens. `kind:delegated` / bare `delegated` are historical
 * spellings; new writes use `child` plus optional `parent:<id>`.
 */
export const CHILD_MARKS = ['child', 'kind:delegated', 'delegated'] as const

const HIDDEN_TOKEN: Record<string, true> = {
  hidden: true,
  'kind:hidden': true,
}

const CHILD_TOKEN: Record<string, true> = {
  child: true,
  'kind:delegated': true,
  delegated: true,
}

/** Rejection of an empty, overlong, or over-count mark set. */
export class TagInvalidError extends Error {
  override readonly name = 'TagInvalidError'
  readonly code = 'tag-invalid' as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Whether a durable title starts with any configured hidden prefix.
 * Empty or undefined titles are not hidden.
 */
export function isTitleHidden(title: string | undefined, prefixes: readonly string[]): boolean {
  if (title === undefined || title === '') return false
  return prefixes.some(prefix => prefix !== '' && title.startsWith(prefix))
}

/** Whether one token is a hidden-visibility mark (new or historical). */
export function isHiddenToken(tag: string): boolean {
  return HIDDEN_TOKEN[tag] === true
}

/** Whether one token is a child-lineage mark (new or historical). */
export function isChildToken(tag: string): boolean {
  return CHILD_TOKEN[tag] === true
}

/** Whether a mark set carries a hidden-visibility token. */
export function hasHiddenMark(tags: readonly string[] | undefined): boolean {
  return tags?.some(isHiddenToken) ?? false
}

/** Whether a mark set carries a child-lineage token. */
export function hasChildMark(tags: readonly string[] | undefined): boolean {
  return tags?.some(isChildToken) ?? false
}

/** `parent:<sessionId>` token for a child session. */
export function parentMark(sessionId: string): string {
  const id = sessionId.trim()
  if (id === '') {
    throw new TagInvalidError('tag-invalid: empty parent session id')
  }
  return `${MARK_PREFIXES.parent}${id}`
}

/** First `parent:<id>` value in a mark set, if any. */
export function parseParentMark(tags: readonly string[]): string | undefined {
  const prefix = MARK_PREFIXES.parent
  for (const tag of tags) {
    if (tag.startsWith(prefix) && tag.length > prefix.length) return tag.slice(prefix.length)
  }
  return undefined
}

/**
 * Structured marks: namespaced tokens (`app:`, `bot:`, `kind:`, …) plus the
 * exact reserved words `child` / `hidden` / `delegated`. Free tags are the
 * rest (`plan`, `wip`).
 */
export function isStructuredMark(tag: string): boolean {
  return tag.includes(':') || tag === 'child' || tag === 'hidden' || tag === 'delegated'
}
