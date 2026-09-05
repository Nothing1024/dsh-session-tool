# dsh-0-1-2-upgrade Spec

> Version: 0.2.0 | Date: 2026-09-05 | Status: Ready 可执行
>
> 本文件是本需求的**唯一事实源**：事实基线、业务合同、技术方案、任务计划、验收协议全部在此。
> 其他文件（handoff.md、tasks.csv）只引用本文件，不复制内容。
>
> 填写三态规则：每个表格单元格只允许三种内容——
> 1. 验证过的事实（注明来源命令）；2. 显式假设 `ASM-xxx`；3. `待勘察`。
> 禁止编造看似合理的命令、symbol、文件名。

---

## 0. 一页纸人话摘要

- **给谁 / 场景**：维护本仓 session-tool 插件（给 DSH 网关加「独立会话」工具和 `dsh-session` 命令行）的人，要把锁定的宿主 DSH 从 `0.1.1-rc.2` 升到 `0.1.2-rc.1`。
- **做什么**：升级后插件必须能编译、能装进网关、网页打得开；agent 的 `session_*` 工具和命令行 `dsh-session` 仍能建会话、发消息、列表，并且出现在官方侧栏。
- **改哪里**：现在同进程还绕 HTTP 打自己的网关（走已删除的 `dsh-host-apiproxy` 包）。新版网关给 `/api` 加了登录 cookie，这条自环会被 401。同进程改为直接调用宿主的会话控制器 / 工作区控制器；命令行跨进程仍走 HTTP，但要先换登录 cookie。
- **怎么算做完**：`env/boot.sh` 用 `0.1.2-rc.1` 启动后，http://127.0.0.1:3081 能打开、插件 `fiberPhase` 为 `active`、第 5.2 节本 spec 的 UF-001..006 矩阵跑完。仓内 `scripts/manual-test.sh` 是另一套编号（脚本自己的 UF-001..008），不能代替 5.2；升级后它必须带 launch token。
- **不做什么**：不升到 `0.1.3-alpha.1`；不改 `session_*` 工具名和对外错误码（hyphen）；不新增 `session_hide` / `dsh-session session hide`；不重做插件标记表。
- **v0.3 补充波次（Phase 5）**：Task 1-16 已全部做完并留下真实证据，但事后邻仓 `vibee` 的一次 `pnpm install` 把本仓依赖改链回旧版 `0.1.0-rc.7`，typecheck 一度爆 37 条品牌类型错误（已用 `rm -rf packages/*/node_modules && pnpm install` 复原）。Phase 5 做三件事：把这种跨仓污染变成一条能自动报警的检查、清掉两处已失效的历史残留、在复原后的依赖上把 5.2 矩阵重跑一遍确认没被打坏。

---

## 1. 事实基线与假设

### 1.1 需求与运行模式

| 项 | 结论 |
|---|---|
| 原始需求 | 阅读 dsh-upgrade-compat skill 升级依赖宿主；用户选定目标 `0.1.2-rc.1`；随后 `/prd-workflow oneclick 规划一口气更新完` |
| 输入类型 | description（Claude 会话 88702f1c 交接 + 本仓现状） |
| Mode | oneclick |
| 置信度 | 高 |
| 输出目录 | `docs/dsh-0-1-2-upgrade/` |

### 1.2 任务类型路由

| 维度 | 结论 |
|---|---|
| 任务类型 | infra（宿主版本/启动链）+ refactor（调用层替换） |
| 主要风险 | ① 同进程 HTTP 自环被新鉴权 401，网关加载失败或 web 白屏；② 品牌类型 `SessionId` 跨物理副本不互认；③ CLI 无 cookie 后 GUI 不可见 |
| 行号引用策略 | 高：迁移必须 symbol + rg anchor；行号仅 hint |
| 必需验收方式 | typecheck / unit / build / 模块加载 / `standards/validate.mjs` / 真实启动 + CLI 矩阵 + GUI 对照 |
| 必须覆盖用户场景 | 同进程工具建会话进 GUI；CLI 跨进程建会话进 GUI；wait/collect 完成检测；hide；网关能开；死网关 fail-loud |

### 1.3 勘察事实清单

> 每条事实必须来自实际执行的命令。没跑命令的不许写在这里。

