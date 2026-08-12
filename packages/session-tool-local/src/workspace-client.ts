/**
 * HTTP client for the web gateway's workspace domain. The web process
 * (`dsh web`) is the workspace registry's authority; this provider holds no
 * workspace state of its own and reaches the registry exclusively through the
 * gateway's fetch carrier (`POST /api/workspace.*`, JSON envelopes). The
 * carrier is the host-apiproxy `AbstractApiClient` — imported through the
 * package's `./client` subpath so no host-side implementation (api-proxy and
 * its service injects) is pulled into this headless process.
 *
 * Transport failures (connection refused, timeout, non-2xx status, protocol
 * mismatch) surface as `SessionWebUnreachableError`; the gateway's business
 * errors surface as `SessionToolError` with the wire code.
 * @module session-tool-local
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcResponse, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionToolError, SessionWebUnreachableError } from 'session-tool'
import type { SessionToolErrorCode } from 'session-tool'

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
const WORKSPACE_WIRE_CODES: Readonly<Record<string, SessionToolErrorCode>> = {
  'workspace-not-found': 'workspace-not-found',
  'workspace-name-conflict': 'workspace-name-conflict',
  'workspace-invalid-path': 'workspace-invalid-path',
}

/**
 * The workspace gateway client: an `AbstractApiClient` subclass whose only
 * aspects are the transport (global fetch) and the base URL (the configured
 * web gateway). All protocol invariants — rpcId minting, envelope wrap/unwrap,
 * zod parsing, unary timeout — live in the base class.
 */
export class WorkspaceHttpClient extends AbstractApiClient {
  /** @param webUrl - the web gateway base URL (e.g. `http://127.0.0.1:3080`). */
  constructor(private readonly webUrl: string, timeoutMs?: number) {
    super(timeoutMs)
    // Fail configuration loud at construction: a malformed gateway URL would
    // otherwise surface as an opaque transport error on the first call.
    new URL(webUrl)
  }

  /** Transport aspect: plain global fetch (Node ≥22 and browsers both provide it). */
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  /** Base URL aspect: every request targets the configured gateway. */
  protected override resolveBase(): string {
    return this.webUrl
  }

  /**
   * Register (or reuse) a workspace over an existing directory. Idempotent by
   * canonical path: a directory already owned returns the existing workspace.
   * @param path - existing directory to adopt, in any path spelling.
   * @returns the workspace and whether this call minted it.
   */
  async addWorkspace(path: string): Promise<WorkspaceAddResult> {
    return await this.invoke('workspace.create', async () => {
      const response = await this.workspace.create({ path })
      return this.unwrap(response)
    })
  }

  /** List all workspaces in the registry's durable order, plus the archive set. */
  async listWorkspaces(): Promise<{ items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] }> {
    return await this.invoke('workspace.list', async () => {
      return this.unwrap(await this.workspace.list({}))
    })
  }

  /** Rename a workspace (the title is trimmed; blank or duplicate titles reject). */
  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    return await this.invoke('workspace.rename', async () => {
      const { workspace } = this.unwrap(await this.workspace.rename({ workspaceId: workspaceId as WorkspaceId, title }))
      return workspace
    })
  }

  /** Delete a workspace registration (directory and session logs are retained). */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    return await this.invoke('workspace.delete', async () => {
      const { deleted } = this.unwrap(await this.workspace.delete({ workspaceId: workspaceId as WorkspaceId }))
      return deleted
    })
  }

  /**
   * Run one gateway call, translating every failure onto the session-tool
   * seam: business errors with a known workspace wire code keep that code;
   * anything else — unknown business code, transport throw, non-2xx status,
   * timeout, envelope/parse mismatch — becomes `SessionWebUnreachableError`.
   */
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

  /** Narrow an RpcResponse to its value, translating a business failure. */
  private unwrap<V>(response: RpcResponse<V>): V {
    if (response.result.ok) return response.result.value
    const error = response.result.error
    const mapped = WORKSPACE_WIRE_CODES[error.code]
    if (mapped !== undefined) {
      throw new SessionToolError(error.message, mapped, { cause: error })
    }
    throw new SessionWebUnreachableError(
      `web gateway rejected the workspace call: ${error.code}: ${error.message}`,
      { cause: error },
    )
  }
}
