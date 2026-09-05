# dsh-0-1-2-upgrade Handoff（Phase 5 补充波次）

本文件是可直接交给 Coding Agent 的交付 Prompt。你的目标不是"按文件改代码"，而是在不破坏业务不变量的前提下，完成 spec 定义的行为。

> 使用方式：把本文件完整粘贴给执行 Agent，或让 Agent 开工前先读本文件。
> 本文件只做入口导航，不复制 spec 内容；所有规则、任务、验收细节以 `spec.md` 为准。
> 路径纪律：本文件内所有文件引用一律相对于**包目录** `docs/dsh-0-1-2-upgrade/`；命令里的路径相对于**仓库根** `session-tool/plugin/`。

## 1. 目标

Task 1-16（把插件从 DSH `0.1.1-rc.2` 升到 `0.1.2-rc.1`）已全部完成且证据真实；本波次只做 Phase 5 的三件事：把邻仓污染变成可自动检出的检查（Task 17）、清掉两处失效历史残留（Task 18）、在复原后的依赖上重跑 5.2 全套确认结论仍成立（Task 19）。

**范围边界**：只做 Task 17/18/19。不要回退、不要重做 Task 1-16。

## 1.1 执行环境假设

| 项 | 假设 |
|---|---|
| 执行环境 | generic（按最保守假设） |
| 浏览器工具 | 默认无浏览器自动化。5.2 的 UI 行（UF-005 的 `ui.png`）按「手动截图 + 回填」执行，与 Task 15 同口径；其余行用 CLI + curl 完成 |
| 长命令策略 | `pnpm install` / `pnpm run build` / 起网关可能较慢，注意超时，必要时拆分执行 |
| 验证命令输出 | 每条验证命令请写出期望输出摘要，失败时贴原文 |
| 平台注意 | macOS，**没有 `timeout` 命令**（实测 `command not found`）。需要限时请用 `perl -e 'alarm shift; exec @ARGV'` 或后台跑 + `kill`，别直接写 `timeout` |

## 2. 资料清单

| 资料 | 路径 | 状态 | 用途 |
|---|---|---|---|
| Spec（唯一事实源） | `spec.md` | found | 业务合同、技术方案、任务详情、验收协议 |
| Tasks CSV（状态板） | `tasks.csv` | found（19 行，1-16 已完成，17-19 待开始） | 任务状态跟踪 |
| Evidence 目录 | `evidence/` | found（phase-0..4 + UF-001..006 已有；`phase-5/` 已建好待填） | 证据归档 |

缺失资料与假设：

- ASM-006（已登记在 spec 1.4）：复发由**邻仓 vibee 的 `pnpm install`** 触发，本仓只能做检测 + 复原，不能单方面根治。

## 3. 开工上下文

### 事情经过（必读，否则会误判现状）

```text
12:51-13:09  Task 15/16 真实跑完 5.2 全套 → evidence/UF-001..006/ + phase-4/ 落盘
             （真实 boot 日志、gateway 拒绝外仓输出、222KB 截图、validator 0 FAIL/22 PASS）
    ~13:40   邻仓 vibee 跑了 pnpm install
             → 本仓 packages/*/node_modules/@deepseek-ai/* 出现 11 条软链指向 vibee 的 rc.7 副本
             → pnpm run typecheck 爆 37 error（Property '[BRAND]' is missing）
    ~13:43   rm -rf packages/*/node_modules && pnpm install → 复原
             → leak=0，14 个包全回 0.1.2-rc.1，四件套复绿
     当前    依赖处于复原态；Phase 5 三条任务待做
```

**结论：Task 1-16 的「已完成」是可信的，证据产出于污染之前。** 不要因为中间出过 37 个错就去回退它们。

### 根因（Task 17 的判定口径依据）

邻仓 ../../vibee/plugin/pnpm-workspace.yaml 把本仓 3 个包 glob 成自己的 workspace 成员，并用 `overrides` 把 `@deepseek-ai/*` 全量钉到 `0.1.0-rc.7`：

```text
packages:
  - ../../session-tool/plugin/packages/session-marks
  - ../../session-tool/plugin/packages/session-tool
  - ../../session-tool/plugin/packages/session-tool-local
overrides:
  '@deepseek-ai/dsh-session': 0.1.0-rc.7   # …全量 rc.7
```

受污染集合与 glob 集合精确吻合：`session-tool-local`(8 条) + `session-tool`(3 条)；`session-marks` 因零 `@deepseek-ai` 依赖（INV-005）无可污染项；未被 glob 的 `session-tool-cli` / `tool-session` 全程干净。`env/profiles/st` 也未被污染（170 个包全在本仓 store），所以 UF-005 的 boot 链路没被影响。

### Phase 地图

```text
P0..P4（Task 1-16，已完成，勿动）
   └→ P5 跨仓污染防护与复原态复验
        Task 17 检测命令 ─┐
        Task 18 清残留   ─┴→ Task 19 复原态重跑 5.2 + 收尾回归（最终验收）
```

### 最关键规则（全量见 spec.md 第 2 章）

- BR-009：`packages/*/node_modules/@deepseek-ai/*` 必须全部解析到本仓 `.pnpm` 且版本 `0.1.2-rc.1`；越界软链必须能被一条命令检出并明确报错。
- BR-001：宿主目标版本 `0.1.2-rc.1`（已核实这就是 npm `latest`，未落后）。
- INV-005：`session-marks` 零 `@deepseek-ai/*` 依赖。
- INV-008：清残留不得改变任何运行时行为。
- ASM-006：污染源是邻仓 install，本仓只做检测 + 复原。
- UF-005：env/boot.sh 起 :3081，UI 非白屏，`fiberPhase=active`。

