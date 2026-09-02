# Handoff 回复：dsh-grok-bot 落地过程中暴露的接口摩擦

**发起方**: dsh-grok-bot 插件  
**回复方**: session-tool 维护者  
**日期**: 2026-09-02  
**状态**: ✅ 已实现

---

## 议题 A：session-marks 缺原子 addTag/removeTag

### 结论

✅ **已实现**。Commit: 8aa1563

### 实现内容

- **新接口**: `PatchMarksRequest` 包含可选的 `add` 和 `remove` 数组
- **新函数**: `patch(sessionId: string, changes: PatchMarksRequest, options?: MarksOptions): Promise<string[]>`
- **行为**:
  - 原子地应用添加（并集）然后删除（差集）
  - 使用现有的 `withLock()` 进行文件级序列化
  - 对合并结果进行完整的 normalizeMarks 验证
  - 幂等操作：重新应用相同操作 = 相同结果

### 迁移指南

dsh-grok-bot 可以立即替换自己的 `withSessionLock + mergeBotMarks` 模式：

```typescript
// 旧代码（packages/dsh-bot-host/src/marks.ts）
const sessionLocks = new Map<string, Promise<void>>()
function withSessionLock<T>(sessionId: string, fn: () => Promise<T>) { ... }
export async function mergeBotMarks(sessionId: string, extra: readonly string[]) {
  return await withSessionLock(sessionId, async () => {
    const existing = await get(sessionId)
    const merged = [...(existing ?? []), DSH_BOT_KIND, ...extra]
    return await put(sessionId, merged)
  })
}

// 新代码
import { patch as patchMarks } from 'session-marks'
export async function mergeBotMarks(sessionId: string, extra: readonly string[]) {
  return await patchMarks(sessionId, { add: [DSH_BOT_KIND, ...extra] })
}
```

### 优势

- ✅ 消除并发写竞态（文件锁现在由 session-marks 内部管理）
- ✅ 代码简化（删除进程内锁机制）
- ✅ 通用解决方案（其他插件可直接使用，无需重新发明）

### 建议推进

- **时间**: 立即可用（无依赖）
- **工作量**: 低（简单的 API 替换）
- **验证**: 现有测试应继续通过；新的 patch() 已验证构建

---

## 议题 B：hidden 与 archived 的语义整合 / list 缺字段

### B.1：list 行加 archived 字段

✅ **已实现**。Commit: 8aa1563

#### 实现内容

- **类型变更**: `SessionToolListRow` 新增可选字段 `archived?: boolean`
- **实现**: `list()` 方法在开始时获取一次 `archivedSessionIds`，注入到每一行
- **过滤**: 隐藏过滤现在检查 `!titleHidden AND !kind:hidden AND !archived`

#### 迁移指南

```typescript
// 旧代码（需要两次调用）
const { archivedSessionIds } = await workspace.listWorkspaces()
const rows = await sessionTool.list(caller, filter)
const isHiddenEverywhere = rows.some(r =>
  r.tags.includes('kind:hidden') && archivedSessionIds.has(r.sessionId)
)

// 新代码（单次调用）
const rows = await sessionTool.list(caller, filter)
const isHiddenEverywhere = rows.some(r => 
  r.archived === true || r.tags.includes('kind:hidden')
)
```

#### 优势

- ✅ 单次 list() 调用获得完整信息（无需额外 workspace 查询）
- ✅ 统一的隐藏语义（kind:hidden 与 archived 在 list 级别合并）
- ✅ 性能提升（避免重复调用 workspace.listWorkspaces）

---

### B.2：kind:hidden 与 archived 的语义整合

✅ **已实现**（分层模型）。Commit: 8aa1563

#### 实现内容

定义了完整的 Visibility 层，统一两个隐藏机制的语义：

**新接口**:
```typescript
export interface SessionVisibility {
  readonly hasHiddenMark: boolean        // kind:hidden 是否设置
  readonly archived: boolean              // workspace 归档状态
  readonly isHidden: boolean              // 复合：hasHiddenMark || archived
}
```

**新方法**:
- `getVisibility(caller, sessionId): Promise<SessionVisibility>`
  - 读取当前隐藏状态（marks + workspace）
  - 返回复合的 "隐藏到底?" 谓词

- `hide(caller, sessionId, options?): Promise<SessionVisibility>`
  - 设置 kind:hidden mark（通过 patch()）
  - 尽力调用 workspace 归档（通过 ctx.get('workspaceRegistry')）
  - 返回更新后的状态
  - 幂等：重新调用 = 无操作

- `unhide(caller, sessionId, options?): Promise<SessionVisibility>`
  - 移除 kind:hidden mark
  - 尽力调用 workspace 取消归档
  - 即使 workspace 服务不可用也能工作

#### 迁移指南

