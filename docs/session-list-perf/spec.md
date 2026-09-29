# session-list-perf Spec

> Version: 0.2.0 | Date: 2026-09-29 | Status: Ready 可执行
>
> Status 取值（校验脚本核对）：Skeleton 骨架（只有方案，第 4、5 章与 tasks.csv、handoff.md 未填）/ Ready 可执行 / InProgress 执行中 / Done 已验收 / Deferred 已搁置。
>
> 本文件是本需求的**唯一事实源**：事实基线、业务合同、技术方案、任务计划、验收协议全部在此。
> 其他文件（handoff.md、tasks.csv）只引用本文件，不复制内容。
>
> 填写三态规则：每个表格单元格只允许三种内容——
> 1. 验证过的事实（注明来源命令）；2. 显式假设 `ASM-xxx`；3. `待勘察`。
> 禁止编造看似合理的命令、symbol、文件名。

---

## 0. 一页纸人话摘要

- **给谁 / 场景**：用 session-tool 列会话的插件和用户。最明显的是 DSH Bot 右栏会话列表，现在每次刷新要等 8–10 秒；session-tool 自己的「会话协作」侧栏面板走的也是同一个列表。
- **问题在哪**：session-tool 的「列会话」(`list()`) 每次都给每一行算「委派状态」（这个会话最后一轮是跑完、失败还是还在跑）。会话不在内存里时，它会把整份日志从磁盘读出来重算。旧格式（v3）的会话每读一次还要让官方宿主临时转换一遍格式，而且转换结果不留。82 个会话就是 82 次整份读取。
- **做什么**：① 宿主列表本来就带着算好的委派状态，直接用，不再重读；② 只有调用方真要委派状态时才去算（新增显式开关，按状态过滤时自动打开），而且只给真正要返回的那一页算；③ 给模型用的 `session_list` 工具和「会话协作」面板显式打开开关，显示和以前一样。命令行 CLI 的输出本来就不含委派状态，不用改。
- **改哪里**：session-tool 仓的 `session-tool-local`（列会话实现和两个传输客户端）、`session-tool`（过滤参数类型）、`tool-session`（模型工具）、`ui-session-tool`（面板的服务端入口）。
- **怎么算做完**：dsh-grok-bot 网关（3084）上 DSH Bot 会话列表接口 `listSessions` 从约 8–10 秒降到 1 秒以内；模型工具和「会话协作」面板显示的委派状态不变；CLI 输出不变；现有测试全绿。
- **不做什么**：不迁移磁盘上的旧格式会话文件（会改写历史数据，需另行确认）；不改官方宿主包；不优化 `collect` / `read` 路径；不加冷读结果缓存。

---

## 1. 事实基线与假设

### 1.1 需求与上下文

| 项 | 结论 |
|---|---|
| 原始需求 | 「那 dsh-session-tool 的根本问题是什么呢？如何修复呢」→「你写一个 handoff，我这边派其他 agent 去改一下」 |
| 需求来源 | dsh-grok-bot 仓对话：排查 Bot 界面加载慢，定位到 `/dsh-bot/listSessions` 慢在 `sessionTool.list()` |
| 置信度 | 高；性能目标值采用 ASM-001 |
| 输出目录 | `docs/session-list-perf/` |

### 1.2 任务类型与验收重点

| 维度 | 结论 |
|---|---|
| 任务类型 | performance + backend（库 API 小幅扩展） |
| 主要风险 | 模型工具 / CLI 静默丢失 `delegation_status` 字段；按委派状态过滤的结果变化 |
| 行号引用策略 | 行号只作 hint，以 symbol + rg anchor 为准 |
| 必需验收方式 | before/after 计时（真实网关 3084）+ unit test + CLI 真实输出 |
| 必须覆盖用户场景 | UF-001 Bot 会话列表加载；UF-002 模型工具 / CLI 列会话输出不变 |

### 1.3 勘察事实清单

