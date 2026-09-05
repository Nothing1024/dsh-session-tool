/**
 * In-process RemoteError → session-tool hyphen codes. 0.1.2 controllers throw
 * slash codes (`session/not-found`); the plugin seam stays hyphenated.
 * @module session-tool-local
 */

import { SessionToolError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'

/** Slash/hyphen Remote codes this client translates onto the session-tool seam. */
export const IN_PROCESS_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = {
  'session/not-found': 'session-not-found',
  'session-not-found': 'session-not-found',
  'session/title-invalid': 'title-invalid',
  'title-invalid': 'title-invalid',
  'tag-invalid': 'tag-invalid',
  'workspace/not-found': 'workspace-not-found',
  'workspace-not-found': 'workspace-not-found',
  'workspace/name-conflict': 'workspace-name-conflict',
  'workspace-name-conflict': 'workspace-name-conflict',
  'workspace/invalid-path': 'workspace-invalid-path',
  'workspace-invalid-path': 'workspace-invalid-path',
}

/** Structural RemoteError (discrimination is `isDSHRemoteError`, not instanceof). */
interface RemoteFailureShape {
  readonly isDSHRemoteError: true
  readonly code: string
  readonly message: string
}

/** Narrow a thrown value to a Remote failure when the structural marker matches. */
export function remoteFailureOf(error: unknown): RemoteFailureShape | undefined {
  if (error === null || typeof error !== 'object') return undefined
  if (!('isDSHRemoteError' in error) || error.isDSHRemoteError !== true) return undefined
  if (!('code' in error) || typeof error.code !== 'string') return undefined
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error)
  return { isDSHRemoteError: true, code: error.code, message }
}

/**
 * Run one in-process controller call, mapping known Remote codes onto
 * {@link SessionToolError}. Unmapped failures propagate unchanged (not
 * `web-unreachable` — this path never fetches).
 */
export async function invokeInProcess<V>(call: () => V | Promise<V>): Promise<V> {
  try {
    return await call()
  } catch (error: unknown) {
    if (error instanceof SessionToolError) throw error
    const remote = remoteFailureOf(error)
    if (remote !== undefined) {
      const mapped = IN_PROCESS_WIRE_CODES[remote.code]
      if (mapped !== undefined) {
        throw new SessionToolError(remote.message, mapped, { cause: error })
      }
    }
    throw error
  }
}