| 事实 | 来源命令 | 输出摘要 |
|---|---|---|
| HEAD `e13b038`；工作区另有未提交的本包与 `.npmrc` | `git log -1 --oneline`；`git status --porcelain` | 已提交树仍是 evolution 修复；本升级包未入库 |
| 插件 monorepo 4 个 Cordis/工具包 + CLI + marks；全部 `@deepseek-ai/dsh-*` pin `0.1.1-rc.2` | `rg "0.1.1-rc.2" packages/*/package.json pnpm-workspace.yaml env/boot.sh env/profiles/st/package.json` | local/cli/session-tool/tool-session/env/st/boot 均 pin rc.2；`dsh-host-apiproxy` 只在 local |
| `adapter-baseline.json` 记录 local 触点含 `dsh-host-apiproxy/api` 与 `/client` | `cat standards/adapter-baseline.json` | session-tool-local 8 个上游 specifier，其中 2 个 apiproxy |
| `SessionHttpClient`/`WorkspaceHttpClient` 继承 `AbstractApiClient`，方法名带点号（`session.create`/`workspace.list`/`session.history`） | `rg "AbstractApiClient|session.history|workspace.list" packages/session-tool-local/src` | session-client.ts L21/L249；workspace-client.ts L16/L91 |
| `SessionToolLocalService` 固定构造两个 HTTP 客户端；`static inject = ['sessions', 'sessionPersistence']`；`webUrl` 默认 `http://127.0.0.1:3080` | `rg "static inject|new SessionHttpClient|webUrl" packages/session-tool-local/src/index.ts` | L135 inject；L160-161 构造；L143 默认 3080 |
| live session 读 `live.events` 三处 | `rg "live\.events" packages/session-tool-local/src/index.ts` | L857 lastAssistantText；L880 delegationStatusOf；L976 resolveInspection |
| `assertNever` 从 `dsh-llm` 导入；`JsonValue` 从 `dsh-tools` 导入 | `rg "assertNever|JsonValue" packages/session-tool-local/src/index.ts packages/tool-session/src/index.ts` | local L16；tool-session L17 |
| `healProfilesModuleFallback(installAnchor())` 同步、单字符串参数 | `rg -n "healProfilesModuleFallback" packages/session-tool-cli/src/index.ts packages/session-tool-cli/node_modules/@deepseek-ai/dsh-app-boot/lib/types/profile.d.ts` | CLI L133；d.ts ` (installAnchor: string, home?: string): void` |
| 测试用 `CallId`；投影 `init()` 无参 | `rg "CallId|init\\(\\)" packages/session-tool-local/tests packages/session-tool-local/src/delegation-projection.ts` | service.spec.ts L14/L321；delegation-projection.ts L115 |
| hide 走 `ctx.get('workspaceRegistry').archiveSession`；unhide 调 `unarchiveSession`，没有则 warn | `rg "archiveSession|unarchiveSession" packages/session-tool-local/src/index.ts` | hide L463-465；unhide L489-492 |
| 仓内启动：`npx @deepseek-ai/dsh@0.1.1-rc.2 --profile st --port 3081`；st bundles = dsh-base + dsh-web-app + tool-session | `sed -n '45p' env/boot.sh`；`cat env/profiles/st/package.json` | boot L45；st L15-18 |
| 升级前 typecheck 14 错、全部路径含 `dsh-grok-bot` 的 `SessionId` 品牌冲突；隔离后 0 error | `pnpm run typecheck`（隔离前/后日志在 `evidence/phase-0/`） | 根因是 `packages/session-tool{,-local}/node_modules/@deepseek-ai/dsh-session` 链到邻仓另一套 peer hash；`rm -rf packages/*/node_modules && pnpm install` 后四包都指向本仓 `a467074c` |
| 单测 157 passed / 1 skipped | `pnpm test` | e2e skipped；见 `evidence/phase-0/test-baseline.log` |
| 上游标签存在 `dsh-v0.1.2-rc.1`；npm `@deepseek-ai/dsh@0.1.2-rc.1` 有；`@deepseek-ai/dsh-host-apiproxy` 最新停在 `0.1.1-rc.2`；`packages/host/apiproxy` 在 0.1.2-rc.1 404 | `gh api .../tags`；`npm view @deepseek-ai/dsh-host-apiproxy versions`；`gh api .../contents/packages/host/apiproxy?ref=dsh-v0.1.2-rc.1` | 404 Not Found；npm 最后 rc.2 |
| 0.1.2-rc.1：`Session.events` getter 删除，改为 `snapshotEvents(from, toExclusive)` | `rg "get events|snapshotEvents" /tmp/sess_index_rc2.ts /tmp/sess_index_012.ts` | rc.2 L559 getter；0.1.2 L600 snapshotEvents |
| 0.1.2-rc.1：`dsh-llm` 不再 `export * from './never.ts'`；`assertNever`/`JsonValue` 在 `@deepseek-ai/dsh-util-values` | `rg "never.ts|assertNever|JsonValue" /tmp/llm_index_012.ts /tmp/util_values_012.ts` | llm 012 无 never；util-values L4 JsonValue、L12 assertNever |
| 0.1.2-rc.1：`CallId` 改名为 `ToolCallId`（`dsh-llm/brand`） | `cat /tmp/llm_brand_012.ts` | `export function ToolCallId(id: string)` |
| 0.1.2-rc.1：`ProjectionDefinition.init(header, inheritedEventCount)` | `rg "init\\(" /tmp/proj_index_rc2.ts /tmp/proj_index_012.ts` | rc.2 `init()`；012 `init(header, inheritedEventCount)` |
| 0.1.2-rc.1：`healProfilesModuleFallback` 改为 `async (options) => Promise<void>`，字段 `installAnchor` | `rg -n "export async function healProfilesModuleFallback" /tmp/boot_profile_012.ts` | `options: ProfileModuleFallbackOptions` |
| `/api` 整前缀先 `requestRejection`：Host 信任失败 403，cookie 未认证 401；`isAuthenticated` 只验 HMAC cookie，无 loopback 豁免 | `sed -n '113,125p' /tmp/conn_index_012.ts`；`rg "requestRejection|isAuthenticated" /tmp/rpc_host_012.ts /tmp/browser_auth_012.ts` | conn L118-122；rpc-host `isTrustedApiRequest ? 403 : cookie 401` |
| Host 信任层允许 loopback hostname，故 127.0.0.1 打 `/api` 过 Host 后仍会 401 | `rg "isLoopbackHostname" /tmp/api_trust_012.ts` | L103 loopback 或 trustedHosts |
| 换 cookie：仅 `GET /?token=<launch-token>` 在 `authorizeIndex` 里 303 + `Set-Cookie`（`location: /`）；cookie 名 `dsh-auth-` + authority 的 sha256。Node `fetch` 默认跟随重定向且无 cookie jar，会丢掉这次 `Set-Cookie` | `sed -n '240,265p' /tmp/browser_auth_012.ts`；`sed -n '16,16p;106,108p' /tmp/browser_auth_012.ts` | L256-264 `writeHead(303)`；`COOKIE_PREFIX = 'dsh-auth-'` |
| 0.1.2 Remote 业务错误是斜杠码，插件对外仍是连字符码 | `rg "RemoteError\\('session/" /tmp/sc_commands_012.ts`；`rg "workspace/(not-found|name-conflict|invalid-path)" /tmp/wc_commands.ts /tmp/sc_commands_012.ts` | `session/not-found`、`session/title-invalid`、`workspace/not-found`、`workspace/name-conflict`、`workspace/invalid-path` |
| CLI 与 `session_*` 工具都没有 hide/unhide 入口；hide 只在 `ctx.sessionTool` | `rg "session_hide|session hide" packages/session-tool-cli/src/index.ts packages/tool-session/src/index.ts`；`rg "name: 'session_" packages/tool-session/src/index.ts` | CLI/工具无命中；工具只有 create/read/wait/collect/write/list/rename |
| `sessionController`/`workspaceController` 经 `declare module` 挂到 Context；只在 `@deepseek-ai/dsh-web-app` 依赖里，不在 `dsh-base` | `rg "sessionController|workspaceController" /tmp/sc_index_012.ts /tmp/wc_index_012.ts`；web-app/base package.json | sc L60-64；wc L26-30；web-app 有两个 controller 包，base 没有 |
| Remote 仍有 unary `session/create|prompt|cancel|rename|list|page`；`session/follow` 与 `workspace/follow` 为 stream；无 `session.history`、无 `workspace.list` unary | `rg "@Remote" /tmp/sc_index_012.ts /tmp/wc_index_012.ts` | sc list/create/rename/prompt/cancel/page/follow/control；wc create/rename/delete/archiveSession/follow |
| 同进程读 workspace 列表：`ctx.workspaceRegistry.list()` + `archivedSessionIds`（feed.baseline 同步） | `rg "workspaceRegistry.list|archivedSessionIds" /tmp/wc_feed_012.ts` | L55-73 |
| `workspaceRegistry.unarchiveSession` 在 0.1.2-rc.1 workspace 源码不存在；`archiveSession` 仍在 | `rg "unarchive|archiveSession" /tmp/ws_index_012.ts` | archiveSession L244；unarchive 无命中 |
| `subagent.prompt` 仍是 `@Remote('prompt')` | `rg "@Remote\\('prompt'\\)" /tmp/sub_index_012.ts` | SubagentRuntime L409 |
| 官方 CLI 矩阵入口与死网关 patch 仍在 | `head -20 scripts/manual-test.sh`；`cat env/dead-web.patch.yml env/cli.patch.yml` | 脚本自有 UF-001..008（与本 spec UF 编号不同）；dead webUrl :3999；cli webUrl :3081 |
| **（v0.3）Task 16 收尾后品牌隔离复发**：typecheck 37 error，源头是 `packages/*/node_modules/@deepseek-ai/*` 有 11 条软链指向邻仓 `vibee` 的 rc.7 副本 | `pnpm run typecheck`；`for d in packages/*/node_modules/@deepseek-ai/*; do readlink "$d"; done \| grep vibee` | 报错含 `plugin/vibee/plugin/node_modules/.pnpm/...dsh-session@0.1.0-rc.7`，`Property '[BRAND]' is missing`；11 条命中集中在 session-tool-local(8) 与 session-tool(3) |
| **（v0.3）复发根因是邻仓 workspace 反向纳管本仓包**：vibee 的 `pnpm-workspace.yaml` 把本仓 3 个包 glob 成自己的 workspace 成员，并用 `overrides` 全量钉 `0.1.0-rc.7` | `cat ../../vibee/plugin/pnpm-workspace.yaml` | `packages:` 含 `../../session-tool/plugin/packages/{session-marks,session-tool,session-tool-local}`；`overrides` 把 `@deepseek-ai/*` 全钉 rc.7、cordis 钉 4.0.1 |
| **（v0.3）受污染集合与 glob 集合精确吻合**：被改链的只有 session-tool-local 与 session-tool | 同上两条对照 | session-marks 无 `@deepseek-ai/*` 依赖（INV-005）故无可污染项；未被 glob 的 session-tool-cli / tool-session 全程干净 |
| **（v0.3）`rm -rf packages/*/node_modules && pnpm install` 可完全复原** | `rm -rf packages/*/node_modules && pnpm install`；复查 readlink 与四件套 | leak=0；14 个包全解析到 `0.1.2-rc.1`；typecheck 0 error、test 223 passed/1 skipped、build 5 包成功、standard:check 通过 |
| **（v0.3）npm 最新版仍是 `0.1.2-rc.1`，本仓 pin 未落后** | `npm view @deepseek-ai/dsh dist-tags --json` | `latest=0.1.2-rc.1`、`next=0.1.2-rc.1`、`alpha=0.1.2-alpha.5`（alpha 版本号更低且非发布线） |
| **（v0.3）两处历史残留已失效但仍在**：apiproxy 已从源码删除，exclude 行空转；tsconfig 注释仍写旧版本 | `rg "0.1.1-rc.2" pnpm-workspace.yaml tsconfig.base.json`；`rg apiproxy packages/*/src` | `pnpm-workspace.yaml:23` 仍 exclude `dsh-host-apiproxy@0.1.1-rc.2`；`tsconfig.base.json:4` 注释 `(pinned 0.1.1-rc.2)`；`packages/*/src` 无 apiproxy 命中 |
| **（v0.3）env/profiles/st 未被污染**，故 UF-005 的 boot 链路未受本次复发影响 | `for d in env/profiles/st/node_modules/@deepseek-ai/*; do readlink "$d"; done \| grep -c vibee` | `st_leak_count=0`；st 下 170 个 `@deepseek-ai/*` 均在本仓 store |

### 1.4 假设清单

| 假设 ID | 内容 | 风险 | 确认方式 |
|---|---|---|---|
| ASM-001 | 传输自动选择：当本进程存在 `sessionController`+`workspaceController`，且 `Config.webUrl` 的 host:port 等于本进程 webServer 监听地址时走同进程；否则走 HTTP。CLI headless 即使自带一套 controller，只要 webUrl 指向 :3081 的 GUI 进程，就必须走 HTTP | 误选本地 store，GUI 看不见 | Task 8 用「同进程建会话侧栏可见 / CLI 建会话也进同一侧栏」对照 |
| ASM-002 | CLI 鉴权：从 boot stdout 的 `dsh web:` URL 取出 `token` 查询参数，写入插件约定环境变量 `DSH_LAUNCH_TOKEN`（或 `--token`）。用 `GET {webUrl}/?token=` 且 **`redirect: 'manual'`**（禁止跟随 303），读取 303 的 `Set-Cookie`，后续 POST `/api/...` 原样带上。Cookie 绑定 `webUrl` 的 host:port。不解析 `$DSH_HOME/.credentials.yaml`。`DSH_LAUNCH_TOKEN` 不是上游环境变量 | 默认 fetch 跟随重定向会丢 cookie，之后每发必 401 | Task 7 用真实 boot 的 launch token 换 cookie；失败映射 `web-unreachable` |
| ASM-003 | 新 unary POST 信封按 `@deepseek-ai/dsh-client-connection` 的 client rpc（路径 `/api/session/create`，payload `{args}`）实现；不手搓第二套协议字段 | 字段漂移 | Task 7 对照 `/tmp` 已拉的 `packages/client/connection/src/client/rpc.ts` 与一次成功 POST |
| ASM-004 | `SessionEvent.seq` 品牌化成 `SessionSeq` 后，插件把 `seq` 当 number 暴露的契约仍可赋值（品牌 number 的子类型） | rename/read 行号类型报错 | Task 4 typecheck 若爆再收窄映射 |
| ASM-005 | 品牌隔离：删掉 `packages/*/node_modules` 后在本仓 `pnpm install`，使四包都链到本仓 `.pnpm`。`.npmrc` 的 `package-import-method=copy` 只是额外防硬链，不是选中本仓 virtual store 的机制。回归：`pnpm run typecheck` 不得出现 `dsh-grok-bot` | 以后默认 auto 安装若再链到邻仓，14 条品牌错会回来 | Task 1 已证实：隔离后 typecheck 0 error。**v0.3 已被证伪其"一次性"部分**：风险确实兑现，且污染源不是 `dsh-grok-bot` 而是 `vibee`，检测口径过窄（见 ASM-006 / BR-009） |
| ASM-006 | 复发是**邻仓 `pnpm install` 触发**，不是本仓命令触发：vibee 把本仓 3 个包 glob 进自己 workspace 并 `overrides` 钉 rc.7，在 vibee 里跑 install 就会改写本仓 `packages/*/node_modules`。因此本仓只能做**检测 + 复原**，不能单方面根治；根治要改邻仓 workspace（属本仓非目标，见 2.8） | 若判断错方向，会去改本仓 `.npmrc` / `tsconfig` 而无效，复发照旧 | Task 17 的 `deps:check` 在污染态必须报错、复原后必须通过；1.3 节已记录 glob 集合与受污染集合精确吻合 |