| 事实 | 来源命令 | 输出摘要 |
|---|---|---|
| 3084 网关上 `listSessions` 耗时 7.7–7.9s，同网关 `listBots` 3ms | `curl -w '%{time_total}' -X POST http://127.0.0.1:3084/dsh-bot/listSessions -d '{"args":{"includeHidden":true}}'` | `200 7.71s` / `200 7.90s`；浏览器内实测 7.3–10.2s |
| 同一批 82 个会话，宿主 `session/list` 只要 167ms | 浏览器 fetch `/api/session/list`（带登录 cookie） | `session/list ms 167`，82 行 |
| 差值来自 `list()` 对每行 `await this.delegationStatusOf(...)`；非 live 会话走 `inspectSession` 整份冷读 + `foldDelegationStatus` | 读 `packages/session-tool-local/src/index.ts` L465-477、L999-1011 | `const inspected = await this.inspectSession(sessionId)` |
| dsh-grok-bot 的 3084 网关加载的就是本仓 `session-tool-local`（link） | `readlink -f ../../dsh-grok-bot/plugin/env/profiles/gb/node_modules/session-tool-local` | 指向本仓 `packages/session-tool-local` |
| 3084 的会话语料：79 个 `session.v3.jsonl.zstd`，4 个 v4，1 个无版本 | `find env/sessions -type f` 统计（dsh-grok-bot 仓） | `79 session.v3` / `4 session.v4` |
| 官方 JSONL 存储对 v3 只读打开走 `prepareStoredMigration`（先 `listArtifacts()` 读全部文件头，再解码迁移），不写回；冷日志缓存上限 2 | 读 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` L2600-2740、L2284 | `COLD_LOG_MEMO_MAX_ENTRIES = 2` |
| 宿主 list 行 `projections.values` 已含 `delegation`（v4 会话 4/4 有；v3 会话 78 行只有 `title`） | 浏览器 fetch `/api/session/list` 后按 `projections.values.delegation` 分组 | `sequenced present 2, cached present 2, cached absent 78` |
| delegation 值形状 `{status, promptCount, lastTurnEnd?, lastAssistantSeq?}` | 同上，打印 `items[0].projections.values.delegation` | `{"status":"failed","lastTurnEnd":"error","promptCount":8,...}` |
| 两个客户端都只取 `title`，丢掉其他投影 | 读 `session-client.ts` L186-205、`session-client-in-process.ts` L235-250 | 只调 `listRowTitle(...)` |
| `read()` 已有同类开关 `includeDelegationStatus` | `rg "includeDelegationStatus" packages/session-tool-local/src/index.ts` | L387 |
| `delegationStatus` 在仓内有两个消费方：`tool-session` 的 `delegation_status` 输出，以及 `ui-session-tool` 会话协作面板（每行状态标签、「停止当前轮次」按钮在详情加载前的可用性）；dsh-grok-bot、vibee 调 `list()` 只用 tags/title | `rg "delegationStatus" packages ../../vibee ../../dsh-grok-bot/plugin/packages` | `ui-session-tool/src/client/panel.tsx` L68、L117 读 `row.delegationStatus`；vibee、dsh-bot 均不读 |
| CLI `session list` 直接调 `ctx.sessionTool.list(CLI_CALLER, ...)`；JSON 输出 `listToolShape` 与文本输出 `renderListText` 都**不含** `delegation_status` | 读 `packages/session-tool-cli/src/index.ts` L297-311、L337-342、L598-627 | `listToolShape` 只映射 session_id / title / tags / status / created_at |
| 测试基线：session-tool-local 210 passed，tool-session 17 passed | `pnpm --filter session-tool-local run test`；`pnpm --filter tool-session run test` | `Tests 210 passed` / `Tests 17 passed` |
| 现有测试 `reads through sessionProjections.stateOf...` 不带 status 过滤就断言 `row.delegationStatus === 'completed'`，默认关掉后会失败，需同步改 | 读 `packages/session-tool-local/tests/service.spec.ts` L1277-1315 | L1306-1308 |
| 面板服务端 `ui-session-tool` 的 list 端点调 `service.list(caller, filter)`，filter 固定 `scope:'all', limit: 50`，不带委派开关；`host.spec.ts` 对该调用做精确 `toHaveBeenCalledWith` | 读 `packages/ui-session-tool/src/index.ts` L33-47、`packages/ui-session-tool/tests/host.spec.ts` L65 | `{ scope: 'all', limit: 50, origin: 'delegated' }` |
| 3081 与 3084 两个 profile 都加载 `ui-session-tool` 与 `tool-session`（link 到本仓） | 读 `env/profiles/st/package.json` L33-36；`ls ../../dsh-grok-bot/plugin/env/profiles/gb/node_modules` | 两边都有 `ui-session-tool`、`tool-session` |
| `list()` 的隐藏 / showDelegated / origin / tags / title 过滤和排序（`createdAt` + id）都不读 `delegationStatus`，只有 `status` 为委派词汇时的过滤读它 | 读 `packages/session-tool-local/src/index.ts` L479-523 | 过滤全是合取条件，调换顺序不改结果 |
| `listMaxRows` 默认 100 | `rg "listMaxRows" packages/session-tool-local/src/index.ts` | `z.number().step(1).min(1).default(100)` |
| 2026-09-29 复测：3084 `listSessions` 200 / 10.14s，返回 71 行，行字段 `createdAt/hidden/sessionId/status/tags/title` | Task 1 同款 curl；`jq '.value.sessions \| length'` | 71 行（Bot 标记过滤后，少于宿主 82 行） |
| 3081 语料：7 个 v3、1 个 v4 | `find env/sessions -type f -name 'session.v*'` 统计 | `7 session.v3` / `1 session.v4` |
| `session-tool-cli` 的测试不覆盖 `session list` | `rg "session list" packages/session-tool-cli/tests` | 无匹配 |
| ui-session-tool 测试基线 19 passed；另有需要真实网关的浏览器验收脚本 | `pnpm vitest run packages/ui-session-tool/tests`；读 `packages/ui-session-tool/tests/browser.e2e.mts` | `Tests 19 passed`；脚本要 `DSH_E2E_URL`（带 token 的 launch URL）和本机 Chrome，只打印 PASS 行 |
| CLI 连 3081 可用命令：`DSH_HOME=$PWD/env DSH_LAUNCH_TOKEN=<token> node packages/session-tool-cli/lib/bin.js session list --scope all --include-hidden --profile headless --patch env/cli.patch.yml --format json`；token 取自 `env/logs/boot-manual.log` 里 `dsh web:` URL 的 `token=`；不带 `--profile headless --patch` 会报 `web-unreachable` | 2026-09-29 实跑 | 8 行，字段 `created_at/session_id/status/tags/title` |
| 3081 面板接口可用 curl 调：`curl -c /tmp/session-list-perf/st.jar "<dsh web: URL>"` → 303 拿 cookie；再 `curl -b /tmp/session-list-perf/st.jar -X POST http://127.0.0.1:3081/api/session-tool/list -H 'content-type: application/json' -d '{"type":"client-request","rpcId":"perf","method":"session-tool/list","payload":{"includeHidden":true}}'` | 2026-09-29 实跑 | `200 0.23s`，8 行：6 行 `idle`、2 行 `failed` |

### 1.4 假设清单

| 假设 ID | 内容 | 风险 | 确认方式 |
|---|---|---|---|
| ASM-001 | 修复后 3084 上 `listSessions` < 1000ms（宿主 list 167ms + marks 读取） | `headerIndex()`（`persistence.list()` + 读 lineage）、`listWorkspaces()`、逐行 `tagsOf` 的耗时都没拆开测过，可能达不到目标 | Task 4 出口先在 3084 计时一次；不达标时临时分段计时（不提交）定位，结果写 `evidence/phase-1/profile.log`；仍不达标按 Task 6 处理，另开任务，不在本包内扩大范围 |

### 1.5 变更记录

| 日期 | 变更条目 | 原因 | 影响任务 |
|---|---|---|---|
| 2026-09-29 | 1.3 事实修正（消费方、CLI 输出）并补 CLI / 面板接口实跑命令；BR-004 改写；新增 BR-006、UF-003、INV-005、EVD-004；UF-002 / INV-001 / EVD-001 改写；ASM-002 实跑证实，转为 1.3 事实并删除；2.8 补两条非目标 | 原 1.3 漏掉 `ui-session-tool` 面板这个消费方，照原方案面板每行会变成「执行状态未知」；CLI 输出本就不含 `delegation_status`，原方案让 CLI 白算一遍；取值范围未限定到当页；响应原文含真实会话标题，不应进 evidence | Task 1（面板基线、证据脱敏）、Task 3（BR-006）、Task 4（改名，入口换成 tool-session + ui-session-tool，提前计时）、Task 5（5.2 矩阵）；均未开工，无需回退 |

---

## 2. 业务合同

