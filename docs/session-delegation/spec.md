# session-delegation Spec

> Version: 0.1.0 | Date: 2026-08-13 | Status: Draft 草稿
>
> 本文件是本需求的**唯一事实源**：事实基线、业务合同、技术方案、任务计划、验收协议全部在此。
> 其他文件（handoff.md、tasks.csv）只引用本文件，不复制内容。
>
> 填写三态规则：每个表格单元格只允许三种内容——
> 1. 验证过的事实（注明来源命令）；2. 显式假设 `ASM-xxx`；3. `待勘察`。
> 禁止编造看似合理的命令、symbol、文件名。

---

## 1. 事实基线与假设

### 1.1 需求与运行模式

| 项 | 结论 |
|---|---|
| 原始需求 | 将 DSH subagent 的"受控机制"（continuation manager：Activation 三态 / ownedChildren 图 / descriptor 冷恢复协议 / child-first drain / 精确父授权）替换为**平级 session + 标签/属性/约束元数据**方案：委派执行单元 = 普通持久会话（`parentSession` 血缘 + tags/投影元数据 + 工具层约束），subagent 外部接口契约（工具名/schema/`SubagentProvider`/`SubagentRun`/workflow/ralph/GUI）**全部保留不破坏**（换引擎不换壳）；编排层暂不交给 vibee（仅后期 flow 生态预留 session 层接入面） |
| 输入类型 | empty（上下文回退协议） |
| Mode | oneclick |
| 置信度 | 高 |
| 输出目录 | `plugin/docs/session-delegation/` |

### 1.2 任务类型路由

| 维度 | 结论 |
|---|---|
| 任务类型 | refactor（核心机制替换）+ backend（上游 RPC/插件工具）+ bugfix 回归（生态兼容） |
| 主要风险 | ① 换引擎后 workflow/ralph/外部 4 后端行为漂移（结构化输出、等待语义）；② 上游改动波及 web 网关既有 344+ 测试；③ continuable 授权放宽的语义变化 |
| 行号引用策略 | 中高：重构/迁移必须 symbol + rg anchor；行号仅 hint |
| 必需验收方式 | unit + typecheck（入场券）+ **真实场景**（headless agent 委派 + GUI 可见性 + workflow 回归） |
| 必须覆盖用户场景 | 模型面委派（one-shot/后台/续写）、协调者查任务清单、GUI 查看/接管委派会话、workflow/ralph 回归 |

### 1.3 勘察事实清单

> 每条事实来自实际执行的命令。

| 事实 | 来源命令 | 输出摘要 |
|---|---|---|
| subagent 家族 11 个包（subagent / -inprocess / -spawn / -fork / -acp / -codex / -claude-code / -dsh-sdk / tool-subagent / -control / -report） | `ls packages/subagent/`（staging-20260811T020137Z） | 11 包确认 |
| continuation manager 实现 1213 行（Activation 接口含 `ownedChildren`/`accepted`/`disposal`/`poke`；`authorizeLineage` 双关卡；`watchSettlement` 三态循环；`drain`/`drainDescendants`） | `wc -l packages/subagent/subagent/src/continuation.ts` + `grep -n "async drain\|authorizeLineage\|watchSettlement"` | 五机制全部在 continuation.ts 确认 |
| 反向依赖 10 个包：`bundle/base`、`host/apiproxy`、`client/ui-subagent`、`workflow/workflow-workerthread`、`workflow/tool-workflow`、`workflow/tool-ralph`、`hooks/hooks-claude`、`ui/jsonrpc`、`sdk/sdk-protocol`、`sdk/helper` | `grep -rln '"@deepseek-ai/dsh-subagent[^"]*"' packages apps --include=package.json` | 10 个消费者确认 |
| bundle/base 挂 7 行 subagent 装配（subagent + spawn + fork + control×2 + tool-subagent×2） | `grep -n "subagent" packages/bundle/base/cordis.patch.yml` | L250-L287 确认 |
| workflow 引擎与 ralph 依赖 subagent 接口面 + spawn provider（ralph 要求 structured output 且 fresh provider） | `grep -rn "subagent" packages/workflow/tool-ralph/src/index.ts` | `getProvider`/`supports structured output` 确认 |
| `session.durableCreate` 端点已存在（含 `parentSessionId`/`title`/`tags`/`workspaceId`/`cwd`） | `grep -rn "durableCreate" env/session-tool-env/packages/host/apiproxy/src` + `git log --oneline -1`（534eb84） | 上游已具备创建+agent 待命+账写入 |
| `session.prompt` 投递即返回 `{accepted: true}`（queue 模式，不等待模型回复） | `sed -n 1800,1880p packages/host/apiproxy/src/api-proxy.ts` | 无同步等待；完成检测需新增 |
| session-tags 服务：log-only `session/tags` 事件 + tags 投影 + hiddenPrefixes 可见性规则 | `sed -n 1,80p env/session-tool-env/packages/session/session-tags/src/index.ts` | 标签/隐藏机制现成 |
| session-projection seam：`ProjectionDefinition`（init/apply/view + schema + stateVersion），插件可注册自定义 unit | `sed -n 1,80p packages/session-projection/session-projection/src/index.ts` | 属性机制现成（subagentTiming 为先例） |
| session-tool 契约已含 `parentSessionId`/`title`/`tags`/`workspacePath`；list 已含 scope/tags/title/status 过滤；owner fence（`assertCreateParent`）已实现 | `grep -n "interface SessionTool\|parentSessionId\|assertCreateParent" plugin/packages/session-tool/src/index.ts` + `session-tool-local/src/index.ts` | 插件已具备血缘/标签/约束骨架 |
| 插件 5 工具已上线：session_create/read/write/list/rename | `grep -n "name:" plugin/packages/tool-session/src/index.ts` | 5 工具确认 |
| 目录 git 归属：工作区根非 git；`plugin/` 与 `env/session-tool-env/` 各自独立 git | `git rev-parse --show-toplevel`（三处） | PRD 包落 `plugin/docs/`（可 commit） |
| 测试命令：插件 `pnpm test`（vitest run）；env `pnpm test`（vitest run，基线 344 例含 durableCreate/rename-tags 13 例） | `grep -A15 '"scripts"' plugin/package.json` + `env/session-tool-env/package.json` | 命令级验证入口确认 |
| DSH 原生 `session.prompt` 对 subagent 会话有所有权栅栏（`hasSubagentOwner` → `agent-busy`） | `grep -n "hasSubagentOwner\|agent-busy" packages/host/apiproxy/src/api-proxy.ts` | L945-L1167 确认 |
| subagent 网关域 3 RPC：`subagent.list` / `subagent.history` / `subagent.prompt` | `grep -n "'subagent" packages/host/apiproxy/src/fetch/handler.ts` | L92-L97 确认 |

### 1.4 假设清单

| 假设 ID | 内容 | 风险 | 确认方式 |
|---|---|---|---|
| ASM-001 | **continuable 平级化选项**：P4 默认走选项 A（send_message/list_agents 改走 session API，续写开放）；若 P0 决策改为选项 B（continuable 暂留旧实现），P4 降级为仅标记 deprecated | 语义变化大（授权放宽） | P0 决策任务 T-002 用户拍板 |
| ASM-002 | **授权强度**默认 `workspace`（同 workspace 可续写），Config 可配 `creator`/`anyone` | 与 subagent 精确父授权语义差异 | P0 决策任务 T-002 |
| ASM-003 | **等待语义** = 单 session idle（不等子树）；`session.wait` 端点实现于 P1 | 子又开子时父不等孙（与现状 whenIdle 有差异） | P0 决策任务 T-002 + P3 回归确认 |
| ASM-004 | **结构化输出**保留：session provider 桥接在子会话注入结构化约定（JSON 文本 + 校验重试），workflow/ralph 的 outputSchema 能力声明保持 true | 文本约定弱于现状强校验 | P3 任务 T-014 实现 + ralph 回归 |
| ASM-005 | **清理策略** = 标记 + 手动 + 超时三件套（tags `~archived` + hiddenPrefixes + 后台扫描任务可后置） | 孤儿会话无自动回收 | P0 决策任务 T-002 + P2 后置 |
| ASM-006 | 上游基线 = `env/session-tool-env` HEAD（534eb84）；subagent 源码基线 = `~/.dsh/source/current`（staging-20260811T020137Z） | 两处基线差异导致定位漂移 | P0 校准任务 T-001 |
| ASM-007 | **收集约束边界**：`session_collect` 只做"完成条件声明式求值"（wait-all/any/n/first-failed + 失败策略 + 超时 + 聚合），**不做**依赖图（DAG）/调度/重试编排——那些留给后期 flow 生态，collect 作为 vibee 未来可复用的执行原语 | 边界膨胀成迷你工作流引擎 | P2 任务 T-012 契约注释 + 5.4 检查 |
| ASM-008 | **provider 桥接落点 = 上游 subagent-session 包**（subagent 家族新成员，与 acp/codex 并列），bundle/base 装配行改为指向它；插件（session-tool）**不注册 provider**，专注工具面/元数据/约束。依据（已勘察）：bundle/base 的 tool-subagent/workflow/ralph 装配行全部指向 provider 名，provider 必须在核心 composition 注册；headless 进程 = web composition 完整挂载（自带 apiProxy），transport 用 `InProcessApiClient(toFetchHandler(ctx.apiProxy))`（headless runner 现成模式，双进程皆进程内网关，无跨进程 HTTP） | 插件若注册 provider，web profile（未装插件）的 workflow 在 `getProvider` 处 AGENT_START 崩溃 | P3 任务 T-014 实现 + 装配回归 |
| ASM-009 | **约束执行路径割裂边界**：creator/anyone 档位只覆盖插件工具路径（`session_write`/`session_collect`）；上游 subagent 工具路径（`subagent`/`send_message` → subagent-session）保持 workspace 级授权（网关既有面），上游不读插件 Config | 用户误以为 creator 档约束了 subagent 工具路径 | BR-005 边界说明 + 5.4 检查 |

