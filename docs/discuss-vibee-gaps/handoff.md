# 讨论 Handoff：vibee 直连 ctx.sessionTool 后，几处后续可能需要的契约支撑

> 发起方：vibee 插件（`plugin/vibee`）
> 收件对象：session-tool 维护者
> 性质：讨论/征询，非任务包——不含 spec/tasks.csv，不要求按 prd-workflow 流程验收
> 关联代码：`plugin/vibee/plugin/packages/vibee-host/src/{executor,engine,wait-bridge}.ts`
> 关联调研：`plugin/vibee/plugin/docs/vibee-flow/evidence/research/vibee-session-tool-integration.md`
> 关联 spec：`plugin/vibee/plugin/docs/vibee-flow/spec.md`（BR-015~018，Phase 6）

## 1. 背景

vibee 是一个编排层：模型通过 `vibee_run` 工具起一个 YAML 工作流，工作流里 `agent://dsh/<task>` 类型的节点需要"起一个会话、发个任务、等结果"。Phase 6 把这条执行路径从早期的 `ctx.subagents`/`SubagentProvider` 桥接，改成了直连 `ctx.sessionTool`（`DshSessionExecutorPort`，`packages/vibee-host/src/executor.ts`）——理由是 vibee 不需要 provider 多态分发，只需要 session-tool 已经提供的 create/write/wait/read 这套程序化原语，两条产品线不再共享 subagent 包族的任何东西。

这次直连让 vibee 变成了 `ctx.sessionTool` 的一个新消费方，形态和现有的 CLI/GUI 工具面（`tool-session`）、`subagent-session` provider 不完全一样：**vibee 是全自动编排，节点执行失败/取消是工作流状态机的一部分，不是人在敲命令**。这个形态差异,让 vibee 在落地时刻意选择了"绕开"契约里几处还不够用的角落,而不是去改契约——绕开的方式记录在这里,供你们判断要不要在契约层面补上,以及要补的话大概是什么样。

先给结论,再给细节。

## 2. 结论先行

| # | 议题 | 归属 | 建议 |
|---|---|---|---|
| A | `SessionToolService` 公开契约没有 `cancel`/`interrupt`，vibee 的"取消工作流"目前只能停止等待、不能真的停掉子会话 | **session-tool（本仓）** | 值得聊，但不紧急——等产品侧真的要求"取消=停止子会话"再启动 |
| B | `collect` 的 250ms 轮询 + 每次全量重折日志（`delegationStatusOf`）在分支数大时有实打实的开销；vibee 的 parallel/foreach 目前**没有**用 `collect` 做 fan-out join（引擎自己在内存里等多次 `execute()`），但一旦用上，这条性能债会被放大 | **session-tool（本仓）** | 值得聊，作为"vibee 未来采用 collect 之前的前置改进项" |
| C | `session-tool-local` 只有 HTTP 网关一条传输路径，vibee 与 web 网关同进程部署时是自环 | **不在本次讨论范围**——已实测确认同进程 HTTP 自环可接受，无需现在处理 | 仅供背景参考，留作独立性能优化项，不要求答复 |
| D | vibee 即将成为 `collect`/`create` 的高频消费方（一次 workflow run 可能 fan-out 出几十个子会话），容量规划视角的提前告知 | **不在本次讨论范围** | 仅供背景参考 |

下面只展开 A、B；C、D 保留作背景说明，不要求答复。

## 3. 议题 A：cancel/interrupt 未提升为公开契约方法

**现状**（`SessionToolService`，`packages/session-tool/src/index.ts:340-420`）：公开接口只有 `create`/`read`/`write`/`list`/`wait`/`collect`/`rename` 七个方法，没有 `cancel`。真正的 cancel 能力存在，但是私有的——`collect` 内部 `onFailure: 'cancel-rest'` 路径调用 `this.sessionClient.cancel(member.sessionId)`（`packages/session-tool-local/src/index.ts:473`），这是 `SessionHttpClient` 的私有能力，没有作为 `SessionToolService` 的方法对外暴露。

**消费方（vibee）的应对**（`packages/vibee-host/src/executor.ts:202-213`）：

```ts
return {
  events: narrationEvents(result, label),
  result,
  // BR-018: no dispose semantics — cancel only stops waiting. The child
  // session remains live and inspectable (see spec Task 36 for the
  // retained-session copy on the model-facing surface).
  cancel: () => {
    aborted = true
    releaseAbort()
    return Promise.resolve()
  },
}
```

vibee 把这条约束写成了业务规则 BR-018："工作流被取消时，子会话不被强制终止，UI 文案不得暗示'已停止'"。也就是说，vibee 现在的取消语义是"我不管子会话了"，而不是"子会话真的停了"——这是绕开契约缺口的选择，不是产品期望的最终状态：用户点"停止工作流"，直觉上应该期待背后的子任务真的停下，而不是留着继续跑、只是不再等它。

**想问的问题**：