### 2.1 BR 业务规则

| 规则 ID | 规则 | 正例 | 反例 | 影响范围 | 验证方式 |
|---|---|---|---|---|---|
| BR-001 | 默认 `list()`（未请求委派状态、`status` 不是委派词汇）不为任何行读冷日志，行不带 `delegationStatus` | dsh-bot `list({scope:'all', includeHidden:true})` → 0 次 `inspectSession` | 仍对 78 个 v3 会话各冷读一次 | `SessionToolLocalService.list` | 单测 spy + 3084 计时 |
| BR-002 | 需要委派状态时取值顺序：live 会话的投影缓存 → 宿主 list 行 `projections.values.delegation.status` → 冷读折叠；前一级有值就不走下一级 | v4 冷会话从宿主行拿到 `failed`，不冷读 | 宿主行已有值仍冷读 | `delegationStatusOf` / list 行组装 | 单测 |
| BR-003 | `filter.status` 为委派词汇（`running`/`completed`/`failed`/`aborted`/`forked`）时自动视同请求委派状态 | `status:'completed'` 只返回已完成行，结果与改前一致 | 默认关闭后过滤结果为空 | list 过滤 | 现有测试 `derives and filters by the delegation projection status` |
| BR-004 | 委派状态的消费方显式请求：`session_list` 模型工具、会话协作面板（`ui-session-tool` list 端点）传 `includeDelegationStatus: true`；CLI `session list` 输出不含该字段，不传 | 工具输出仍有 `delegation_status`；面板行仍显示「已完成 / 失败」等标签 | 面板行全变「执行状态未知」；CLI 为不输出的字段冷读 | tool-session、ui-session-tool | 单测 + 3081 面板接口真实输出 |
| BR-005 | 宿主行投影值只接受合法 `DelegationStatus` 枚举，非法 / 缺失按「无值」处理进入下一级 | `{status:'weird'}` → 走冷读 | 把非法字符串透传给调用方 | 两个传输客户端 | 单测 |
| BR-006 | 请求委派状态时只给需要的行取值：`status` 是委派词汇 → 在其余过滤之后，对剩下的候选行取值；否则 → 排序分页后只给当页行取值 | 3 个冷会话、`limit: 1` → 只冷读 1 次 | 先给全部网关行取值再过滤分页 | `SessionToolLocalService.list` | 单测 spy 冷读次数 |

### 2.2 UF 用户验收场景（索引）

| 场景 ID | Given | When | Then | 角色 | 验证方式 | Evidence |
|---|---|---|---|---|---|---|
| UF-001 | dsh-grok-bot 网关 3084 已用新构建重启 | 请求 DSH Bot 会话列表接口 `listSessions` | 1 秒内返回（ASM-001），行数与改前一致 | Bot 用户 | curl 计时 | EVD-001 |
| UF-002 | session-tool 网关 3081 运行 | 模型调用 `session_list` / CLI `session list --format json` | 工具输出仍含 `delegation_status`，按委派状态过滤结果不变；CLI 输出与改前逐行一致 | Agent / CLI 用户 | 单测 + CLI 真实输出 | EVD-002 |
| UF-003 | session-tool 网关 3081 运行，浏览器已用 launch URL 登录 | 打开侧栏「会话协作」面板 | 每行委派状态标签与改前一致；「停止当前轮次」按钮可用性不变 | Web 用户 | 面板接口真实输出 + 浏览器验收脚本 | EVD-004 |

### 2.3 核心业务流程（步骤级交互脚本）

#### UF-001: Bot 会话列表加载

**前置状态**：dsh-grok-bot 网关 3084 运行新构建；语料为现有会话（宿主 82 个，Bot 标记过滤后 71 行）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 打开右栏 DSH Bot 页签 | 列表 loading | `ui-dsh-bot` 发 `POST /dsh-bot/listSessions` | — |
| 2 | — | — | dsh-bot-host 调 `sessionTool.list(CLI, {scope:'all', includeHidden:true})`；list 只调宿主 list + 读 marks，不冷读 | — |
| 3 | — | — | 返回会话行（无 `delegationStatus`，dsh-bot 不用） | 1 秒内出现会话列表，条目与改前一致 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 宿主投影缺失 | v3 会话宿主行只有 `title` | 列表正常显示 | 默认不请求委派状态，不冷读 | 无需恢复 |
| session-tool 连不上网关 | `sessionTool.list` 抛 `web-unreachable` | 列表正常显示 | dsh-bot 走既有 `listViaPlatform` 回退（本次不改） | 无需恢复 |

**界面状态机**：

```text
loading → ready（<1s）
   |
   v
 error（网关错误，沿用现有重试按钮）
```

**入口接线清单**：

- 右栏 DSH Bot 页签 → `ui-dsh-bot/src/client/rpc.ts` `dshBotCall('listSessions')` → `dsh-bot-host` `listBotSessions` → 本仓 `SessionToolLocalService.list`（入口不改，只改 list 内部）

#### UF-002: 模型工具 / CLI 列会话

**前置状态**：session-tool 网关 3081 运行；有已完成 / 失败的子会话。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 模型调用 `session_list` 工具 | — | tool-session 传 `includeDelegationStatus: true` | — |
| 2 | — | — | 按 BR-002 顺序、BR-006 范围取委派状态 | 工具文本输出 `id [idle]/completed ...` 格式不变 |
| 3 | 跑 CLI `session list --scope all --include-hidden --format json` | — | CLI 不传开关，按 BR-001 不算委派状态 | JSON 行字段与改前一致（本就不含 `delegation_status`） |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 按委派状态过滤 | 工具参数 `status:'completed'` | 只列已完成行 | BR-003 自动请求委派状态 | 无需恢复 |
| 冷会话无宿主值 | v3 会话、非 live | 行仍含 `delegation_status` | 回落冷读（与改前同速） | 无需恢复；提速需另做 v3 迁移（非目标） |

**界面状态机**（CLI）：

```text
invoke → rows printed（含 delegation_status）
   |
   v
 error（沿用现有 CLI 错误码输出）
```

**入口接线清单**：

- 模型工具：`packages/tool-session/src/index.ts` `session_list` `execute` → `ctx.sessionTool.list`（需加 `includeDelegationStatus: true`）
- CLI：`packages/session-tool-cli/src/index.ts` `session list` action → `ctx.sessionTool.list`（不改；委派词汇 `--status` 走 BR-003）