### 1.5 变更记录

| 日期 | 变更条目 ID | 原因 | 影响任务与处置 |
|---|---|---|---|
| 2026-09-05 | spec v0.2 | 本地 review：阶段闸门自相矛盾、斜杠错误码、303 cookie、UF-004 无入口 | Task 2/4/7/10/11/14 改写；UF-004 改为内部服务单测；BR-006 补映射 |
| 2026-09-05 | spec v0.3：新增 BR-009、INV-008、ASM-006、Phase 5（Task 17-19），ASM-005 标注部分证伪 | Task 16 收尾（13:09）后品牌隔离复发：邻仓 vibee 的 workspace glob + rc.7 overrides 把本仓依赖改链回旧版，typecheck 37 error。原 ASM-005 只防 `dsh-grok-bot`，检测口径漏掉 vibee | **不回退任何已完成任务**：Task 1-16 的 evidence 于污染发生前产出且真实有效，状态保持「已完成」。新增 Task 17（检测脚本）、Task 18（清残留）、Task 19（复原态重跑 5.2 + 回归收尾）。Task 19 覆盖并取代 Task 15/16 作为最终验收 |

### 1.6 质量记录

| 项 | 结果 |
|---|---|
| `validate_package.py --repo` | 0 FAIL / 0 WARN / 22 PASS（2026-09-05 v0.2；§3.3 22 条 rg 全命中） |
| `validate_package.py --repo` | 0 FAIL / 1 WARN / 21 PASS（2026-09-05 v0.3 加入 Phase 5 后复跑） |
| `validate_package.py --repo` | 0 FAIL / 1 WARN / 21 PASS（2026-09-05 Phase 5 执行完毕后复跑；证据 `evidence/phase-5/validate-package.log`）。执行期修正一处：§3.3 中 `pnpm-workspace.yaml` 的定位命令原为 `rg "0.1.1-rc.2"`，Task 18 按设计删掉了该行导致 anchor 失效，已改为稳定 symbol `minimumReleaseAgeExclude` |
| v0.3 唯一 WARN 的性质 | 「真实场景任务（任务 15）不在最后一个 Phase（P5）」——**设计如此，不修**。P5 是 P4 收尾后追加的补充波次；Task 19 是 P5 内的真实场景重跑且兼任回归收尾。硬把 Task 15 挪进 P5 会篡改它 12:51-13:09 的真实执行时序 |
| Stage 1 无人值守 | 用户在源会话写了「规划一口气更新完」并两次 `continue`，本包不在 Stage 1 停等 |
| handoff.md | v0.2 未生成（当前会话执行）；**v0.3 已生成**——Phase 5 交由子 agent 执行，需要交付入口 |

---

## 2. 业务合同

### 2.1 BR 业务规则

| 规则 ID | 规则 | 正例 | 反例 | 影响范围 | 验证方式 |
|---|---|---|---|---|---|
| BR-001 | 宿主目标版本是 `0.1.2-rc.1`，不是 `0.1.3-alpha.1`。例外：`dsh-host-apiproxy` 在 npm 无 0.1.2，保持 `0.1.1-rc.2` 直到 Task 6/7 删掉 import | boot/st/`dsh*`（除 apiproxy）均为 `0.1.2-rc.1` | boot 仍 pin `0.1.1-rc.2` 或跳到 alpha | env、package.json、pnpm-workspace、setup.sh、dsh.plugin.json；host-descriptor 在 Task 14 | `rg "0.1.1-rc.2" env/boot.sh env/setup.sh pnpm-workspace.yaml packages/*/package.json packages/tool-session/dsh.plugin.json env/profiles/st/package.json` → 仅 apiproxy 行 |
| BR-002 | 同进程（tool-session 挂在 GUI 那个 web-app 树上）禁止再 HTTP 自环；必须调 `ctx.sessionController` / `ctx.workspaceController`（及同树的 `workspaceRegistry` 读列表） | st profile 里 `session_create` 不发 loopback POST | 同进程仍 POST `http://127.0.0.1:3081/api/...` 被 401 | session-tool-local | 单测断言未 fetch；真实场景侧栏可见 |
| BR-003 | 跨进程（`dsh-session` CLI 打已运行网关）必须继续打 `Config.webUrl` 指向的 GUI 进程，不得写入 CLI 自己树里的 session 栈 | CLI `--patch env/cli.patch.yml` 建的会话出现在 :3081 侧栏 | CLI 把会话写进 headless 本地 store，侧栏没有 | CLI + HTTP 客户端 | UF-002 |
| BR-004 | 跨进程 HTTP 必须带浏览器 cookie 鉴权；无 cookie 的失败对调用方仍是 `web-unreachable`（不新增对外错误码） | 有 launch token 时 create 成功 | 裸 curl POST `/api/session/create` 401，CLI 打出 `[web-unreachable]` | HTTP 客户端 | UF-002 失败分支 + UF-006 |
| BR-005 | `session.wait` / `session_collect` 不得依赖已删除的 `session.history`。完成态：`session.list` 的 `running` 位 + 本进程 `snapshotEvents()` 或 `sessionPersistence.inspect()` 的 `turn/end` | wait 在 turn/end 后返回 completed | 仍调用 `sessions.history` 编译失败或运行抛错 | session-client / collect | UF-003 |
| BR-006 | `session_*` 工具名、`ctx.sessionTool` 方法名、**对外**错误码集合不改名或删除。HTTP 客户端必须把 0.1.2 斜杠码映射回现有连字符码，未映射不得变成 `web-unreachable` | 缺会话仍是 `[session-not-found]` | 把 `session/not-found` 原样抛成 `[web-unreachable]` | tool-session / session-tool / HTTP 客户端 | tools.spec + Task 7 映射表单测 |
| BR-007 | 升级后预检必须全过：typecheck 无邻仓品牌噪音、build、各包 `import(lib)`、`node standards/validate.mjs`、网关启动、插件 `fiberPhase=active`、web UI 可打开 | 预检清单逐项 OK | 编译不过仍部署 | 全仓 | UF-005 |
| BR-008 | hide 在同进程继续 best-effort `workspaceRegistry.archiveSession`；unhide 在没有 `unarchiveSession` 时保持 warn、不抛、标记仍清除 | hide 后官方栏可归档；unhide 清 `kind:hidden` | unhide 因缺方法抛错导致标记没清 | hide/unhide | UF-004 |
| BR-009 | 本仓 `packages/*/node_modules/@deepseek-ai/*` 必须全部解析到**本仓** `.pnpm`，且版本为 `0.1.2-rc.1`。存在指向仓外（`vibee` / `grok` / 任意本仓根之外路径）的软链即为污染，必须能被一条命令检出并明确报错，不得只靠 typecheck 报品牌错来间接发现 | `pnpm run deps:check` 通过；11 条软链全部落在本仓 store | 任一软链 `readlink` 落到 `../../vibee/...`，或解析到 `0.1.0-rc.7` | 全仓依赖布局 | Task 17：污染态必须非 0 退出，复原后必须 0 退出 |

### 2.2 UF 用户验收场景（索引）

| 场景 ID | Given | When | Then | 角色 | 验证方式 | Evidence |
|---|---|---|---|---|---|---|
| UF-001 | st profile 网关 :3081 已起，插件 active | agent 调 `session_create` 再 `session_write` | 官方侧栏出现该会话，打开能看到对话 | agent / 操作员 | agent 工具 + GUI | EVD-001 |
| UF-002 | 同一网关；CLI `--profile headless --patch env/cli.patch.yml` 带 token | `dsh-session session create --workspace` | 会话出现在同一 :3081 侧栏，不是 CLI 私有 store | CLI 操作员 | CLI + GUI | EVD-002 |
| UF-003 | 已有一条会跑模型的会话 | `session_wait` / `session_collect` | 回合结束后返回终态，超时返回 timeout 且会话仍在 | agent / CLI | CLI | EVD-003 |
| UF-004 | 已有可见会话（**非用户可见**：无 `session_hide` 工具、无 `dsh-session session hide`，豁免 CLI/浏览器） | 调用 `ctx.sessionTool.hide` 再默认 list；`unhide` | 默认 list 丢掉该行；unhide 后标记清除；缺 unarchive 只 warn | 内部服务 | unit | EVD-004 |
| UF-005 | 干净 env，依赖已是 0.1.2-rc.1 | `sh env/boot.sh` 后打开 web | 进程起来、UI 非白屏、pluginInventory 中 tool-session `fiberPhase=active` | 操作员 | boot + browser/curl | EVD-005 |
| UF-006 | 无网关或 webUrl=:3999 | CLI create/list/workspace | 退出非 0，stderr 含 `[web-unreachable]`，不写出会话 | CLI 操作员 | CLI | EVD-006 |

### 2.3 核心业务流程（步骤级交互脚本）

本需求无浏览器单页表单。界面 = 官方 Web 侧栏 + CLI stdout/stderr。状态机按命令行/网关态写。

#### UF-001: 同进程工具建会话并进 GUI

**前置状态**：`sh env/boot.sh` 使 :3081 为本仓 `env/`；模型 key 在 `env/.env`；插件 active。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 在已开的 web 会话里让 agent 调 `session_create`（带 workspace_path） | 工具卡 generic「Create a persistent session」 | 同进程 `sessionController.create` + workspace 注册，不 HTTP 自环 | 工具返回 `session_id` |
| 2 | agent 调 `session_write` 发一句中文 | 工具卡「prompt sent」 | `sessionController.prompt` 入队 | 官方会话视图出现 user 消息并开始流式回复 |
| 3 | 打开侧栏该会话 | 侧栏高亮 | 普通 session 事件推送 | 完整对话可见 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 控制器未注入 | 误装到没有 web-app 的树且 transport 选了 in-process | 工具失败，错误可读 | 启动期或首调 fail loud，禁止静默 HTTP 自环 | 改 transport 或补 web-app bundle |
| 模型不可用 | 无 key | 会话在，回复失败 | prompt 已接受或模型错误按现契约透传 | 补 key 后重 write |

