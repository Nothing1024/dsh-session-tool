# Session-Tool 演进路线图

综合 dsh-grok-bot 和 vibee 两个消费方的 handoff 讨论，梳理优先级和实现策略。

## 议题总览与优先级

| 来源 | 议题 | 优先级 | 复杂度 | 建议 |
|------|------|--------|--------|------|
| dsh-grok-bot | A：session-marks 缺原子 addTag/removeTag | 🟡 中 | 低 | **立即做** |
| dsh-grok-bot | B.1：list 缺 archived 字段 | 🟡 中 | 低 | **立即做** |
| dsh-grok-bot | B.2：kind:hidden 与 archived 的结构化设计 | 🔴 高 | 高 | **前置于 vibee 采用** |
| vibee | A：cancel/interrupt 公开契约 | 🟡 中 | 低 | **中期做，有前置** |
| vibee | B：collect 轮询性能债 | 🟡 中 | 中 | **等 vibee 真的接上 collect 时做** |

---

## 分阶段实现方案

### 第 1 阶段：快速收益（2-3 天）

这一阶段做"dsh-grok-bot A + B.1"的两个低成本改进，为其他工作奠定基础。

#### 1A. session-marks 加 patch 方法

```typescript
// packages/session-marks/src/index.ts

export interface PatchMarksRequest {
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}

/**
 * Atomically add/remove individual tags from one session (file-lock protected).
 * The final set is normalized (dedupe, sort, size checks) as a whole.
 * @returns the final normalized tag set after the patch.
 * @throws TagInvalidError if validation fails.
 */
export async function patch(
  sessionId: string,
  changes: PatchMarksRequest,
  options?: MarksOptions,
): Promise<string[]> {
  const id = requireId(sessionId)
  const path = marksPath(options?.dshHome)
  
  return withLock(path, async () => {
    const table = await loadTable(path)
    const existing = table.get(id) ?? []
    
    // Compute new set
    let updated = [...existing]
    if (changes.remove?.length) {
      const removeSet = new Set(changes.remove.map(t => t.trim()))
      updated = updated.filter(tag => !removeSet.has(tag))
    }
    if (changes.add?.length) {
      updated = [...updated, ...changes.add]
    }
    
    // Normalize (dedup, sort, validate)
    const normalized = normalizeMarks(updated)
    
    table.set(id, normalized)
    await saveTable(path, table)
    return normalized
  })
}
```

**收益**：
- dsh-grok-bot/vibee 不再需要自己的 withSessionLock
- 避免并发写竞态

---

#### 1B. SessionToolListRow 加 archived 字段

```typescript
// packages/session-tool/src/index.ts

export interface SessionToolListRow {
  readonly sessionId: SessionId
  readonly title?: string
  readonly tags: readonly string[]
  readonly status: 'live' | 'idle'
  readonly delegationStatus?: 'idle' | 'running' | 'completed' | 'failed' | 'aborted' | 'max-tokens'
  readonly createdAt: number
  readonly archived?: boolean  // 新增：来自 workspace registry
}
```

**实现建议**：
- session-tool-local 在 list 返回时，额外调一次 `workspaceClient.listWorkspaces()` 拿 archivedSessionIds 集合
- 对每一行 `row.archived = archivedSessionIds.has(row.sessionId)`
- 成本：O(workspaces) 数量的一次查询，通常很小

**收益**：
- 调用方一次请求得到完整信息
- dsh-grok-bot 可以判断"会话是否已从所有地方隐藏"

---

### 第 2 阶段：结构化 Mark 与 Visibility 层（3-5 天）

这一阶段主要为 dsh-grok-bot B.2 服务，但架构上为 vibee 和其他未来消费方奠定基础。

#### 2. 分层模型：保持 marks jsonl 简单 + 上层 visibility API

**核心思想**：
- 底层：marks 仍是 `string[]`（不破坏现有消费方）
- 中层：新增 `SessionVisibility` 概念，统一"这个会话对谁可见"的语义
- 高层：为 dsh-grok-bot 提供 `hide()/unhide()` 便利 API

