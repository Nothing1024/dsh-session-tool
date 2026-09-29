# session-list-perf Handoff

本文件是可直接交给 Codex / Claude / Generic Coding Agent 的交付 Prompt。你的目标不是"按文件改代码"，而是在不破坏业务不变量的前提下，完成 spec 定义的用户可见行为。

> 使用方式：把本文件完整粘贴给执行 Agent，或让 Agent 开工前先读本文件。
> 本文件只做入口导航，不复制 spec 内容；所有规则、任务、验收细节以 `spec.md` 为准。
> 路径纪律：包内文件（spec.md、tasks.csv、evidence/）写相对包目录的路径；源码文件写相对仓库根的路径；禁止绝对路径。
> 所有命令都在**仓库根目录**执行；包目录相对仓库根写作 `docs/session-list-perf`。

## 1. 目标

让 `SessionToolLocalService.list()` 默认不再对每个冷会话整份读日志算委派状态：优先用宿主 list 行自带的 delegation 投影，只有调用方显式请求（或按委派状态过滤）时才计算，而且只算当页 / 过滤后的行；dsh-grok-bot 3084 上 `listSessions` 从约 8–10s 降到 1s 内，`session_list` 模型工具、会话协作面板、CLI 的输出不变。

## 1.1 执行环境假设

| 项 | 假设 |
|---|---|
| 执行环境 | generic |
| 浏览器工具 | 不需要交互式浏览器：5.2 用 curl / CLI / 测试命令，面板另有 `test:browser` 脚本（playwright-core 无头启动本机 Chrome） |
| 长命令策略 | 正常执行；`listSessions` 改前单次约 8–10s，curl 不要设过短超时 |
| 验证命令输出 | 每条验证命令保存完整输出到 spec 指定的 evidence 路径 |

## 2. 资料清单

| 资料 | 路径 | 状态 | 用途 |
|---|---|---|---|
| Spec（唯一事实源） | `spec.md` | found | 业务合同、技术方案、任务详情、验收协议 |
| Tasks CSV（状态板） | `tasks.csv` | found | 任务状态跟踪（唯一状态板） |
| Evidence 目录 | `evidence/` | found | 证据归档 |

包工具：下文 `$SPEC_SKILL` 指执行机上 spec-workflow skill 的目录（常见 `~/.claude/skills/spec-workflow` 或 `~/.agents/skills/spec-workflow`，按执行机实际查找，不要写死）。其中 scripts/board.py 看进度与可开工任务，scripts/validate_package.py 做包校验。执行机上没有该 skill 时：状态板直接读 tasks.csv；校验改为人工核对 5.2 执行矩阵的 evidence 路径逐条落盘，并在完成总结中注明"未跑校验脚本"。

缺失资料与假设：

- ASM-001: 目标耗时 < 1000ms，已于 2026-09-29 证实（3084 改后 0.41–0.51s）。
- 3081 的 launch token、cookie 只在执行时从 `env/logs/boot-manual.log` 的 `dsh web:` 行取，不入 evidence；具体命令见 spec 1.3。

## 3. 开工上下文

### 架构 Before / After

```text
Before: list() → 宿主 list（167ms，丢掉 projections）→ 每行 delegationStatusOf → 非 live 冷读整份日志（v3 还要迁移）≈ 8–10s
After:  list() → 宿主 list（行多带 delegationStatus）→ 过滤 → 未请求则不算；
        请求时只给当页 / 委派过滤候选取值：live 投影 → 宿主值 → 冷读兜底
        tool-session / ui-session-tool 显式传 includeDelegationStatus: true；CLI 不传（输出本就不含该字段）
```

### Phase 地图

```text
P0 基线（Task 1）──> P1 契约与实现（Task 2-4）──> P2 验收与收尾（Task 5-6）
```

### 最关键规则（全量见 spec.md 第 2 章）

