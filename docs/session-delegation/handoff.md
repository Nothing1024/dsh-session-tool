# session-delegation Handoff

本文件是可直接交给 Codex / Claude / Generic Coding Agent 的交付 Prompt。你的目标不是"按文件改代码"，而是在不破坏业务不变量的前提下，完成 spec 定义的用户可见行为。

> 使用方式：把本文件完整粘贴给执行 Agent，或让 Agent 开工前先读本文件。
> 本文件只做入口导航，不复制 spec 内容；所有规则、任务、验收细节以 `spec.md` 为准。

## 1. 目标

把 DSH subagent 的"受控机制"（continuation manager 五机制）替换为**平级持久会话 + 标签/属性/约束元数据**方案：委派执行单元 = 普通会话（parentSession 血缘 + tags + delegation 状态投影 + 工具层约束），而 subagent 全部外部接口契约（工具名/schema/SubagentProvider/SubagentRun/workflow/ralph/GUI）保持零破坏（换引擎不换壳）；编排层（workflow）不动，仅预留 session 层给后期 flow 生态。

## 2. 资料清单

| 资料 | 路径 | 状态 | 用途 |
|---|---|---|---|
| Spec（唯一事实源） | `spec.md` | found | 业务合同、技术方案、任务详情、验收协议 |
| Tasks CSV（状态板） | `tasks.csv` | found | 22 任务状态跟踪 |
| Evidence 目录 | `evidence/` | found | 证据归档 |

缺失资料与假设：

- ASM-001: continuable 平级化默认选项 A（send_message/list_agents 走 session API），需 T-002 用户拍板
- ASM-002: 授权强度默认 workspace，Config 可配 creator/anyone，需 T-002 拍板
- ASM-003: 等待语义 = 单 session idle（不等子树），需 T-002 拍板
- ASM-005: 清理策略 = 标记+手动+超时三件套，超时任务可后置，需 T-002 拍板

## 3. 开工上下文

### 架构 Before / After

```text
Before:
模型 ─▶ tool-subagent ─▶ ctx.subagents ─▶ spawn/fork provider ─▶ continuation manager
      （Activation 三态 / ownedChildren / descriptor / drain / 精确父授权）─▶ 受控子会话

After:
模型 ─▶ tool-subagent ─▶ ctx.subagents ─▶ session provider（薄桥接）
      ─▶ durableCreate + prompt + wait + read ─▶ 平级持久会话
      （header 血缘/深度 + tags 分类 + delegation 投影状态 + 工具层约束）
生态契约全部不变；编排层 workflow 不动
```

### Phase 地图

```text
P0 基线与决策 → P1 上游核心小改 → P2 插件元数据设施 → P3 换引擎(不破坏生态)
                                                       │
P4 continuable 平级化 ◀────────────────────────────────┘
                       │
P5 真实场景验收 ◀──────┘
```

### 最关键规则（Top 10，全量见 spec.md 第 2 章）