```typescript
// packages/session-tool/src/index.ts

/**
 * Visibility state of a session: combines plugin marks + workspace archival.
 * Intended for calls that need to know "is this session truly hidden everywhere?"
 */
export interface SessionVisibility {
  /** Whether kind:hidden mark is set. */
  readonly hasHiddenMark: boolean
  /** Whether session is archived in workspace registry. */
  readonly archived: boolean
  /**
   * Composite: true if (hasHiddenMark || archived).
   * This is the "default hidden" definition used by list(includeHidden: false).
   */
  readonly isHidden: boolean
}

/**
 * Read the visibility state of a session.
 * Combines session-marks layer + workspace registry state.
 */
export async function getVisibility(
  caller: SessionToolCaller,
  sessionId: SessionId,
): Promise<SessionVisibility> {
  // Check mark
  const marks = await sessionMarksClient.get(sessionId)
  const hasHiddenMark = marks?.includes('kind:hidden') ?? false
  
  // Check archived
  const { archivedSessionIds } = await this.workspaceList(caller)
  const archived = archivedSessionIds.includes(sessionId)
  
  return {
    hasHiddenMark,
    archived,
    isHidden: hasHiddenMark || archived,
  }
}

/**
 * Hide a session (both marks + archived, if bound to workspace).
 * Completes even if workspace binding fails (best-effort for archival).
 */
export async function hide(
  caller: SessionToolCaller,
  sessionId: SessionId,
  options?: { syncToArchived?: boolean },  // default true
): Promise<SessionVisibility> {
  // (1) Set kind:hidden mark
  await sessionMarksClient.patch(sessionId, { add: ['kind:hidden'] })
  
  // (2) Try to archive in workspace (if syncToArchived is true)
  if (options?.syncToArchived !== false) {
    try {
      await workspaceClient.archiveSession(sessionId)
    } catch (e) {
      // Log but don't fail; mark is already set
      console.warn(`archiveSession failed for ${sessionId}`, e)
    }
  }
  
  return getVisibility(caller, sessionId)
}

/**
 * Unhide a session (both marks + archived).
 */
export async function unhide(
  caller: SessionToolCaller,
  sessionId: SessionId,
  options?: { syncToArchived?: boolean },
): Promise<SessionVisibility> {
  // (1) Remove kind:hidden mark
  await sessionMarksClient.patch(sessionId, { remove: ['kind:hidden'] })
  
  // (2) Try to unarchive
  if (options?.syncToArchived !== false) {
    try {
      await workspaceClient.unarchiveSession(sessionId)
    } catch (e) {
      console.warn(`unarchiveSession failed for ${sessionId}`, e)
    }
  }
  
  return getVisibility(caller, sessionId)
}
```

**list 改进**（集成 archived 状态）：

```typescript
async list(caller: SessionToolCaller, filter: SessionToolListFilter): Promise<SessionToolListResult> {
  // ... 现有逻辑 ...
  
  // 新增：如果 includeHidden === false，过滤掉 (hasHiddenMark || archived) 的行
  const { archivedSessionIds } = await this.workspaceList(caller)
  
  if (filter.includeHidden !== true) {
    rows = rows.filter(row => {
      const hasHiddenMark = row.tags.includes('kind:hidden')
      const archived = archivedSessionIds.has(row.sessionId)
      return !(hasHiddenMark || archived)
    })
  }
  
  // ... 分页 ...
}
```

**权限栅栏**：
- hide/unhide 复用 assertContinuationAllowed（与 write/wait 同级）
- 理由：隐藏是一个状态修改操作，权限栅栏应该和"修改会话"一致

**收益**：
- dsh-grok-bot 可以用 hide()/unhide() 替代手工的"打两枪"
- 语义清晰：调用方知道"隐藏"是什么意思
- 架构上为多插件 namespace 做了准备（未来可扩展成 `hide(scopedBy: 'plugin:dsh-grok-bot')`）
- 与 archived 的关系显式化了

---

### 第 3 阶段：vibee cancel 和 collect 性能（5-7 天）

这个阶段主要为 vibee 服务，但前置于 vibee 真正采用 collect。

#### 3A. cancel/interrupt 提升为公开契约

```typescript
// packages/session-tool/src/index.ts

export interface SessionToolService {
  // ... 现有方法 ...
  
  /**
   * Cancel an in-progress session's current turn.
   * 
   * Semantics: sends a cancellation signal to the web gateway, which will
   * interrupt the model's execution loop and mark the turn as `aborted`.
   * The session remains durable and inspectable; this does not delete it.
   * Caller must be the session itself or one of its ancestors (same as write/wait).
   * 
   * @param caller - the calling agent or the CLI.
   * @param sessionId - target session to cancel.
   * @returns void (settle means the cancel signal was accepted).
   * @throws if the session is not found or the caller lacks permission.
   */
  cancel(caller: SessionToolCaller, sessionId: SessionId): Promise<void>
}
```