---

## 2. 业务合同

> 本章是 BR/UF/INV/EVD 的唯一定义处。任务、handoff、review 一律引用 ID，不复制表格。

### 2.1 BR 业务规则

| 规则 ID | 规则 | 正例 | 反例 | 影响范围 | 验证方式 |
|---|---|---|---|---|---|
| BR-001 | 委派执行单元必须是**持久平级会话**：`parentSession` 血缘记录 + 普通 session 全生命周期（持久化/恢复/GUI 可见），无运行时父子控制 | 委派后父 agent dispose，子会话仍可被任何人 prompt | 子会话随父级联停止（ownedChildren 语义残留） | subagent 包/插件 | unit + 真实场景 |
| BR-002 | **生态契约零破坏**：`subagent`/`subagent_fork` 工具名与 schema、`SubagentProvider`/`SubagentRun` 接口、`subagent.list/history/prompt` RPC 形状、workflow/ralph 调用方式全部不变 | workflow 以 `subagentProvider: spawn` 配置跑通 | 工具名/schema/RPC 字段任何变化 | 全部 | 全量回归 |
| BR-003 | 委派元数据（来源/模式/深度/状态）必须**持久可查**：来源/深度入 header，状态由投影推导，标签可过滤 | `session_list` 按 `tags:['delegated']` + status 过滤出运行中任务 | 状态只在内存、崩溃丢失 | session-tool | unit + 重启验证 |
| BR-004 | 完成状态必须**可从会话日志推导**（投影纯函数），不依赖任何进程本地状态 | 进程重启后 `session_list` 仍显示 completed/failed | 重启后状态消失或需手动修复 | session-tool 投影 | unit + 重启验证 |
| BR-005 | 约束（续写授权/深度上限）在**插件工具层执行**，强度由 Config 决定；默认不改变 web GUI 既有会话行为。**路径边界**（ASM-009）：creator/anyone 档位只约束插件工具路径（`session_write`/`session_collect`）；上游 subagent 工具路径（`subagent`/`send_message`）保持 workspace 级授权（网关既有面） | `allowOthersToWrite: 'workspace'` 下同 workspace 会话可续写 | 约束逻辑进入核心或影响非委派会话 | session-tool + subagent-session | unit |
| BR-006 | 上游改动**零新增事件类型**（归因走 `MessageSource` 合并扩展；深度走既有 header 字段） | 父投递消息在子日志带 `coordinator` 归因 | 新增 `subagent/*` 式专用事件 | env worktree | typecheck + 测试 |
| BR-007 | 收集约束必须**声明式求值**：对一组会话（血缘树或 tags 聚合）判定完成条件（`wait: all/any/n/first-failed` + `on_failure: continue/cancel-rest` + 超时），结果从会话日志/投影聚合；**禁止**内置依赖图/调度/重试编排 | `wait: 'all'` 下 3 个会话全部终态后返回聚合结果 | `wait: 'n'(2)` 下等全部 3 个才返回 | session-tool collect | unit + 冒烟 |

### 2.2 UF 用户验收场景（索引）

| 场景 ID | Given | When | Then | 角色 | 验证方式 | Evidence |
|---|---|---|---|---|---|---|
| UF-001 | agent 有 `subagent` 工具 | 前台委派一个任务 | 工具返回最终结果文本（与现状一致），子会话持久存在 | 模型 agent | headless 冒烟 | EVD-001 |
| UF-002 | agent 有 `send_message` 工具，子会话已存在 | 向子会话发后续消息 | 消息作为新轮次进入子会话日志，子会话可被任何 workspace 内调用方续写 | 模型 agent | headless 冒烟 | EVD-001 |
| UF-003 | 协调者 agent 创建了多个委派会话 | `session_list` 按血缘/状态过滤 | 返回任务清单（running/completed/failed），`session_wait` 可等待完成 | 模型 agent | 插件 unit + 冒烟 | EVD-002 |
| UF-004 | web GUI 运行中，委派会话存在 | 用户打开侧边栏/会话列表 | 委派会话可见（按配置），可打开、可续写、可停止；`origin` 仅作分类 | 人类用户 | 浏览器实测 | EVD-003 |
| UF-005 | workflow 引擎配置 `subagentProvider: spawn` | 跑一个 workflow | 结果与改造前一致（含结构化输出场景） | 编排层 | workflow e2e | EVD-004 |
| UF-006 | 外部 CLI 后端（acp/codex/claude-code/sdk）已装配 | 通过 `subagent` 工具调用任一后端 | 行为与改造前一致 | 模型 agent | 装配回归 | EVD-005 |
| UF-007 | 协调者 agent 创建了 N 个委派会话（`tags:['delegated']`） | 调用 `session_collect`（wait-all / wait-n / 失败策略） | 按声明条件返回聚合结果（或按 n 提前返回、按策略取消其余） | 模型 agent | 插件 unit + headless 冒烟 | EVD-009 |

### 2.3 核心业务流程（步骤级交互脚本）

> 本需求主体是 backend/refactor，用户可见面 = 模型工具 + GUI。GUI 侧（UF-004）为唯一浏览器可见流程；模型侧流程（UF-001~003）以工具调用 + 会话日志为"界面"。

#### UF-001: 前台委派（模型视角，one-shot 兼容）

**前置状态**：agent 运行于 headless 或 web 进程；`subagent` 工具已装配；Config 选择 `session` 后端（或默认路径）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `subagent({description, prompt})` | — | 工具经 `ctx.subagents` session provider：durableCreate(平级会话, parentSession=调用者) + prompt(任务文本) | — |
| 2 | — | — | 等待子会话 idle（`session.wait` 或进程内 agent/status） | — |
| 3 | — | — | 读子会话最后 assistant/message + turn/end reason | 工具返回 `{output, stopReason}`（与现状同形状） |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 创建失败 | web 网关不可达/workspace 不存在 | 工具报错（`web-unreachable`/`workspace-not-found`） | 无会话产生 | 模型重试或换 workspace |
| 等待超时 | 子会话长时间不 idle | 工具报错/超时返回 | 会话保留（可后续 read） | 模型 `session_read` 接管 |
| 子会话失败 | turn/end reason = error/aborted | 工具返回 `stopReason: 'error'` | 会话日志保留失败现场 | 模型决定重试或人工介入 |

**界面状态机**（工具调用生命周期）：

```text
idle → creating → waiting(idle) → collected
              │          │
              ▼          ▼
          error(可重试)   timeout(会话保留,可读)
```

**入口接线清单**：

- 模型入口：`subagent` 工具（tool-subagent 包，名字不变）→ `ctx.subagents` → session provider
- 网关入口：`session.durableCreate` + `session.prompt` + `session.wait`（P1 新增）

#### UF-002: 后台委派与续写（模型视角，send_message 兼容）

**前置状态**：存在委派会话（血缘 parentSession = 调用者）；调用方位于同一 workspace。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `send_message({subagent_id, message})` | — | 消息经 `session.prompt` 投递（coordinator 归因）到子会话 | 返回成功（同现状形状） |
| 2 | 模型调用 `list_agents` | — | 改走 `session_list`（血缘 + 状态投影） | 返回子会话清单（running/complete 词汇保持） |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 会话不存在 | subagent_id 已删/无权限 | 工具报 not-found | 无副作用 | 模型 `session_list` 核实 |
| 授权不足 | Config=`creator` 且调用者非创建者 | 工具报拒绝 | 消息未投递 | 更换调用者或放宽 Config |

**入口接线清单**：

- `send_message` → `session.prompt`（coordinator source）
- `list_agents` → `session_list`（scope tree + 状态投影）

#### UF-003: 协调者任务管理（模型视角）

**前置状态**：协调者 agent 已创建 ≥1 个委派会话（title 含任务名、tags 含 `delegated`）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `session_list({scope:'tree', tags:['delegated']})` | — | 本地血缘扫描 + 投影过滤 | 任务清单（标题/tags/status） |
| 2 | 模型调用 `session_wait({session_id, timeout})` | — | 订阅投影变更/轮询，直到 status ∈ {completed,failed,aborted} | 完成状态 + 最后消息摘要 |
| 3 | 模型调用 `session_read({session_id})` | — | 读本地持久日志 | 完整结果 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 空列表 | 无委派会话 | 返回空 items | — | 模型先 create |
| 等待超时 | 子会话长期 running | 超时返回当前状态 | 无副作用 | 模型决定继续等或接管 |

**入口接线清单**：

- `session_list` / `session_wait` / `session_read`（tool-session 包）

#### UF-004: GUI 查看与接管委派会话（人类视角，唯一浏览器流程）

**前置状态**：`dsh web` 运行；委派会话已创建于可见 workspace；Config `showDelegated: true`（默认）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 打开侧边栏会话列表 | 委派会话出现在列表中（无隐藏） | 网关 session.list 返回含委派会话 | 可辨识（标题/tags） |
| 2 | 点击委派会话 | 进入普通会话视图 | session.history 读持久日志 | 完整 transcript |
| 3 | 输入消息并发送 | 消息入队列 | session.prompt 投递（user 归因） | 模型回复实时流式出现 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 委派会话跨进程不可见 | 创建于 headless、web 未重启 | 列表缺行 | 持久化按 cwd 分目录，web 视图需刷新/重启 | 重启 web 或经网关创建 |
| 权限受限 | Config=`creator` 且用户非创建者 | 发送按钮禁用/报错 | prompt 被拒 | 放宽 Config |

