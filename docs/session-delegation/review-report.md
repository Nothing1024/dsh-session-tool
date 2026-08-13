# session-delegation Review Report

> Review mode: full | Date: 2026-08-13 | Reviewer: Cursor Grok 4.6
>
> 二次审查：对照 spec 5.2 原文重核补跑 evidence 正文，不以「文件已换」当作行通过。

## 0. 结论（二次审查）

| 项 | 结论 |
|---|---|
| 是否可发布 | Conditional |
| 阻塞问题数 | 0（无 P0） |
| 高风险问题数 | 0（无 P1）；新 P2 × 1（collect 跨进程状态） |
| Evidence 是否充分 | 原 Fail 行都有现场记录；其中 wait-n 的 cancel-rest、timeout 的「慢会话 running」未按 2.3 字面完成 |
| 最大风险 | `session_collect` 在 CLI/第二进程折本地 persistence，对 web 上仍在跑的会话会误报终态并跳过 cancel-rest |

**一句话**：主路径（委派、授权拒绝、fan-out 3、GUI 重启）是真跑过的。**Status=Done 仍略超前**：UF-007 的 cancel-rest / running 超时被产品行为挡住，证据里自己写了 workaround。引擎可继续用。

5.2 二次核销约 **8 Pass / 5 Partial / 0 Fail**（补跑收口曾报 11/13 Pass，偏松）。

### 二次审查新问题

#### BUG-007: 跨进程 collect 不看网关 running

**严重级别**：P2  
**关联**：BR-007 / UF-007 / spec 2.3 wait-n 与超时分支  
**复现步骤**：

1. `dsh web` 持有会话；另一进程 `bootProfile(headless)` 调 `ctx.sessionTool.collect`。
2. wait-n n=2 + cancel-rest：两个快会话已完成，慢会话 web `running=true`、history 仍 `assistant/chunk`。
3. collect 快照把慢会话标 `aborted`，`cancel-rest` 不再发 `session.cancel`；慢会话继续写。
4. 对 web `running=true` 的会话 `wait:all timeoutMs:3500`：3–4ms 返回 `satisfied:true` / `aborted`。

**期望**：谓词看直播状态；cancel-rest 取消未完成成员；running 超时返回 `satisfied:false`。  
**实际**：fold `inspectSession` 本地日志；与 web 不一致时误终态。同进程（web 里模型调 `session_collect`）走 `ctx.sessions.get`，这条路径未在本次复打。  
**证据**：`evidence/UF-007/n.log`、`timeout.log`。  
**建议**：collect 快照合并网关 `running`（或 `session.wait`）；本地无 `turn/end` 且 web running 时不得当终态。

#### BUG-008: spec/ASM-008 仍写 headless 自带 apiProxy

**严重级别**：P3  
**关联**：ASM-008 / spec 1.3 / UF-005  
**实际**：`dsh run --profile headless` 调 workflow 三 `agent()` → `apiProxy service is absent`。fan-out 3 是在 **web 进程**跑通的。  
**证据**：`evidence/UF-005/workflow.log` 对照节；`packages/bundle/headless/README.md`。  
**建议**：改 spec 1.3 / ASM-008 / 5.2 环境准备：headless = dsh-base + runner，无 Host；session provider / workflow 要 web composition。

仍为 Partial、本次未补：UF-001 子失败（ralph 代理 + 单测）；UF-007 wait-all（打在已完成会话上，6ms）。

---

## 0a. 补跑收口（同日，口径偏松）

| 项 | 当时结论 |
|---|---|
| 是否可发布 | Yes（按 5.2 已补的现场口径） |
| Evidence 是否充分 | 原 Fail 行已现场补齐；UF-001 子失败、UF-007 wait-all 仍为 Partial |
| 一句话 | F-001～F-008 已跑完。Status=Done 现在站得住。 |

补跑证据路径未改：`fail-create.log` / `fail-auth.log` / `workflow.log` / `n.log` / `timeout.log` / `restart.png`。二次审查认为其中 n.log / timeout.log **不能把整行标 Pass**。