**界面状态机**：

```text
idle → created (侧栏出现) → prompting → streaming → idle
```

**入口接线清单**：

- 工具注册：`packages/tool-session/src/index.ts` `defineTool` 的 `session_create` / `session_write`
- bundle：`packages/tool-session/cordis.patch.yml` 挂 `session-tool-local` + `tool-session`
- profile：`env/profiles/st` bundles 含 `tool-session`
- 验证入口：web http://127.0.0.1:3081 侧栏；或 `bash scripts/manual-test.sh`

#### UF-002: CLI 跨进程建会话并进同一 GUI

**前置状态**：UF-001 的网关仍在；拿到本次进程 launch token（stdout 或 `DSH_LAUNCH_TOKEN`）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `node packages/session-tool-cli/lib/bin.js --profile headless --patch env/cli.patch.yml session create --workspace env/manual-view --title …` | CLI 打印 session_id | HTTP：token 换 cookie → POST `/api/session/create`（及 workspace/create）打 :3081 | 退出码 0 |
| 2 | 刷新或看侧栏 | 侧栏新增一行 | web 进程事件推送 | 标题可见 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 无 token | 未设 `DSH_LAUNCH_TOKEN` 且无法换 cookie | CLI `[web-unreachable]` | HTTP 401 映射，不写本地 store | 补 token 重试 |
| 打错进程 | webUrl 指向别人的 :3081 | `env/gateway-id.sh` 拒绝或业务失败 | 现有 gateway_require | 用本仓 env boot |

**界面状态机**：

```text
cli-boot → auth-cookie → rpc → printed-id
                |
                v
              web-unreachable
```

**入口接线清单**：

- CLI bin：`packages/session-tool-cli/src/bin.ts` → `bootProfile` → `ctx.sessionTool`
- patch：`env/cli.patch.yml` `webUrl: http://127.0.0.1:3081`
- 验证入口：上述 node 命令 + 浏览器侧栏

#### UF-003: wait / collect 完成检测

**前置状态**：已有一条会跑模型的会话（UF-001/002 的 write）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `session_wait` 或 CLI 等价 | 命令阻塞 | 轮询 list.running + 本地/同进程日志 `turn/end`，不调 `session.history` | 返回 completed/failed/aborted |
| 2 | `session_collect` wait=all | 阻塞至集合终态 | 同上，按现谓词聚合 | 打印各 session 状态 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 超时 | timeout_ms 内未 idle | 返回 timeout，非异常 | 会话保留 | 再 wait |
| 会话不存在 | 错 id | `[session-not-found]` | 不误报 completed | 换 id |

**界面状态机**：

```text
waiting → terminal | timeout
```

**入口接线清单**：

- 工具：`session_wait` / `session_collect` in `packages/tool-session/src/index.ts`
- 实现：`SessionToolLocalService.wait` / `collect` + 客户端 settle
- 验证入口：CLI 或 agent 工具

#### UF-004: hide / unhide

**前置状态**：测试里已有一条默认可见会话。本流程无 CLI/工具入口，按内部服务回放。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 调用 `ctx.sessionTool.hide` | 返回 `isHidden: true` | 写 `kind:hidden`；同进程 best-effort `archiveSession` | 默认 list 无此行 |
| 2 | 调用 `ctx.sessionTool.unhide` | 返回 `isHidden: false` | 去掉标记；无 `unarchiveSession` 则 warn | 标记清除；官方归档态可能仍在（既有边界） |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 无权限 | 非允许 caller | fence 错误 | 不改标记 | 换 caller |
| archive 失败 | registry 抛错 | hide 仍成功 | warn 日志 | 标记已在，可重试 archive |

**界面状态机**：

```text
visible → hidden-mark → unhidden-mark
```

**入口接线清单**：

- `SessionToolLocalService.hide` / `unhide`（`packages/session-tool-local/src/index.ts`）
- 验证入口：`pnpm exec vitest run packages/session-tool-local/tests/service.spec.ts -t "getVisibility / hide / unhide"`
- 非接线：不要把 `rename --tag kind:hidden` 当成 `hide()`（不走 `archiveSession`）

#### UF-005: 网关启动与插件 active

**前置状态**：`pnpm install && pnpm run build`；`sh env/setup.sh` 已把 st 依赖换成 0.1.2-rc.1。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `sh env/boot.sh` | stdout 出现本进程 URL/token | `npx @deepseek-ai/dsh@0.1.2-rc.1 --profile st --port 3081 --no-open` | 进程存活 |
| 2 | 打开 http://127.0.0.1:3081 | 页面不是白屏 | Cordis 加载 tool-session | 官方 UI |
| 3 | 查 pluginInventory | JSON 含 tool-session | 插件 fiber 进入 active | `fiberPhase=active` |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 模块解析失败 | 仍 import apiproxy | 网关起不来或白屏 | Loader 抛错 | 回退 `dsh@0.1.1-rc.2` 或修 import |
| 口被占 | 别人的 :3081 | boot 拒绝或 gateway-id 失败 | 现有 gateway_refuse_foreign | 杀掉占口或换环境 |

**界面状态机**：

```text
stopped → booting → ui-up + plugin-active
```

**入口接线清单**：

- `env/boot.sh` L45 版本字符串
- `env/profiles/st/package.json` bundles
- 验证入口：浏览器 :3081；调试 curl 见 README（须带 cookie）

#### UF-006: 死网关 fail-loud

**前置状态**：不启动 :3081，或使用 `env/dead-web.patch.yml`（webUrl :3999）。

**成功主路径**（此处「成功」= 正确失败）：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | CLI create/list/workspace | stderr `[web-unreachable]` | HTTP 失败或 401，不写会话 | 非 0 退出 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 误连本机其他 GUI | 未跑 gateway-id | 可能写进别人的 store | 现有脚本应先 gateway_require | 强制 EXPECTED_HOME |
| 把错误吞成空列表 | 客户端把 401 当空 | 假成功 | 禁止 | 映射为 web-unreachable |

**界面状态机**：

```text
call → web-unreachable
```

**入口接线清单**：

- `env/dead-web.patch.yml`
- `scripts/manual-test.sh` 死网关段
- 验证入口：`dsh-session --patch env/dead-web.patch.yml session list`

### 2.4 INV 不变量

| 不变量 ID | 内容 | 关联 BR/UF | 验证方式 |
|---|---|---|---|
| INV-001 | `session_create/read/write/list/rename/wait/collect` 工具名与 `ctx.sessionTool` 方法名保持 | BR-006 | tools.spec + rg name: |
| INV-002 | `read` 仍走本地 `sessionPersistence.inspect`，不 acquire agent | UF-001 | service 单测 + 代码路径 |
| INV-003 | 设计 §15：围绕 GUI 进程的会话操作必须让官方侧栏看得到 | BR-002/003 UF-001/002 | 真实侧栏 |
| INV-004 | owner fence、scope、hiddenPrefixes、`kind:hidden`、marks.jsonl 语义不变 | UF-004 | 现有 service.spec |
| INV-005 | `session-marks` 零 `@deepseek-ai/*` 依赖 | BR-006 | `cat packages/session-marks/package.json` |
| INV-006 | 升级前 157 条单测的行为口径保留（允许改 mock 的 URL/方法名） | BR-007 | `pnpm test` |
| INV-007 | 无 `unarchiveSession` 时 unhide 不抛 | BR-008 | UF-004 |
| INV-008 | 清理历史残留（apiproxy exclude 行、tsconfig 旧版本注释）不得改变任何运行时行为：`pnpm-workspace.yaml` 的其余 exclude 项、`tsconfig.base.json` 的编译选项本体一律不动 | BR-001/BR-009 | Task 18 前后 `pnpm install --frozen-lockfile` 不报 lockfile 变更；四件套结果不变 |

### 2.5 EVD 证据清单

| 证据 ID | 类型 | 期望证据 | 保存位置 |
|---|---|---|---|
| EVD-001 | log | 同进程 create/write 成功 + 侧栏可见说明 | `evidence/UF-001/success.log` |
| EVD-002 | log | CLI create 成功 + 同 GUI 可见 | `evidence/UF-002/success.log` |
| EVD-003 | log | wait 终态 + collect 超时快照 | `evidence/UF-003/wait-success.log` |
| EVD-004 | log | hide/unhide 与 list 过滤 | `evidence/UF-004/hide.log` |
| EVD-005 | log + screenshot | boot、plugin active、UI 非白屏 | `evidence/UF-005/boot.log` + `evidence/UF-005/ui.png` |
| EVD-006 | log | dead-web `[web-unreachable]` | `evidence/UF-006/dead-web.log` |
| EVD-007 | log | typecheck/test/build/standard 命令输出 | `evidence/phase-0/` 与 `evidence/phase-4/` |
| EVD-008 | log | 无 token CLI 401→web-unreachable | `evidence/UF-002/fail-401.log` |
| EVD-009 | log | 污染复现与检出：`deps:check` 在污染态非 0 退出并列出越界软链，复原后 0 退出 | `evidence/phase-5/deps-check.log` |
| EVD-010 | log | 残留清理前后 lockfile 与四件套无变化 | `evidence/phase-5/cleanup.log` |
| EVD-011 | log + screenshot | 复原依赖后 5.2 矩阵重跑 | `evidence/phase-5/rerun-5.2.log` + `evidence/phase-5/ui.png` |

### 2.6 角色与权限矩阵

无多角色产品权限。调用方只有 agent 与 CLI；既有 fence（INV-004）不在本次扩张。本节不开表。

### 2.7 负向 / 破坏性场景

| 场景 | Given | When | Then | Evidence |
|---|---|---|---|---|
| 无鉴权 HTTP | 网关已起 | 裸 POST `/api/session/create` | 401，CLI 映射 web-unreachable | EVD-008 |
| 死网关 | webUrl :3999 | CLI 写操作 | web-unreachable，零会话 | EVD-006 |
| 邻仓品牌污染 | 未做 Task 1 | typecheck | 不得把 grok-bot 的 14 错当成新 L1 | EVD-007 |
| 旧会话 jsonl | 升级前已有会话目录 | 新网关 read/list | inspect 仍可读（INV-002） | EVD-001 |