- BR-001: 委派执行单元必须是持久平级会话，无运行时父子控制
- BR-002: 生态契约零破坏（工具名/schema/SubagentProvider/SubagentRun/RPC 形状/workflow/ralph）
- BR-003: 委派元数据（来源/模式/深度/状态）必须持久可查
- BR-004: 完成状态必须可从会话日志推导（投影纯函数），跨重启保持
- BR-005: 约束（授权强度/深度上限/可见性）在插件工具层执行，Config 决定
- BR-006: 上游改动零新增事件类型（归因走 MessageSource 合并扩展）
- INV-001: 会话日志 append-only、session/* 事件词汇不变
- INV-002/003: subagent 工具名/schema 与 RPC 响应形状不变
- INV-004: 旧 subagent 会话（含 subagent/descriptor 事件）只读兼容
- INV-005: workflow/ralph 的 provider 配置值与能力声明不变

### 禁止事项

- 不得改变 `SubagentResult`/`SubagentStopReason`/`SubagentRun` 形状（P3 Task 13 的 localAgent 语义变化是唯一例外，必须先 rg 全仓核查消费点并记录）
- 不得修改外部 4 后端（acp/codex/claude-code/sdk）代码
- 不得悄悄把 provider 能力声明（outputSchema）改为 false（ralph 会拒绝启动）
- 不得新增 session 事件类型（归因走 MessageSource 声明合并）
- 不得删除 `subagent/descriptor` 事件类型定义（旧日志 fold 依赖）
- 不得只跑单测就宣称完成——完成的唯一标准是 spec.md 第 5.2 节真实场景全套测试
- 不得在 P0 决策（T-002）定案前推进 P2-P4 任务

## 4. 开工前初始化

1. 通读 `spec.md` 第 1、2 章（事实基线 + 业务合同，重点读 2.3 节流程脚本）。
2. 预读 spec.md 第 5 章验收协议——先知道完成标准（5.2 真实场景测试），再开工。
3. 打开 `tasks.csv`，结合第 4 章找到第一条可执行任务。
4. 运行 `git status` 确认工作区状态（两处 git：`plugin/` 与 `env/session-tool-env/`）。
5. 运行基线命令：`cd env/session-tool-env && pnpm test`（344+ 例）与 `cd plugin && pnpm test`（67+ 例），与 spec 1.3 基线对比。

## 5. 核心执行循环

```text
WHILE 存在待开始或进行中的任务:
    1. 找到下一条前置任务已完成的任务
    2. 读 spec.md 第 4 章对应 Task 详情
    3. 回答：关联 BR/UF/INV/EVD 是什么？哪些行为不能变？
    4. 状态板更新为「进行中」
    5. 按三段式定位校验文件位置（symbol + rg anchor，行号仅 hint）
    6. 执行具体操作
    7. 运行验证命令并保存 evidence
    8. 通过 → 状态「已完成」；失败 → 排障，最多主动修复 3 次
    9. 仍失败 → 标记「已阻塞:{原因}」，继续不依赖该任务的后续任务
   10. Phase 回归通过后，输出 Phase summary，再进入下一 Phase
```

不要中途问"是否继续"。除非所有剩余任务都被阻塞，否则继续推进。**T-002 是唯一需要用户在场的任务**（4 个开放决策拍板），阻塞时先执行不依赖它的任务。

## 6. 排障顺序

1. 查 spec.md 第 4 章当前任务的注意事项。
2. 查 spec.md 第 2 章关联 BR/UF/INV。
3. 按错误类型定位：import、类型、权限、API、数据、UI 状态、测试 fixture。
4. 最多主动修复 3 次，仍失败则阻塞并继续其他任务。

## 7. 完成标准与汇报

所有任务「已完成」后：

1. 运行最终验收命令：两处 `pnpm test` 全量 + `pnpm typecheck`（命令级，入场券）。
2. **执行 spec.md 第 5.2 节真实场景全套测试**：按 5.2 执行矩阵逐行回放（headless 委派、协调者任务管理、GUI 可见/续写/停止、workflow/ralph、外部 4 后端、重启恢复），保存 evidence 到矩阵写明的路径。任何一行失败 = 未完成。
3. 重跑 `python3 /Users/dev/.agents/skills/prd-workflow/scripts/validate_package.py plugin/docs/session-delegation`——审计真实场景任务证据是否落盘（缺失 = FAIL）。
4. 对照 spec.md 第 2 章逐条核对 BR/UF/INV/EVD。
5. 对照 spec.md 第 5.4 节专项检查清单自检（含入口接线可达性）。
6. 输出最终总结：

```markdown
## 完成总结
- 完成范围：...
- 修改文件：...
- 通过的 BR/UF：...（真实场景执行矩阵 N/N 行通过）
- 未破坏的不变量：...
- Evidence：evidence/...
- 剩余风险：...
```