#### UF-003: 会话协作面板列会话

**前置状态**：3081 运行新构建；浏览器已通过 launch URL 登录；语料里有带委派状态的会话。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 点侧栏「会话协作」 | 列表显示「正在加载…」 | 面板发 `session-tool/list` RPC | — |
| 2 | — | — | `ui-session-tool` host 调 `service.list(web, {scope:'all', limit:50, includeDelegationStatus:true, ...})`；按 BR-002 顺序、BR-006 范围取值 | — |
| 3 | — | — | 返回行带 `delegationStatus` | 每行显示「已完成 / 失败 / 运行中…」标签，与改前一致 |
| 4 | 选中一个运行中的会话 | 详情加载前「停止当前轮次」按钮可用性取自行值 | — | 与改前一致 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 按运行状态筛选 | 「运行状态」下拉选「已完成」 | 只列已完成行 | BR-003 自动请求；BR-006 在其余过滤之后取值 | 无需恢复 |
| 冷会话无宿主值 | v3 会话、非 live | 行仍显示状态标签 | 回落冷读（单行与改前同速，但只读当页行） | 无需恢复 |
| 接口出错 | list 抛错 | 列表上方 `role=alert` 错误文字 | 沿用现有错误处理（本次不改） | 点「刷新」 |

**界面状态机**：

```text
loading → ready（行带状态标签）
   |
   v
 error（alert 文案，「刷新」重试）
```

**入口接线清单**：

- 侧栏「会话协作」→ `packages/ui-session-tool/src/client/panel.tsx` `call('list', query)` → `packages/ui-session-tool/src/index.ts` `if (method === 'list')` → `service.list(caller, filter)`（filter 需加 `includeDelegationStatus: true`；请求字段白名单不变）

### 2.4 INV 不变量

| 不变量 ID | 内容 | 关联 BR/UF | 验证方式 |
|---|---|---|---|
| INV-001 | `session_list` 工具输出形状不变（有值时含 `delegation_status`）；CLI JSON / 文本输出形状不变（本就不含该字段） | BR-004 / UF-002 | CLI 真实输出对比 + tool-session 测试 |
| INV-002 | 委派状态过滤结果不变 | BR-003 | 现有测试 `derives and filters by the delegation projection status` |
| INV-003 | 行的 `sessionId`/`title`/`tags`/`status`/`createdAt`/`archived`、排序、分页不变 | BR-001 / UF-001 | 3084 改前改后行集合对比 + 现有 list 测试 |
| INV-004 | `read()`、`collect` 行为不变（它们的 `delegationStatusOf` 调用不改） | — | session-tool-local 全部测试通过 |
| INV-005 | 会话协作面板每行 `delegationStatus` 与改前一致；面板 RPC 请求字段白名单不变，开关由服务端固定打开 | BR-004 / UF-003 | 3081 面板接口 before/after 对比 + `host.spec.ts` |

### 2.5 EVD 证据清单

| 证据 ID | 类型 | 期望证据 | 保存位置 |
|---|---|---|---|
| EVD-001 | log | 改前 / 改后 `listSessions` 计时各 3 次 + 行 id 集合 diff（响应原文含会话标题，只放 `/tmp`） | `evidence/UF-001/` |
| EVD-002 | log/json | CLI 改前 / 改后 JSON 输出；工具与委派过滤测试输出 | `evidence/UF-002/` |
| EVD-003 | log | 测试与 typecheck 输出 | `evidence/phase-{N}/`、`evidence/final/` |
| EVD-004 | log/json | 3081 面板接口改前 / 改后 `sessionId → delegationStatus` 映射与 diff；浏览器验收脚本输出 | `evidence/UF-003/` |

### 2.6 角色与权限矩阵

单一调用方语义，无权限差异：`list()` 的 scope / 访问围栏逻辑不改。

### 2.7 负向 / 破坏性场景

| 场景 | Given | When | Then | Evidence |
|---|---|---|---|---|
| 宿主投影值非法 | 宿主行 `delegation.status` 不在枚举内 | 请求委派状态 | 视为无值，回落下一级（BR-005） | EVD-003 |
| 旧数据兼容 | v3 会话宿主行无 delegation | 默认 list | 不冷读，不报错 | EVD-001 |

权限不足、重复提交、空数据不适用：list 是只读查询，权限围栏不改；空语料行为不变（INV-003）。

### 2.8 非目标

- 不把磁盘上的 v3 会话迁移为 v4（要改写历史会话文件，需用户另行确认）。
- 不改官方 `@deepseek-ai/dsh-session-persistence-jsonl`（只读打开不写回、缓存上限 2 属上游问题，可另行报告）。
- 不改 `collect` / `read` 的委派状态路径。
- 不优化 `tagsOf` 每行读一次 marks 文件（除非 ASM-001 实测不达标，另开任务）。
- 不加冷读结果缓存。按 `(sessionId, updatedAt)` 缓存折叠结果能让 v3 语料上带委派状态的调用只慢第一次，但要新增 BR 和失效语义，另开包。
- 不改 CLI `session list` 的输出（本就不含 `delegation_status`）。

---

## 3. 技术方案

### 3.1 架构 Before / After

```text
Before:
list() → sessionClient.list()  (宿主 167ms，丢掉 projections 只留 title)
       → for each row: delegationStatusOf(id)
             live?  → projections.stateOf
             else   → inspectSession(id)  整份冷读 + fold   ← v3 每次还要迁移，82 行 ≈ 7–10s

After:
list() → sessionClient.list()  (行多带 delegationStatus?：取自 projections.values.delegation.status)
       → 组装行（不含委派状态）→ 隐藏 / showDelegated / origin / tags / title 过滤
       → want = filter.includeDelegationStatus === true || status 是委派词汇
       → want 为 false：直接排序分页，行不带 delegationStatus
       → status 是委派词汇：对剩余候选取值后过滤，再排序分页
       → 其余 want 为 true：排序分页后只给当页行取值
       取值顺序：live 投影 → 宿主行值 → inspectSession 冷读（最后兜底）
tool-session / ui-session-tool → list(..., { includeDelegationStatus: true })；CLI 不传
```

### 3.2 模块改造