**界面状态机**：

```text
列表(可见/隐藏按 Config) → 打开(只读历史) → 发送(running) → 完成(可继续)
```

**入口接线清单**：

- 侧边栏列表（session.list 返回集）→ 会话视图（ui-conversation 复用）→ 发送（session.prompt）
- `origin`/tags 隐藏逻辑从"强制隐藏"改为"Config 可配"

#### UF-005: workflow/ralph 回归（编排层）

**前置状态**：workflow 引擎 + tool-ralph 装配于测试 composition。

**成功主路径**：

| 步骤 | 动作 | 系统行为 | 结果 |
|---|---|---|---|
| 1 | 运行 workflow（fan-out 3 个子 agent） | 引擎经 `ctx.subagents` session provider 创建 3 个平级会话 | 各会话独立持久 |
| 2 | 收集结果 | provider 等各会话 idle 并读结果 | 结果与改造前一致 |
| 3 | 运行 ralph（fresh + structured） | provider 声明 outputSchema:true，结构化约定注入 | 结构化结果可解析 |

**失败分支**：

| 分支 | 触发条件 | 表现 | 恢复路径 |
|---|---|---|---|
| 结构化不可解析 | 子模型不遵守 JSON 约定 | provider 报错重试 | 重试或降级文本结果 |

**入口接线清单**：`tool-workflow` → `ctx.subagents`（provider 名不变）。

#### UF-006: 外部 CLI 后端回归（acp/codex/claude-code/sdk）

**前置状态**：4 个外部后端装配。

**主路径**：调用 `subagent` 工具并指定外部后端 → 行为与改造前一致（这些后端不经过 session 栈，仅回归确认未被波及）。

**失败分支**：N/A（外部后端不受本次改动影响，回归仅为确认；失败分支不适用，注明原因：它们不依赖被替换的 in-process 机制）。

#### UF-007: 协调者扇出-收集（模型视角，类树收集约束）

**前置状态**：协调者 agent 已创建 ≥2 个委派会话（同一血缘树或同一 `plan:<id>` tag）；`session_collect` 工具已装配。

**成功主路径（wait-all）**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `session_collect({root: 自己, wait: 'all', timeout_ms})` | — | 解析集合（血缘树）→ 订阅各会话投影状态 | — |
| 2 | — | — | 逐个会话到达终态（completed/failed/aborted），谓词 all 满足 | — |
| 3 | — | — | 聚合各会话结果摘要 | 返回 `{satisfied: true, sessions: [{id, status, result}], elapsed_ms}` |

**成功主路径（wait-n 提前返回）**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `session_collect({root, wait: 'n', n: 2, on_failure: 'cancel-rest'})` | — | 解析集合 + 订阅状态 | — |
| 2 | 2 个会话终态 | — | 谓词 n 满足 → `cancel-rest` 取消剩余会话（`session.cancel`，不删除） | 返回 `{satisfied: true, sessions: [2 个结果 + 其余 cancelled]}` |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 超时 | 会话长期 running 超过 `timeout_ms` | 返回 `{satisfied: false, sessions: 当前快照}`（不报错） | 无副作用 | 模型决定继续 collect 或逐个接管 |
| 空集合 | root/tags 无匹配会话 | 返回空 sessions + `satisfied: false` | 无副作用 | 模型先 create |
| 会话不存在 | 集合中某 id 已删 | 该项标记 `missing`（不整体失败） | 其余继续求值 | 模型核对清单 |

**界面状态机**（collect 工具生命周期）：

```text
idle → resolving(集合) → waiting(订阅/轮询) → satisfied(聚合返回)
                              │                    │
                              ▼                    ▼
                          timeout(快照返回)    (cancel-rest 时部分 cancelled)
```

**入口接线清单**：

- 模型入口：`session_collect` 工具 → `ctx.sessionTool.collect`
- 数据入口：`traceSession`（血缘树）+ delegation 投影（status）+ tags（聚合）——全部现成
- 动作入口：`session.cancel`（cancel-rest）——现成

### 2.4 INV 不变量

| 不变量 ID | 内容 | 关联 BR/UF | 验证方式 |
|---|---|---|---|
| INV-001 | 会话日志 append-only、surface 语义、`session/*` 事件词汇不变；零新增事件类型（归因走 MessageSource 合并扩展） | BR-006 | env 全量测试 |
| INV-002 | `subagent`/`subagent_fork`/`send_message`/`list_agents` 工具名与参数 schema 不变 | BR-002 / UF-001/002 | 工具 schema 测试 |
| INV-003 | `SubagentProvider`/`SubagentRun`/`subagent.list/history/prompt` RPC 响应形状不变 | BR-002 | 契约测试 |
| INV-004 | 旧持久会话（改造前创建的 subagent 会话）只读兼容，不因本次改动损坏 | BR-001 | 加载旧日志测试 |
| INV-005 | workflow/ralph 的 `subagentProvider` 配置值与 provider 能力声明（outputSchema/inheritsParentContext）不变 | BR-002 / UF-005 | workflow e2e |

### 2.5 EVD 证据清单

| 证据 ID | 类型 | 期望证据 | 保存位置 |
|---|---|---|---|
| EVD-001 | log/test | headless 委派冒烟：工具返回 + 子会话日志（coordinator 归因可见） | `evidence/UF-001/` |
| EVD-002 | log/test | 协调者任务清单 + wait 输出 | `evidence/UF-003/` |
| EVD-003 | screenshot/log | GUI 侧边栏可见委派会话 + 打开/发送截图 + console 无错误 | `evidence/UF-004/` |
| EVD-004 | log/test | workflow e2e 通过输出（fan-out 3 + 结构化 1） | `evidence/UF-005/` |
| EVD-005 | log/test | 外部 4 后端装配回归输出 | `evidence/UF-006/` |
| EVD-006 | log | env 全量测试通过（基线 344+ 例） | `evidence/phase-1/` |
| EVD-007 | log | 插件全量测试通过（基线 67+ 例） | `evidence/phase-2/` |
| EVD-008 | log | 重启恢复验证：委派会话状态投影在重启后保持 | `evidence/phase-2/` |
| EVD-009 | log/test | 协调者扇出-收集：wait-all 聚合 + wait-n 提前返回 + cancel-rest + 超时快照 | `evidence/UF-007/` |

### 2.6 角色与权限矩阵

| 角色 | 可见 | 可操作 | 禁止 | 失败提示 | 验证场景 |
|---|---|---|---|---|---|
| 协调者 agent | 自己的血缘树 | 创建/投递/等待/读/停 | 跨 workspace 会话 | scope/workspace 拒绝 | UF-001~003 |
| 其他 agent（同 workspace） | 同 workspace 会话 | 投递/读（Config=`workspace`） | Config=`creator` 时续写他人任务 | 工具报拒绝 | UF-002 |
| 人类用户（GUI） | 可见会话（按 Config） | 打开/续写/停止 | 隐藏会话（`~` 前缀） | 列表缺行 | UF-004 |
| workflow/ralph | provider 接口 | 委派/收集 | 深度超限 | provider 拒绝 | UF-005 |

### 2.7 负向 / 破坏性场景

| 场景 | Given | When | Then | Evidence |
|---|---|---|---|---|
| 授权不足 | Config=`creator` | 非创建者 prompt 委派会话 | 投递被拒，日志无新消息 | EVD-002 |
| 进程重启 | 委派会话 running 中 | 重启 web 进程 | 会话持久，状态投影从日志重建 | EVD-008 |
| 深度超限 | 调用者 depth ≥ max | 再创建委派会话 | 工具拒绝创建 | EVD-002 |
| 旧数据兼容 | 改造前 subagent 会话存在 | 加载/读取 | 只读正常，无损坏 | EVD-004 |
| 并发续写 | 两个调用方同时 prompt 同一会话 | — | 消息均入 inbox 队列（Agent inbox FIFO） | EVD-002 |

### 2.8 非目标

- 编排层迁移到 vibee（本包只预留 session 层接入面，不做 vibee 集成）。
- workflow 引擎/工具/ralph 退役（保持现状）。
- subagent 外部 4 后端（acp/codex/claude-code/sdk）改造。
- 会话树/分支 UI、worktree 并行工作区、handoff（Codex 式）能力。
- GUI 侧 subagent catalog 嵌套树视图的重新设计（保持现有组件兼容）。

---

## 3. 技术方案

### 3.1 架构 Before / After

```text
Before:
模型 ─▶ tool-subagent ─▶ ctx.subagents ─▶ spawn/fork provider
                                              │
                                              ▼
                              continuation manager(continuation.ts, 1213 行)
                                ├─ Activation 三态(进程本地驻留)
                                ├─ ownedChildren 图(child-first)
                                ├─ descriptor 冷恢复协议(版本化事件)
                                ├─ child-first drain(关闭仪式)
                                └─ 精确父授权(双关卡)
                                              │
                                              ▼
                              子会话(受控:隐藏/不可接管/仅父可续)

After:
模型 ─▶ tool-subagent ─▶ ctx.subagents ─▶ subagent-session 包(上游新 provider)
                                              │  InProcessApiClient(toFetchHandler(apiProxy))
                                              ▼
                              durableCreate + prompt + wait + read
                                              │
                                              ▼
                              平级持久会话(一等公民)
                                ├─ header: parentSession/delegationDepth(血缘+深度)
                                ├─ tags: delegated/task:<planId>(分类)
                                ├─ 投影: delegation unit(status 从日志推导)
                                └─ 约束: 插件工具层(owner fence/scope/Config)

生态契约(不变): SubagentProvider/SubagentRun/send_message/list_agents/
                subagent.list/history/prompt RPC/workflow/ralph/GUI
编排层(不动):   workflow 照常;vibee 后期从 session 层接入(本包不实现)
```