不适用：重复提交（会话 create 幂等不是本次范围）；空数据列表在现有 list 空态单测覆盖。

### 2.8 非目标

- 不升级到 `0.1.3-alpha.1`。
- 不把 CLI 改成只写本地 store、放弃 GUI 可见性。
- 不实现 `unarchiveSession` 上游缺失的能力。
- 不新增 `session_hide` 工具或 `dsh-session session hide` 动词。
- 不把 `session.history` 调试 curl 原样保留（README 改为带 cookie 的 `session/page` 或本地 inspect）。
- 不改 vibee / dsh-grok-bot 邻仓（只隔离对本仓 typecheck 的污染）。

---

## 3. 技术方案

### 3.1 架构 Before / After

```text
Before (0.1.1-rc.2):
  [web-app 进程]
    tool-session ──HTTP loopback──► host-apiproxy /api/session.*
    dsh-session CLI ──HTTP──► 同一 /api/session.*（无鉴权）

After (0.1.2-rc.1):
  [web-app 进程 = GUI 权威]
    tool-session ──in-process──► ctx.sessionController / ctx.workspaceController
                                 ctx.workspaceRegistry.list()
                                 live.snapshotEvents() / sessionPersistence.inspect()

  [dsh-session CLI 另进程]
    session-tool-local ──GET /?token=（redirect:manual，收 303 Set-Cookie）──POST /api/session/create 等──► GUI 进程
```

### 3.2 模块改造

| 模块 | 职责 | 改造说明 |
|---|---|---|
| session-tool-local session/workspace client | 对 GUI 权威的读写 | 拆成 InProcess* 与 AuthenticatedHttp*；删除 `AbstractApiClient` |
| SessionToolLocalService | 选传输、fence、wait/collect | 按 ASM-001 选择客户端；events→snapshotEvents；wait 不用 history |
| session-tool-cli | boot + 动词 | `composeProfile` 改 async，`await healProfilesModuleFallback({installAnchor})`；透传 token |
| tool-session | 工具 | `JsonValue` 改从 `dsh-util-values`；其余契约不动 |
| session-tool 契约包 | 类型 | 仅在 seq 品牌迫使改字段类型时最小改动（ASM-004） |
| env / standards | 启动与基线 | boot 版本、st 依赖、adapter-baseline 去掉 apiproxy、加入新包 |
| 测试 | 锁行为 | URL 从 `/api/session.create` 改为 `/api/session/create`；补 in-process 不 fetch；CallId→ToolCallId |

### 3.3 三段式定位清单

| 文件 | 稳定定位 | 搜索定位 | 行号 hint | 备注 |
|---|---|---|---|---|
| `packages/session-tool-local/src/session-client.ts` | `SESSION_WIRE_CODES` | `rg "SESSION_WIRE_CODES" packages/session-tool-local/src/session-client.ts` | L55 | 斜杠码映射到连字符码 |
| `packages/session-tool-local/src/session-client.ts` | `class SessionHttpClient` | `rg "class SessionHttpClient" packages/session-tool-local/src/session-client.ts` | L70 | 重写或并列 InProcess |
| `packages/session-tool-local/src/workspace-client.ts` | `class WorkspaceHttpClient` | `rg "class WorkspaceHttpClient" packages/session-tool-local/src/workspace-client.ts` | L58 | 同上 |
| `packages/session-tool-local/src/index.ts` | `class SessionToolLocalService` | `rg "class SessionToolLocalService" packages/session-tool-local/src/index.ts` | L134 | 选传输 |
| `packages/session-tool-local/src/index.ts` | `static inject` | `rg "static inject" packages/session-tool-local/src/index.ts` | L135 | 可能增 sessionController 可选 inject |
| `packages/session-tool-local/src/index.ts` | `live.events` | `rg "live.events" packages/session-tool-local/src/index.ts` | L857,L880,L976 | 改 snapshotEvents |
| `packages/session-tool-local/src/index.ts` | `assertNever` | `rg "assertNever" packages/session-tool-local/src/index.ts` | L16 | 改 dsh-util-values |
| `packages/session-tool-local/src/index.ts` | `unhide` | `rg "unarchiveSession" packages/session-tool-local/src/index.ts` | L489 | 保持 warn |
| `packages/session-tool-local/src/delegation-projection.ts` | `init:` | `rg "init:" packages/session-tool-local/src/delegation-projection.ts` | L115 | 加 header 参数 |
| `packages/session-tool-local/src/session-client.ts` | `readLastTurnEndReason` | `rg "readLastTurnEndReason" packages/session-tool-local/src/session-client.ts` | L249 | 去掉 history |
| `packages/tool-session/src/index.ts` | `JsonValue` | `rg "JsonValue" packages/tool-session/src/index.ts` | L17 | 改 import |
| `packages/session-tool-cli/src/index.ts` | `composeProfile` | `rg "export async function composeProfile" packages/session-tool-cli/src/index.ts` | L132 | 已改 async heal |
| `packages/session-tool-local/tests/service.spec.ts` | `CallId` | `rg "CallId" packages/session-tool-local/tests/service.spec.ts` | L14,L321 | ToolCallId |
| `packages/session-tool-local/tests/session-client.spec.ts` | `inspectEvents` | `rg "never posts history" packages/session-tool-local/tests/session-client.spec.ts` | L357 | wait 走 inspect，不再 posts history |
| `packages/session-tool-local/package.json` | `dsh-util-values` | `rg "dsh-util-values" packages/session-tool-local/package.json` | L37 | Task 6/7 已删 apiproxy；assertNever 改此包 |
| `env/boot.sh` | `dsh@0.1.2-rc.1` | `rg "dsh@0.1.2-rc.1" env/boot.sh` | L45 | 已钉 0.1.2-rc.1 |
| `env/profiles/st/package.json` | `dsh-base` | `rg "dsh-base" env/profiles/st/package.json` | L5 | 版本钉死 |
| `pnpm-workspace.yaml` | `minimumReleaseAgeExclude` | `rg "minimumReleaseAgeExclude" pnpm-workspace.yaml` | L10 | 改 exclude 列表；Task 18 后此文件已无 `0.1.1-rc.2`，故定位改用稳定 symbol |
| `standards/adapter-baseline.json` | `dsh-util-values` | `rg "dsh-util-values" standards/adapter-baseline.json` | L21 | Task 14 已去掉 apiproxy |
| `packages/tool-session/cordis.patch.yml` | `webUrl` | `rg "webUrl" packages/tool-session/cordis.patch.yml` | L20 | 可保留；默认 auto：webUrl 命中本进程则 in-process |
| `scripts/manual-test.sh` | `CLI_BIN` | `rg "CLI_BIN" scripts/manual-test.sh` | L18 | 矩阵入口 |
| `packages/session-tool-local/src/index.ts` | `archiveSession` | `rg "archiveSession" packages/session-tool-local/src/index.ts` | L464 | hide |

### 3.4 API / 数据 / 权限 / 路由影响

对外部产品 HTTP 无新公开面；插件仍只通过 `ctx.sessionTool` 与 CLI。数据仍是 `$DSH_HOME` 下 jsonl 会话与 `session-tool/marks.jsonl`。无前端路由表。鉴权变化只作用于跨进程打 `/api` 的 CLI（BR-004）。本节不开四行仪式表。

---

## 4. Phase 计划与任务详情

> Phase 依赖链：

```text
P0 基线隔离与钉版本 → P1 L1 编译修复 → P2 调用层双通道 → P3 测试重写 → P4 文档与真实场景
```

> 实现任务数 ≥ 8，状态板用同目录 `tasks.csv`。

### Phase 0: 基线隔离与钉版本

> 你在哪里：typecheck 已被隔离（Task 1 完成）；依赖仍是 0.1.1-rc.2。
> 做完之后：manifest 与 boot 指向 0.1.2-rc.1；`dsh-host-apiproxy` 仍留在 0.1.1-rc.2，直到 P2 删掉 import。

### Task 1: 隔离 SessionId 品牌类型解析

- **关联**：BR-007 / UF-005 / INV-006 / EVD-007 / ASM-005
- **前置任务**：无
- **风险等级**：P0

**为什么做**：不先隔离，升级后无法区分「新 L1」和「邻仓品牌噪音」。

**涉及文件与定位**：

- `tsconfig.json`：`paths`，`rg "paths" tsconfig.json`，L5
- `pnpm-workspace.yaml`：workspace 边界，`rg "packages" pnpm-workspace.yaml`，L1

**具体操作**：

1. 确认 14 条错误全部含 `dsh-grok-bot`（已在 1.3 验证）。
2. 删掉 `packages/*/node_modules` 后在本仓 `pnpm install`（已做）。`.npmrc` `package-import-method=copy` 只作额外防硬链。
3. 保存隔离前后日志。回归：`pnpm run typecheck` 输出不得含 `dsh-grok-bot`。

**验证**：`pnpm run typecheck 2>&1 | tee docs/dsh-0-1-2-upgrade/evidence/phase-0/typecheck-after-isolation.log` → 输出不含 `dsh-grok-bot`

**Evidence**：`evidence/phase-0/typecheck-after-isolation.log`

**注意事项**：禁止用 `as any` 或关掉 strict 来「修」品牌；禁止改邻仓代码。

### Task 2: 钉死 0.1.2-rc.1 依赖与 env 启动版本

- **关联**：BR-001 / UF-005 / EVD-007
- **前置任务**：1
- **风险等级**：P0

**为什么做**：插件编译面与网关运行面必须同一版本，否则品牌与模块必炸。

**涉及文件与定位**：

