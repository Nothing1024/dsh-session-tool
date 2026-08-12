# Phase 0 Baseline（T-001 校准记录）

> 记录时间：2026-08-12（会话执行时点）
> 校准命令与输出见本文件；相关日志 `env-test.log` / `plugin-test.log` / `apiproxy-test.log`。

## 1. git 基线

| 仓库 | HEAD | 说明 |
|---|---|---|
| `env/session-tool-env` | `534eb84` feat(apiproxy): durable session creation and tags-taking rename for the session-tool plugin | 与 spec ASM-006 预期一致（534eb84） |
| `plugin/` | `3765918` spec/handoff/overview: 体检补充——T-002 扩为 6 项决策、T-14 补深度校验落点与 fork 待勘察、1.3 补装配勘察事实、版本 0.2.0 | 最新 spec 修订 |
| `~/.dsh/source/current` | symlink → `staging-20260811T020137Z` | 与 spec 1.3 勘察一致 |

两处 git 工作区均 clean（`git status --short` 无输出）。

## 2. 测试基线

### 2.1 env worktree 全量

命令：`cd env/session-tool-env && pnpm test`（vitest run）

- Test Files: 733 passed / 15 failed（failed 全部为 `|thread-safe|` 项目）
- Tests: **12523 passed / 61 failed / 101 skipped**（另一次运行：12554 passed / 30 failed——失败数随运行波动）
- 基线判定：全部失败均位于 `|thread-safe|` 标签项目（hooks-claude/hooks-codex/sandbox-local/workflow-workerthread/typert），
  特征为真实子进程/OS 探针/worker 环境类测试（如 worker env 泄漏 `keys: 1`、sandbox-exec/landlock 探针、hook 子进程桥），
  属本机环境依赖的**不稳定用例**（两次运行失败数 30→61 波动），**与 session-delegation 改动无关**，且在本基线（未改任何代码）即失败。
- 记录：完整输出存 `env-test.log`（12523 passed 尾部）。
- **稳定基线口径**：`pnpm vitest run packages/host/apiproxy` = 344/344 全绿（spec 5.1「web 网关 344+」即此口径）。

### 2.2 env web 网关（spec 5.1 的 344+ 基线口径）

命令：`pnpm vitest run packages/host/apiproxy`

- Test Files: **20 passed (20)**
- Tests: **344 passed (344)**
- 与 spec「web 网关既有 344+ 测试」基线吻合 ✅

### 2.3 plugin 全量

命令：`cd plugin && pnpm test`（vitest run）

- Test Files: **6 passed (6)**
- Tests: **67 passed (67)**
- 与 spec「插件基线 67+ 例」吻合 ✅

## 3. subagent 源码基线核对（ASM-006）

- `~/.dsh/source/current`（staging-20260811T020137Z）与 env worktree 的 `packages/subagent` 存在**源码级差异**（非仅构建产物）：
  - env worktree `continuation.ts` = 1285 行（含 `SubagentInterruptAuthority` / `interrupt()` 扩展，worktree 基线 b7f909d 私有快照更新）；
  - staging `continuation.ts` = 1213 行（spec 3.3 行号 hint 基于此）。
- 结论：**改动以 env worktree 为准**（实际改造仓库，git 可提交），spec 3.3 行号仅 hint，定位一律 symbol + rg。
- 同步决策：无需把 staging 同步进 worktree —— worktree 是 534eb84 基线，含私有快照更新（interrupt 等），覆盖 spec 全部锚点 symbol。

## 4. spec 3.3 待勘察项补全（4 项）

| 文件 | 补全结果 |
|---|---|
| `packages/subagent/tool-subagent/src/index.ts` | `toolName: z.string().default('subagent')`（L78）→ 工具注册 `name: config.toolName ?? 'subagent'`（L247）；provider 未注册时延迟注册（L403） |
| `packages/subagent/tool-subagent-control/src/` | `src/index.ts` L27 `name: 'send_message'`（另有 `interrupt_agent`）；`src/list-agents.ts` L91 `name: 'list_agents'` |
| `packages/host/apiproxy/src/api/sessions.schema.ts` | `durableCreate` 请求 schema L117（zod，workspaceId/cwd 二选一 L127）、响应 schema L130 |
| `plugin/packages/session-tool-local/src/session-client.ts` | `SessionHttpClient.durableCreate` L87（内部 `invoke('session.durableCreate')` L95，调 `this.sessions.durableCreate` L96） |

## 5. 结论

- 基线可复现：env apiproxy 344 例全绿、plugin 67 例全绿；env 全量 12554 通过（30 例环境相关失败已记录原因）。
- 决策前置（T-002）未定案前不推进 P2-P4。