| 模块 | 职责 | 改造说明 |
|---|---|---|
| `session-tool`（类型包） | `SessionToolListFilter` 契约 | 新增 `includeDelegationStatus?: boolean`，注释写明默认 false、委派词汇 status 自动开启 |
| `session-tool-local` 客户端 | 宿主 list 行映射 | `SessionListRow` 新增 `delegationStatus?: DelegationStatus`；HTTP 与 in-process 两个 `list()` 都从 `projections.values.delegation.status` 解析，非法值丢弃 |
| `session-tool-local` 服务 | `list()` 组装行 | 按需计算；取值顺序 BR-002，取值范围 BR-006；`delegationStatusOf` 加可选「宿主行值」参数或在 list 内先判 |
| `tool-session` | `session_list` 工具 | 调 list 时传 `includeDelegationStatus: true` |
| `ui-session-tool` | 会话协作面板服务端 list 端点 | filter 加 `includeDelegationStatus: true`；请求字段白名单不变 |
| `session-tool-cli` | `session list` 命令 | 不改：输出不含委派状态；委派词汇 `--status` 由 BR-003 自动处理 |

### 3.3 三段式定位清单

| 文件 | 稳定定位 | 搜索定位 | 行号 hint | 备注 |
|---|---|---|---|---|
| `packages/session-tool-local/src/index.ts` | `async list(caller: SessionToolCaller, filter: SessionToolListFilter)` | `rg "const delegationStatus = await this.delegationStatusOf" packages/session-tool-local/src/index.ts` | L419-529（逐行组装 L465-477） | 主改点 |
| `packages/session-tool-local/src/index.ts` | `private async delegationStatusOf` | `rg "private async delegationStatusOf" packages/session-tool-local/src/index.ts` | L999-1011 | collect 也调用，签名改动须兼容 |
| `packages/session-tool-local/src/session-client.ts` | `export interface SessionListRow` / `SessionHttpClient.list` | `rg "export interface SessionListRow" packages/session-tool-local/src/session-client.ts` | L29-42、L186-205 | HTTP 客户端 |
| `packages/session-tool-local/src/session-client-in-process.ts` | `function listRowTitle` / `InProcessSessionClient.list` | `rg "function listRowTitle" packages/session-tool-local/src/session-client-in-process.ts` | L23-28、L235-250 | 3084 实际走这条（in-process） |
| `packages/session-tool-local/src/delegation-projection.ts` | `export type DelegationStatus` | `rg "export type DelegationStatus" packages/session-tool-local/src/delegation-projection.ts` | L23-30 | 枚举来源，校验用 |
| `packages/session-tool/src/index.ts` | `export interface SessionToolListFilter` | `rg "export interface SessionToolListFilter" packages/session-tool/src/index.ts` | L213-240 | 加字段 |
| `packages/tool-session/src/index.ts` | `session_list` 的 `execute` | `rg "delegation_status: row.delegationStatus" packages/tool-session/src/index.ts` | L421-444 | 传开关 |
| `packages/session-tool-cli/src/index.ts` | `session list` action | `rg "const result = await ctx.sessionTool.list" packages/session-tool-cli/src/index.ts` | L610-623 | 不改，只核对 |
| `packages/session-tool-local/tests/service.spec.ts` | `derives and filters by the delegation projection status` / `reads through sessionProjections.stateOf` | `rg "reads through sessionProjections.stateOf" packages/session-tool-local/tests/service.spec.ts` | L1132-1171、L1277-1315 | 后者需传开关 |
| `packages/ui-session-tool/src/index.ts` | `createHandler` 里 `if (method === 'list')` 分支 | `rg "service.list" packages/ui-session-tool/src/index.ts` | L33-47 | 传开关 |
| `packages/ui-session-tool/tests/host.spec.ts` | `uses the authenticated carrier and coexists with the official RPC interceptor` | `rg "scope: 'all', limit: 50" packages/ui-session-tool/tests/host.spec.ts` | L65 | 精确断言需加开关 |
| `packages/ui-session-tool/src/client/panel.tsx` | 列表行 `statusLabels[row.delegationStatus]` | `rg "row.delegationStatus" packages/ui-session-tool/src/client/panel.tsx` | L68、L117 | 只读核对，不改 |

### 3.4 API / 数据 / 权限 / 路由影响

API：`SessionToolListFilter` 新增可选字段；`SessionToolListRow.delegationStatus` 在默认调用下不再出现（类型本就可选，文档注明「请求时才有」）；仓内两个消费方（tool-session、ui-session-tool）改为显式请求（1.3 节 grep）；面板 RPC 契约 `SidebarApi.list.input` 不变，开关由服务端固定打开。数据、权限、路由均无影响：只读路径，不写盘，不改围栏。

---

## 4. Phase 计划与任务详情

```text
P0 基线 ──> P1 契约与实现 ──> P2 验收与收尾
```

### Phase 0: 基线

> 你在哪里：`listSessions` 7.7–10.1s；测试 210 / 17 / 19 通过。
> 做完之后：改前计时、行 id 集合、CLI 输出、面板委派状态映射都落盘，可做 before/after 对比。

### Task 1: 记录列表耗时与输出基线

- **关联**：UF-001 / UF-002 / UF-003 / INV-001 / INV-003 / INV-005 / EVD-001 / EVD-002 / EVD-004
- **风险等级**：P2

**为什么做**：性能改动必须有可比对的前值；行集合用于 INV-003 对比，面板映射用于 INV-005 对比。

**涉及文件与定位**：

- 无代码改动。

**具体操作**：

1. `sh ~/.agents/skills/dsh-plugin-debug/scripts/dsh-rpc-who.sh 3084` 确认 `DSH_HOME` 是 dsh-grok-bot 的 `env/`；`... 3081` 确认是本仓 `env/`。
2. `mkdir -p /tmp/session-list-perf`；先 `date +%s000 >> evidence/UF-001/before-timing.log` 记下基线时刻，再跑 3 次 `curl -s -o /tmp/session-list-perf/before-body.json -w '%{http_code} %{time_total}\n' -X POST http://127.0.0.1:3084/dsh-bot/listSessions -H 'content-type: application/json' -d '{"args":{"includeHidden":true}}' >> evidence/UF-001/before-timing.log`。响应原文含真实会话标题，只放 `/tmp`。
3. `jq -r '.value.sessions[].sessionId' /tmp/session-list-perf/before-body.json | sort > evidence/UF-001/before-ids.txt`。
4. 按 1.3 节 CLI 实跑命令（`DSH_LAUNCH_TOKEN` 从环境变量传，值不入盘）跑一次，stdout 存 `evidence/UF-002/before-cli.json`。
5. 按 1.3 节面板接口 curl 命令换 cookie 并请求一次，响应存 `/tmp/session-list-perf/before-panel.json`；`jq -r '.result.value.sessions[] | [.sessionId, (.delegationStatus // "-")] | @tsv' /tmp/session-list-perf/before-panel.json | sort > evidence/UF-003/before-panel.tsv`。
6. 跑 `pnpm --filter session-tool-local run test`、`pnpm --filter tool-session run test`、`pnpm vitest run packages/ui-session-tool/tests`。