- `packages/*/package.json`：`rg "0.1.1-rc.2" packages/*/package.json`
- `env/boot.sh`：`rg "dsh@0.1.1-rc.2" env/boot.sh`，L45
- `env/profiles/st/package.json`：`rg "dsh-base" env/profiles/st/package.json`
- `pnpm-workspace.yaml`：`rg "0.1.1-rc.2" pnpm-workspace.yaml`
- `packages/tool-session/dsh.plugin.json`：`rg "0.1.1-rc.2" packages/tool-session/dsh.plugin.json`

**具体操作**：

1. 所有 `@deepseek-ai/dsh*`（**除** `dsh-host-apiproxy`）与需要升的 `cordis` 钉到 0.1.2-rc.1。
2. **不要删除** `dsh-host-apiproxy`（npm 无 0.1.2；客户端仍 import `AbstractApiClient`）。新增 `dsh-util-values`；`dsh-client-connection` / `dsh-api-session-controller` / `dsh-api-workspace-controller` 等到 Task 6/7 真正 import 时再加。
3. `env/boot.sh`、`env/setup.sh` 提示、st profile、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`、`packages/tool-session/dsh.plugin.json` 同步。
4. `pnpm install`（env/st 也要）。

**验证**：`rg "0.1.1-rc.2" env/boot.sh env/setup.sh pnpm-workspace.yaml packages/*/package.json packages/tool-session/dsh.plugin.json env/profiles/st/package.json` → 仅 `dsh-host-apiproxy` 行（文档历史叙述除外）

**Evidence**：`evidence/phase-0/pin.log`

**注意事项**：`minimumReleaseAgeExclude` 必须改成新版本否则 pnpm 可能装不上。host-descriptor 注释留 Task 14。

### Task 3: 执行 Phase 0 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：1;2

**验证**：`pnpm test` 在尚未改源码前仍应对 0.1.1 行为全绿或明确记录因 pin 导致的预期失败清单到 `evidence/phase-0/notes.md`

**Evidence**：`evidence/phase-0/`

### Phase 1: L1 编译修复

> 你在哪里：版本已钉，apiproxy 仍在，源码仍引用迁走的符号（`assertNever`、`CallId`、`init()`、`live.events`、heal 签名）。
> 做完之后：在 **仍保留 apiproxy** 的前提下 `pnpm run typecheck` 与 `pnpm run build` 通过。

### Task 4: 修复 L1 符号与函数签名

- **关联**：BR-001 / BR-007 / INV-001 / EVD-007 / ASM-004
- **前置任务**：3
- **风险等级**：P0

**为什么做**：这些是机械编译断裂，不修后面客户端改不了 typecheck。

**涉及文件与定位**：

- `packages/session-tool-local/src/index.ts`：`rg "assertNever|live\\.events" packages/session-tool-local/src/index.ts`
- `packages/tool-session/src/index.ts`：`rg "JsonValue" packages/tool-session/src/index.ts`
- `packages/session-tool-cli/src/index.ts`：`rg "healProfilesModuleFallback" packages/session-tool-cli/src/index.ts`
- `packages/session-tool-local/src/delegation-projection.ts`：`rg "init:" packages/session-tool-local/src/delegation-projection.ts`
- `packages/session-tool-local/tests/service.spec.ts`：`rg "CallId" packages/session-tool-local/tests/service.spec.ts`

**具体操作**：

1. `assertNever` / `JsonValue` 改从 `@deepseek-ai/dsh-util-values`。
2. `live.events` → `live.snapshotEvents()`。
3. `healProfilesModuleFallback({ installAnchor: installAnchor() })` 并让 `composeProfile`/`bootProfile` 链路 async。
4. `delegationProjectionDefinition.init` 改为接受 `header, inheritedEventCount`（可忽略参数，返回原 idle 状态）；测试与 `foldDelegationStatus` 同步。
5. `CallId` → `ToolCallId`。
6. 若 `seq` 品牌迫使契约改动，最小映射为 number 对外（ASM-004）。

**验证**：`pnpm run typecheck` → 0 error（apiproxy 仍在，不得在本任务删它）

**Evidence**：`evidence/phase-1/typecheck.log`

**注意事项**：不要在本任务重写 HTTP 客户端；只让符号对上。

### Task 5: 执行 Phase 1 回归验证

- **关联**：本 Phase 全部 BR
- **前置任务**：4

**验证**：`pnpm run typecheck && pnpm run build` → 成功；`node -e "import('./packages/session-tool-local/lib/index.js').then(()=>console.log('OK'))"` → 打印 OK（apiproxy 此时仍应可解析）

**Evidence**：`evidence/phase-1/`

### Phase 2: 调用层双通道

> 你在哪里：符号已对齐，客户端仍走 apiproxy。
> 做完之后：同进程零 loopback；CLI 带 303 cookie 打 GUI；wait/hide 按新面工作；apiproxy 依赖已删除。

### Task 6: 实现同进程 session/workspace 客户端

- **关联**：BR-002 / UF-001 / INV-003 / EVD-001
- **前置任务**：5
- **风险等级**：P0

**为什么做**：这是升级后 web 不 401、GUI 仍即时入账的干净路径。

**涉及文件与定位**：

- `packages/session-tool-local/src/session-client.ts`：`rg "class SessionHttpClient" packages/session-tool-local/src/session-client.ts`
- `packages/session-tool-local/src/workspace-client.ts`：`rg "class WorkspaceHttpClient" packages/session-tool-local/src/workspace-client.ts`

**具体操作**：

1. 新增 in-process 实现：create/prompt/cancel/rename/list 调 `sessionController`；workspace create/rename/delete 调 `workspaceController`；listWorkspaces 用 `workspaceRegistry.list()` + `archivedSessionIds`。
2. wait 的 running 位用 controller.list；turn/end 用 `sessions.get(id).snapshotEvents()` 或 persistence。
3. 对外错误码仍是连字符（`session-not-found` 等）。
4. 本模块不 import `dsh-host-apiproxy`。HTTP 文件可暂时仍引用，直到 Task 7。

**验证**：in-process 新文件 `rg "AbstractApiClient|dsh-host-apiproxy"` → 无命中

**Evidence**：`evidence/phase-2/in-process.log`

**注意事项**：CLI 不得走这条实现写自己的 store（BR-003）。`subagent.prompt` 同进程用 `ctx` 上的 SubagentRuntime 若可注入，否则保持现有 continuable 路径并在 evidence 注明。

### Task 7: 实现跨进程鉴权 HTTP 客户端

- **关联**：BR-003 / BR-004 / UF-002 / UF-006 / ASM-002 / ASM-003 / EVD-002 / EVD-008
- **前置任务**：5
- **风险等级**：P0

**为什么做**：CLI 必须继续把会话写进 GUI 进程。

**涉及文件与定位**：

- `packages/session-tool-local/src/session-client.ts`：`rg "doFetch|resolveBase" packages/session-tool-local/src/session-client.ts`
- `packages/session-tool-cli/src/index.ts`：`rg "bootProfile" packages/session-tool-cli/src/index.ts`

**具体操作**：

1. 按 ASM-003 实现 unary POST（路径斜杠、`args` 信封）。删除 `AbstractApiClient` / `dsh-host-apiproxy` 依赖。
2. 按 ASM-002 换 cookie：`GET /?token=` 使用 `redirect: 'manual'`，从 303 读取 `Set-Cookie`，后续 POST 带同一 Cookie（host:port 必须与 `webUrl` 一致）。401/403 → `SessionWebUnreachableError`。
3. 斜杠码映射（对外不变）：`session/not-found`→`session-not-found`，`session/title-invalid`→`title-invalid`，`workspace/not-found`→`workspace-not-found`，`workspace/name-conflict`→`workspace-name-conflict`，`workspace/invalid-path`→`workspace-invalid-path`。未列出的业务码不得吞成 `web-unreachable` 而不留 evidence。
4. 不再调用 `session.history` / `workspace.list`；list 用 `session/list`。workspace 列表优先读 `workspace/follow` 首帧 `baseline` 后 cancel。
5. CLI token 入口：环境变量 `DSH_LAUNCH_TOKEN` 必做，`--token` 可选；值来自 boot stdout `dsh web:` URL 的 `token` 查询参数。

**验证**：未认证 POST → `[web-unreachable]`；`session/not-found` 映射后仍是 `[session-not-found]`（单测即可；有 token 的集成放到 UF-002）

**Evidence**：`evidence/phase-2/http-auth.log`

**注意事项**：禁止读取 `.credentials.yaml` 手搓 HMAC。禁止 `fetch` 默认跟随 303。stream follow 只允许「读完 baseline 即 cancel」，wait 主路径仍用 unary list + 本地 inspect。

### Task 8: 接入传输选择器并改写 provider

- **关联**：BR-002 / BR-003 / ASM-001 / UF-001 / UF-002
- **前置任务**：6;7
- **风险等级**：P0

**为什么做**：同一套 `SessionToolLocalService` 既挂 web-app 又被 CLI boot。

**涉及文件与定位**：

- `packages/session-tool-local/src/index.ts`：`rg "new SessionHttpClient|new WorkspaceHttpClient" packages/session-tool-local/src/index.ts`

**具体操作**：

1. 实现 ASM-001 选择器；提供显式 `Config.transport: 'in-process' | 'http' | 'auto'`（默认 auto）。
2. in-process 但缺 controller：fail loud。
3. st overlay 保持 webUrl :3081 以便 auto 命中本进程；cli.patch 的 webUrl :3081 在 CLI 树中不命中本进程监听 → http。
4. 更新 Config schema（schemastery）。

**验证**：新增选择器用例（可先只跑该文件）：同进程不 fetch；http 模式才 fetch。不要用全量 `pnpm test` 当本任务闸门（旧 HTTP 单测仍断言点号路径）

**Evidence**：`evidence/phase-2/selector.log`

**注意事项**：默认值必须让「官方包 webUrl 3080 + 同进程 web」仍走 in-process，避免生产自环 401。

### Task 9: 改写 wait/collect 完成检测

- **关联**：BR-005 / UF-003 / EVD-003
- **前置任务**：8
- **风险等级**：P1

**为什么做**：`session.history` 已消失，现 settle 会编译/运行失败。

**涉及文件与定位**：

- `packages/session-tool-local/src/session-client.ts`：`rg "readLastTurnEndReason|sessions.history" packages/session-tool-local/src/session-client.ts`
- `packages/session-tool-local/src/index.ts`：`rg "delegationStatusOf|lastAssistantText" packages/session-tool-local/src/index.ts`

**具体操作**：

1. HTTP 模式：list.running + persistence.inspect 找最后 `turn/end`。
2. 同进程：list 或 live running + snapshotEvents。
3. collect 轮询继续用现 `COLLECT_POLL_MS`。

**验证**：针对 settle/wait 的新或改写用例通过。不要用全量 `pnpm test` 当本任务闸门

**Evidence**：`evidence/phase-2/wait.log`

**注意事项**：冷会话无 turn/end 仍报 idle（现语义）。

### Task 10: 改写 hide 归档路径

- **关联**：BR-008 / UF-004 / INV-007 / EVD-004
- **前置任务**：8
- **风险等级**：P2

**为什么做**：hide 已走 in-process registry；确认 0.1.2 仍有 `archiveSession`、仍无 unarchive。

**涉及文件与定位**：

- `packages/session-tool-local/src/index.ts`：`rg "archiveSession|unarchiveSession" packages/session-tool-local/src/index.ts`

**具体操作**：

1. 保持 hide→archiveSession best-effort。
2. unhide 保持缺方法 warn。
3. 单测锁住「缺 unarchive 不抛」。不要新增 CLI/工具 hide 动词。

**验证**：`pnpm exec vitest run packages/session-tool-local/tests/service.spec.ts -t "getVisibility / hide / unhide"`

**Evidence**：`evidence/phase-2/hide.log`

**注意事项**：不要为了 GUI 对称去调用不存在的 Remote。

### Task 11: 执行 Phase 2 回归验证

- **关联**：本 Phase 全部 BR/UF
- **前置任务**：6;7;8;9;10

**验证**：`rg "AbstractApiClient|dsh-host-apiproxy|session\\.history" packages --glob '*.ts' --glob '!**/tests/**' --glob '!**/lib/**'` → 无命中；`pnpm run typecheck` → 0 error。**不要**在本任务跑全量 `pnpm test`（点号路径断言留给 Task 12）

**Evidence**：`evidence/phase-2/`

### Phase 3: 测试重写

> 你在哪里：实现已切，旧 HTTP 单测仍断言点号路径。
> 做完之后：单测锁住新路径与选择器。

### Task 12: 重写网关客户端与服务层单测

- **关联**：INV-006 / UF-001 / UF-002 / UF-006 / EVD-007
- **前置任务**：11
- **风险等级**：P1

**为什么做**：旧断言 `/api/session.create`、`session.history`、`workspace.list` 会红。

**涉及文件与定位**：

- `packages/session-tool-local/tests/session-client.spec.ts`：`rg "session.history|/api/session" packages/session-tool-local/tests/session-client.spec.ts`
- `packages/session-tool-local/tests/workspace-client.spec.ts`：`rg "workspace.list" packages/session-tool-local/tests/workspace-client.spec.ts`
- `packages/session-tool-cli/tests/e2e.spec.ts`：`rg "DEAD_WEB_URL|webUrl" packages/session-tool-cli/tests/e2e.spec.ts`

**具体操作**：

1. HTTP 测试改为新路径与 401 映射。
2. 增加 in-process 测试（mock controller/registry）。
3. e2e 无网关仍全部 web-unreachable。
4. CallId 已在 Task 4 改过则此处只补行为。

**验证**：`pnpm test` → 通过数 ≥ 升级前 157，e2e 可仍 skip 或转绿

**Evidence**：`evidence/phase-3/unit.log`

**注意事项**：不要为了绿而删 fence 用例。

### Task 13: 执行 Phase 3 回归验证

- **关联**：INV-004 / INV-006
- **前置任务**：12

**验证**：`pnpm test && pnpm run typecheck && pnpm run build`

**Evidence**：`evidence/phase-3/`

### Phase 4: 文档与真实场景

> 你在哪里：单测绿，env/文档/预检未跑。
> 做完之后：预检 + 5.2 全套过，需求完成。

### Task 14: 更新文档与 adapter-baseline

- **关联**：BR-007 / UF-005 / EVD-007
- **前置任务**：13
- **风险等级**：P2

**为什么做**：README 里 `session.history` 调试 curl 会误导；baseline 仍列 apiproxy 会让 `standard:check` 失败或反过来不允许新触点。

**涉及文件与定位**：

- `README.md`：`rg "session.history" README.md`
- `standards/adapter-baseline.json`：`rg "dsh-host-apiproxy" standards/adapter-baseline.json`
- `standards/host-descriptor.json`：`rg "0.1.1-rc.2" standards/host-descriptor.json`
- `env/README.md`：`rg "0.1.1-rc.2" env/README.md`

**具体操作**：

1. 调试示例改为带 cookie 的新路径或删掉 history。
2. `node standards/validate.mjs --update-baseline`（仅在 import 集合已审过之后）。
3. host-descriptor 注释改为 0.1.2-rc.1。
4. `scripts/manual-test.sh` 读取 `DSH_LAUNCH_TOKEN`（或从 `dsh web:` 行解析 token）；在脚本头注明其 UF-001..008 **不是** 本 spec 的 UF-001..006。

**验证**：`pnpm run standard:check` → 通过

**Evidence**：`evidence/phase-4/standard-check.log`

**注意事项**：baseline 更新必须可 diff 审，禁止顺手加无关上游包。

### Task 15: 执行 spec 5.2 真实场景全套测试

- **关联**：全部用户可见 UF / EVD-001..008
- **前置任务**：14
- **风险等级**：P0

**为什么做**：单测绿 ≠ 网关能开、CLI 能进 GUI。

**涉及文件与定位**：

- `scripts/manual-test.sh`：`rg "CLI_BIN" scripts/manual-test.sh`
- `env/boot.sh`：`rg "dsh@" env/boot.sh`

**具体操作**：

1. 按 5.2 环境准备启动。
2. 逐行跑执行矩阵，落盘 evidence 路径。
3. GUI 截图 UF-005；CLI 日志 UF-002/003/006；UF-004 落单测日志；UF-001 用 agent 或等价同进程工具路径。

**验证**：5.2 执行矩阵全部行通过

**Evidence**：`evidence/UF-001/` 至 `evidence/UF-006/`

**注意事项**：无浏览器自动化时 UF-005 UI 用手动截图回填，命令与 pluginInventory 仍由本机 curl（带 cookie）完成。

### Task 16: 执行 Phase 4 回归验证

- **关联**：全部 BR/UF/INV
- **前置任务**：15

**验证**：`pnpm run typecheck && pnpm test && pnpm run build && pnpm run standard:check` + 5.4 清单

**Evidence**：`evidence/phase-4/`

---

### Phase 5: 跨仓污染防护与复原态复验（v0.3 补充波次）

> 你在哪里：Task 1-16 已完成且证据真实（12:51-13:10 产出）。此后邻仓 vibee 的一次 `pnpm install` 把本仓依赖改链回 rc.7，typecheck 37 error；已用 `rm -rf packages/*/node_modules && pnpm install` 复原，四件套复绿。
> 做完之后：污染有专用命令可检出（不再靠品牌错间接发现）；两处历史残留清掉；5.2 矩阵在复原后的依赖上重跑一遍确认未被打坏。
> **重要**：不要回退 Task 1-16 的状态。它们的 evidence 产出于污染之前，真实有效。

### Task 17: 新增跨仓依赖污染检测命令

- **关联**：BR-009 / ASM-005 / ASM-006 / EVD-009 / INV-005
- **前置任务**：无
- **风险等级**：P0

**为什么做**：ASM-005 只防 `dsh-grok-bot` 这一个名字，vibee 从旁边绕过去了；而且只有跑 typecheck 撞上品牌错才发现，反馈链太长。需要一条按「是否越出本仓」而不是按「黑名单仓名」判定的检查。

**涉及文件与定位**：

- `package.json`：`scripts`，`rg '"scripts"' package.json`，L8 起，新增 `deps:check` 条目
- 新建 `scripts/check-deps-isolation.mjs`（若偏好复用现有风格，可参照 `standards/validate.mjs` 的输出格式）

**具体操作**：

1. 脚本遍历 `packages/*/node_modules/@deepseek-ai/*` 与 `env/profiles/st/node_modules/@deepseek-ai/*`，对每一项 `fs.realpath` 后判断是否仍在本仓根目录内；越界即记为污染。
2. 同时校验解析到的 `package.json` 的 `version`：非 `0.1.2-rc.1` 的 `@deepseek-ai/dsh*` 记为版本漂移（`cordis` 等非 dsh 包不纳入版本判定）。
3. 有任一命中：打印每条越界项的「包名 → realpath 真实落点 → 版本」，给出复原命令 `rm -rf packages/*/node_modules && pnpm install`，以非 0 退出。
4. 全部干净：打印检查总数并 0 退出。
5. `package.json` 加 `"deps:check": "node scripts/check-deps-isolation.mjs"`。

**验证**：先在复原态跑 `pnpm run deps:check` → 0 退出；再人工制造一条越界软链（`ln -sfn ../../../../../vibee/plugin/node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.7_1dcde9bfc9fa0140c66648fbcb67b346/node_modules/@deepseek-ai/dsh-session packages/session-tool-local/node_modules/@deepseek-ai/dsh-session`）后重跑 → 必须非 0 退出且点名该条；最后 `rm -rf packages/*/node_modules && pnpm install` 复原并再确认 0 退出。三段输出都 tee 进 evidence。

**Evidence**：`evidence/phase-5/deps-check.log`

**注意事项**：判定口径必须是「realpath 是否越出本仓根」，**不要**写死 `vibee`/`grok` 黑名单——下一个邻仓换个名字就又漏了，这正是 ASM-005 栽跟头的地方。制造污染后务必复原，别把坏状态留在盘上。不要试图改邻仓 vibee 的 workspace 配置（见 2.8 非目标）。

### Task 18: 清理两处失效历史残留

- **关联**：BR-001 / INV-008 / EVD-010
- **前置任务**：无
- **风险等级**：P2

**为什么做**：apiproxy 已从源码删干净（`rg apiproxy packages/*/src` 无命中），但 workspace 里还给它留着 exclude 行；tsconfig 注释还写着旧版本号。都不影响运行，属于会误导下一个读代码的人的噪音。

**涉及文件与定位**：

- `pnpm-workspace.yaml`：`rg "dsh-host-apiproxy" pnpm-workspace.yaml`，L23，删除该行
- `tsconfig.base.json`：`rg "0.1.1-rc.2" tsconfig.base.json`，L4 注释，改为 `0.1.2-rc.1`

**具体操作**：

1. 删掉 `pnpm-workspace.yaml` 里 `minimumReleaseAgeExclude` 下的 `'@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2'` 整行；其余 exclude 项一律不动。
2. 把 `tsconfig.base.json` L4 注释里的 `(pinned 0.1.1-rc.2)` 改成 `(pinned 0.1.2-rc.1)`；编译选项本体不动。
3. 跑 `pnpm install --frozen-lockfile` 确认 lockfile 未被牵动。

**验证**：`rg "0.1.1-rc.2" pnpm-workspace.yaml tsconfig.base.json` → 无命中；`pnpm install --frozen-lockfile` → 不报 lockfile 不一致；`pnpm run typecheck && pnpm test` → 与改动前一致（0 error / 223 passed / 1 skipped）

**Evidence**：`evidence/phase-5/cleanup.log`

**注意事项**：`docs/` 下大量 `0.1.1-rc.2` 是历史叙述（记录"从 rc.2 升上来"这件事），**不要动**。只清 `pnpm-workspace.yaml` 和 `tsconfig.base.json` 这两处。

### Task 19: 复原态重跑 5.2 全套并收尾回归

- **关联**：全部 BR/UF/INV；EVD-011
- **前置任务**：17;18
- **风险等级**：P0

**为什么做**：Task 15 的 5.2 证据产出于污染发生之前，中间依赖被换过一轮又换回来，需要在当前这套复原后的依赖上确认结论仍成立。这是本波次「完成」的唯一标准。

**具体操作**：

1. 先 `pnpm run deps:check` 确认起点干净——污染态下跑 5.2 没有意义。
2. 按 5.1 跑命令级四件套 + 模块加载 + 无 apiproxy 扫描。
3. 按 5.2 执行矩阵逐行重跑 UF-001..006（含全部失败分支），证据落 `evidence/phase-5/`，不要覆盖 `evidence/UF-00x/` 下 Task 15 的原始证据。
4. 重跑 `python3 ~/.claude/skills/prd-workflow/scripts/validate_package.py docs/dsh-0-1-2-upgrade --repo .`。

**验证**：`pnpm run deps:check && pnpm run typecheck && pnpm test && pnpm run build && pnpm run standard:check` 全过 + 5.2 矩阵 10 行全过 + 5.4 清单逐条核销

**Evidence**：`evidence/phase-5/rerun-5.2.log` + `evidence/phase-5/ui.png`

**注意事项**：UF-005 需要真实起网关，`env/boot.sh` 会拒绝外仓占用 :3081（`env/gateway-id.sh`）——起不来先看是不是别的 DSH 占着口。无浏览器自动化时 UI 行按手动截图回填，与 Task 15 同口径。

---

## 5. 验收与 Review 协议

> **验收铁律：命令级验证（5.1）通过只是入场券，不是完成。** 用户可见的需求必须通过 5.2 真实场景全套测试才算完成。

### 5.1 命令级验证（入场券）

| 验证项 | 命令 | 期望 | Evidence |
|---|---|---|---|
| 依赖隔离 | `pnpm run deps:check` | 0 退出；无越出本仓的 `@deepseek-ai/*` 软链 | EVD-009 |
| typecheck | `pnpm run typecheck` | 0 error，无 `dsh-grok-bot`，无 `vibee` 路径 | EVD-007 |
| unit | `pnpm test` | ≥157 passed | EVD-007 |
| build | `pnpm run build` | 成功 | EVD-007 |
| 模块加载 | `node -e "import('./packages/session-tool-local/lib/index.js').then(()=>console.log('OK'))"` | 打印 OK | EVD-007 |
| 标准 | `pnpm run standard:check` | 通过 | EVD-007 |
| 无 apiproxy | `rg "dsh-host-apiproxy|AbstractApiClient" packages --glob '!**/lib/**'` | 无命中 | EVD-007 |

### 5.2 真实场景全套测试（Real-Run，完成的唯一标准）

**环境准备**：

| 项 | 值 |
|---|---|
| 启动命令 | `pnpm install && pnpm run build && sh env/setup.sh && sh env/boot.sh` |
| 访问入口 | 浏览器 `http://127.0.0.1:3081`；CLI `node packages/session-tool-cli/lib/bin.js --profile headless --patch env/cli.patch.yml` |
| 测试账号/数据 | `env/.env` 模型 key；从 boot stdout 的 `dsh web:` URL 取 `token` 查询参数写入 `DSH_LAUNCH_TOKEN`（插件约定）；workspace 目录 `env/manual-view` |
| 干净状态定义 | 停网关；可保留 marks.jsonl 或按矩阵自己打 stamp 前缀；口 3081 必须是本仓 `env/`（`env/gateway-id.sh`） |
| 可用测试工具 | CLI 直跑 + curl（带 cookie）+ 浏览器目视/截图（本会话无强制浏览器自动化；UI 行手动回填） |

**执行矩阵**：

| UF | 执行方式 | 操作来源 | 必须核对的点 | Evidence |
|---|---|---|---|---|
| UF-001 主路径 | CLI/agent + 浏览器 | 2.3 UF-001 成功主路径 | 侧栏出现会话；同进程无 401 | `evidence/UF-001/success.log` |
| UF-001 失败分支 控制器未注入 | unit/log | 2.3 对应分支 | fail loud 非静默自环 | `evidence/UF-001/fail-inject.log` |
| UF-002 主路径 | CLI + 浏览器 | 2.3 UF-002 | 同一 :3081 侧栏可见 | `evidence/UF-002/success.log` |
| UF-002 失败分支 无 token | CLI | 2.3 无 token | `[web-unreachable]` | `evidence/UF-002/fail-401.log` |
| UF-003 主路径 | CLI | 2.3 wait/collect | 终态不是抛错 | `evidence/UF-003/wait-success.log` |
| UF-003 失败分支 超时 | CLI | 2.3 超时 | timeout 且会话仍在 | `evidence/UF-003/collect-timeout.log` |
| UF-004 主路径 | unit（无 CLI/工具入口） | 2.3 hide/unhide | `getVisibility / hide / unhide` 绿；缺 unarchive 不抛 | `evidence/UF-004/hide.log` |
| UF-005 主路径 | boot + 浏览器 + curl | 2.3 启动 | UI 非白屏；fiberPhase=active | `evidence/UF-005/boot.log` + `evidence/UF-005/ui.png` |
| UF-005 失败分支 占口 | 已有文档化检查 | gateway-id | 拒绝外仓 | `evidence/UF-005/boot.log` |
| UF-006 主路径 | CLI + dead-web patch | 2.3 死网关 | web-unreachable | `evidence/UF-006/dead-web.log` |
**通过标准**：执行矩阵全部行通过且 evidence 齐全。任何一行失败 = 本需求未完成。

**v0.3 说明（Task 19 重跑口径）**：上表 10 行的 evidence/UF-001..006/ 是 Task 15 于 2026-09-05 12:51-13:09 产出的原始证据，真实有效，**不要覆盖**。Task 19 是在复原后的依赖上把**同样这 10 行**重跑一遍，结果一律写入 evidence/phase-5/（文件名见第 4 章 Task 19 的 Evidence 字段与 2.5 节 EVD-011）。污染检出本身不是新的用户场景，作为命令级入场券列在 5.1 的 `deps:check` 行。

> 审计提示：本节矩阵只登记**场景**及其canonical证据路径，不登记重跑副本——否则 Task 19 未开工时校验脚本会把「尚未产出」误报成「标完成却没证据」。Task 19 的 phase-5 证据不在 check 10 的自动审计范围内，需按 5.4 清单人工核对。

### 5.3 Evidence 目录结构与命名

```text
evidence/
  phase-{N}/
  UF-{xxx}/
```

- EVD ID 必须能在第 2.5 节找到。
- 截图命名：`UF-005-success.png` 或 `ui.png`。

### 5.4 Review 专项检查清单

- [ ] 生产代码无 `dsh-host-apiproxy` / `AbstractApiClient` / `session.history` 调用
- [ ] 同进程路径零 loopback fetch（可用一次运行时日志或 mock 计数证明）
- [ ] CLI 无 token 时不会写本地 store 冒充成功
- [ ] `pnpm run typecheck` 不含 `dsh-grok-bot`
- [ ] `env/boot.sh` 与 st profile 均为 `0.1.2-rc.1`
- [ ] 5.2 执行矩阵全部通过，evidence 齐全且与第 2.5 节 EVD 清单一致
- [ ] 2.3 节每条流程的入口接线已实现
- [ ] 所有 BR/UF/INV 可对照第 2 章核销
- [ ] `pnpm run deps:check` 通过；判定口径是 realpath 越界而非仓名黑名单（BR-009）
- [ ] `rg "0.1.1-rc.2" pnpm-workspace.yaml tsconfig.base.json` 无命中，且 `docs/` 历史叙述未被误改（INV-008）
- [ ] Task 15 原始证据 `evidence/UF-001/` ~ `evidence/UF-006/` 未被 Task 19 覆盖
- [ ] Task 19 的 phase-5 重跑证据齐全（`evidence/phase-5/deps-check.log`、`cleanup.log`、`rerun-5.2.log`、`ui.png`）——此项不在校验脚本自动审计范围，须人工核对
