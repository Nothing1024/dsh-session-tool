# 讨论 Handoff：dsh-grok-bot 落地过程中暴露的接口摩擦

> 发起方：dsh-grok-bot 插件（`plugin/dsh-grok-bot`）
> 收件对象：session-tool 维护者
> 性质：讨论/征询，非任务包——不含 spec/tasks.csv，不要求按 prd-workflow 流程验收
> 关联代码：`plugin/dsh-grok-bot/plugin/packages/dsh-bot-host/src/{marks,platform,ask,group-engine}.ts`
> 关联 spec：`plugin/dsh-grok-bot/plugin/docs/dsh-bot-mvp/spec.md`（ASM-007 / BR-010）

## 1. 背景

dsh-grok-bot 在实现「bot 专属默认模型」（BR-010）与「隐藏辅助会话」两类需求时，踩到了几处 session-tool 现有 API 的边界。逐一核实后，归属并不都在 session-tool：有的确实是 session-tool 自身可以低成本补的小接口；有的其实属于另一个仓库（`deepseek-harness` 的 `dsh-host-apiproxy` / `dsh-agent-default-model`），写进这里只是为了记录完整背景，不需要 session-tool 团队处理。

先给结论，再给细节，方便你决定要不要接这个活。

## 2. 结论先行

| # | 议题 | 归属 | 建议 |
|---|---|---|---|
| A | session-marks 缺原子 `addTag`/`removeTag`，只有整集替换的 `put` | **session-tool（本仓）** | 值得聊，成本低 |
| B | `kind:hidden`（session-tool 概念）与 `archived`（workspace 概念）是两套独立机制，没有统一动词，且 `session.list` 行不带 `archived` 字段 | **一半在 session-tool（list 缺字段），一半在 workspace registry（archiveSession）** | 值得聊 list 缺字段这一半 |
| C | `session.selectModel` 会连带重写全局 `agent-default-model`，没有 session-only 开关 | **不在 session-tool**——属于 `dsh-host-apiproxy` / `dsh-agent-default-model`（`deepseek-harness` 仓库） | 仅供背景参考，需求应发去对应仓库，不需要 session-tool 处理 |
| D | `session.create` 不接受 `agentPreset` | **不在 session-tool** | dsh-grok-bot 侧已决定自行在应用层 append 处理，不提交讨论 |

下面只展开 A、B；C 保留作背景说明，不要求答复。

## 3. 议题 A：session-marks 的原子标签操作

**现状**（`packages/session-marks/src/index.ts:104-120`）：`put(sessionId, tags)` 是整集替换（last-wins），没有 `addTag`/`removeTag`。

**消费方的应对**（`plugin/dsh-grok-bot/plugin/packages/dsh-bot-host/src/marks.ts:95-115`）：

```ts
const sessionLocks = new Map<string, Promise<void>>()

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> { ... }

export async function mergeBotMarks(sessionId: string, extra: readonly string[] = []): Promise<string[]> {
  return await withSessionLock(sessionId, async () => {
    const existing = await get(sessionId)
    const merged = [...(existing ?? []), DSH_BOT_KIND, ...extra]
    return await put(sessionId, merged)
  })
}
```

注释原文（marks.ts:1-6）："session-tool create already puts the create-time set; this get+put pair is the兜底 merge so a concurrent writer cannot drop `kind:delegated` / parent tags (vibee markVibeeSession shape)."

也就是说：dsh-bot-host 自己造了一个 get+merge+put 的进程内锁，来防止并发写互相覆盖别的消费方（如 vibee）打的标记。这不是 dsh-grok-bot 独有的问题——任何两个插件同时想往同一会话追加标记，都会撞见"整集替换"语义带来的竞态。

**为什么这可能是 session-tool 该管的事**：`normalizeMarks`（index.ts:57-88）、`withLock`（写文件级锁，index.ts 内部）这些基础设施已经在 session-marks 包里了，加一对 `addTag(sessionId, tag)` / `removeTag(sessionId, tag)`（内部实现为文件锁下的 get→union/diff→put）应该是增量工作，不需要改存储格式或语义。

**想问的问题**：
1. 是否愿意在 session-marks 里加 `addTag`/`removeTag`（或 `patch(sessionId, {add, remove})`）？
2. 如果不愿意加在库里，是否有官方推荐的跨插件并发写模式（比如约定的锁粒度），让各消费方不用各自重新发明 `withSessionLock`？