**实现**（内部）：
```typescript
async cancel(caller: SessionToolCaller, sessionId: SessionId): Promise<void> {
  // Reuse existing permission check
  assertContinuationAllowed(caller, sessionId)
  
  // Delegate to existing private method
  await this.sessionClient.cancel(sessionId)
}
```

**权限栅栏**：
- 复用 assertContinuationAllowed（与 write/wait 同级）
- 理由：vibee 的"取消工作流"需要可靠的权限隔离，与续写权限级别相同

**收益**：
- vibee 可以实现真正的"取消子会话"语义（替换 BR-018）
- 调用方不再需要绕过契约自己拿 sessionClient

---

#### 3B. collect 轮询性能优化

**两个方向的取舍建议**：

方案 **i**（推荐）：delegationStatusOf 改成读投影缓存

```typescript
private async delegationStatusOf(sessionId: SessionId): Promise<DelegationStatus | undefined> {
  // 优先读 live session 的投影缓存
  const live = this.ctx.sessions.get(sessionId)
  const projection = this.ctx.sessionProjections?.get(sessionId)
  if (projection !== undefined) {
    return projection.delegationStatus
  }
  
  // Fallback：读日志并重折（用于冷启）
  const inspected = await this.inspectSession(sessionId)
  return inspected === undefined ? undefined : foldDelegationStatus(inspected.events)
}
```

方案 **ii**（后续考虑）：250ms 轮询改成变更订阅

- 需要 session 层暴露 onChanged 事件
- 改动较大，当下不必做

**建议**：先做方案 **i**（代码改动小，收益立竿见影），vibee 采用 collect 时再评估是否需要 ii。

**性能基准**（用于 vibee 验收）：
- 20 分支 workflow 的 collect 在 fan-out 大时延迟应控制在 **500ms 内**（目前 250ms 轮询下约 1-2s）
- 随着 vibee 接上 collect，逐步迭代

---

## 实现时间表建议

| 阶段 | 任务 | 预计时间 | 前置条件 |
|------|------|---------|---------|
| 1 | session-marks patch + list archived | 2-3 天 | 无 |
| 2 | Visibility API + hide/unhide | 3-5 天 | 完成阶段 1 |
| 3A | cancel 公开契约 | 1 天 | 完成阶段 2（可并行） |
| 3B | collect 轮询优化 | 1-2 天 | 完成阶段 3A（可并行） |

**总周期**：约 1 周（可并行化到 5-6 天）

---

## 对 dsh-grok-bot 的建议

- **立即采用**：阶段 1 完成后，替换 withSessionLock + mergeBotMarks，改用 `patch()`
- **短期采用**：阶段 2 完成后，替换"打两枪"的 create+mergeBotMarks+archiveSession，改用 `hide()`
- **现状维持**：阶段 2 之前，继续用 BR-018（"取消只停等待"）；阶段 3A 完成后可升级为真正的"取消子会话"

---

## 对 vibee 的建议

- **阶段 1-2 完成**后，vibee 可以利用 hide/unhide 的统一隐藏语义
- **阶段 3A 完成**后，vibee 可以实现真正的 cancel 语义（不再是 BR-018 的"只停等待"）
- **阶段 3B 完成**后，vibee 采用 collect 时性能会显著改善；如需更激进的优化，可在此基础上考虑方案 ii（变更订阅）
- **容量规划**：几十个子会话的 fan-out 在阶段 3B 完成后应可接受；如遇到瓶颈，优先排查是否需要订阅式变更（方案 ii）

---

## 不在本次范围的项

1. **session-tool-local 的 InProcessApiClient**：awaiting other consumers; no blocking item
2. **workspace 的 unarchiveSession API**：vibee 未来如需这个，另行 handoff
3. **mark schema 定义**：vibee 的 output schema 私有于 vibee-host，session-tool 不感知
4. **容量规划与流量控制**：当 vibee 大量接上 collect 时，可能需要再次讨论

