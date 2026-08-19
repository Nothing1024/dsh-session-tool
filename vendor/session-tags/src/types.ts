/**
 * Pure types of the tags domain: the `tags` projection-key declaration.
 * @module @deepseek-ai/dsh-session-tags/types
 */

export {}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current normalized tag set — the latest `session/tags`
     * event (last-wins), or `null` before the first accepted set.
     */
    tags: readonly string[] | null
  }
}