### 3.2 模块改造

| 模块 | 职责 | 改造说明 |
|---|---|---|
| env worktree: `packages/host/apiproxy` | web 网关 | ① durableCreate 补 `delegationDepth` 写入；② 新增 `session.wait` 端点；③ 归因扩展 `MessageSource` coordinator（若 P0 决策）；④ subagent domain 保留形状、内部读血缘+标记（P4） |
| env worktree: `packages/core/session`（或 llm 类型） | 消息归因 | `MessageSourceMap` 合并扩展 `coordinator`（声明合并，零核心改动） |
| subagent 包: `subagent-session`(新增) | provider(上游) | `providerName: 'session'`；`start()` = `InProcessApiClient(toFetchHandler(ctx.apiProxy))` → durableCreate + prompt + wait + read（headless runner 现成模式，双进程皆进程内网关）；`prepareContinuable()` 返回空 spec（续写走 session.prompt，continuable 语义保留）；fork 支持 = `sessions.fork` + attach；能力声明与 spawn 一致 |
| subagent 包: `subagent-spawn`/`subagent-fork` | provider | **退役**（被 subagent-session 取代，P3 后删除） |
| subagent 包: `subagent-inprocess` | 驱动器 | 退役（P3 后不再被 spawn/fork 使用，P4 删除） |
| subagent 包: `subagent`(核心) | seam | continuation manager/descriptor/Activation 标记 deprecated(P3)→删除(P4)；接口面(provider/run/depth/composition)保留 |
| subagent 包: `tool-subagent-control` | 模型工具 | `send_message`→session.prompt(coordinator)；`list_agents`→session_list(状态投影映射)（P4） |
| subagent 包: `tool-subagent-report` | 报告通道 | 保留或退役（P0 决策；默认保留，子结果经会话日志已可达） |
| session-tool 插件: `packages/session-tool-local` | provider/服务 | 注册 `delegation` 投影 unit；`session_wait` 实现；list 扩展投影/血缘过滤；Config 约束（授权强度/深度上限/可见性）；**新增收集约束求值器 `collect`**（谓词求值 + 聚合 + cancel-rest） |
| session-tool 插件: `packages/tool-session` | 模型工具 | `session_create` 传来源/深度；`session_list` 加 status 过滤；新增 `session_wait` 与 **`session_collect`**；schema 扩展 |
| session-tool 插件: `packages/session-tool` | 契约 | 新增 wait/约束/投影相关类型与错误码 |
| 上游 bundle: `bundle/base` | 装配 | 删 subagent-spawn/fork 行 → 加 subagent-session 行；`tool-subagent`×2 的 `provider: spawn/fork` → `session`（backgroundMode: continuable 保留）；`workflow-workerthread` `provider: spawn` → `session`；`tool-ralph` `subagentProvider: spawn` → `session` |
| 上游: `client/ui-subagent`、`hooks-claude` | 消费面 | P4：origin 降级为分类、可见性 Config；hooks 事件保留或映射 |

### 3.3 三段式定位清单

> 行号只是 hint；漂移时以 symbol + rg anchor 为准。

| 文件 | 稳定定位 | 搜索定位 | 行号 hint | 备注 |
|---|---|---|---|---|
| `packages/subagent/subagent/src/continuation.ts` | `class ContinuationManager` / `startContinuable` / `followup` / `drain` / `authorizeLineage` / `watchSettlement` | `rg "class ContinuationManager" packages/subagent/subagent/src/continuation.ts` | L314/L384/L532/L1016/L1038 | 五机制本体,1213 行 |
| `packages/subagent/subagent/src/descriptor.ts` | `snapshotSubagentDescriptor` / `foldSubagentDescriptor` / `SUBAGENT_DESCRIPTOR_VERSION` | `rg "SUBAGENT_DESCRIPTOR_VERSION" packages/subagent/subagent/src/descriptor.ts` | 全文件 312 行 | 冷恢复协议 |
| `packages/subagent/subagent-inprocess/src/index.ts` | `startInProcessRun` / `drivePublishedRun` / `readResult` | `rg "startInProcessRun" packages/subagent/subagent-inprocess/src/index.ts` | L99/L160/L214 | one-shot 驱动器 |
| `packages/subagent/subagent-spawn/src/index.ts` | `class SpawnProvider` / `start` / `prepareContinuable` | `rg "class SpawnProvider" packages/subagent/subagent-spawn/src/index.ts` | L41-L60 | 换引擎目标点 |
| `packages/subagent/tool-subagent/src/index.ts` | `name: 'subagent'` 工具定义 | `rg "toolName" packages/subagent/tool-subagent/src/index.ts` | 待勘察 | 工具面(名字不变) |
| `packages/subagent/tool-subagent-control/src/index.ts` | `send_message` / `list_agents` 工具 | `rg "send_message" packages/subagent/tool-subagent-control/src/` | 待勘察 | P4 改走 session API |
| `packages/host/apiproxy/src/api-proxy.ts` | `sessions:` 域 `prompt` / `durableCreate`(env) / `hasSubagentOwner` / `subagents:` 域 | `rg "durableCreate|hasSubagentOwner|async prompt" packages/host/apiproxy/src/api-proxy.ts` | L945/L1442/L1813 | 网关改造点 |
| `packages/host/apiproxy/src/api/sessions.schema.ts` | RPC schema 定义 | `rg "durableCreate" packages/host/apiproxy/src/api/sessions.schema.ts` | 待勘察 | wait 端点 schema 落点 |
| `packages/bundle/base/cordis.patch.yml` | subagent/workflow/ralph 装配行 | `rg -n "subagent|workflow-workerthread|tool-ralph" packages/bundle/base/cordis.patch.yml` | L250-L333 | 5 处 provider 指向需改 |
| `packages/subagent/subagent-session/`(新增) | 上游 session provider | `rg "subagent-session" packages/subagent/` | 新增包 | 实现=headless runner 模式 + sessions.fork |
| `packages/bundle/headless/cordis.patch.yml` | headless=web composition | `rg "dsh-web-app" packages/bundle/headless/cordis.patch.yml` | 全文件 | 证明双进程皆进程内网关 |
| `packages/session-projection/session-projection/src/index.ts` | `ProjectionDefinition` 接口 / `ctx.sessionProjections` | `rg "ProjectionDefinition" packages/session-projection/session-projection/src/index.ts` | L43-L77 | 投影 unit 注册点 |
| `packages/session/session-tags/src/index.ts`(env) | `SessionTagsService` / `filterVisibleByRules` | `rg "SessionTagsService" packages/session/session-tags/src/index.ts` | L33-L80 | tags/可见性 |
| `plugin/packages/session-tool/src/index.ts` | `SessionToolCreateOptions` / `SessionToolListFilter` | `rg "interface SessionToolCreateOptions" plugin/packages/session-tool/src/index.ts` | L29-L136 | 契约扩展点 |
| `plugin/packages/session-tool-local/src/index.ts` | `assertCreateParent` / `list` / `read` / provider 实现 | `rg "assertCreateParent" plugin/packages/session-tool-local/src/index.ts` | L115-L195 | 约束/过滤实现点 |
| `plugin/packages/tool-session/src/index.ts` | 5 工具定义 | `rg "name: 'session_" plugin/packages/tool-session/src/index.ts` | L55-L230 | 工具 schema 扩展点 |
| `plugin/packages/session-tool-local/src/session-client.ts` | `SessionHttpClient`(durableCreate/prompt/list/rename) | `rg "durableCreate" plugin/packages/session-tool-local/src/session-client.ts` | 待勘察 | wait 客户端落点 |
| `plugin/packages/session-tool-local/src/collect.ts`(新增) | 收集约束求值器 | `rg "collect" plugin/packages/session-tool-local/src/` | 新增文件 | 谓词求值/聚合/cancel-rest |
| `plugin/packages/session-tool/src/index.ts` | `SessionToolCollectRequest/Result` 契约 | `rg "SessionToolCollect" plugin/packages/session-tool/src/index.ts` | 新增类型 | collect 契约 |
| `packages/workflow/tool-ralph/src/index.ts` | `getProvider` / structured 能力检查 | `rg "supports structured output|getProvider" packages/workflow/tool-ralph/src/index.ts` | L221-L229 | 回归锚点 |

### 3.4 API / 数据 / 权限 / 路由影响

| 类型 | 是否影响 | 说明 | 兼容策略 |
|---|---|---|---|
| API | 是(新增 1) | `session.wait(sessionId, {until?, timeout?})` 端点新增;`session.durableCreate` 增加 `delegationDepth` 字段(可选) | 新增字段可选、旧调用不传即旧行为;wait 为纯新增 |
| 数据 | 是(仅 header) | 委派会话 header 增加 `delegationDepth` 写入;无新事件类型 | 可选字段,旧日志兼容 |
| 权限 | 是(插件层) | Config 约束(workspace/creator/anyone)替换 subagent 精确父授权 | 默认 `workspace`,与现状 web GUI 行为一致 |
| 路由 | 否 | 无新路由;subagent domain RPC 形状不变 | — |

---

## 4. Phase 计划与任务详情

> Phase 依赖链：