- BR-001: 默认 list 不为任何行读冷日志，行不带 `delegationStatus`。
- BR-002: 需要时取值顺序 live 投影 → 宿主行值 → 冷读，前一级有值不走下一级。
- BR-003: `status` 为委派词汇时自动请求委派状态，过滤结果不变。
- BR-004: `session_list` 工具与会话协作面板显式请求；CLI 不传。
- BR-005: 宿主值只接受合法枚举，非法按无值处理。
- BR-006: 请求时只给当页行或委派过滤的候选行取值。
- UF-001: 3084 `listSessions` < 1s，行不丢失。
- UF-003: 会话协作面板每行委派状态标签与改前一致。
- INV-001: 工具与 CLI 输出形状不变。
- INV-003: 行字段、排序、分页不变。
- INV-004: `read()` / `collect` 行为不变。

### 禁止事项

- 不得为了通过测试删除现有业务分支。
- 不得绕过权限判断（list 的 scope / 访问围栏不改）。
- 不得只修改 mock/fixture，不修改真实路径。
- 不得把失败状态吞掉。
- 不得只按行号修改；必须用 symbol/rg anchor 校验（三段式定位见 spec.md 第 3.3 节）。
- 不得只实现函数而不接线：tool-session 和 ui-session-tool 两个入口都必须传开关，CLI 不改（接线清单见 spec.md 第 2.3 节）。
- 不得把开关加进面板 RPC 的请求字段白名单（由服务端固定打开）。
- 不得迁移或改写磁盘上的会话文件，不得改 `node_modules/@deepseek-ai/*`（非目标，见 spec.md 2.8）。
- 不得停掉未用 `dsh-rpc-who.sh` 确认身份的网关进程；3084 属于 `../../dsh-grok-bot/plugin/env/`，3081 属于本仓 `env/`。
- 不得把 `DSH_LAUNCH_TOKEN`、带 token 的 launch URL、cookie jar、3084 响应原文（含真实会话标题）写进 evidence；原文只放 `/tmp/session-list-perf/`。
- 重启 3084 会打断正在用 Bot 页面的用户，重启前先告知。
- 不得只跑单测就宣称完成——完成的唯一标准是 spec.md 第 5.2 节真实场景全套测试。

## 4. 开工前初始化（一次性）

1. 通读 `spec.md` 第 1、2 章（事实基线 + 业务合同，重点读 2.3 节流程脚本）。
2. 预读 spec.md 第 5 章验收协议——先知道完成标准（5.2 真实场景测试），再开工。
3. 看进度与可开工任务：`python3 $SPEC_SKILL/scripts/board.py docs/session-list-perf`（没有 skill 时直接读 tasks.csv）。
4. 结构闸门：`python3 $SPEC_SKILL/scripts/validate_package.py docs/session-list-perf` 必须 0 FAIL 才开工；有 FAIL 先按第 6.1 节修包，不许带病执行。
5. 运行 `git status` 确认工作区干净或已知状态（`env/logs/` 未跟踪属正常）。
6. 把 spec.md 顶部 `Status` 改为 `InProgress 执行中`（已是 InProgress 则跳过）。测试基线由 Task 1 出口检查采集，这里不重复跑。

## 5. 核心执行循环

```text
WHILE 存在可开工任务（前置已满足的待开始任务）:
    1. 取第一条可开工任务（有 skill 时用 board.py --next；前置任务以 tasks.csv 为准）
    2. tasks.csv 该行改「进行中」——立即写盘，不批量刷
    3. 锚点级读取：只读 spec.md 第 4 章该 Task 的段落 + 其关联 BR/UF/INV/EVD 的定义行，
       不重读全文；验证命令以该段落的「验证」行为准，CSV 那列只是摘要
    4. 回答：关联 BR/UF/INV/EVD 是什么？哪些行为不能变？
    5. 按三段式定位校验文件位置；行号漂移以 symbol + rg anchor 为准，漂移记入状态板备注列
    6. 执行具体操作
    7. 运行验证命令（任务验证行带「Phase 出口检查」的，一并执行），evidence 按任务要求落盘
    8. 通过 → 状态「已完成」；失败 → 排障，最多主动修复 3 次
    9. 仍失败 → 标记「已阻塞:{原因}」，继续不依赖该任务的后续任务
   10. commit：一个语义单元一次，message 格式 `<scope>: <做了什么>` 且点名条目 ID
       （如 `perf(session-tool-local): Task-3 list 按需计算委派状态 BR-001/BR-002/BR-006`；禁止"更新文档""phase N complete"）
   11. 一个 Phase 的最后一条任务完成 → 输出 Phase summary 到 evidence/phase-{N}/，再进入下一 Phase
```