**验证**：`evidence/UF-001/before-timing.log` 有 1 行时间戳 + 3 行 200；`before-cli.json` 可被 `jq` 解析；`before-panel.tsv` 行数与面板接口返回行数一致；Phase 出口检查：`pnpm --filter session-tool-local run test && pnpm --filter tool-session run test && pnpm vitest run packages/ui-session-tool/tests` → 210 / 17 / 19 passed，输出存 `evidence/phase-0/exit.log`

**Evidence**：`evidence/UF-001/before-timing.log`、`evidence/UF-001/before-ids.txt`、`evidence/UF-002/before-cli.json`、`evidence/UF-003/before-panel.tsv`、`evidence/phase-0/exit.log`

**注意事项**：易错点 基线必须在改代码并 build 之前采；禁止把 `DSH_LAUNCH_TOKEN`、带 token 的 launch URL、cookie jar、3084 响应原文写进 evidence

### Phase 1: 契约与实现

> 你在哪里：基线已落盘。
> 做完之后：默认 list 不冷读；工具与 CLI 输出不变；测试覆盖新行为。

### Task 2: 列表行携带宿主委派投影

- **关联**：BR-002 / BR-005 / EVD-003
- **风险等级**：P1

**为什么做**：宿主 list 行已含 delegation 投影，客户端丢掉了它。

**涉及文件与定位**：

- `packages/session-tool-local/src/session-client.ts`：`export interface SessionListRow`，`rg "export interface SessionListRow" packages/session-tool-local/src/session-client.ts`，L29-42、L186-205（hint）
- `packages/session-tool-local/src/session-client-in-process.ts`：`function listRowTitle`，`rg "function listRowTitle" packages/session-tool-local/src/session-client-in-process.ts`，L23-28、L235-250（hint）
- `packages/session-tool-local/src/delegation-projection.ts`：`export type DelegationStatus`

**具体操作**：

1. `SessionListRow` 加 `readonly delegationStatus?: DelegationStatus`，注释「宿主 list 行 delegation 投影；缺失或非法时不填」。
2. 写一个解析函数（从 `projections.values.delegation.status` 取值并校验枚举），两个客户端共用；两个文件现有的 `listRowTitle` 是重复实现，可顺手合到同一处共用模块，不新增第三份。
3. HTTP 与 in-process 两个 `list()` 映射时填入该字段。

**验证**：`pnpm run typecheck` → 通过；`pnpm --filter session-tool-local run test` → 通过数 ≥ 基线

**Evidence**：`evidence/phase-1/task-2.log`

**注意事项**：易错点 `projections` 在 HTTP 路径是 `unknown`，必须逐层判空；禁止把非法字符串透传

### Task 3: 列表按需计算委派状态

- **关联**：BR-001 / BR-002 / BR-003 / BR-006 / INV-002 / INV-003 / INV-004
- **风险等级**：P0

**为什么做**：根因就是 list 对每行无条件冷读。

**涉及文件与定位**：

- `packages/session-tool/src/index.ts`：`export interface SessionToolListFilter`，`rg "export interface SessionToolListFilter" packages/session-tool/src/index.ts`，L213-240（hint）
- `packages/session-tool-local/src/index.ts`：`async list(...)`、`private async delegationStatusOf`，`rg "const delegationStatus = await this.delegationStatusOf" packages/session-tool-local/src/index.ts`，L465-477、L999-1011（hint）
- `packages/session-tool-local/tests/service.spec.ts`：`reads through sessionProjections.stateOf`，L1277-1315（hint）

**具体操作**：

1. `SessionToolListFilter` 加 `readonly includeDelegationStatus?: boolean`，JSDoc：默认 false；`status` 为委派词汇时自动视为 true；同步修正 `SessionToolListRow.delegationStatus` 注释为「仅在请求时出现」。
2. `list()` 重排为：先组装不含委派状态的行 → 隐藏 / showDelegated / origin / tags / title 过滤 → 算 `want`。`status` 是委派词汇时，对剩余候选行取值后按状态过滤；其余 `want` 为 true 时，排序分页后只给当页行取值（BR-006）；`want` 为 false 时不取值（BR-001）。取值按 BR-002 顺序（live 投影 → `row.delegationStatus` → 冷读），实现方式：给 `delegationStatusOf` 加可选 `hostValue` 参数，或在 list 内先判；collect 路径调用保持不变（INV-004）。已取过值的行不重复取。
3. 更新 `reads through sessionProjections.stateOf...` 测试：list 调用传 `includeDelegationStatus: true`。
4. 新增测试（同文件，沿用 `listRow` / `sessionClient()` 辅助）：
   - 默认 list 对冷会话不调用持久化读（spy `ctx.sessionPersistence` 的 `open`/`inspect` 或服务的冷读入口），行无 `delegationStatus`。
   - `includeDelegationStatus: true` 且宿主行带 `delegationStatus: 'failed'` → 行为 `failed`，且不冷读。
   - `includeDelegationStatus: true` 且宿主行无值 → 回落冷读，结果与折叠一致。
   - 宿主行值非法（BR-005）→ 回落冷读（如在 Task 2 的解析层测更合适就放那里）。
   - `includeDelegationStatus: true`、3 个无宿主值的冷会话、`limit: 1` → 冷读恰好 1 次，且是当页那一行（BR-006）。
   - `status: 'completed'` + `title` 过滤 → 只对标题命中的行冷读（BR-006）。

**验证**：`pnpm --filter session-tool-local run test` → 全部通过，含新增用例；现有 `derives and filters by the delegation projection status` 不改仍通过

**Evidence**：`evidence/phase-1/task-3.log`

**注意事项**：易错点 `tagsOf` 仍然每行读，别顺手改动行形状；过滤是合取条件，重排顺序不能改变结果（INV-002 / INV-003）；禁止为过测试删掉现有断言

### Task 4: 工具与面板显式请求委派状态

