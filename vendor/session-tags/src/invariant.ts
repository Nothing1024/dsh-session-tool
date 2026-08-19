/**
 * Companion invariant for `session/tags` events: the canonical form is a
 * non-empty, duplicate-free, ascending-sorted tag list.
 * @module @deepseek-ai/dsh-session-tags/invariant
 */

/** Reject a `session/tags` payload that is not in canonical form. */
export function assertCanonicalSessionTags(tags: readonly string[]): void {
  if (tags.length === 0) throw new Error('session-tags: empty tag set is not canonical')
  for (let i = 1; i < tags.length; i += 1) {
    const prev = tags[i - 1]
    const current = tags[i]
    if (prev === undefined || current === undefined) continue
    if (current === prev) throw new Error('session-tags: duplicate tags are not canonical')
    if (current < prev) throw new Error('session-tags: tags must be sorted ascending')
  }
}
