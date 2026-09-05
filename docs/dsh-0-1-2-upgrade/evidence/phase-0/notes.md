# Phase 0 notes

## Task 1 — 品牌隔离（2026-09-05）

根因：`packages/session-tool` 与 `session-tool-local` 的 `@deepseek-ai/dsh-session` 符号链接指向邻仓 `dsh-grok-bot/plugin/node_modules/.pnpm/...`（另一套 peer hash `a4e4bb24`），与本仓 `a467074c` 物理副本的 `SessionId` `[BRAND]` 不互认。typecheck 14 条全部是这个。

真正起作用的步骤：

- 删除 `packages/*/node_modules` 后在本仓 `pnpm install`
- 四个包的 `dsh-session` 均指向本仓 `node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.1-rc.2_a467074c...`

`.npmrc` 的 `package-import-method=copy` 只是额外避免硬链，**不是**选中本仓 virtual store 的机制。回归：`pnpm run typecheck` 不得出现 `dsh-grok-bot`。

结果：

- `pnpm run typecheck` 0 error（见 `typecheck-after-isolation.log`）
- `pnpm test` 157 passed / 1 skipped（见 `test-baseline.log`）

## Task 2 — 钉 0.1.2-rc.1（2026-09-05）

`rg "0.1.1-rc.2"` 于 boot/setup/workspace/packages/*/package.json/dsh.plugin.json/st 仅剩 `dsh-host-apiproxy` 行。见 `pin.log`。

未加 `dsh-api-session-controller` / `dsh-api-workspace-controller` / `dsh-client-connection`（等 Task 6/7 import）。已加 `dsh-util-values@0.1.2-rc.1`；cordis 4.0.1 → 4.0.2（0.1.2-rc.1 peer）。

## Task 3 — pin 后 `pnpm test` 预期失败（2026-09-05）

命令：`pnpm test` → 退出非 0。日志：`test-after-pin.log`。

| 口径 | 数量 |
|---|---|
| 基线（Task 1，0.1.1-rc.2） | 157 passed / 1 skipped |
| pin 后（源码未改） | **15 failed / 142 passed / 1 skipped**（158 总） |
| 失败文件 | 仅 `packages/session-tool-local/tests/service.spec.ts`（58 中 15 红） |

其余 8 个文件全绿（marks / tools / collect / delegation-projection / workspace-client / session-client / workspace / cli marks）；e2e 仍 skip。

**不要当全绿。** 失败全部是 0.1.2-rc.1 L1 断裂（spec 1.3 / Task 4），不是 pin 写错：

| 根因（与 spec 1.3 对齐） | 症状 | 用例 |
|---|---|---|
| `SessionInspection.events` / `Session.events` getter 删除，改为 `snapshotEvents()` | `TypeError: inspection.events is not iterable`；`TypeError: events is not iterable`（`foldDelegationStatus(live.events)`） | read 5 条；list/collect/showDelegated 9 条 |
| `CallId` 改名为 `ToolCallId` | `TypeError: CallId is not a function` | `maps assistant and tool events onto their roles` |

15 条失败名：

1. reads a locally persisted transcript with incremental and capped reads
2. maps assistant and tool events onto their roles
3. rejects missing and foreign sessions; the CLI bypasses the fence
4. admits the creator to a child whose live header dropped parentSession (rc.7)
5. reloads remembered lineage so a creator can read after restart
6. picks up CLI-written lineage without a process restart
7. showDelegated false hides delegated rows unless explicitly requested
8. wait-all aggregates when every member is terminal
9. wait-n returns early and cancel-rest cancels the unfinished members
10. first-failed satisfies on the failed member
11. returns a timeout snapshot without error when the deadline passes
12. lists the caller tree for scope own, with hidden titles excluded by default
13. derives and filters by the delegation projection status
14. filters origin=delegated by kind:delegated (bare delegated is compat)
15. enforces the tree root fence and the all-scope gates

处置：不在本任务改源码。Task 4 修 `snapshotEvents` / `CallId`→`ToolCallId` / `assertNever` / `init(header, inheritedEventCount)` / heal 签名。