- **关联**：BR-004 / INV-001 / INV-005 / UF-002 / UF-003
- **风险等级**：P1

**为什么做**：`tool-session` 和 `ui-session-tool` 是 `delegationStatus` 仅有的两个消费方，默认关掉后必须显式打开才能保持输出不变；CLI 输出不含该字段，不改。

**涉及文件与定位**：

- `packages/tool-session/src/index.ts`：`session_list` `execute`，`rg "delegation_status: row.delegationStatus" packages/tool-session/src/index.ts`，L421-444（hint）
- `packages/tool-session/tests/tools.spec.ts`：`session_list forwards the delegation status filter and projects delegation_status`，L281-311（hint）
- `packages/ui-session-tool/src/index.ts`：`if (method === 'list')` 分支，`rg "service.list" packages/ui-session-tool/src/index.ts`，L33-47（hint）
- `packages/ui-session-tool/tests/host.spec.ts`：`rg "scope: 'all', limit: 50" packages/ui-session-tool/tests/host.spec.ts`，L65（hint）

**具体操作**：

1. `tool-session` 的 `ctx.sessionTool.list(...)` 参数对象加 `includeDelegationStatus: true`；`tools.spec.ts` 那条用例的 `expect.objectContaining` 加上 `includeDelegationStatus: true`，丢开关时它会失败。
2. `ui-session-tool` list 分支的 `filter` 加 `includeDelegationStatus: true`；请求字段白名单 `record(payload, [...])` 与 `SidebarApi.list.input` 不变（开关由服务端固定打开，不让浏览器传）；`host.spec.ts` L65 的精确断言加上该字段。
3. CLI `session list` 不改。
4. `pnpm run build`，让 3081 / 3084 能加载新产物。
5. 提前验证 ASM-001：用 `dsh-rpc-who.sh 3084` 确认身份 → 对该 pid 发 SIGTERM → 在 `../../dsh-grok-bot/plugin` 下 `sh env/boot.sh` → 按 Task 1 第 2 步命令计时 1 次，写 `evidence/phase-1/early-timing.log`。≥ 1000ms 时临时加分段计时（`headerIndex` / `listWorkspaces` / 宿主 list / `tagsOf` / 取值，不提交）再测一次，结果写 `evidence/phase-1/profile.log`，然后撤掉分段计时代码。

**验证**：`pnpm run typecheck` → 通过；`pnpm --filter tool-session run test` → 17 passed；`pnpm vitest run packages/ui-session-tool/tests` → 19 passed；Phase 出口检查：`pnpm run typecheck && pnpm --filter session-tool-local run test && pnpm --filter tool-session run test && pnpm vitest run packages/ui-session-tool/tests && pnpm run build` → 全部通过，输出存 `evidence/phase-1/exit.log`；`early-timing.log` 已落盘

**Evidence**：`evidence/phase-1/exit.log`、`evidence/phase-1/early-timing.log`（不达标时加 `evidence/phase-1/profile.log`）

**注意事项**：易错点 重启 3084 会打断正在用 Bot 页面的用户，先告知；禁止改工具输出 schema；禁止把开关加进面板 RPC 请求字段白名单

### Phase 2: 验收与收尾

> 你在哪里：代码和构建完成。
> 做完之后：真实网关上计时达标、输出不变，全量回归通过。

### Task 5: 执行 spec 5.2 真实场景全套测试

- **关联**：UF-001 / UF-002 / UF-003 / INV-001 / INV-003 / INV-005 / EVD-001 / EVD-002 / EVD-004
- **风险等级**：P1

**为什么做**：单测不能证明真实语料上的耗时和面板显示。

**涉及文件与定位**：

- 无代码改动。

**具体操作**：

1. 重启 3084：先 `dsh-rpc-who.sh 3084` 确认 pid 与 `DSH_HOME` 属于 dsh-grok-bot `env/`，再对该 pid 发 SIGTERM，然后在 `../../dsh-grok-bot/plugin` 下跑 `sh env/boot.sh`（`boot.sh` 发现已起会直接退出，所以必须先停）。Task 4 之后没有再 build 过，可跳过这一步。
2. 重启 3081（同样先确认身份）；重启后 launch token 会变，从新的 `dsh web:` 行取。
3. 按 5.2 执行矩阵逐行执行，evidence 存到 Evidence 列路径；浏览器验收脚本那一行放最后跑（它会新建并归档一个测试会话）。

**验证**：按 5.2 执行矩阵逐行回放，全部通过

**Evidence**：`evidence/UF-001/`、`evidence/UF-002/`、`evidence/UF-003/`

**注意事项**：易错点 不重启网关就测，测到的是旧代码；禁止停掉未确认身份的进程

### Task 6: 执行最终回归验证

- **关联**：全部 BR/UF/INV
- **风险等级**：P2

**为什么做**：收尾闸门。

**涉及文件与定位**：

- 无代码改动。

**具体操作**：

1. 跑 5.1 全部命令。
2. 若 ASM-001 未达标，把剖析结果写进 `evidence/final/regression.log` 并在完成总结里列为剩余风险。
3. 重跑包校验。

**验证**：5.1 全部行 → 通过；`python3 $SPEC_SKILL/scripts/validate_package.py docs/session-list-perf` → 0 FAIL

**Evidence**：`evidence/final/regression.log`

**注意事项**：易错点 通过数必须 ≥ 基线（新增用例后 session-tool-local 应大于 210）

---

## 5. 验收与 Review 协议

### 5.1 命令级验证（入场券）

| 验证项 | 命令 | 期望 | Evidence |
|---|---|---|---|
| typecheck | `pnpm run typecheck` | 0 error | EVD-003 |
| session-tool-local unit | `pnpm --filter session-tool-local run test` | 全部通过，数量 > 210 | EVD-003 |
| tool-session unit | `pnpm --filter tool-session run test` | 17 passed | EVD-003 |
| ui-session-tool unit | `pnpm vitest run packages/ui-session-tool/tests` | 19 passed | EVD-003 |
| dsh-bot 回退路径 | `pnpm -C ../../dsh-grok-bot/plugin vitest run packages/dsh-bot-host/tests/ask.spec.ts` | 全部通过 | EVD-003 |
| build | `pnpm run build` | 成功 | EVD-003 |

### 5.2 真实场景全套测试（Real-Run，完成的唯一标准）

**环境准备**：