### 禁止事项

- 不得回退或重做 Task 1-16；不得覆盖 `evidence/UF-001/` ~ `evidence/UF-006/` 下 Task 15 的原始证据（Task 19 的重跑一律写 `evidence/phase-5/`）。
- 不得在 Task 17 里写死 `vibee` / `grok` 仓名黑名单——必须按 realpath 是否越出本仓根判定。ASM-005 就是栽在口径太窄上。
- 不得修改邻仓 vibee 的任何文件（spec 2.8 非目标）。
- 不得清理 docs/ 下的 `0.1.1-rc.2`——那是历史叙述，只清仓库根的 pnpm-workspace.yaml 和 tsconfig.base.json 两处。
- 不得用 `as any` 或关 strict 来"修"品牌类型错误；出现品牌错说明依赖又被污染了，去跑复原命令。
- 不得只跑 typecheck/unit 就宣称完成——完成的唯一标准是 spec 5.2 全套（Task 19）。
- 不得把失败状态吞掉；制造污染验证后必须复原，别把坏状态留在盘上。

## 4. 开工前初始化

1. 通读 `spec.md` 第 1.3 节（标 v0.3 的 7 条事实）、第 2 章 BR-009 / INV-008、第 4 章 Phase 5 三条任务详情。
2. 预读 `spec.md` 第 5 章——先知道完成标准，再开工。
3. 打开 `tasks.csv`，确认 17/18/19 为「待开始」，1-16 为「已完成」。
4. `git status` 确认工作区状态（注意：本包尚未入库，工作区有大量未提交改动，属正常）。
5. 跑基线：`pnpm run typecheck && pnpm test`（期望 0 error / 223 passed / 1 skipped）。若此处就报品牌错，先跑 `rm -rf packages/*/node_modules && pnpm install` 复原再开工。

## 5. 核心执行循环

```text
WHILE 存在待开始或进行中的任务:
    1. 找到下一条前置任务已完成的任务（17 和 18 无前置，可并行；19 依赖 17;18）
    2. 读 spec.md 第 4 章对应 Task 详情
    3. 回答：关联 BR/UF/INV/EVD 是什么？哪些行为不能变？
    4. tasks.csv 状态更新为「进行中」
    5. 按三段式定位校验文件位置（行号只是 hint）
    6. 执行具体操作
    7. 运行验证命令并保存 evidence 到 evidence/phase-5/
    8. 通过 → 状态「已完成」；失败 → 排障，最多主动修复 3 次
    9. 仍失败 → 标记「已阻塞:{原因}」，继续不依赖该任务的后续任务
```

不要中途问"是否继续"。除非所有剩余任务都被阻塞，否则继续推进。

## 6. 排障顺序

1. 查 `spec.md` 第 4 章当前任务的注意事项。
2. 查 `spec.md` 第 2 章关联 BR/UF/INV。
3. 按错误类型定位：
   - **品牌类型错**（`Property '[BRAND]' is missing`）→ 依赖又被污染了，跑 `rm -rf packages/*/node_modules && pnpm install`。
   - **网关起不来** → 仓库根的 env/boot.sh 会拒绝外仓占用 :3081，看是不是别的 DSH 占着口（env/gateway-id.sh）。
   - **CLI 401** → 检查 `DSH_LAUNCH_TOKEN`，从 boot stdout 的 `dsh web:` URL 取 token（ASM-002）。
4. 最多主动修复 3 次，仍失败则阻塞并继续其他任务。

## 7. 完成标准与汇报

三条任务全部「已完成」后：

1. 命令级（入场券）：`pnpm run deps:check && pnpm run typecheck && pnpm test && pnpm run build && pnpm run standard:check`
2. **执行 spec.md 5.2 全套**（Task 19）：真实起网关，按 2.3 流程脚本逐条回放 UF-001..006 主路径与失败分支，证据落 `evidence/phase-5/`。任何一行失败 = 未完成。
3. 重跑 `python3 ~/.claude/skills/prd-workflow/scripts/validate_package.py docs/dsh-0-1-2-upgrade --repo .` → 期望 **0 FAIL / 1 WARN**。那条 WARN 是「真实场景任务（任务 15）不在最后一个 Phase（P5）」，**设计如此，不要去修**（理由见 spec 1.6）。除此之外出现任何 FAIL 或新 WARN 都要处理。
   注意：Task 19 产出的 `evidence/phase-5/` 证据**不在**该脚本的自动审计范围内（5.2 矩阵只登记 canonical 路径），必须按 5.4 清单人工核对齐全。
4. 对照 `spec.md` 第 2 章逐条核销 BR/UF/INV/EVD（新增 BR-009、INV-008、EVD-009/010/011）。
5. 对照 `spec.md` 5.4 专项清单自检（含新增 3 条）。
6. 按 spec 9.2 规范做**本地** commit：scope 用 `spec`/`tasks`/`evidence`，message 点名条目 ID。**不要 push**，也不要动 Task 1-16 已有的提交历史。
7. 输出最终总结：

```markdown
## 完成总结
- 完成范围：Task 17/18/19
- 修改文件：...
- 通过的 BR/UF：...（5.2 执行矩阵 N/N 行通过）
- 未破坏的不变量：INV-001..008
- Evidence：evidence/phase-5/...
- 剩余风险：邻仓 vibee 再次 install 仍会污染（ASM-006，本仓非目标），但 deps:check 现在能立刻检出
```