1. 是否愿意把 `cancel(caller, sessionId)` 提升为 `SessionToolService` 的公开方法（内部实现直接复用 `collect` 已经在用的 `sessionClient.cancel`）？
2. 如果愿意，权限栅栏打算怎么定——是复用 `assertContinuationAllowed`（写/等的栅栏），还是需要一条独立的、可能更严格的栅栏（"谁可以强制终止一个会话正在进行的 turn"通常比"谁可以续写"更敏感）？
3. 如果不愿意在这个阶段做，vibee 这边会继续用 BR-018 的"只停等待"语义，不会绕过契约自己拿 `sessionClient` 实例——只是想确认这是刻意的设计边界，还是"还没来得及做"。

## 4. 议题 B：`collect` 的轮询开销，vibee 未来若采用会放大

**现状**（`packages/session-tool-local/src/index.ts:447-483`）：`collect` 是一个 `for (;;)` 循环，每轮 `collectSnapshot`→`delegationStatusOf`（`:789`）对每个成员会话重新 `foldDelegationStatus(events)` 全量重折日志，然后 `sleep(COLLECT_POLL_MS)`（`:482`，`COLLECT_POLL_MS = 250`，`:984`），不读已注册的 `sessionProjections` 投影缓存，也不订阅变更事件。

**vibee 侧现状**：Phase 6 的调研文档（`vibee-session-tool-integration.md` §3）已经把这条性能债记录为"已知的性能债，不因这次重定位而改变"，并明确 vibee 的 parallel/foreach 节点未来的 join 逻辑设想是复用 `collect`——`session-delegation` spec 的 ASM-007 也把 `collect` 定位为"vibee 未来可复用的执行原语"。但截至目前，vibee-host 的 parallel/foreach **还没有**接上 `collect`（引擎自己在内存里 `Promise.all` 多个 `execute()` 调用，没有经过 session-tool），所以这条性能债眼下不影响 vibee 的实际运行——只是"还没触发"，不是"不存在"。

**想问的问题**：

1. `delegationStatusOf` 改成读 `ctx.sessionProjections` 的缓存投影值（而非每次全量重折），或者把 250ms 轮询换成订阅 `onChanged` 事件，这两个方向哪个更符合 session-tool 现有的架构习惯？我们没有偏好，只是想知道往哪个方向对齐评审会更顺。
2. 这项改进要不要等 vibee 真的接上 `collect` 再做（届时我们可以提供一个具体的 fan-out 规模数据作为验收基准，比如"20 分支 workflow 的 collect 延迟应该控制在多少"），还是你们觉得现在就值得先做（毕竟 `subagent-session` provider 等其他消费方也在用 `collect`，改进不是 vibee 专属收益）？

## 5. 议题 C（仅背景，不要求处理）：传输层自环

vibee 与 web 网关同进程部署时，`ctx.sessionTool.create/write/wait/read` 每次调用都经 `SessionHttpClient`/`WorkspaceHttpClient` 走 `Config.webUrl`（默认 `http://127.0.0.1:3080`）发 HTTP 请求回自己的进程。vibee 侧一度把这个自环判定为"阻塞项，需要 session-tool 先加 `Config.transport: 'in-process'`"，后来复核推翻——`session-tool` 自己的生产部署（`tool-session` 挂在 `web` profile）本来就是这样跑的，loopback 自环 + HTTP 序列化的开销对"起一个子会话、等一次 idle"这种非高频操作可忽略，实测链路无异常（详见 `plugin/vibee/plugin/docs/vibee-flow/evidence/phase-6/transport-calibration.md`）。

写在这里只是为了记录完整背景：如果未来 session-tool 自己出于其他消费方（比如高频场景）的需要加了 `InProcessApiClient(toFetchHandler(ctx.get('apiProxy')))` 分支（`subagent-session` provider 已经在用这个模式），vibee 会自动受益，不需要跟着改代码——因为 `DshSessionExecutorPort` 只依赖 `ctx.sessionTool` 服务接口。**不需要 session-tool 团队为 vibee 单独排期做这件事。**

## 6. 议题 D（仅背景，不要求处理）：vibee 会是一个新的高频消费方

一次 vibee workflow run 里的 `parallel`/`foreach` 节点可能在几秒内对同一个 `runId` 打出几十个 `create`（每个 tagged `vibee:<runId>`），随后各自 `write`+`wait`。这和目前 `tool-session`/`subagent-session` 的调用节奏（人在敲命令，或模型一次委派一个子任务）不同——量级更���近"批量"而不是"交互"。写在这里是提前给个容量规划信号，不是现在就要求处理；如果议题 B 的改进推进，这个使用形态可以作为其中一个验收场景。

## 7. 不在讨论范围内的项

- **`session-tool-local` 的 `Config.transport: 'in-process'`**：已在议题 C 说明，vibee 不阻塞于此，不要求排期。
- **`SessionToolService.create`/`write` 新增 `outputSchema` 参数**：vibee 已经决定这套 JSON 约定+校验私有于 vibee-host（BR-017），不要求 session-tool 契约感知"schema"这个概念。

## 8. 期望的下一步

这不是任务包，没有验收矩阵。如果 A、B 里有你们觉得值得做的，麻烦回个话说说大概优先级/时间；如果都不打算现在做，也请直说原因（比如"cancel 就该留在私有层，等真正的产品需求出现再谈契约"），我们会照单全收，vibee 侧会继续维持 BR-018/现有 collect 绕开方案，不会追着要。
