# Phase 0 决策记录（T-002）

> 记录时间：2026-08-12
> 用户拍板结论（全部 6 项，均采纳推荐默认值）；用户原话摘要：逐项选择 Recommended 选项（选项 A / workspace / 单 session idle + P1 / 三件套超时可后置 / JSON 约定+校验重试 / report 保留）。

## 决策清单

| 决策 ID | 议题 | 拍板结论 | 影响 |
|---|---|---|---|
| ASM-001 | continuable 平级化方案 | **选项 A**：send_message/list_agents 改走 session API，续写开放；P4 全量实施（Task 18/19/20 不降级） | P4 任务按全量实施执行 |
| ASM-002 | 授权强度默认值 | **`workspace`**（同 workspace 可续写），Config 可配 `creator`/`anyone` | BR-005 / Task 11 约束矩阵默认档 = workspace |
| ASM-003 | 等待语义 | **单 session idle（不等子树）**；`session.wait` 端点 **P1 实现** | Task 6 端点 + Task 10 工具 |
| ASM-005 | 清理策略 | **标记+手动+超时三件套**（tags `~archived` + hiddenPrefixes + 后台扫描），**超时扫描任务可后置**（不阻塞主线） | 本包实现标记+手动；超时扫描列为可选后置项 |
| ASM-004 | 结构化输出 | **JSON 约定 + 校验重试**（prompt 注入 ```json 包裹约定 + 结果解析校验 + 失败重试一次）；能力声明保持 `outputSchema: true` | Task 15 实现；ralph 回归 |
| report 去留 | tool-subagent-report | **默认保留**（子结果经会话日志已可达，但不退役，零生态风险） | 无删除任务；P4 不触碰 report |

## 对 spec 的同步修订（已写入 spec.md）

- 1.4 假设清单：ASM-001/002/003/004/005 结论列更新为最终值（本文件拍板结果）。
- 2.1 BR-005：默认值明确为 `workspace`。
- 2.3 UF-002 失败分支：授权不足 = Config=`creator` 场景（默认 workspace 不拒绝）。
- 任务拆分无变化（选项 A、report 保留 → 无需新增/降级任务）。