```text
P0 基线与决策 → P1 上游核心小改 → P2 插件元数据设施 → P3 换引擎(不破坏生态)
                                                       │
P4 continuable 平级化 ◀────────────────────────────────┘
                       │
P5 真实场景验收 ◀──────┘
```

> 任务状态跟踪：同目录 `tasks.csv`（23 任务 ≥ 8）。
> 任务标题格式：`### Task {N}: {标题}`，N 与 CSV 序号一致。

### Phase 0: 基线与决策

> 你在哪里：讨论已定方向（平级 session + 元数据方案 + 换引擎不换壳），4 个开放决策未定案；基线已勘察（见 1.3）。
> 做完之后：基线可复现、决策定案、spec 1.4 假设清单更新为最终值。

### Task 1: 校准上游与插件基线

- **关联**：INV-004 / EVD-006 / EVD-007
- **前置任务**：无
- **风险等级**：P0

**为什么做**：spec 1.3 勘察基于 `~/.dsh/source/current`（staging-20260811T020137Z）与 env worktree（534eb84），两者基线不同；所有后续定位必须锚定实际改造 worktree。

**涉及文件与定位**：

- `env/session-tool-env/`：`git log --oneline -3`、`git status --short`
- `plugin/`：`git log --oneline -3`
- `~/.dsh/source/current`：`ls -la` 确认 symlink 指向

**具体操作**：

1. 记录 env worktree HEAD 与 plugin HEAD，写入 `evidence/phase-0/baseline.md`
2. 跑基线测试：`cd env/session-tool-env && pnpm test`（预期 344+ 例全绿）、`cd plugin && pnpm test`（预期 67+ 例全绿），记录数量
3. 核对 spec 3.3 定位清单中 4 个 `待勘察` 项（tool-subagent 工具定义、tool-subagent-control、sessions.schema.ts、session-client.ts），用 rg 补全 symbol 与行号
4. 确认 subagent 源码基线（`~/.dsh/source/current` vs env worktree）是否需要同步到 env 后再改

**验证**：`pnpm test`（两处）→ 与基线记录一致；`rg` 补全项无 `待勘察` 残留

**Evidence**：`evidence/phase-0/baseline.md` + 测试输出

**注意事项**：禁止在未确认基线前改代码；两处基线差异（ASM-006）若导致 subagent 包在 env 中不存在，需先在 env 同步该包（`pnpm install` 范围核对）

### Task 2: 定案开放决策并更新 spec 假设清单

- **关联**：ASM-001~005 / BR-005 / UF-002 / UF-004
- **前置任务**：1
- **风险等级**：P0

**为什么做**：4 个开放决策（continuable A/B、授权强度、等待语义、清理策略）决定 P2-P4 全部任务形态；spec 1.4 当前为草案值。

**涉及文件与定位**：

- `plugin/docs/session-delegation/spec.md`：第 1.4 节假设清单、第 2 章受影响 BR/UF
- 讨论记录：本对话（五机制详解、Codex 对照、wt-vibee 约束）

**具体操作**：

1. 逐项与用户确认：
   - ASM-001：continuable 选项 A（send_message/list_agents 走 session API，续写开放）或选项 B（暂留旧实现）
   - ASM-002：授权强度默认值（`workspace` / `creator` / `anyone`）
   - ASM-003：等待语义（单 session idle）+ `session.wait` 端点是否 P1 实现
   - ASM-005：清理策略（标记+手动+超时）及超时任务是否本包实现
2. 将定案结果写回 spec 1.4 假设清单（结论列更新为最终值），同步更新 2.1 BR-005 与 2.3 UF-002/004 相关分支
3. 若决策影响任务拆分（如选项 B → P4 降级），同步修订本第 4 章

**验证**：`python3 /Users/dev/.agents/skills/prd-workflow/scripts/validate_package.py plugin/docs/session-delegation` → 0 FAIL；spec 1.4 无"待确认"字样

**Evidence**：`evidence/phase-0/decisions.md`（决策记录 + 用户拍板结论）

**注意事项**：禁止在决策未定案时推进 P2-P4 任务；决策记录必须含用户原话摘要，防返工

### Task 3: 执行 Phase 0 回归验证

- **关联**：本 Phase 全部任务
- **前置任务**：1;2

**验证**：基线测试复跑（两处 `pnpm test`）→ 与 baseline.md 一致；spec 校验脚本 0 FAIL；决策记录已落盘

**Evidence**：`evidence/phase-0/` 目录完整

### Phase 1: 上游核心小改

> 你在哪里：基线稳定、决策定案。
> 做完之后：env worktree 具备委派所需三个上游能力（深度写入、归因、wait 端点），全量测试绿。

### Task 4: durableCreate 补 delegationDepth 写入

- **关联**：BR-003 / BR-006 / INV-001 / EVD-006
- **前置任务**：3
- **风险等级**：P1

**为什么做**：委派会话的深度约束需要持久深度；`session.durableCreate` 已有 `parentSessionId` 参数但未写 `delegationDepth`。

**涉及文件与定位**：

- `env/session-tool-env/packages/host/apiproxy/src/api-proxy.ts`：`sessions:` 域 `durableCreate` 实现，`rg "durableCreate" packages/host/apiproxy/src/api-proxy.ts`
- `env/session-tool-env/packages/host/apiproxy/src/api/sessions.schema.ts`：`rg "durableCreate" packages/host/apiproxy/src/api/sessions.schema.ts`

**具体操作**：

1. `sessions.schema.ts`：durableCreate 请求加可选 `delegationDepth?: number`（非负安全整数校验）
2. `api-proxy.ts` durableCreate 实现：透传到 `SessionStore.create` 的 `meta.delegationDepth`（参考既有 `parentSessionId` 处理路径）
3. 校验规则：depth 超过调用方自身 `delegationDepthOf + 1` 时拒绝（`delegation-depth` 错误码，参考 `subagent/depth.ts` 的 `resolveChildDepth` 语义）

**验证**：`pnpm test`（env）→ 新增用例覆盖：合法写入 header、超限拒绝、旧调用（不传字段）行为不变

**Evidence**：`evidence/phase-1/durable-depth.log`

**注意事项**：禁止改动 `SessionHeader` 类型本身（字段已存在）；错误码需进 `RpcErrorDetailsMap`（参考你已加的 `tag-invalid` 先例）

### Task 5: MessageSource 增加 coordinator 归因

- **关联**：BR-006 / INV-001 / UF-002 / EVD-001
- **前置任务**：3
- **风险等级**：P2

**为什么做**：父 agent 投递到子会话的消息目前在子日志中归因 `user`，无法区分"agent 委派"与"人类输入"；平级续写开放后归因是唯一区分通道。

**涉及文件与定位**：

- `env/session-tool-env/packages/core/session/src/types.ts`（或 llm 的 `MessageSourceMap` 声明处）：`rg "MessageSourceMap" packages/core/session/src/`
- `env/session-tool-env/packages/host/apiproxy/src/api-proxy.ts`：`sessions.prompt` 的 `source` 构造（L1813 附近）
- 参考先例：`packages/subagent/subagent/src/continuation.ts` 的 `CoordinatorMessageSource`（L48-L70，声明合并模式）

**具体操作**：

1. 在 llm 的 `MessageSourceMap` 声明合并 `coordinator: { kind: 'coordinator', form: 'relay', senderSessionId }`（复刻 continuation.ts 现有类型，若已存在则直接复用）
2. `session.prompt` 请求加可选 `sourceKind?: 'user' | 'coordinator'`（默认 user，旧调用不变）
3. 归因写入子会话 `user/message` 的 `source` 字段

**验证**：`pnpm test`（env）→ prompt 带 coordinator 时消息 source 正确；不带时仍为 user；会话日志校验通过

**Evidence**：`evidence/phase-1/attribution.log`

**注意事项**：禁止改 `MessageSource` 联合类型本体（用声明合并）；`form: 'relay'` 语义与现有 relay 一致

### Task 6: 新增 session.wait 端点

- **关联**：ASM-003 / BR-001 / UF-001 / UF-003 / EVD-001
- **前置任务**：4
- **风险等级**：P1

**为什么做**：`session.prompt` 投递即返回；完成检测需要"等待会话 idle/完成"的同步端点，供 session provider 与 `session_wait` 工具使用。

**涉及文件与定位**：

- `env/session-tool-env/packages/host/apiproxy/src/api-proxy.ts`：`sessions:` 域（prompt 附近 L1813）新增 `wait`
- `env/session-tool-env/packages/host/apiproxy/src/api/sessions.schema.ts`：wait 请求/响应 schema
- 参考实现：`packages/bundle/headless/src/index.ts` 的 `agent/status` idle 订阅模式（L157-L161）

**具体操作**：

1. schema：`session.wait({ sessionId, until?: 'idle' | 'turn-end', timeoutMs? })` → `{ status: 'idle' | 'completed' | 'failed' | 'aborted' | 'timeout', lastTurnEndReason? }`
2. 实现：进程内 `ctx.on('agent/status')` + `agent.whenIdle()`（参照 headless runner）；会话不存在 → `session-not-found`；Agent 未 attach → 冷 resume 后等待（或按 P0 决策只等已 attach）
3. 超时返回 `timeout`（不报错），会话保持可继续
4. `session-client.ts`（插件侧）补 wait 客户端方法

**验证**：`pnpm test`（env）→ wait 对 running 会话阻塞至 idle、超时路径、不存在会话错误；headless 冒烟（create → prompt → wait → 拿到 completed）

**Evidence**：`evidence/phase-1/wait.log`

**注意事项**：禁止 wait 对 subagent 栅栏会话生效（P4 前保持现状）；禁止在 wait 中创建/销毁任何 Agent 状态