不要中途问"是否继续"。除非所有剩余任务都被阻塞，否则继续推进。用户明确说本轮不做的任务标「暂缓:{原因}」，不算阻塞。

到达「执行 spec 5.2 真实场景全套测试」任务时：先核对 5.2 环境准备表（启动命令 / 访问入口 / 工具），按第 1.1 节执行环境假设执行；执行矩阵**逐行**回放，evidence 存到矩阵 Evidence 列写明的路径。全部回放完后，**先把该任务标「已完成」，再重跑校验脚本**——证据审计只在任务标完成后才触发；报证据缺失或空文件就改回「进行中」，补齐后再标。

## 6. 排障顺序

1. 查 spec.md 第 4 章当前任务的注意事项。
2. 查 spec.md 第 2 章关联 BR/UF/INV。
3. 按错误类型定位：import、类型、API、数据、测试 fixture。
4. 3084 计时没变：先确认已 `pnpm run build` 且 3084 已重启（`boot.sh` 发现已起会直接退出）。
5. 最多主动修复 3 次，仍失败则阻塞并继续其他任务。

### 6.1 发现 spec 本身有错

不许在代码里就地打补丁绕过。按顺序：改 spec 第 2 章（BR/UF/INV/EVD，Version +0.1，1.5 节记变更）→ 列出受影响任务 → tasks.csv 同步（受影响的「已完成」回退为「待开始」并注明原因）→ 刷新本文件第 3 节 → 重跑校验脚本 → 继续执行循环。

## 7. 收尾与汇报

tasks.csv 全部「已完成」或「暂缓」后（含 review 追加的 Phase-Fix），做一次收尾。5.2 已由最后 Phase 的真实场景任务执行过，收尾**不重跑 5.2 全套**：

1. 确认最后 Phase 的「执行 spec 5.2 真实场景全套测试」「执行最终回归验证」两条任务都是「已完成」。
2. 本轮做过 Phase-Fix 时：按 review-report.md 中对应 BUG 的复现步骤逐条复核，把结论回写 review-report 的问题清单与第 0 节结论（只复核这些项，不整包重审）。
3. 对照 spec.md 第 2 章逐条核对 BR/UF/INV/EVD，对照第 5.4 节专项检查清单自检（含入口接线可达性）。
4. 全部通过 → spec.md 顶部 `Status` 改为 `Done 已验收`；有未通过项 → 把对应任务改回「进行中」或「已阻塞:原因」，Status 保持 `InProgress`。
5. 重跑 `python3 $SPEC_SKILL/scripts/validate_package.py docs/session-list-perf` → 0 FAIL。
6. 执行期间 spec 第 4 章变过（含追加 Phase-Fix）→ 刷新本文件第 3 节 Phase 地图。
7. 输出最终总结：

```markdown
## 完成总结
- 完成范围：...
- 修改文件：...
- 通过的 BR/UF：...（真实场景执行矩阵 N/N 行通过）
- 未破坏的不变量：...
- Evidence：evidence/...
- 暂缓项：...（没有则写"无"）
- 剩余风险：...（ASM-001 是否达标；v3 冷读在 `session_list` 无过滤 / 面板首屏上仍慢，缓存为非目标）
```
