# Phase 1 notes

## Task 4 — L1 符号与函数签名（2026-09-05）

按 spec Task 4 机械对齐 0.1.2-rc.1，**未**重写 HTTP 客户端、**未**删除 `dsh-host-apiproxy`。

| 项 | 处置 |
|---|---|
| `assertNever` / `JsonValue` | 改从 `@deepseek-ai/dsh-util-values`（peer 已在 Task 2 钉 0.1.2-rc.1） |
| `live.events` | `live.snapshotEvents()`；live `SessionInspection` 补 `inheritedEventCount` |
| `healProfilesModuleFallback` | `await healProfilesModuleFallback({ installAnchor: installAnchor() })`；`composeProfile`/`bootProfile` async |
| `delegationProjectionDefinition.init` | `(header, inheritedEventCount)`，忽略参数仍返回 idle；测试与 `foldDelegationStatus` 同步 |
| `CallId` | `ToolCallId` |
| `seq` 品牌（ASM-004） | 对外 `number`：`messageRow.seq` / `lastAssistantSeq` 用 `Number(event.seq)` |

额外 typecheck 断裂（apiproxy 仍 0.1.1-rc.2）：`session.list` 的 `projections.values` 走 0.1.1 `SessionProjectionMap`，与钉死的 0.1.2 `dsh-session-title` 不是同一份表，`values.title` 不再有类型。`listRowTitle(unknown)` 从 wire 读 string title，不改 RPC。

验证：`pnpm run typecheck` → 0 error。日志：`typecheck.log`。

## Task 5 — Phase 1 回归（2026-09-05）

| 命令 | 结果 | 日志 |
|---|---|---|
| `pnpm run typecheck` | 0 error | `typecheck.log` |
| `pnpm run build` | 5 包 tsdown 成功 | `build.log` |
| `node -e "import('./packages/session-tool-local/lib/index.js').then(()=>console.log('OK'))"` | 打印 `OK` | `import.log` |
| apiproxy 从 `session-tool-local` 解析 | `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 仍可 resolve | `import.log` |
