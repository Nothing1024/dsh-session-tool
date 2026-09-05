/**
 * Authenticated HTTP client for the GUI process workspace domain. Mutations
 * POST `/api/workspace/{create,rename,delete}` with Connection `{ args }`
 * envelopes. List reads `workspace/follow` first baseline then cancel
 * (no `workspace.list` unary).
 * @module session-tool-local
 */

import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'
import {
  GatewayHttpRpc,
  HTTP_WIRE_CODES,
  throwGatewayFailure,
  type GatewayHttpRpcOptions,
} from './http-rpc.ts'

/** One gateway workspace row (wire projection of the host workspace entity). */
export interface WorkspaceView {
  /** The workspace id. */
  readonly workspaceId: string
  /** Canonical directory path (host-side realpath canon). */
  readonly path: string
  /** Display title (defaults to the path basename at create). */
  readonly title: string
  /** Sessions accounted under this workspace, in manually owned order. */
  readonly sessionIds: readonly string[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

/** Result of {@link WorkspaceHttpClient.addWorkspace}. */
export interface WorkspaceAddResult {
  /** The registered (or reused) workspace. */
  readonly workspace: WorkspaceView
  /** Whether this call minted the record (`false` = reused by canonical path). */
  readonly created: boolean
}

/** Workspace wire codes this client translates onto the session-tool seam. */
export const WORKSPACE_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = HTTP_WIRE_CODES

/** Options accepted beside a webUrl string constructor. */
export type WorkspaceHttpClientOptions = Omit<GatewayHttpRpcOptions, 'webUrl'>

/**
 * Cross-process workspace client. Cookie exchange and unary POST live in
 * {@link GatewayHttpRpc}.
 */
export class WorkspaceHttpClient {
  private readonly rpc: GatewayHttpRpc

  constructor(webUrlOrRpc: string | GatewayHttpRpc, options?: WorkspaceHttpClientOptions) {
    this.rpc = typeof webUrlOrRpc === 'string'
      ? new GatewayHttpRpc({ webUrl: webUrlOrRpc, ...options })
      : webUrlOrRpc
  }

  /**
   * Register (or reuse) a workspace over an existing directory. Idempotent by
   * canonical path: a directory already owned returns the existing workspace.
   */
  async addWorkspace(path: string): Promise<WorkspaceAddResult> {
    return await this.invoke('workspace/create', async () => {
      const result = await this.call<{ workspace: WorkspaceView; created: boolean }>('workspace/create', {
        request: { path },
      })
      return {
        workspace: asWorkspaceView(result.workspace),
        created: result.created,
      }
    })
  }

  /**
   * List all workspaces plus the archive set. Reads `workspace/follow` first
   * baseline frame, then cancels the stream.
   */
  async listWorkspaces(): Promise<{ items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] }> {
    return await this.invoke('workspace/follow', async () => {
      const frame = await this.rpc.followFirst('workspace/follow', {})
      return baselineOf(frame)
    })
  }

  /** Rename a workspace (the title is trimmed; blank or duplicate titles reject). */
  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    return await this.invoke('workspace/rename', async () => {
      const { workspace } = await this.call<{ workspace: WorkspaceView }>('workspace/rename', {
        request: { workspaceId, title },
      })
      return asWorkspaceView(workspace)
    })
  }

  /** Delete a workspace registration (directory and session logs are retained). */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    return await this.invoke('workspace/delete', async () => {
      const { deleted } = await this.call<{ deleted: boolean }>('workspace/delete', {
        request: { workspaceId },
      })
      return deleted
    })
  }

  private async call<V>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<V> {
    const result = await this.rpc.call<V>(endpoint, args)
    if (result.ok) return result.value
    throwGatewayFailure(endpoint, result.error)
  }

  private async invoke<V>(method: string, call: () => Promise<V>): Promise<V> {
    try {
      return await call()
    } catch (error: unknown) {
      if (error instanceof SessionToolError) throw error
      throw new SessionWebUnreachableError(
        `web gateway unreachable for ${method}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

function asWorkspaceView(workspace: WorkspaceView): WorkspaceView {
  return {
    workspaceId: String(workspace.workspaceId),
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds.map(String),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function baselineOf(frame: unknown): { items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] } {
  if (!isRecord(frame) || frame.type !== 'baseline' || !isRecord(frame.value)) {
    throw new TypeError('workspace/follow first frame was not a baseline')
  }
  const itemsRaw = frame.value.items
  const archivedRaw = frame.value.archivedSessionIds
  if (!Array.isArray(itemsRaw) || !Array.isArray(archivedRaw)) {
    throw new TypeError('workspace/follow baseline missing items or archivedSessionIds')
  }
  return {
    items: itemsRaw.map(row => asWorkspaceView(row as WorkspaceView)),
    archivedSessionIds: archivedRaw.map(String),
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
