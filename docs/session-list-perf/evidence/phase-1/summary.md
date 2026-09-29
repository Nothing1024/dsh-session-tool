# Phase 1 Summary

## 完成任务

- Task 2 列表行携带宿主委派投影
- Task 3 列表按需计算委派状态
- Task 4 工具与面板显式请求委派状态

## 验证命令（含出口检查）

| 命令 | 结果 | 日志 |
|---|---|---|
| `pnpm run typecheck` | 通过 | `phase-1/exit.log` |
| `pnpm --filter session-tool-local run test` | 215 passed（基线 210；新增 1 条客户端用例 + 4 条按需计算用例，旧实现下 4 条全部失败） | `phase-1/task-2.log`、`phase-1/task-3.log`、`phase-1/exit.log` |
| `pnpm --filter tool-session run test` | 17 passed | `phase-1/exit.log` |
| `pnpm vitest run packages/ui-session-tool/tests` | 19 passed | `phase-1/exit.log` |
| `pnpm run build` | 通过 | `phase-1/exit.log` |
| 3084 重启后 `listSessions` 计时 1 次 | 200 / 0.33s，71 行（ASM-001 达标，未做分段剖析） | `phase-1/early-timing.log` |

## 剩余风险

- 3084 原进程由另一个 omp 会话托管；本次停掉后改由 hub 进程 `gb-3084` 托管（persist）。