---

## 0b. 上午审计原文（补跑前）

| 项 | 当时结论 |
|---|---|
| 是否可发布 | Conditional |
| 阻塞问题数 | 0（无 P0） |
| 高风险问题数 | 0（无 P1）；P2 × 2 |
| Evidence 是否充分 | 主路径充分，失败分支与部分指定场景不充分 |
| 最大风险 | spec Status 标 Done，但 5.2 多行用单测替代真实回放；状态板仍有 2 条「待开始」 |

**当时一句话**：引擎替换主路径是做了的，插件测试 107/107 全绿。按 spec 自己的完成标准**不能算做完**。

---

## 1. 输入资料

| 资料 | 路径 / 来源 | 状态 | 备注 |
|---|---|---|---|
| Spec | `plugin/docs/session-delegation/spec.md` | Found | Status: Done 完成；Version 0.2.0 |
| Tasks CSV | `plugin/docs/session-delegation/tasks.csv` | Found | 23 条；T-003、T-021 仍「待开始」 |
| Diff / 实现 | `plugin/` HEAD `3e8ecfe`；`env/session-tool-env` HEAD `60b16a1` | Found | 两仓均 clean |
| Evidence | `plugin/docs/session-delegation/evidence/` | Found | 37 个文件；含 UF-004 png |
| 包校验 | `validate_package.py` 2026-08-13 复跑 | Found | 0 FAIL / 0 WARN / 13 PASS（只查路径存在，不查证据质量） |
| 插件测试 | `cd plugin && pnpm test` 2026-08-13 复跑 | Found | 107/107 全绿 |
| env 全量测试 | 本次未复跑 | Evidence claimed | T-023 记录 23–34 失败，称为「环境基线」 |

缺失资料必须标注 `Evidence Missing` 或 `ASSUMED`。

---

## 2. L1 静态一致性

| 检查项 | 结果 | 证据 | 风险 |
|---|---|---|---|
| 所有 BR 有实现 | Pass | `subagent-session` 包存在；spawn/fork/inprocess 目录已删；`session.wait`/`durableCreate`/`delegationDepth` 在 apiproxy；插件 `wait`/`collect`/`delegation-projection`/`assertContinuationAllowed` 存在；bundle/base 5 处 `provider: session` | 无 |
| 所有 BR 有验证 | Partial | 主路径有真实日志；BR-005 creator 档、BR-007 timeout/cancel-rest 主要靠单测 | 边界规则未现场回放 |
| 所有 UF 有 evidence 文件 | Pass | 5.2 引用路径均存在（含 `success.png`/`restart.png`） | 文件在 ≠ 场景按脚本执行 |
| INV 未被破坏 | Pass（代码层） | `hasSubagentOwner`/`ContinuationManager` 源码无匹配；`subagent_fork` 工具名保留；descriptor 类型保留 | 文档仍写 continuation.ts |
| diff 未越界 | Pass | 未改外部 4 后端包；report 工具保留 | knip.json 仍登记已删的 `subagent-spawn` |
| 未删除权限/错误处理 | Pass | 插件 fence + `allowOthersToWrite` 仍在；网关 fail-loud | ASM-009 路径分裂仍在（设计如此） |
| 未只改 mock/fixture | Pass | 真实模型日志（7×8=56、9×9=81）+ GUI 截图 | 部分失败分支只有单测纪要 |

---

## 3. L2 技术验证

