# session-tool

DSH（DeepSeek Harness）会话管理插件项目：创建 / 读取 / 写入 / 列出 / 重命名会话，通过 **agent 工具** 与 **`dsh-session` CLI** 两个操作面暴露，复用 DSH 既有会话栈（事件溯源 Session log、session persistence、title/tags 服务），**零新增事件类型**。

方法论参考 OpenAI Codex CLI 的会话模型（可寻址 id、append-only transcript、fork 血缘、列表式恢复）——**只借鉴思想，不封装、不依赖第三方运行时**。

## 形态

```
session-tool/
├── docs/design.md            # 完整设计文档（含实施记录）
├── docs/research.md          # 7 家第三方 CLI 会话模型调研
├── packages/
│   ├── session-tool/         # Service Definition：ctx.sessionTool 契约 + 错误类
│   ├── session-tool-local/   # Provider：基于 DSH 会话栈实现（fence/冷恢复/scope 门槛）
│   ├── tool-session/         # bundle：5 个 session_* 工具 + cordis.patch.yml
│   └── session-tool-cli/     # bin：dsh-session（辅助 CLI，薄壳）
└── env/                          # 仓内 DSH_HOME（boot.sh）
```

## 安装 / 调试

仓内 `env/` 就是 `DSH_HOME`，见 `env/README.md`。不要再找 worktree 或 LAN skill。

```sh
pnpm install && pnpm run build
sh env/setup.sh
sh env/boot.sh
```

起来之后 agent 可用 `session_*` 工具。hiddenPrefixes 等在 bundle 的 `cordis.patch.yml`。

## CLI 用法

```sh
dsh-session session create [--title T] [--tag T] [--parent ID] [--workspace PATH] [--profile <name>]
dsh-session session read <session_id> [--since-seq N] [--max-blocks N]
dsh-session session write <session_id> <text...>
dsh-session session list [--scope own|tree|all] [--root ID] [--tag T] [--title T] [--status live|idle] [--include-hidden] [--cursor C] [--limit N]
dsh-session session rename <session_id> [--title T] [--tag T]
dsh-session workspace add <path> [--title T] [--profile <name>]
dsh-session workspace list [--profile <name>]
dsh-session workspace rename <workspace_id> --title <title> [--profile <name>]
dsh-session workspace delete <workspace_id> [--profile <name>]
```

- 默认 boot `headless` profile（自动初始化），`--profile` 可覆盖；安装锚点可用 `DSH_SESSION_ANCHOR` 覆盖；
- 默认人类可读输出；`--format json` 输出与工具 output 同构的 JSON（workspace 子命令为 CLI 自有 JSON 投影）；
- CLI 是人工身份（`kind: cli`），豁免 owner fence；`own` scope 仅 agent 可用。

## Workspace（围绕 web 进程）

workspace 注册表归 **web 进程**（`dsh web`）所有；本插件的 workspace 操作全部走 web 网关的 HTTP carrier（`POST /api/workspace.*`，JSON envelope），插件进程内不持有任何 workspace 状态：

- `session_create` 的 `workspace_path` / CLI `session create --workspace <path>`：先经网关幂等注册（同 canonical path 复用），再以网关返回的 **canonical path 作为新会话 header 的 `cwd`** 建会话——持久化按 cwd 分目录、跨进程可访问；**workspace 账（GUI 分组）只由 attachSession 写入**（bootstrap 仅在 workspace 域首次初始化建账），跨进程 session 在 GUI 显示于"未分组"（详见 docs/design.md §14 边界与上游化建议）；
- `dsh-session workspace add/list/rename/delete`：注册 / 列表 / 改名 / 删除（保留目录与会话日志）；
- 网关不可达或拒绝时 fail loud：`[web-unreachable]` / 透传网关 wire 错误码（`workspace-not-found` / `workspace-name-conflict` / `workspace-invalid-path`）；
- 网关地址 = `session-tool-local` 的 `Config.webUrl`（bundle patch 可配置，默认 `http://127.0.0.1:3080`）。

## 开发

```sh
pnpm install
pnpm run build
pnpm test
```

## 关键设计（详见 docs/design.md）

- **session_write 只管日志，投递归 send_message**：追加 `user/message` 事件落盘（resume 语义，冷会话可写），不唤醒、不投递；
- **owner fence**：agent 调用者必须是目标会话自身或其祖先（沿 header `parentSession` 链）；CLI 豁免；
- **list 三作用域**：`own`（调用者 + 后代，agent 专用）、`tree`（指定根，调用者须为根或祖先）、`all`（Config 门槛：`allowAllScope: top-level|any|none` + `cliAllowAll`）；全部默认应用 hiddenPrefixes 过滤；
- **重命名**：`session/title`（user 源 pin 标题、停自动生成）+ `session/tags`（last-wins）；hiddenPrefixes 规则与 GUI 工作区浏览器共用同一套（session-tags 的 `filterVisibleByRules`）；
- **workspace 注册/绑定走 web 网关**：`session_create --workspace_path` 先经网关幂等注册 workspace，再以 canonical path 作为会话 header `cwd`（归属机制）；workspace 管理经 `dsh-session workspace` 子命令；网关地址 `Config.webUrl` 可配置（默认 `http://127.0.0.1:3080`）；不可达 fail loud（`web-unreachable`）；
- **错误码**：`session-not-found` / `unauthorized` / `scope-denied` / `empty-content` / `limit-exceeded` / `title-invalid` / `tag-invalid` / `web-unreachable` / `workspace-not-found` / `workspace-name-conflict` / `workspace-invalid-path`（HarnessError code，工具失败结果与 CLI stderr 均携带）。

## 注意事项

- **同一会话请勿并发写**：DSH 的会话是单主模型（一个会话同时只由一个进程写入，协调器的串行化锁是进程内的）。并行执行多条写命令到**同一个** `session_id` 属于未定义行为，竞态窗口下可能产生重复 seq 导致会话损坏。读可以任意并发（`session_read`/`session_list` 天然跨进程）。
