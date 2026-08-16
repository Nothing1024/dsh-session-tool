# @deepseek-ai/dsh-session-tags

English | [中文](README.zh.md)

Log-backed session tag sets with last-wins replace semantics and deployment-owned visibility rules. Every accepted set is a log-only `session/tags` event; `foldSessionTags()` and `ctx.sessionTags.get()` select the latest event and return its event seq and timestamp.

Tags are exact match keys: normalization trims, strips terminal control sequences, deduplicates, and sorts ascending, so each set has exactly one durable representation. A tag that exceeds the configured UTF-8 byte limit is **rejected**, never silently truncated — truncation would change the key consumers match on. Sets that normalize to empty or exceed the tag-count limit are rejected the same way.

The `tags` projection key (declaration-merged into `SessionProjectionMap`) serves the current normalized set to client list rows through the existing host→wire→client→React pipeline; the shared `rules.ts` functions apply the same hidden-prefix rules on the model-facing list surface and the GUI workspace browser, so both surfaces agree on which sessions are hidden.

## Service: `SessionTagsService` (ctx key: `sessionTags`)

- `get(session)` folds the latest accepted tag set from a live or replayed log.
- `accept(session, tags)` accepts an explicit tag set synchronously: it normalizes the input, validates the limits, and appends a `session/tags` event. A later accept fully replaces the previous set (last-wins); there is no add/remove granularity.
- `isHidden(title)` reports whether a durable title starts with any configured hidden prefix.
- `filterVisible(rows)` filters list rows (objects exposing `title`) through the same rules, preserving input order.

The service appends its event directly through `Session` without opening a turn; persistence observes it eagerly and drains on ordinary lifecycle checkpoints. The projection unit child activates only when a projection registry is composed, so headless assemblies stay unaffected.

## Configuration

All fields are required; the library supplies no defaults.

| Key | Contract |
|---|---|
| `maxTags` | Positive maximum surviving tag count in any accepted set. |
| `maxTagBytes` | Positive maximum UTF-8 bytes in any single accepted tag; an over-budget tag rejects. |
| `hiddenPrefixes` | Title prefixes that hide a session from default lists; trimmed, deduplicated, and sorted at load. An empty array hides nothing. |

## Invariant

The `./invariant` companion (`session-tags-invariant`) rejects any appended `session/tags` event whose tags are empty, duplicate, or not ascending-sorted — the canonical form the service produces before every append.

## Model Experience

### Session tags state

#### What the model sees

Nothing. `session/tags` is log-only and never enters the session surface, `deriveMessages()`, system prompt, tool schemas, or request prefix. A model-facing list tool consuming `rules.ts` is a separate package.

#### Token effect

Zero tokens added to the main agent request.

#### KV Cache effect

None; tag events do not change reconstructed request content or the cache key.

## Known Limitations and Deferred Work

- Tag removal without replacement (clearing a set to empty) is not supported; an empty set is rejected by design so a session either has tags or has never been tagged.
- Tags are compared case-sensitively; no case folding or synonym mapping.
- Hidden-prefix rules apply to durable titles only, not to tag values.