| 验证项 | 是否运行 | 结果 | Evidence | 问题 |
|---|---|---|---|---|
| typecheck（plugin） | 本次未单独跑 | ASSUMED | T-023 声称通过 | — |
| typecheck（env） | 本次未跑 | ASSUMED | T-023 声称通过 | — |
| lint | No | NA | — | 包未要求 lint 作为 5.1 入场券 |
| unit（plugin） | Yes（2026-08-13） | Pass | 8 files / 107 tests / 5.91s | 与 T-023 口径一致 |
| unit（env 全量） | No（本次） | Fail vs spec 5.1 字面 | `evidence/phase-5/final-acceptance.log`：12464 例中 23 failed | spec 5.1 写 `pnpm test`「344+ 例全绿」；实际全量从未全绿，P0 基线已 30–61 失败 |
| integration / e2e | Evidence | Partial | UF-001/002/005 真实模型；workflow fan-out 3 走单测 | 见 L3 |
| build | 本次未跑 | ASSUMED | — | — |
| 包校验 | Yes | Pass | 0 FAIL / 13 PASS | 闸门不检查 CSV 是否全部已完成，也不检查日志是否为真实回放 |
| migration/benchmark | NA | NA | — | — |

---

## 4. L3 用户路径复现

> 本次 **没有** 重新启动 `dsh web` / headless agent 做现场回放。下表是对已归档 evidence 对照 spec 2.3 / 5.2 的核销。未现场复跑记为证据审计，不是新的 Real-Run。

| UF | 复现步骤 | 期望 | 实际 | 结果 | Evidence |
|---|---|---|---|---|---|
| UF-001 主路径 | 协调者 `subagent` 委派 7×8 | 工具返回结果；子会话持久；coordinator 归因 | 真实模型「7×8 等于 56。」；source=coordinator | Pass | `evidence/UF-001/success.log` |
| UF-001 创建失败 | headless + web 不可达 | `web-unreachable`、零会话残留 | 日志写「由 RPC 单测覆盖」，无现场不可达回放 | Fail | `evidence/UF-001/fail-create.log` |
| UF-001 子失败 | 子 turn/end=error | `stopReason: error`、日志保留现场 | ralph 结构化失败作代理 + run.ts 单测 | Partial | `evidence/UF-001/fail-child.log` |
| UF-002 主路径 | `send_message` + `list_agents` | 续写入子会话；complete 词汇 | 同一次 e2e：9×9=81；list_agents `[complete]` | Pass | `evidence/UF-002/success.log` |
| UF-002 授权失败 | Config=`creator` + 非创建者 | 投递被拒、日志无新消息 | 仅 `service.spec.ts` 矩阵 | Fail | `evidence/UF-002/fail-auth.log` |
| UF-003 | `session_list` + `session_wait` | 清单 + wait 完成 | wait 打在已 completed 会话上（立即返回） | Pass | `evidence/UF-003/success.log` |
| UF-004 主路径 | 浏览器侧边栏→打开→发送 | 可见、可续写、console 无应用错误 | `success.png` 为真实 DSH GUI（e2e-委派任务、1+1/2+2） | Pass | `evidence/UF-004/success.png` + `console.log` |
| UF-004 重启 | 停进程→重启→会话仍在 | 截图证明 GUI 恢复 | `restart.png` 视觉上接近空白骨架；文字日志称 `session.list` 返回 2 条 | Partial | `evidence/UF-004/restart.png` |
| UF-005 | workflow fan-out 3 + ralph structured | 3 子 agent 收集；结构化可解析 | 真实 workflow 只有 **1** 个 agent；ralph 主路径单测、失败分支真实 | Partial | `evidence/UF-005/workflow.log` |
| UF-006 | 外部 4 后端装配 | 行为不变 | spec 允许装配测试；acp/codex/claude/sdk 单测计数 | Pass | `evidence/UF-006/backends.log` |
| UF-007 wait-all | 3 个会话全部终态后聚合 | wait-all 阻塞至完成 | collect 6ms，打在已完成会话上 | Partial | `evidence/UF-007/all.log` |
| UF-007 wait-n | n=2 + cancel-rest | 提前返回并取消其余 | 真实 n=1、1ms；cancel-rest 单测 | Partial | `evidence/UF-007/n.log` |
| UF-007 超时 | 慢会话超 `timeout_ms` | `satisfied:false` 快照、不报错 | 仅 collect.spec 单测 | Fail | `evidence/UF-007/timeout.log` |

### 入口接线与交互完整性（对照 spec 2.3）

