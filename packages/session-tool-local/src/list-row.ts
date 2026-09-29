/**
 * Projection fields both session clients read off a host `session/list`
 * row's `projections.values` block. The block is untrusted wire data on the
 * HTTP path, so every level is checked before use.
 * @module session-tool-local/list-row
 */

import { isDelegationStatus, type DelegationStatus } from './delegation-projection.ts'

/** Projection fields a list row carries through to the service. */
export interface ListRowProjections {
  /** Normalized title projection, when one has been accepted. */
  readonly title?: string
  /** Host delegation projection status; absent when missing or not a known literal (BR-005). */
  readonly delegationStatus?: DelegationStatus
}

/**
 * Read the title and delegation status off a list row's projection values.
 * @param values - `projections.values` of one host list item (any shape).
 * @returns the recognised fields; unknown or malformed ones are omitted.
 */
export function listRowProjections(values: unknown): ListRowProjections {
  if (values === undefined || values === null || typeof values !== 'object' || Array.isArray(values)) return {}
  const record = values as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title : undefined
  const delegation = record.delegation
  const status = delegation !== null && typeof delegation === 'object'
    ? (delegation as Record<string, unknown>).status
    : undefined
  return {
    ...title === undefined ? {} : { title },
    ...isDelegationStatus(status) ? { delegationStatus: status } : {},
  }
}