### Task 7: 执行 Phase 1 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：4;5;6

**验证**：`pnpm test`（env，全量 344+ 例）→ 全绿；旧调用兼容用例（不传新字段）通过；无新增事件类型（rg 校验 `session/*` 事件词汇）

**Evidence**：`evidence/phase-1/`

### Phase 2: 插件元数据设施

> 你在哪里：上游能力就绪。
> 做完之后：session-tool 具备委派元数据全套（投影状态、过滤、wait 工具、约束 Config），插件测试绿。

### Task 8: 注册 delegation 投影 unit

- **关联**：BR-003 / BR-004 / UF-003 / EVD-002 / EVD-008
- **前置任务**：7
- **风险等级**：P1

**为什么做**：委派会话状态（running/completed/failed）必须从日志推导且跨重启保持——这是平级化替代 Activation 三态的关键。

**涉及文件与定位**：

- `plugin/packages/session-tool-local/src/`：新增 `delegation-projection.ts`
- `packages/session-projection/session-projection/src/index.ts`：`ProjectionDefinition` 接口（L43-L77）
- 参考先例：`packages/subagent/subagent/src/projection.ts`（subagentTiming unit，82 行）

**具体操作**：

1. 声明 `ProjectionDefinition<'delegation', DelegationState>`：`{ status: 'idle'|'running'|'completed'|'failed'|'aborted'|'max-tokens', lastTurnEnd?, promptCount, lastAssistantSeq? }`
2. `apply`：`turn/start`→running；`turn/end`→按 reason.kind 映射；`assistant/message`→记录 seq；compaction 替换时回退 idle
3. `view` + zod schema + `stateVersion: 1`
4. 在 `session-tool-local` 挂载时注册到 `ctx.sessionProjections`（无该服务时跳过，降级为无投影）

**验证**：`pnpm test`（plugin）→ 新 unit 测试：事件序列→状态推导、重启后从日志重建（EVD-008）、compaction 回退

**Evidence**：`evidence/phase-2/projection.log`

**注意事项**：`apply` 必须纯函数、同步、无副作用；状态变更时 `Object.is` 不相等才返回新引用（防无效下游工作）

### Task 9: session_list 扩展投影/血缘过滤

- **关联**：BR-003 / UF-003 / EVD-002
- **前置任务**：8
- **风险等级**：P2

**为什么做**：协调者需要"我的任务清单+状态"视图；现状 list 的 status 过滤只分 live/idle。

**涉及文件与定位**：

- `plugin/packages/session-tool/src/index.ts`：`SessionToolListFilter`（L102-L136）
- `plugin/packages/session-tool-local/src/index.ts`：`list` 实现（L185+）
- `plugin/packages/tool-session/src/index.ts`：`session_list` schema（L211+）

**具体操作**：

1. `SessionToolListFilter` 加 `status?: 'running'|'completed'|'failed'|'aborted'`（来自投影）与 `origin?: 'delegated'`（按 tags/header 判定）
2. 本地实现：读取投影值（`ctx.sessionProjections` 或降级读日志尾部），与血缘扫描（scope tree）组合过滤
3. `session_list` schema 暴露新参数

**验证**：`pnpm test`（plugin）→ 过滤组合（tags+status+scope）用例全绿

**Evidence**：`evidence/phase-2/list-filter.log`

**注意事项**：投影不可用时（未挂载）必须显式降级（status 过滤报错或忽略并注明），禁止静默返回错误数据

### Task 10: session_wait 工具与 create 来源/深度传参

- **关联**：BR-001 / BR-003 / UF-001 / UF-003 / EVD-002
- **前置任务**：8
- **风险等级**：P2

**为什么做**：模型面完成检测（session_wait）与委派元数据入口（create 传来源/深度）。

**涉及文件与定位**：

- `plugin/packages/tool-session/src/index.ts`：新增 `session_wait` 工具（schema 对齐 Task 6 的 wait 端点）
- `plugin/packages/session-tool/src/index.ts`：`SessionToolCreateOptions` 加 `delegationDepth?`/`origin?`（可选）
- `plugin/packages/session-tool-local/src/session-client.ts`：wait 客户端调用（Task 6 已补）

**具体操作**：

1. `session_wait({session_id, timeout_ms?, until?})` → 调网关 wait（web 进程）/本地投影轮询（headless 直连场景），返回状态+摘要
2. `session_create` 透传 `delegationDepth`（若 P0 决策启用约束则校验调用者深度）
3. 工具描述与输出对齐 Codex 线程模型表述（任务等待）

**验证**：`pnpm test`（plugin）→ 新工具 schema/映射用例；headless 冒烟：create→write→wait→状态正确

**Evidence**：`evidence/phase-2/wait-tool.log`

**注意事项**：`session_wait` 超时返回当前状态（非错误），与 wait 端点语义一致

### Task 11: 约束 Config(授权强度/深度上限/可见性)

- **关联**：BR-005 / UF-002 / UF-004 / EVD-002
- **前置任务**：9
- **风险等级**：P1

**为什么做**：平级化后授权从"精确父"改为 Config 约束；可见性从"强制隐藏"改为可配。

**涉及文件与定位**：

- `plugin/packages/session-tool-local/src/index.ts`：Config 定义（`rg "interface Config" plugin/packages/session-tool-local/src/index.ts`）
- `plugin/packages/tool-session/cordis.patch.yml`：bundle patch 配置行

**具体操作**：

1. Config 新增：`allowOthersToWrite?: 'workspace'|'creator'|'anyone'`（默认 workspace）、`maxDelegationDepth?: number`（默认无限制或 8）、`showDelegated?: boolean`（GUI 可见性默认 true）
2. 续写约束实现：`session_write`/`session_wait` 前置校验（creator 模式：调用者 == parentSession 血缘链上的创建者；workspace 模式：同 workspace）
3. 深度约束：`session_create` 校验调用者 `delegationDepthOf + 1 <= maxDelegationDepth`
4. 可见性：list 返回委派会话（默认），`showDelegated: false` 时按 tags/header 过滤

**验证**：`pnpm test`（plugin）→ 三种授权模式矩阵、深度超限、可见性开关用例全绿

**Evidence**：`evidence/phase-2/constraints.log`

**注意事项**：creator 模式的"血缘链"判定用 header.parentSession 递归（复用 scope tree 扫描）；禁止把约束逻辑写进核心

### Task 12: 实现收集约束求值器(session_collect)

- **关联**：BR-007 / UF-007 / EVD-009
- **前置任务**：8;10
- **风险等级**：P1

**为什么做**：平级化拆掉受控树后，收集约束（"等全部完成再返回"/"完成 N 个即返回"）是唯一未覆盖的树语义——用声明式约束求值器补上，血缘树数据仍在但"等树"从隐式机制变成显式谓词。

**涉及文件与定位**：

- `plugin/packages/session-tool-local/src/collect.ts`（新增）：约束求值器
- `plugin/packages/session-tool/src/index.ts`：`SessionToolCollectRequest/Result` 契约类型
- `plugin/packages/tool-session/src/index.ts`：`session_collect` 工具（schema + 渲染）
- 数据面（全部现成）：`traceSession`（血缘树）、delegation 投影（Task 8 的 status）、tags（`delegated`/`plan:<id>`）、`session.cancel`（cancel-rest 动作）

**具体操作**：

1. 服务层 `collect(request)`：
   - 集合解析：血缘树扫描（`root` sessionId 或 `tags` 聚合，二者其一）+ 可选 `filter: { status?, tags? }`
   - 状态源：`ctx.sessionProjections` 的 `delegation` unit（onChanged 订阅，现成）或降级轮询（`readSession` 尾部）
   - 谓词求值器（纯函数，独立可测）：`wait: 'all' | 'any' | 'n' | 'first-failed'` + `n?` + `on_failure: 'continue' | 'cancel-rest'` + `timeout_ms?`
   - 完成动作：满足 → 聚合各会话结果（投影 lastTurnEnd + 日志尾部摘要）；超时 → 返回当前快照（不报错）；`cancel-rest` → 对未满足者逐个 `session.cancel`（现成）
2. 工具面 `session_collect({root?, tags?, filter?, wait, n?, on_failure?, timeout_ms?})` → `{ satisfied, sessions: [{id, status, result}], elapsed_ms }`
3. 约束边界（写入契约注释）：**不做**依赖图（DAG）/调度/重试编排——那些留给后期 flow 生态；collect 是执行面原语

**验证**：`pnpm test`（plugin）→ 谓词求值器全矩阵（all/any/n/first-failed × continue/cancel-rest × timeout）单测；工具 schema/渲染用例；headless 冒烟：create×3 → collect(all) 聚合

**Evidence**：`evidence/phase-2/collect.log`

**注意事项**：谓词求值器必须是纯函数（输入集合快照 → 判定），订阅只做"状态变化触发重算"；`cancel-rest` 只取消未完成者、不删除会话；禁止把依赖图/调度逻辑混入本任务

### Task 13: 执行 Phase 2 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：8;9;10;11;12

**验证**：`pnpm test`（plugin 全量 67+ 例）→ 全绿；重启恢复验证（EVD-008）：创建委派会话→杀进程→重启→`session_list` 状态正确

**Evidence**：`evidence/phase-2/`

### Phase 3: 换引擎(不破坏生态)

> 你在哪里：插件元数据设施就绪。
> 做完之后：spawn/fork 的 one-shot 走 session 栈实现，workflow/ralph/外部后端零行为差异。

### Task 14: 新增上游 subagent-session provider 包(桥接定案)