| 项 | 值 |
|---|---|
| 启动命令 | 3084：`sh env/boot.sh`（在 `../../dsh-grok-bot/plugin` 下，先停旧进程；会打断正在用 Bot 页面的用户）；3081：`sh env/boot.sh`（本仓） |
| 访问入口 | 3084：`http://127.0.0.1:3084/dsh-bot/listSessions`（POST，本地无需 cookie，已实测 200）；3081 CLI 与面板接口：1.3 节实跑命令；浏览器验收：`DSH_E2E_URL=<dsh web: URL> pnpm -C packages/ui-session-tool run test:browser` |
| 测试账号/数据 | 3084 现有语料（宿主 82 个，79 个 v3；Bot 列表 71 行）；3081 现有 8 个会话（7 个 v3） |
| 干净状态定义 | curl / CLI 只读；浏览器验收脚本会新建并归档一个 `侧栏验收-*` 会话，所以放最后跑 |
| 可用测试工具 | curl、jq、CLI、本机 Chrome（浏览器验收脚本用 playwright-core 无头启动） |

**执行矩阵**：

| UF | 执行方式 | 操作来源 | 必须核对的点 | Evidence |
|---|---|---|---|---|
| UF-001 主路径 | curl | 2.3 节 UF-001 主路径；同 Task 1 第 2-3 步命令，文件名换 `after-*` | 3 次均 200 且 < 1000ms（ASM-001）；`comm -23 before-ids.txt after-ids.txt` 为空（没有行丢失）；`comm -13` 多出的行，`createdAt` 都晚于 before-timing.log 的基线时刻 | `evidence/UF-001/after-timing.log`、`evidence/UF-001/ids.diff`（写命令与两段 comm 结果） |
| UF-001 宿主投影缺失 | curl + 日志 | 2.3 节 UF-001 分支「宿主投影缺失」 | 同一请求期间网关无新增 error；v3 行照常返回 | `evidence/UF-001/v3-rows.log` |
| UF-001 连不上网关 | 命令 | 2.3 节 UF-001 分支「session-tool 连不上网关」；跑 5.1 dsh-bot 回退路径命令 | `falls back to platform.listSessions` 用例通过 | `evidence/UF-001/fallback.log` |
| UF-002 主路径（工具） | 命令 | 2.3 节 UF-002 第 1-2 步；`pnpm --filter tool-session run test` | `session_list forwards the delegation status filter and projects delegation_status` 通过（含开关断言） | `evidence/UF-002/tool.log` |
| UF-002 主路径（CLI） | CLI | 2.3 节 UF-002 第 3 步；1.3 节 CLI 实跑命令，输出存 `after-cli.json` | `diff <(jq -S . before-cli.json) <(jq -S . after-cli.json)` 无差异 | `evidence/UF-002/after-cli.json`、`evidence/UF-002/cli-diff.log`（写命令与退出码） |
| UF-002 按委派状态过滤 | 命令 | 2.3 节 UF-002 分支「按委派状态过滤」；`pnpm --filter session-tool-local run test -t "delegation projection status"` | 用例通过 | `evidence/UF-002/status-filter.log` |
| UF-002 冷会话无宿主值 | 命令 | 2.3 节 UF-002 分支「冷会话无宿主值」；Task 3 新增的回落冷读用例 | 用例通过 | `evidence/UF-002/cold-fallback.log` |
| UF-003 主路径 + 冷会话无宿主值 | curl | 2.3 节 UF-003 主路径与分支「冷会话无宿主值」；同 Task 1 第 5 步命令，文件名换 `after-*`，加 `-w '%{time_total}'` | `diff before-panel.tsv after-panel.tsv` 无差异（3081 的 7 个 v3 行都走冷读兜底） | `evidence/UF-003/after-panel.tsv`、`evidence/UF-003/panel.diff`（写命令、退出码、耗时） |
| UF-003 按运行状态筛选 | curl | 2.3 节 UF-003 分支「按运行状态筛选」；同上命令，payload 改为 `{"includeHidden":true,"status":"failed"}` | 返回的 id 集合等于 `before-panel.tsv` 中 `failed` 行的 id 集合 | `evidence/UF-003/status-filter.tsv` |
| UF-003 接口出错 | curl | 2.3 节 UF-003 分支「接口出错」；同上命令，payload 改为 `{"status":"weird"}` | `result.ok` 为 false，`error.code` 为 `invalid-input` | `evidence/UF-003/error.json` |
| UF-003 浏览器验收 | 命令 | 2.3 节 UF-003 主路径第 1、4 步；5.2 环境准备的浏览器验收命令（最后跑） | 输出 `PASS: official sidebar, ...` 且退出码 0；日志里不出现 launch URL | `evidence/UF-003/browser.log` |

**通过标准**：执行矩阵全部行通过且 evidence 齐全。任何一行失败 = 本需求未完成，回到对应任务修复后重跑。ASM-001 未达标时 UF-001 主路径记为失败并按 Task 6 第 2 步处理。

### 5.3 Evidence 目录结构与命名

```text
evidence/
  phase-0/exit.log
  phase-1/task-2.log task-3.log exit.log early-timing.log [profile.log]
  UF-001/before-timing.log before-ids.txt after-timing.log after-ids.txt ids.diff v3-rows.log fallback.log
  UF-002/before-cli.json after-cli.json cli-diff.log tool.log status-filter.log cold-fallback.log
  UF-003/before-panel.tsv after-panel.tsv panel.diff status-filter.tsv error.json browser.log
  final/regression.log
```

### 5.4 Review 专项检查清单

- [ ] 默认 `list()` 路径不再触达冷读入口（看 Task 3 新测试 + 3084 计时）
- [ ] 请求委派状态时只给当页 / 过滤后的候选行取值（BR-006 用例）
- [ ] `delegationStatusOf` 在 collect 路径的调用未被改变语义
- [ ] 两个传输客户端解析逻辑只有一份，不复制
- [ ] `SessionToolListFilter` / `SessionToolListRow` 的 JSDoc 已写明新默认值
- [ ] 5.2 执行矩阵全部通过，evidence 齐全且与第 2.5 节 EVD 清单一致
- [ ] 2.3 节每条流程的「入口接线清单」已实现（tool-session 与 ui-session-tool 都传了开关，CLI 未改）
- [ ] evidence 里没有 token、launch URL、cookie、3084 响应原文
- [ ] 所有 BR/UF/INV 状态可对照第 2 章逐条核销
