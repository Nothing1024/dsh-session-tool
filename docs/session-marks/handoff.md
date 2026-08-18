# session-marks Handoff

本文件是可直接交给 Codex / Claude / Generic Coding Agent 的交付 Prompt。目标是完成 spec 定义的用户可见行为，而不是随意改文件。

> 使用方式：把本文件完整粘贴给执行 Agent，或让 Agent 开工前先读本文件。
> 本文件只做入口导航；规则、任务、验收以 `spec.md` 为准。

## 1. 目标

拆掉未发布的 `@deepseek-ai/dsh-session-tags` vendor，用 `$DSH_HOME/session-tool/marks.jsonl` 作为特殊会话种类位的真存储（vibee / hidden / delegated / 后期 Web）。工具参数仍叫 `tags`。本包不做 Web 页。

## 2. 资料清单

| 资料 | 路径（相对本文件所在目录） | 状态 | 用途 |
|---|---|---|---|
| Spec | `spec.md` | found | 唯一事实源 |
| Tasks CSV | `tasks.csv` | found | 状态板 |
| Evidence | `evidence/` | found | 证据归档 |

缺失资料与假设：见 spec 第 1.4 节 ASM-001～008。

## 3. 开工上下文

### 架构 Before / After

```text
Before: --tag → 网关丢弃（假成功）+ vendor session-tags + 扫日志 session/tags
After:  --tag → marks.jsonl 真写；~ 与 kind:hidden 双闸；无 vendor；listByKind 给后期 UI
```

### Phase 地图

```text
P0 基线 → P1 session-marks 库 → P2 接线 → P3 委派+查询 → P4 拆 vendor → P5 文档 → P6 5.2 真跑
```

### 最关键规则（Top 10，全量见 spec 第 2 章）

- BR-001: 禁止写官方 `session/tags` 事件
- BR-002: create/rename tags 必须落盘才算成功
- BR-003: 保留名 kind:vibee / kind:delegated / kind:hidden / ui:aux
- BR-004: 默认 list 藏 `~` 标题或 kind:hidden
- BR-006: 过滤只认标记表
- BR-007: 委派 create 自动 kind:delegated
- BR-008: listByKind/get + CLI marks 供后期 Web
- BR-009: 拆除 vendor
- INV-001: 无 tag 的官方会话路径不回归
- INV-003: 不改官方会话栏 / 不 registerTab

### 禁止事项

- 不得重写一套假的 `@deepseek-ai/dsh-session-tags`
- 不得往会话日志塞新 event type
- 不得实现 vibee 页或 better-sidebar Special tab
- 不得只跑单测宣称完成——必须过 spec 5.2
- 不得为了测试删除隐藏或 fence 逻辑
- 不得只按行号改（用 spec 3.3 symbol + rg）
- 不得把 parent/depth 存进标记表冒充 header

## 4. 开工前初始化

1. 通读 `spec.md` 第 1、2 章，重点 2.3。
2. 预读第 5 章，尤其 5.2 环境准备。
3. 打开 `tasks.csv`，从 Task 1 开始。
4. `git -C plugin/session-tool/plugin status`：已有 rc.7 未提交改动，本需求 diff 不要无故 revert。
5. 基线：`cd /Users/dev/workspace/dsh/plugin/session-tool/plugin && PATH=/Users/dev/.nvm/versions/node/v24.18.0/bin:$PATH pnpm test`

## 5. 核心执行循环

```text
WHILE 存在待开始或进行中的任务:
    按 spec 第 4 章执行 → 更新 tasks.csv → 存 evidence
    失败最多修 3 次，否则 已阻塞:原因
```

不要中途问是否继续。

## 6. 排障顺序

1. 当前 Task 注意事项
2. 第 2 章对应 BR/UF/INV
3. 假成功（没写 jsonl）、vendor 残留、DSH_HOME 指错 env/

## 7. 完成标准与汇报

1. `pnpm test && pnpm run build`
2. 执行 spec 5.2 全矩阵，evidence 落盘
3. `python3 /Users/dev/.agents/skills/prd-workflow/scripts/validate_package.py /Users/dev/workspace/dsh/plugin/session-tool/plugin/docs/session-marks`
4. 对照第 2 章与 5.4 核销
5. 输出完成总结（范围 / 文件 / UF 矩阵 / INV / evidence / 剩余风险）