- **关联**：BR-001 / BR-002 / INV-002 / INV-003 / UF-001 / UF-005 / EVD-001 / EVD-004 / ASM-008
- **前置任务**：13
- **风险等级**：P0（本包核心）

**为什么做**：把 one-shot 委派从 continuation manager 换到 session 栈，接口契约不变——"换引擎不换壳"的主体。**落点已定案为上游新包**（ASM-008）：provider 必须在核心 composition 注册（bundle/base 的 tool-subagent/workflow/ralph 装配行全部指向 provider 名），插件只装 headless profile、不注册 provider。

**涉及文件与定位**：

- `packages/subagent/subagent-session/`（新增包，与 subagent-acp/codex 并列）：`src/index.ts` + `src/run.ts`
- 实现参考：`packages/bundle/headless/src/index.ts` 的 `InProcessApiClient(toFetchHandler(ctx.apiProxy))` 模式（L150-L167）+ `completedTurnPrefix`（subagent-fork L38-L52）
- 装配：`packages/bundle/base/cordis.patch.yml` L250-L333（5 处 provider 指向）
- 被取代：`subagent-spawn`/`subagent-fork`/`subagent-inprocess`

**具体操作**：

1. 新包 `subagent-session`：`providerName: 'session'`，实现 `SubagentProvider`：
   - `start(request)` = `new InProcessApiClient(toFetchHandler(ctx.apiProxy))` → `sessions.durableCreate({ parentSessionId, delegationDepth: depth+1, title, tags: ['delegated'] })`（fork 场景先 `sessions.fork` 再 attach）→ `sessions.prompt`（coordinator 归因）→ `sessions.wait` → 读最后 `assistant/message` + `turn/end` reason → 组装 `SubagentRun`（`{ id, localAgent: undefined, result, dispose }`）
   - `prepareContinuable()` 返回空 spec（continuable 语义保留：续写走 `session.prompt`，send_message 经 tool-subagent-control 改走 session API——P4 Task 18）
   - 能力声明与 spawn 一致（`outputSchema: true` 等，Task 15 保证）；`inheritsParentContext: false`
2. `bundle/base` 装配：删 subagent-spawn/fork 行 → 加 subagent-session 行；`tool-subagent`×2 `provider: session`（backgroundMode: continuable 保留）；`workflow-workerthread` `provider: session`；`tool-ralph` `subagentProvider: session`
3. 依赖：subagent 接口 + `@deepseek-ai/dsh-host-apiproxy`（client 子路径，与插件 workspace-client 同模式）

**验证**：subagent 包既有 one-shot 测试改接新 provider 后全绿；workflow e2e（UF-005）先行冒烟（配置 `subagentProvider: session`）

**Evidence**：`evidence/phase-3/session-run.log`

**注意事项**：**`SubagentRun.localAgent` 语义变化是最大兼容风险**——检查 workflow-workerthread/ralph 是否消费 `localAgent`（rg 全仓）；若消费则需在 provider 层提供等价物或接受 `undefined` 并回归确认；禁止改变 `SubagentResult`/`SubagentStopReason` 形状；transport 一律 `InProcessApiClient`（双进程皆进程内网关，不做 HTTP 跨进程路径）

### Task 15: 结构化输出保留(outputSchema 兼容)

- **关联**：ASM-004 / INV-005 / UF-005 / EVD-004
- **前置任务**：14
- **风险等级**：P1

**为什么做**：ralph 要求 provider `supports structured output`；session 栈无 subagent 的 structured_output 强校验工具，需用约定+校验替代。

**涉及文件与定位**：

- `packages/subagent/subagent-inprocess/src/structured.ts`：`attachStructuredRuntime`（L49，强校验参考）
- `packages/workflow/tool-ralph/src/index.ts`：structured 能力检查（L221-L229）

**具体操作**：

1. session 实现：request.outputSchema 存在时，首条 prompt 注入结构化约定（"最终答案必须以 ```json 包裹且符合给定 schema，否则工具会重试"）+ 结果侧 JSON 解析校验
2. 解析失败：按 P0 决策重试一次或返回 `stopReason: 'error'` 并在输出中说明
3. 能力声明保持 `outputSchema: true`；ralph 回归

**验证**：ralph e2e（structured 场景）→ 结构化结果可解析；非法 JSON 场景按决策处理且不挂死

**Evidence**：`evidence/phase-3/structured.log`

**注意事项**：禁止悄悄把能力声明改为 false（ralph 会拒绝启动）；约定文本必须进 prompt 且子会话日志可复查

### Task 16: workflow/ralph/外部 4 后端回归

- **关联**：BR-002 / INV-005 / UF-005 / UF-006 / EVD-004 / EVD-005
- **前置任务**：14;14
- **风险等级**：P1

**为什么做**：换引擎后编排层与外部后端是最大行为差异风险面，须全量回归。

**涉及文件与定位**：

- `packages/workflow/workflow-workerthread/`：引擎（依赖 subagent + spawn）
- `packages/workflow/tool-ralph/`：ralph
- `packages/subagent/subagent-acp|codex|claude-code|dsh-sdk/`：外部 4 后端（不应被波及）

**具体操作**：

1. workflow e2e：fan-out 3 子 agent + 收集结果，对比改造前基线
2. ralph e2e：fresh + structured 场景
3. 外部 4 后端装配测试：acp（mock server）/codex（mock）/claude-code（mock）/sdk（真 runtime）逐一跑 one-shot
4. `localAgent` 消费点全仓 rg 核查结果记录

**验证**：各 e2e 全绿；无行为差异（与改造前输出 diff 一致或已记录接受差异）

**Evidence**：`evidence/phase-3/ecosystem.log`

**注意事项**：外部 4 后端若暴露 `localAgent` 依赖，单独记录为 P4 决策输入；禁止为通过测试修改外部后端代码

### Task 17: 执行 Phase 3 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：14;14;15

**验证**：subagent 包全量测试 + workflow/ralph e2e + 外部 4 后端装配 → 全绿；`SubagentRun`/`SubagentResult` 形状契约测试通过

**Evidence**：`evidence/phase-3/`

### Phase 4: continuable 平级化

> 你在哪里：one-shot 已平级化。
> 做完之后：continuable 面（send_message/list_agents/UI）也走 session 栈，continuation manager 退役（按 P0 决策选项 A；选项 B 则本 Phase 降级为 deprecated 标记）。

### Task 18: send_message/list_agents 改走 session API

- **关联**：BR-001 / BR-002 / INV-002 / INV-003 / UF-002 / EVD-001
- **前置任务**：16
- **风险等级**：P0（按 ASM-001 选项 A）

**为什么做**：模型面续写与枚举从 continuation manager 换到 session 栈，工具名/schema/返回词汇不变。

**涉及文件与定位**：

- `packages/subagent/tool-subagent-control/src/index.ts`：`send_message` / `list_agents` 工具（`rg "send_message" packages/subagent/tool-subagent-control/src/`）
- `packages/subagent/subagent/src/index.ts`：`SubagentService.followup` / `listChildren`（L444/后续）

**具体操作**：

1. `send_message`：内部改调 `session.prompt`（coordinator 归因）到目标会话；返回形状保持（成功/未投递语义映射到 prompt 的 accepted/错误码）
2. `list_agents`：改调 `session_list`（血缘 + 状态投影），把 running/complete 词汇映射到投影 status
3. `SubagentService.followup`/`listChildren` 保留签名（其他消费方如 GUI RPC 仍用），实现改为 session 栈路径
4. 授权按 Config（Task 11）执行

**验证**：tool-subagent-control 既有测试（schema/路由渲染）改造后全绿；headless 冒烟：委派→send_message 续写→list_agents 显示 running→完成

**Evidence**：`evidence/phase-4/control.log`

**注意事项**：返回词汇"started/steered/not delivered"等现状渲染若被测试 pin 住，需保持渲染文本或同步更新测试并记录差异；禁止改变工具名

### Task 19: apiproxy subagent domain 与 UI 兼容

- **关联**：BR-002 / INV-003 / UF-004 / EVD-003
- **前置任务**：17
- **风险等级**：P1

**为什么做**：GUI 的 subagent catalog 视图继续工作；委派会话在侧边栏的可见性从"强制隐藏"改为 Config 可配。

**涉及文件与定位**：

- `packages/host/apiproxy/src/api-proxy.ts`：`subagents:` 域（`subagent.list/history/prompt`，`rg "'subagent" packages/host/apiproxy/src/fetch/handler.ts` L92-L97）+ 栅栏 `hasSubagentOwner`（L945）
- `packages/client/ui-subagent/`：catalog 组件（P4 最小改动）
- `packages/bundle/base/cordis.patch.yml`：L250-L287 装配行

**具体操作**：

1. `subagent.list`：实现改为读血缘 + 标记（sessionQuery.traceSession + tags/header），响应形状不变
2. `subagent.prompt`：实现改为 `session.prompt`（coordinator），授权按插件 Config（或保留栅栏直到 P0 决策确认）
3. 栅栏 `hasSubagentOwner`：按 P0 决策移除或保留为 creator 模式实现
4. 可见性：委派会话默认出现在侧边栏（`showDelegated` 默认 true）；`origin` 仅分类
5. ui-subagent 回归：catalog 打开/历史/续写按钮行为与改造前一致（数据源语义变化不改变 UI 行为）

**验证**：GUI 冒烟（浏览器）：侧边栏可见委派会话 → 打开 → 续写成功 → Stop 可用；catalog 视图回归

**Evidence**：`evidence/phase-4/gui.log` + 截图

**注意事项**：RPC 响应字段一个都不能少（契约测试 pin 形状）；禁止在 P4 改 UI 视觉