| UF | 入口真实可达 | loading/禁用态 | 错误提示 | 成功反馈 | 结果 |
|---|---|---|---|---|---|
| UF-001 | Yes（`subagent` 工具） | NA（模型工具） | 失败分支未现场 | Yes（结果文本） | Pass 主路径 |
| UF-002 | Yes（`send_message`/`list_agents`） | NA | 授权失败未现场 | Yes | Pass 主路径 |
| UF-003 | Yes（`session_list`/`session_wait`） | wait 未 demonstrably 阻塞 | 空列表有观察 | Yes | Pass |
| UF-004 | Yes（GUI 侧边栏） | 截图未见 loading/禁用 | console 无应用错误 | Yes（流式回复） | Pass 主路径 |
| UF-005 | Yes（workflow 工具） | NA | ralph 失败真实 | 非 fan-out 3 | Partial |
| UF-006 | Yes（装配/单测） | NA | spec 失败分支 N/A | 单测 | Pass |
| UF-007 | Yes（`session_collect`） | 未演示等待中状态 | 超时未现场 | 已完成会话上的即时 satisfied | Partial |

---

## 5. L4 反向 / 破坏性验证

| 场景 | 操作 | 期望 | 实际 | 结果 | 风险 |
|---|---|---|---|---|---|
| 权限不足 | Config=`creator` 非创建者 prompt | 拒绝且无新消息 | 仅单测 | Fail（未现场） | 默认档是 workspace，线上默认路径风险低 |
| 非法输入 | 空 title/tags、超限 depth | 预检/拒绝 | 插件单测覆盖 | Pass（单测） | — |
| 网络失败 | web 不可达 | `web-unreachable` | 插件 e2e fixture 钉死 3999；UF-001 创建失败未现场 | Partial | headless 无网关时的工具报错未按 5.2 回放 |
| 重复提交 | 并发写同一 session | 未定义 / 队列 | T17 边界仍在（进程内锁） | Pass（已文档化） | 跨进程并发写仍会损坏 seq |
| 旧数据兼容 | 带 `subagent/descriptor` 的旧日志 | 只读不损坏 | list-children 62 例；descriptor.ts 保留 | Pass | `types.ts` 注释仍指向已删 `continuation.ts` |

---

## 6. 问题清单

| ID | 严重级别 | 标题 | 关联 BR/UF/INV | 复现步骤 | 期望 | 实际 | 证据 | 建议修复 |
|---|---|---|---|---|---|---|---|---|
| BUG-001 | P2 | 5.2 多行用单测替代真实回放后标完成 | UF-001/002/005/007；spec 5.2 | 对照 5.2 矩阵与各 `fail-*.log`/`timeout.log`/`n.log`/`workflow.log` | 每行从真实入口回放 | 失败分支与 fan-out 3 / cancel-rest / timeout 为单测纪要 | 见各 evidence 文件「验证方式」节 | 按 5.2 补跑缺口，或把 spec 5.2 降级为「主路径真实 + 失败分支单测」并改 Status |
| BUG-002 | P2 | UF-004 重启截图不能证明 GUI 恢复 | UF-004；EVD-003；BR-004 | 打开 `evidence/UF-004/restart.png` | 侧边栏可见委派会话、transcript 完整 | 截图接近空白布局；恢复只写在 console.log | `restart.png` 188KB vs `success.png` 385KB | 重截重启后侧边栏+打开会话；不要只靠 RPC list |
| BUG-003 | P3 | 状态板与 Done 声明矛盾 | T-003；T-021；T-023 | 读 `tasks.csv` 与 `evidence/phase-5/final-acceptance.log` | 23 条均为已完成 | T-003、T-021 为「待开始」；T-023 却写「全部已完成」 | `tasks.csv` L4/L22；`final-acceptance.log` L21 | 补标 T-021（已有 phase4-regression.log）或补跑 T-003 |
| BUG-004 | P3 | spec 5.1「env 全量全绿」与事实不符 | spec 5.1；EVD-006 | 读 P0 baseline 与 T-023 | `pnpm test` 全绿 | 基线即 30–61 失败；收尾仍 23–34 失败 | `evidence/phase-0/baseline.md`；`final-acceptance.log` | 5.1 改为 apiproxy 稳定口径 + 全量允许环境失败名单 |
| BUG-005 | P3 | handoff.md 未随 Done 刷新 | handoff 开工上下文 | 读 `handoff.md` §2 | 决策已拍板、Status Done | 仍写 ASM 需 T-002 拍板 | `handoff.md` L22-30 | 刷新假设清单与完成状态 |
| BUG-006 | P3 | 退役后文档/配置残留 | INV；T-020 | `rg ContinuationManager`；读 `types.ts`、knip、subsystems/subagent.md | 无死引用 | 源码无 ContinuationManager；docs/knip/注释仍提 spawn 与 continuation.ts | `packages/subagent/subagent/src/types.ts` L6；`knip.json`；`docs/subsystems/subagent.md` | 清注释、knip 条目、子系统文档 |