## 4. 议题 B：hidden 与 archived 的语义整合 / list 行缺字段

**现状**：
- `kind:hidden` + 标题前缀（如 `~dsh-bot: `）是 session-marks 层的一等公民，`sessionTool.list({ includeHidden })` 认这个（`hiddenPrefixes` 配置项）。
- 官方 GUI 侧栏的"藏起来"走的是完全不同的服务——`workspace.archiveSession`（不在 session-tool 里，是 `ctx.get('workspaceRegistry')` 或网关 `apiProxy.workspace.archiveSession`）。
- `dsh-grok-bot/docs/dsh-bot-mvp/spec.md` 记录了这条已验证事实（0.1.1-rc.2 实测）：官方 GUI **不按** `~` 标题过滤会话列表，必须额外调 `archiveSession` 才能让它在官方分组栏消失。

**消费方每次建隐藏会话都要打两枪**（`plugin/dsh-grok-bot/plugin/packages/dsh-bot-host/src/ask.ts:259-267`）：

```ts
const created = await sessionTool.create(caller, {
  title,
  tags: [DSH_BOT_KIND, DSH_BOT_HIDDEN_KIND],
  ...
})
sessionId = created.sessionId
await mergeBotMarks(sessionId, [DSH_BOT_HIDDEN_KIND])   // ① session-tool 侧隐藏
await platform.archiveSession(sessionId)                 // ② workspace 侧隐藏（另一个子系统）
```

`group-engine.ts:286-290` 里 `platform.archiveSession` 失败时只能 best-effort 吞掉（注释："尽力归档"），因为它不是 session-tool 保证的原子操作的一部分。

**另一半**：`SessionToolListRow`（`packages/session-tool/src/index.ts` 导出类型）不带 `archived` 字段。dsh-bot-host 想知道一个会话"是否已从所有地方隐藏"时，必须再调一次 workspace 侧的 `archivedSessionIds` 集合去 join（`workbench-sessions.ts` 内的 `listOwnedSessions`），list 行本身给不出这个信息。

**想问的问题**：
1. `session.list` 的行是否可以顺带带上 `archived: boolean`（即使数据来自 workspace registry 内部查一次，对 session-tool 调用方是免费的，好过让每个消费方自己再发一次请求）？
2. `kind:hidden`（session-marks 概念）与 `archived`（workspace 概念）要不要在 session-tool 层面统一成一个语义（哪怕只是 session-tool 内部自动帮忙调一次 archiveSession，而不是要求消费方自己知道要打两枪）？如果这超出 session-tool 的职责边界，也请直说——我们可以接受"两个系统就是两个系统，消费方自己拼"这个结论，只是想确认这是不是刻意的设计分离。

## 5. 议题 C（仅背景，不要求处理）：会话级模型覆盖

`session.selectModel {sessionId, provider, model, reasoningEffort?}` 是网关 RPC（`@deepseek-ai/dsh-host-apiproxy`），调用后会**同时重写部署级默认** `agent-default-model`（`@deepseek-ai/dsh-agent-default-model`），没有 session-only 的开关。dsh-bot-host 现在的应对是"snapshot 全局默认 → selectModel → 立刻恢复全局默认"外加进程内互斥锁防止并发覆盖互相踩踏（`plugin/dsh-grok-bot/plugin/packages/dsh-bot-host/src/platform.ts:293-345`）。

这两个包都不在 session-tool 仓库里，也不依赖 session-tool。写在这里只是为了记录我们踩过的坑；如果你们知道该找 `deepseek-harness` 哪个具体的 owner，欢迎指路，但不需要 session-tool 这边花时间处理。

## 6. 不在讨论范围内的项

- **`session.create` 不接受 `agentPreset`**（`plugin/dsh-grok-bot/plugin/packages/dsh-bot-host/src/platform.ts:19-52, 207-243`）：dsh-grok-bot 已决定维持现状，继续走网关 `apiProxy.sessions.create({agentPreset})` 双轨创建，不要求 session-tool 改 `create` 签名。

## 7. 期望的下一步

这不是任务包，没有验收矩阵。如果 A、B 里有你们觉得值得做的，麻烦回个话说说大概优先级/时间；如果都不打算做，也请直说原因（比如"marks 就该是无 schema 的裸标签，语义交给消费方"），我们会照单全收，不会追着要。
