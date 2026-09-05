/**
 * In-process workspace client: create/rename/delete go through
 * `ctx.workspaceController`; listWorkspaces reads `workspaceRegistry.list()`
 * plus `archivedSessionIds` (feed.baseline, no follow stream).
 *
 * Do not construct this from the CLI (BR-003): that would mutate the CLI
 * tree's registry instead of the GUI process. Task 8's transport selector
 * keeps CLI on HTTP.
 * @module session-tool-local
 */

import { invokeInProcess } from './in-process-wire.ts'
import type { WorkspaceAddResult, WorkspaceView } from './workspace-client.ts'

/** `ctx.workspaceController` mutation surface this client calls. */
export interface InProcessWorkspaceController {
  create(request: { readonly path: string }): Promise<{
    readonly workspace: WorkspaceView
    readonly created: boolean
  }>
  rename(request: {
    readonly workspaceId: string
    readonly title: string
  }): Promise<{ readonly workspace: WorkspaceView }>
  delete(request: { readonly workspaceId: string }): Promise<{ readonly deleted: boolean }>
}

/** One registry entity as projected by `workspaceRegistry.list()`. */
export interface InProcessWorkspaceEntity {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** `ctx.workspaceRegistry` read surface for listWorkspaces. */
export interface InProcessWorkspaceRegistry {
  list(): readonly InProcessWorkspaceEntity[]
  readonly archivedSessionIds: readonly string[]
}

/** Constructor deps: GUI-tree controller + registry. */
export interface InProcessWorkspaceClientDeps {
  readonly workspaceController: InProcessWorkspaceController
  readonly workspaceRegistry: InProcessWorkspaceRegistry
}

/**
 * Same-process workspace client. Callers inject `ctx.workspaceController`
 * and `ctx.workspaceRegistry` from the web-app tree; this module does not
 * import the controller package.
 */
export class InProcessWorkspaceClient {
  private readonly workspaceController: InProcessWorkspaceController
  private readonly workspaceRegistry: InProcessWorkspaceRegistry

  constructor(deps: InProcessWorkspaceClientDeps) {
    this.workspaceController = deps.workspaceController
    this.workspaceRegistry = deps.workspaceRegistry
  }

  /**
   * Register (or reuse) a workspace over an existing directory. Idempotent by
   * canonical path: a directory already owned returns the existing workspace.
   */
  async addWorkspace(path: string): Promise<WorkspaceAddResult> {
    return await invokeInProcess(async () => {
      const result = await this.workspaceController.create({ path })
      return {
        workspace: asWorkspaceView(result.workspace),
        created: result.created,
      }
    })
  }

  /**
   * List all workspaces in the registry's durable order, plus the archive set.
   * Reads the registry directly (same projection as workspace/follow baseline).
   */
  async listWorkspaces(): Promise<{ items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] }> {
    const items = this.workspaceRegistry.list().map(workspaceViewOf)
    const archivedSessionIds = this.workspaceRegistry.archivedSessionIds.map(String)
    return { items, archivedSessionIds }
  }

  /** Rename a workspace (the title is trimmed; blank or duplicate titles reject). */
  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    return await invokeInProcess(async () => {
      const { workspace } = await this.workspaceController.rename({
        workspaceId: workspaceId as never,
        title,
      })
      return asWorkspaceView(workspace)
    })
  }

  /** Delete a workspace registration (directory and session logs are retained). */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    return await invokeInProcess(async () => {
      const { deleted } = await this.workspaceController.delete({
        workspaceId: workspaceId as never,
      })
      return deleted
    })
  }
}

function workspaceViewOf(workspace: InProcessWorkspaceEntity): WorkspaceView {
  return {
    workspaceId: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds.map(String),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
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