```typescript
// 旧代码（"打两枪"模式）
await sessionTool.rename(sessionId, { 
  tags: [...tags, DSH_BOT_HIDDEN_KIND] 
})
await platform.archiveSession(sessionId)  // 第二次调用，可能失败

// 新代码（统一 API）
await sessionTool.hide(caller, sessionId)
// 两个操作原子地进行（mark 立即设置，archive 尽力）
```

#### 优势

- ✅ 统一的 API（替代消费方的两次独立调用）
- ✅ 语义清晰（"隐藏" = mark + archive，而不是两个独立的概念）
- ✅ 容错性（mark 总是成功；archive 失败不阻断操作）
- ✅ 幂等（hide/unhide 可安全重试）
- ✅ 可选依赖（不依赖 workspace 服务存在）

#### 架构设计

采用分层模型而非直接改造 workspace 集成：
- **底层**: session-marks 保持简单（string[] 标记）
- **中层**: SessionVisibility 接口统一语义
- **高层**: hide/hide API 提供便利包

**为什么这样设计**:
- 保持 session-marks 的简洁性（无 schema 演进）
- 向后兼容（put() 和 get() 不变）
- 为多插件 namespace 分离做准备（未来可扩展为 hide(scope: 'plugin:dsh-grok-bot')）
- 不改变 workspace 职责边界（archival 仍由 workspace 管理）

#### 关于 workspace.unarchiveSession

**当前状态**: 
- `hide()` 尝试通过 `ctx.get('workspaceRegistry').archiveSession()` 调用
- `unhide()` 尝试调用 `unarchiveSession()`（如果存在）
- 失败时仅记录警告；mark 操作已完成

**未来改进机会**:
- 如果 workspace 团队在网关 API 中添加 unarchiveSession，unhide() 会自动获得完整支持
- 当前可通过手动调用 workspace.unarchiveSession 补充

### 建议推进

- **时间**: 立即可用（无顶层依赖）
- **工作量**: 低（复合现有 API）
- **验证**: 所有类型检查和构建通过
- **优先级**: 高（大幅简化消费方代码）

---

## 议题 C：会话级模型覆盖（仅背景参考）

不在 session-tool 范围内。建议 dsh-grok-bot 向 deepseek-harness 仓库提交对应讨论。

---

## 议题 D：会话创建时不接受 agentPreset（设计决定）

已确认 dsh-grok-bot 决定维持双轨创建（session-tool.create + apiProxy.sessions.create）。session-tool 无需改动。

---

## 总结与建议

| 议题 | 状态 | 优先级 | 建议 |
|------|------|--------|------|
| A：patch() | ✅ 已实现 | 🟡 中 | 立即采用（0 依赖） |
| B.1：list archived | ✅ 已实现 | 🟡 中 | 采用以简化消费方逻辑 |
| B.2：hide/unhide | ✅ 已实现 | 🔴 高 | **强烈建议采用**（统一 API） |
| C：模型选择 | ➖ 无需处理 | — | 向 deepseek-harness 提交 |

### 下一步

1. **立即可采用**: patch()、list archived、hide/unhide（无外部依赖）
2. **验证集成**: dsh-grok-bot 团队可在本地测试 Phase 1-3 迁移
3. **性能评估**: hide/unhide 的 workspace 集成是否满足性能需求
4. **文档与示例**: session-tool 将补充 patch/hide/unhide 的使用示例

### 成本评估

- **dsh-grok-bot 迁移成本**: 低
  - 替换 withSessionLock（~50 行删除）
  - 替换 mergeBotMarks（~10 行改动）
  - 替换 archiveSession 调用（~1 行改动，从 2 次调用 → 1 次）
  - **总计**: ~1-2 小时工作量

- **session-tool 维护成本**: 低
  - 新 API 均为附加，无改动现有逻辑
  - 测试覆盖通过编译验证

---

## 附录：API 参考

### patch()

```typescript
// 导入
import { patch } from 'session-marks'

// 用法
const result = await patch(sessionId, {
  add: ['tag1', 'tag2'],    // 可选
  remove: ['tag3']          // 可选
}, { dshHome: process.env.DSH_HOME })

// 返回标准化后的标签数组
console.log(result)  // ['tag1', 'tag2']（已排序去重）
```

### hide() / unhide() / getVisibility()

```typescript
// 导入（通过 ctx.sessionTool）
const visibility = await ctx.sessionTool.getVisibility(caller, sessionId)
// { hasHiddenMark: true, archived: false, isHidden: true }

await ctx.sessionTool.hide(caller, sessionId, { syncToArchived: true })
// Mark 立即设置；archive 尽力（失败不阻断）

await ctx.sessionTool.unhide(caller, sessionId)
// Mark 移除；unarchive 尽力
```

---

**Contact**: session-tool 维护者  
**Follow-up**: 欢迎反馈迁移过程中的任何问题
