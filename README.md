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
└── scripts/generate-tsconfig-paths.mjs   # 生成 worktree 构建产物 paths 映射
```

## 安装到 profile（agent 工具面）

```sh
# 1. 先构建本项目与 worktree 依赖
(cd ../dsh-worktree-profiles && pnpm install && pnpm run build:lib:host && pnpm run build:lib:client)
pnpm -r run build

# 2. 把 bundle 装进 profile（headless 或任意 profile）
dsh plugin --profile headless add \
  packages/tool-session packages/session-tool-local packages/session-tool \
  ../dsh-worktree-profiles/packages/session/session-tags
```

之后 `dsh run`（agent）即可用 `session_create` / `session_read` / `session_write` / `session_list` / `session_rename` 五个工具；hiddenPrefixes 等配置在 profile 的 `cordis.patch.yml`（bundle 默认 `~` 前缀隐藏）。

## CLI 用法

```sh
dsh-session session create [--title T] [--tag T] [--parent ID] [--profile <name>]
dsh-session session read <session_id> [--since-seq N] [--max-blocks N]
dsh-session session write <session_id> <text...>
dsh-session session list [--scope own|tree|all] [--root ID] [--tag T] [--title T] [--status live|idle] [--include-hidden] [--cursor C] [--limit N]
dsh-session session rename <session_id> [--title T] [--tag T]
```

- 默认 boot `headless` profile（自动初始化），`--profile` 可覆盖；安装锚点默认指向 `../dsh-worktree-profiles`（`DSH_SESSION_ANCHOR` 可覆盖）；
- 默认人类可读输出；`--format json` 输出与工具 output 同构的 JSON；
- CLI 是人工身份（`kind: cli`），豁免 owner fence；`own` scope 仅 agent 可用。

## 开发

```sh
pnpm install
node scripts/generate-tsconfig-paths.mjs   # worktree 构建产物变动后重生成
pnpm -r run typecheck
pnpm -r run build
npx vitest run                             # 31 例（服务 20 + 工具 10 + CLI e2e 1）
DSH_SNAPSHOT=record npx vitest run packages/session-tool-cli/tests/e2e.spec.ts   # 重录 e2e fixture
```

## 关键设计（详见 docs/design.md）

- **session_write 只管日志，投递归 send_message**：追加 `user/message` 事件落盘（resume 语义，冷会话可写），不唤醒、不投递；
- **owner fence**：agent 调用者必须是目标会话自身或其祖先（沿 header `parentSession` 链）；CLI 豁免；
- **list 三作用域**：`own`（调用者 + 后代，agent 专用）、`tree`（指定根，调用者须为根或祖先）、`all`（Config 门槛：`allowAllScope: top-level|any|none` + `cliAllowAll`）；全部默认应用 hiddenPrefixes 过滤；
- **重命名**：`session/title`（user 源 pin 标题、停自动生成）+ `session/tags`（last-wins）；hiddenPrefixes 规则与 GUI 工作区浏览器共用同一套（session-tags 的 `filterVisibleByRules`）；
- **错误码**：`session-not-found` / `unauthorized` / `scope-denied` / `empty-content` / `limit-exceeded` / `title-invalid` / `tag-invalid`（HarnessError code，工具失败结果与 CLI stderr 均携带）。