### Task 20: continuation manager 退役

- **关联**：BR-001 / INV-004 / EVD-006
- **前置任务**：17;18
- **风险等级**：P1

**为什么做**：五机制（Activation/ownedChildren/descriptor/drain/精确父授权）全部被 session 栈替代后，删除死代码（按 ASM-001 选项 A）。

**涉及文件与定位**：

- `packages/subagent/subagent/src/continuation.ts`（1213 行）
- `packages/subagent/subagent/src/descriptor.ts` / `descriptor-seed.ts` / `activation-setup-registry.ts`
- `packages/subagent/subagent/src/index.ts`：`startContinuable`/`followup`/`reportFrom`/`drainContinuableDescendants` 导出
- `packages/subagent/subagent-inprocess/`（驱动器）
- `packages/subagent/subagent-spawn/` / `subagent-fork/`（被 subagent-session 取代，P3 已退役）

**具体操作**：

1. 先标记 deprecated（保留一版），跑全量测试确认无引用
2. 删除 continuation.ts/descriptor 相关文件与导出；`subagent-inprocess` 删除
3. `subagent/descriptor` 事件类型保留在类型层（旧日志只读兼容，INV-004）
4. 清理 bundle/base 装配行（spawn/fork 的 provider 行按 Task 14/17 的实际落点调整）

**验证**：`pnpm test`（env）→ 全绿；`rg "ContinuationManager|startContinuable" packages/` → 无残留；旧 subagent 会话日志加载测试通过（INV-004）

**Evidence**：`evidence/phase-4/retire.log`

**注意事项**：禁止删除 `subagent/descriptor` 事件类型定义（旧日志 fold 依赖）；删除前必须全仓 rg 引用确认

### Task 21: 执行 Phase 4 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：17;18;19

**验证**：env 全量测试 + GUI 冒烟复跑 + 旧日志兼容测试 → 全绿；无死代码残留（knip/jscpd 检查）

**Evidence**：`evidence/phase-4/`

### Phase 5: 真实场景验收

> 你在哪里：机制替换完成。
> 做完之后：真实场景全套通过，spec 状态 Ready→Done，evidence 归档完整。

### Task 22: 执行 spec 5.2 真实场景全套测试

- **关联**：全部用户可见 UF（UF-001~006）/ EVD-001~008
- **前置任务**：20
- **风险等级**：P0

**验证**：按 5.2 执行矩阵逐行回放（headless 委派冒烟、协调者任务管理、GUI 可见/续写/停止、workflow/ralph 回归、外部 4 后端、重启恢复），全部通过且 evidence 落盘

**Evidence**：`evidence/UF-*/`（见 5.2 矩阵）

### Task 23: 执行 Phase 5 回归验证(最终验收,含文档收尾)

- **关联**：全部 BR/UF/INV/EVD
- **前置任务**：21

**验证**：两处 `pnpm test` 全量 + `validate_package.py` 二次运行（证据审计 0 FAIL）+ spec 5.4 专项检查逐条过 + 文档收尾（spec Status → Done；handoff.md 若存在同步刷新；evidence 目录结构与 2.5 节一一对应）

**Evidence**：`evidence/phase-5/` + `evidence/phase-5/final.log`

---

## 5. 验收与 Review 协议

> **验收铁律：命令级验证（5.1）通过只是入场券，不是完成。用户可见需求必须通过 5.2 真实场景全套测试才算完成。**

### 5.1 命令级验证(入场券)

| 验证项 | 命令 | 期望 | Evidence |
|---|---|---|---|
| env typecheck | `cd env/session-tool-env && pnpm typecheck` | 通过 | EVD-006 |
| env 全量测试 | `cd env/session-tool-env && pnpm test` | 344+ 例全绿 | EVD-006 |
| 插件 typecheck | `cd plugin && pnpm typecheck` | 通过 | EVD-007 |
| 插件全量测试 | `cd plugin && pnpm test` | 67+ 例全绿 | EVD-007 |
| 包校验脚本 | `python3 /Users/dev/.agents/skills/prd-workflow/scripts/validate_package.py plugin/docs/session-delegation` | 0 FAIL | 对话输出 |
| 死代码检查 | `rg "ContinuationManager|startContinuable|subagent-inprocess" packages/`(P4 后) | 无残留 | EVD-006 |

### 5.2 真实场景全套测试(Real-Run,完成的唯一标准)

**环境准备**：

| 项 | 值 |
|---|---|
| 启动命令 | `cd env/session-tool-env && pnpm build` 后 `dsh web`(web 网关,默认 3080 或独立端口);headless: `dsh --profile headless "..."` |
| 访问入口 | GUI `http://127.0.0.1:3080`;headless CLI;`dsh-session` CLI |
| 测试账号/数据 | 真实 API key(`~/.dsh/.env`);临时 `$DSH_HOME` + 独立 web 端口(参照 design.md §14/§15 实测方式) |
| 干净状态定义 | 临时 `$DSH_HOME`(全隔离);重复实验前清空 sessions 目录 |
| 可用测试工具 | Chrome DevTools MCP(浏览器实测,GUI 场景);headless CLI;`dsh-session --format json`;curl(网关 RPC) |

**执行矩阵**(每条 = 2.3 节一条流程脚本的真实回放):

| UF | 执行方式 | 操作来源 | 必须核对的点 | Evidence |
|---|---|---|---|---|
| UF-001 主路径 | headless + curl | 2.3 UF-001 主路径 | 工具返回结果形状与改造前一致;子会话持久存在且日志含 coordinator 归因 | `evidence/UF-001/success.log` |
| UF-001 失败分支(创建失败) | headless(web 不可达) | 2.3 对应分支 | `web-unreachable` 报错、零会话残留 | `evidence/UF-001/fail-create.log` |
| UF-001 失败分支(子失败) | headless(prompt 触发 error) | 2.3 对应分支 | `stopReason: 'error'`,失败现场在日志 | `evidence/UF-001/fail-child.log` |
| UF-002 主路径 | headless + curl | 2.3 UF-002 | send_message 续写成功,消息入子会话;list_agents 词汇正确 | `evidence/UF-002/success.log` |
| UF-002 失败分支(授权) | Config=creator + 非创建者 | 2.3 对应分支 | 投递被拒,日志无新消息 | `evidence/UF-002/fail-auth.log` |
| UF-003 主路径 | headless | 2.3 UF-003 | 任务清单状态正确;wait 返回完成 | `evidence/UF-003/success.log` |
| UF-004 主路径 | 浏览器 MCP | 2.3 UF-004 | 侧边栏可见→打开→发送→实时回复;console 无错误 | `evidence/UF-004/success.png` + console.log |
| UF-004 失败分支(重启) | 浏览器 + 进程重启 | 2.3 对应分支 | 重启后会话仍在、状态投影正确 | `evidence/UF-004/restart.png` |
| UF-005 主路径 | workflow e2e | 2.3 UF-005 | fan-out 3 结果一致;structured 可解析 | `evidence/UF-005/workflow.log` |
| UF-006 主路径 | 装配测试 | 2.3 UF-006 | 外部 4 后端行为不变 | `evidence/UF-006/backends.log` |
| UF-007 主路径(wait-all) | headless | 2.3 UF-007 wait-all 主路径 | 3 会话全部终态后聚合返回 | `evidence/UF-007/all.log` |
| UF-007 主路径(wait-n) | headless | 2.3 UF-007 wait-n 主路径 | n=2 提前返回 + cancel-rest 取消剩余 | `evidence/UF-007/n.log` |
| UF-007 失败分支(超时) | headless(慢会话) | 2.3 对应分支 | `satisfied:false` 快照返回不报错 | `evidence/UF-007/timeout.log` |

**通过标准**:执行矩阵全部行通过且 evidence 齐全。任何一行失败 = 未完成,回到对应任务修复后重跑。

### 5.3 Evidence 目录结构与命名

```text
evidence/
  phase-{0..5}/      # 每 Phase 命令输出、summary
  UF-{001..006}/     # 真实场景回放:success/fail-{分支}/restart 等,文件名含场景与状态
  baseline.md        # P0 基线
  decisions.md       # P0 决策记录
```

### 5.4 Review 专项检查清单

- [ ] `SubagentRun`/`SubagentResult`/`SubagentStopReason` 形状与改造前一致(契约测试 pin)
- [ ] `subagent.list/history/prompt` RPC 响应字段零删减
- [ ] workflow/ralph 在 `subagentProvider: session` 配置下行为无差异(含 structured)；装配行 5 处指向核对(bundle/base L250-L333)
- [ ] 约束路径边界(ASM-009)：creator/anyone 档位只作用于插件工具路径；subagent 工具路径保持 workspace 级——Config 文档写明
- [ ] 旧 subagent 会话(带 `subagent/descriptor` 事件)只读加载不损坏(INV-004)
- [ ] 委派会话跨重启状态投影正确(BR-004)
- [ ] 约束矩阵(workspace/creator/anyone × 深度超限 × 可见性)全部验证
- [ ] 收集约束矩阵(wait: all/any/n/first-failed × on_failure: continue/cancel-rest × timeout)全部验证;collect 无依赖图/调度/重试逻辑(ASM-007 边界)
- [ ] 无新增 session 事件类型(INV-001)——rg 校验 `session/*` 词汇表
- [ ] continuation manager 删除后无死代码、无引用残留
- [ ] 5.2 执行矩阵全部通过,evidence 齐全且与 2.5 节 EVD 清单一致
- [ ] 2.3 节每条流程的「入口接线清单」已实现——从真实入口可达
- [ ] 所有 BR/UF/INV 状态可对照第 2 章逐条核销