### BUG-001: 5.2 多行用单测替代真实回放后标完成

**严重级别**：P2  
**关联**：UF-001 失败分支 / UF-002 授权 / UF-005 fan-out 3 / UF-007 timeout·cancel-rest / spec 5.2 / 第 7 节 Done Definition  
**复现步骤**：

1. 打开 spec 5.2 执行矩阵，要求「headless + curl / 浏览器 MCP / 真实回放」。
2. 打开对应 evidence：`fail-create.log`、`fail-auth.log`、`timeout.log`、`n.log`、`workflow.log`。
3. 各文件「验证方式」写明单测覆盖或 n=1 / 1 个 agent。

**期望结果**：5.2 每一行从真实入口执行；失败分支不是单元测试纪要。  
**实际结果**：validate_package.py 因文件存在而 PASS；T-022/T-023 标已完成。  
**证据**：上述 log 文件正文。  
**建议修复**：补跑或降级 spec 5.2 口径后改 Status。

### BUG-002: UF-004 重启截图不能证明 GUI 恢复

**严重级别**：P2  
**关联**：UF-004 重启分支 / EVD-003 / BR-004 / EVD-008  
**复现步骤**：并排打开 `success.png` 与 `restart.png`。  
**期望结果**：重启后侧边栏仍有委派会话，打开后 transcript 完整。  
**实际结果**：`success.png` 可核销主路径；`restart.png` 看不到会话内容。console.log 用 `session.list` 证明持久化，不能替代 GUI 截图。  
**证据**：`evidence/UF-004/restart.png`。  
**建议修复**：重启后重截侧边栏+会话视图。

### BUG-003: 状态板与 Done 声明矛盾

**严重级别**：P3  
**关联**：T-003 / T-021 / T-023  
**复现步骤**：`tasks.csv` 过滤「待开始」。  
**期望结果**：Status=Done 时 23 条已完成。  
**实际结果**：T-003、T-021 待开始；T-021 其实已有 `phase-4/phase4-regression.log`。  
**证据**：`tasks.csv`；`evidence/phase-5/final-acceptance.log` L21。  
**建议修复**：更新 CSV；T-003 补一次基线复跑记录或注明 T-002 无代码故与 T-001 合并。

---

## 7. 发布建议

- **引擎替换可以合入/继续用**：one-shot 与 continuable 已走 `subagent-session`；工具名/schema 保留；GUI 主路径有真实截图；插件 107 例今天全绿。
- **PRD 不应维持 Status = Done**，除非：补跑 BUG-001 缺口，或显式改 5.2「完成的唯一标准」。
- 必须先修复（若要坚持 Done）：BUG-001、BUG-002。
- 可延期：BUG-003～006（文档/状态板/基线口径）。
- 需要补充 evidence：UF-001 网关不可达现场；UF-002 creator 档现场；UF-005 fan-out 3 现场；UF-007 n=2+cancel-rest 与 timeout 现场；UF-004 重启 GUI 截图。
