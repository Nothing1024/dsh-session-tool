# DSH Session Tool —— 设计文档

> 状态：设计已收敛（2026-08-11）；实施完成（2026-08-11，见 §12 实施记录），核心 4 包 + CLI 已在 plugin-dev/session-tool-env 环境全链路验证。
> 形态：**独立插件项目**，通过 DSH bundle 机制挂载；不修改 DSH 核心仓库（dev-dsh）。

## 1. 背景与目标

DSH（DeepSeek Harness）的 subagent 目前是**单次运行、不可交互**：每次运行创建临时线程（如 `subagent-codex` 的 ephemeral thread），用完即弃，thread id 不落盘。要查看 subagent / 子 agent 会话并复用现有界面，需要一个**会话管理工具**：

1. 创建会话
2. 读取会话对话内容
3. 向会话写入 / 插入内容（user prompt）
4. 列出会话（多作用域、可传参）
5. 按规则重命名（前端展示与 filter 筛选：带自定义标识的会话不展示）

**方法论参考**：OpenAI Codex CLI 的会话模型——双层可寻址 id（session_id / thread_id）、JSONL transcript 可回放、持久线程 + `turn/start` 续聊、fork 血缘（`forked_from_thread_id` / `parent_thread_id`）、`resume` 列表式恢复。**只借鉴思想，不封装、不依赖第三方运行时。**

**已确认的决策**：
- 独立插件项目（本仓库），bundle 挂载进 DSH profile；
- 依赖 `@deepseek-ai/dsh-*` 通过 pnpm `link:` 协议指向 `../plugin-dev/session-tool-env` checkout（dev-dsh 的专用 worktree，见 §12）；
- CLI 为项目自带 bin（不动 DSH 的 `apps/cli`）；
- 工具命名统一 `session_*`（避开 DSH 已有 `task_*` 后台任务语义）；
- `session_write` 写入 `user/message` 事件（= 输入 prompt），不唤醒、不投递，投递仍归 `send_message`；
- 支持冷会话写入（resume 语义）。

## 2. 总体形态

```
/Users/dev/workspace/dsh/session-tool/
├── package.json / pnpm-workspace.yaml      # monorepo root（待实施时建）
├── docs/design.md                          # 本文档
└── packages/
    ├── session-tool/          # Service Definition：抽象 SessionToolService（ctx.sessionTool）
    ├── session-tool-local/    # Provider：基于 DSH 现有会话栈实现
    ├── tool-session/          # bundle 包：5 个 agent 工具 + dsh.bundle.patch 声明
    └── cli/                   # bin：dsh-session（辅助 CLI，boot 后调服务）
```

### 挂载机制（DSH 现成能力）

- bundle = npm 包，`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；
- 用户侧：`dsh plugin --profile <name> add <包名>` → pnpm 装入 profile → 插件行进组成；
- 插件行解析：两锚点（dsh 安装 → profile node_modules → `$DSH_HOME/profiles/node_modules` fallback）。

### CLI 独立化的收益

之前的方案 (b)（插件声明 CLI 命令）需要改 DSH 的 `apps/cli`（预读 profile 组成、动态组 Commander）。独立项目里 **CLI 是项目自己的 bin**（`dsh-session`），自己 parse、自己 boot（复用公开的 `@deepseek-ai/dsh-app-boot` 的 `runProfile`）、调 `ctx.sessionTool` 打印退出——**apps/cli 零改动**，"命令由插件声明"的精神天然成立。

## 3. 服务契约（`ctx.sessionTool`）

| 操作 | 能力 | 复用 DSH 设施 |
|---|---|---|
| `create(options)` | 创建会话 | `ctx.sessions.create()`（**id 由服务按 header 索引续号 mint**，避开 store 进程内计数器的跨进程撞号；agent 调用者创建的会话默认 `parentSession = 调用者`，CLI 创建为顶层会话） |
| `read(id, opts)` | 读取会话对话 | `SessionPersistence`（jsonl/sqlite 后端、`load()`/`inspect()`）+ projection |
| `write(id, content)` | 追加 user prompt | `Session.append('user/message', ...)`（事件溯源 append-only log，追加即持久化） |
| `list(filter)` | 列出会话 | `listChildren` / `listDescendants` + `sessionPersistence.list()` |
| `rename(id, title?, tags?)` | 重命名 + 打标 | `SessionTitleService.rename()`（`session/title` 事件，pin 标题、停自动生成）+ `SessionTagsService.accept()`（`session/tags` 事件，last-wins） |

**关键性质：零新事件类型。** 全部操作复用 DSH 既有事件与既有服务；`user/message`、`session/title`、`session/tags` 都是现成的。

### write 语义（已确认）

- 写入 `user/message` 文本块，即"输入 prompt"；
- 持久化：走 session persistence 落盘（"模型可见 ⟺ 已记录"不变量天然满足）；
- **不唤醒、不投递**：只追加日志；目标会话下次续聊时消费（resume 语义，对应 Codex `turn/start`）；
- 投递仍是 `send_message`（continuable 子代理 inbox 链路）——**投递管活体，write 管日志**；
- **支持冷会话**：目标不在 live store 时，`persistence.load(id)` 物化 → append → 写回；
- 权限 fence：调用者必须是目标会话祖先链上的 Agent。

### list 作用域（已确认：三种都支持、可传参）

| scope | 语义 | agent 工具权限 | CLI |
|---|---|---|---|
| `own`（默认） | 调用者自身 + 后代（`listDescendants(自根)`） | 天然受限 | 无意义，报错提示用 `tree`/`all` |
| `tree` | 以 `session_id` 为根的子树 | fence：调用者必须是该根的祖先或自身 | 任意根（人工身份） |
| `all` | store 全部已物化会话 | 门槛：默认仅顶层 agent（`delegationDepth === 0`），Config 分级 | 默认允许，Config 可关 |

- 所有 scope **默认应用隐藏过滤**（`filterVisibleByRules`，hiddenPrefixes 规则）；`include_hidden` 是唯一豁免出口；
- 门槛实现：`Config.allowAllScope: 'top-level' | 'any' | 'none'`（默认 `'top-level'`）+ `Config.cliAllowAll: boolean`（默认 `true`）；越权 fail loud，不静默降级。

### 重命名规则与前端 filter（复用现成设施）

- `session-tags` 的 `Config.hiddenPrefixes` → `normalizeHiddenPrefixes` → `isTitleHidden` → `filterVisibleByRules`；
- 语义：标题以隐藏前缀开头的会话不进默认列表；未命名会话永不隐藏；
- DSH 文档明确：模型侧 list 工具与 GUI 工作区浏览器**共用同一套规则**——前后端天然一致；
- "带自定义标识的会话不展示" = 标题前缀约定（如 `~`、`[internal]`）。

## 4. Agent 工具（5 个，全 `generic` 渲染意图）

渲染意图按 AGENTS.md 契约预先定死：五个工具均不碰终端、不碰文件，**全部 `card: 'generic'`、无 `locations`**，UI 桥零特判。

### session_create
```
parameters: {
  title?: string,              // 缺省由 session-title 自动生成（LLM/fallback）
  parent_session_id?: string,  // fork 血缘 → header.parentSession
  tags?: string[],             // 创建后立即 accept
}
output: { session_id: string }
```

### session_read
```
parameters: {
  session_id: string,
  since_seq?: number,          // 增量读取
  max_blocks?: number,         // 钳制到 Config.readMaxBlocks
}
output: { session_id, messages: [{ seq, role: 'user'|'assistant'|'tool', blocks }] }
```

### session_write
```
parameters: {
  session_id: string,          // 支持冷会话（resume 语义）
  content: string,             // 非空；追加为 user/message 文本块
}
output: { session_id, seq }    // 追加事件的 seq
```

### session_list
```
parameters: {
  scope?: 'own'|'tree'|'all',  // 默认 own
  session_id?: string,         // tree 的根
  tags?: string[],             // 与折叠标签集求交
  title?: string,              // 子串过滤
  status?: 'live'|'idle',
  include_hidden?: boolean,    // 默认 false
  cursor?: string, limit?: number,
}
output: { sessions: [{ session_id, title, tags, status, created_at }], next_cursor? }
```

### session_rename
```
parameters: {
  session_id: string,
  title?: string,              // sessionTitle.rename()，pin 标题
  tags?: string[],             // sessionTags.accept()，last-wins 替换
}
output: { session_id, title?, tags? }
```

## 5. CLI（`dsh-session` bin）

```
dsh-session session create [--title T] [--tag T] [--parent ID] [--profile <name>]
dsh-session session read <session_id> [--since-seq N]
dsh-session session write <session_id> <text...>
dsh-session session list [--scope own|tree|all] [--root ID] [--tag T]
                         [--include-hidden] [--limit N] [--format text|json]
dsh-session session rename <session_id> [--title T] [--tag T]
```

- 默认 boot `headless` profile，`--profile` 可覆盖（与 `dsh run` 一致）；
- **boot 实现**：`runProfile` 在 `apps/cli` 内部且未被 `@deepseek-ai/dsh` 导出，CLI 直接用 `@deepseek-ai/dsh-app-boot` 公开原语组 boot（`loadProfile`（缺失 profile 自动按模板初始化）→ `loadOptionalPatches`/`loadOverlayPatches` → `boot` + `installFailLoud` + `loadLayeredEnv`）；安装锚点 = worktree 的 `apps/cli/package.json`（`DSH_SESSION_ANCHOR` 可覆盖），bundle 解析与用户 `dsh run` 完全一致；
- **headless-runner 剥离**：headless profile 组合含一次性 runner 行，CLI 组 patch 时把 `headless-runner` 行（id-targeted 与 insert 两种形态）剥掉——boot 成会话存储而非跑任务；
- 输出：默认人类可读 text，`--format json`（每个 verb 都支持）输出与工具 output 同构的 JSON——**工具与 CLI 共享同一服务层，schema 不重写**；
- 逻辑全部在插件包内，CLI 只是薄壳（parse → boot → 调 `ctx.sessionTool` → 打印 → 退出）。

## 6. 配置（全部进 Config，无硬编码）

```yaml
# 挂载后 cordis.patch.yml 中插件行 config（归属 session-tool-local 行）
session-tool-local:
  allowAllScope: 'top-level'   # all scope 门槛：top-level | any | none
  cliAllowAll: true            # CLI 是否允许 all
  readMaxBlocks: 500           # 单次读取上限
  listMaxRows: 100             # 列表上限
# hiddenPrefixes 等沿用 session-tags 插件自己的 Config
```

## 7. 错误码（窄异常 + wire 映射）

| 异常类 | wire code | 触发 |
|---|---|---|
| `SessionNotFoundError` | `session-not-found` | 会话不存在 / 冷加载失败 |
| `SessionToolUnauthorizedError` | `unauthorized` | owner fence 越权 |
| `SessionScopeDeniedError` | `scope-denied` | all scope 门槛不满足 |
| `SessionEmptyContentError` | `empty-content` | 空内容 / 空标题 / 空标签集 |
| `SessionTitleInvalidError` | `title-invalid` | **复用 session-title 现有异常** |
| `SessionTagsInvalidError` | `tag-invalid` | **复用 session-tags 现有异常** |
| `SessionLimitError` | `limit-exceeded` | 超 Config 上限 |

模式对齐：`SessionTitleInvalidError` 的 wire 映射注释惯例 + `SubagentError('UNAUTHORIZED', ...)` 的 code 风格。

## 8. 与 Codex 方法论对应

> 详细调研（7 家 CLI 逐一核实：Codex / Claude Code / Gemini / OpenCode / Aider / Cline / ACP，含命令速查与源码引用）见 [`research.md`](research.md)。

| Codex | 本工具对应 |
|---|---|
| `thread/start` 区分 ephemeral / 持久 | `session_create` 建持久会话（DSH 现有 subagent 仍是一次性 ephemeral） |
| `session_id` / `thread_id` 可寻址 | `SessionId`（branded），工具/CLI 输出即公开 id |
| JSONL transcript 可回放 | `session_read`（DSH session-persistence 的 jsonl 后端） |
| `turn/start` 续聊、fork（forked/parent） | `session_write` + header `parentSession` / `seedLength` |
| `codex resume` 列表式恢复 | `session_list` + session-title 自动标题 |
| 无原生重命名 | DSH 更强：显式重命名 pin + tags 规则 + 前后端统一 filter |

## 9. 测试策略

1. 服务层单测：owner fence、冷会话 resume、隐藏过滤、分页、scope 门槛；
2. 工具层：schema / render 单测 + **keyless snapshot**（headless 跑"创建 → 写入 → 读取 → 重命名 → 列表"完整脚本录 snapshot）；
3. CLI e2e：`dsh-session` 在 headless profile 上跑（`dsh run` 同款骨架）；
4. 类型门禁（strict、export-jsdoc）照常。

## 10. 实施顺序（2026-08-11 全部完成）

```
1. ✅ session-tool（Service Definition）+ session-tool-local（Provider）   ← 核心逻辑
2. ✅ tool-session（5 工具 + bundle patch）                                 ← 组装
3. ✅ cli（dsh-session bin）                                                ← 辅助操作面
4. ✅ CLI e2e + snapshot + 文档完善                                          ← 验证
5. （可选）上游化：功能稳定后评估是否把 cli-command 机制贡献回 DSH 核心
```

## 11. 开放问题（已定案，2026-08-11）

1. **npm scope 与包名**：无 scope 私有名——`session-tool`、`session-tool-local`、`tool-session`、`session-tool-cli`（对齐 dsh-artifact 单包惯例）；
2. **工具链**：pnpm workspace + tsc（typecheck，**artifact-plane**：paths 指向 worktree 构建产物 `lib/types`，生成器 `scripts/generate-tsconfig-paths.mjs` 产出 400 条映射，tsc 不下沉 worktree 源码）+ tsdown（runtime 与 d.ts）+ vitest（测试 lane：自有包 alias 到 src，`@deepseek-ai/*` 走 `link:` 解析到 worktree 构建 lib）；
3. **link 策略**：全部用 pnpm `link:`（纯符号链接，运行时经 realpath 落到 worktree 自身 node_modules，避免 `file:` 级联安装 workspace:^ 依赖的解析问题）；typecheck 走构建产物 d.ts，测试 lane 走构建 lib，`pnpm run build:lib:host` + `build:lib:client` 后即可全链路运行；
4. **提案文档**：暂缓——先在本项目验证稳定性，上游化时再迁移（§10.5）。

## 12. 实施记录（2026-08-11）

开发环境：`plugin-dev/session-tool-env` —— dev-dsh 仓库的新 git worktree（分支 `plugin-dev/session-tool-env`，基于 dev-dsh HEAD）。主 checkout 未动；`packages/session/session-tags`（未提交 WIP）原样复制进 worktree 并加入 `tsconfig.host.json` references。

实施中确认/修正的设计点：

1. **id 续号 mint**：`SessionStore` 的 id 是进程内计数器，跨进程创建会与已持久化 id 撞车（e2e 实锤）。`create` 按 header 索引（live + 持久化）续 `session-<n>` 系列 mint 不冲突 id；
2. **agent 创建默认挂父**：fence 要求调用者在目标祖先链上；agent 创建会话默认 `parentSession = 调用者`，否则创建者自己无权访问（CLI 创建为顶层会话）；
3. **CLI boot 不依赖 runProfile**：`runProfile` 在 `apps/cli` 内部、`@deepseek-ai/dsh` 无 exports；CLI 用 `@deepseek-ai/dsh-app-boot` 原语组 boot，剥掉 `headless-runner` 行（id-targeted + insert 两种形态）；
4. **typecheck 走 artifact-plane**：extend worktree `tsconfig.base.json` 会把 vendor 源码拉进程序（其自有 tsconfig 更宽松，报一堆假错）；改为生成 400 条 paths 指向 worktree 构建产物 `lib/types`（`skipLibCheck` 只查声明）；
5. **link: 而非 file:**：`file:` 会尝试安装目标包依赖（workspace:^ 在项目外解析失败）；`link:` 纯符号链接，运行时 realpath 落回 worktree node_modules；
6. **clientBundle 系包**（typert-registry、api-gateway 等）的 node 半身由 `build:lib:client` 产出——worktree 只跑 `build:lib:host` 时 `dsh run` 同样缺 lib，需补跑 client pass；
7. **commander 父命令选项不传给子命令 action**：`--profile`/`--patch` 定义在五个 verb 上（正好贴合设计语法 `dsh-session session create --profile X`）；
8. **隐藏过滤作用于所有 scope**：`tree`/`all` 同样默认过滤 hiddenPrefixes，`include_hidden` 是唯一豁免（e2e fixture 里 `~internal` 会话从 tree 列表消失即为正确行为）；
9. **写入 seq 从 3 起**（真实 headless 组合）：create 时 guard 插件会追加 `permission/preset`、`sandbox/mode`、`approval/policy` 三个事件，title/tags 随后，冷恢复追加 `session/end-seed` —— 全部是 DSH 既有事件，零新增；
10. **测试**：服务层 20 例（fence/冷恢复/隐藏/分页/scope 门槛）、工具层 10 例（schema/render/参数映射）、CLI e2e 1 例（真实 headless profile + bundle 安装 + 12 步全流程，fixture 回放，`DSH_SNAPSHOT=record` 重录）。

验证：`pnpm -r run typecheck`、`pnpm -r run build`、`npx vitest run`（31/31）全绿；e2e 在临时 `$DSH_HOME` 上跑通 create → write → read → rename → list（含隐藏规则、tree scope、错误码 `session-not-found`/`scope-denied`）。

### 13. 第二轮全场景测试（2026-08-11）与修复

补充测试矩阵（真实环境，T1-T17 + 2 次 LLM agent 场景）：

| 场景 | 结果 |
|---|---|
| T1-T3 空 store / 空 tag / 超长 tag | ✅ `(no sessions)` / `[tag-invalid]` |
| T4-T7 三代血缘 + tree 各层视角 | ✅ |
| **T8 tree 根不存在（CLI）** | 🐛 修复：原来静默返回空列表 → 现在 `[session-not-found]`（agent 路径原本正确；CLI 的 fence 豁免跳过了存在性检查，已补 `index.has` 前置校验 + 单测） |
| T9-T10 since_seq 超界 / 组合 | ✅ 空 / 正确 |
| T11 无标题 + write 自动标题跨进程 | ✅ fallback 标题生成并可见 |
| **T12-T13 rename 部分提交** | 🐛 修复：空 title/空 tags 原来会部分提交（title 已改但 tags 失败）→ 现在提交前 `assertValidTitleTags` 预检（normalizeSessionTitle/normalizeTags），空输入零提交；超限类仍可能部分提交（事件溯源无回滚，文档化）+ 单测 |
| T14 `--profile` 自定义 profile | ✅ 共享同一 store |
| T15 `--patch` overlay | ✅ 按 DSH patch 语义整体替换 config（缺必填字段 fail loud）；**顺带修复 CLI 错误输出双前缀** `dsh-session: dsh-session:` |
| T16 agent 三代血缘（own/create parent 链/tree） | ✅ 真实 LLM |
| **T17 并发写同一冷会话** | ⚠️ **发现 DSH 核心边界**：两个进程并发 resume+append 同一会话 → 磁盘重复 seq（end-seed 6×2、消息 7×2），静默损坏。根因：协调器 `serialize` 锁是**进程内**的（`this.chains`），`appendCore` 的 seq 校验基于加载时的内存 cursor——check-then-act 跨进程竞态。DSH 设计上会话单进程单主，并发写同一会话是未定义行为。插件层不绕过（不动 DSH 核心）；**上游化建议**：协调器做跨进程原子 append（文件锁/期望位置校验）。CLI 用户应避免并发写同一会话。 |

已提交 `fa1ac1d`（CLI json 同构）+ 本轮三处修复（T8 存在性校验、T12/T13 输入预检、双前缀）+ 对应单测（服务层 20→22 例）。

### 14. 第三轮：workspace 注册/绑定（2026-08-12，围绕 web 进程）

**决策**（用户拍板）：workspace 注册表归 **web 进程**（`dsh web`）所有，插件经其 HTTP 网关操作；绑定用 header `cwd` 归属机制（持久化按 canonical cwd 分目录、跨进程可访问；但 **workspace 账 / GUI 分组只由 attachSession 写入**——bootstrap 仅在 workspace 域**首次初始化**时按 cwd 建账，此后重启只重建缓存、不入账；web 的 `session.create` adopt 已持久化 session 会走 `agents.resume()` 启动 agent，不可用作轻量补账——要运行中即时入账需上游化给核心加 `workspace.attachSession` RPC）；操作面 = `dsh-session workspace` 子命令 + `session_create` 的 `workspace_path` 隐式注册（不加独立 agent 工具）；网关地址 `Config.webUrl` 可配置（默认 `http://127.0.0.1:3080`）。

**实施**：

1. **`session-tool` 契约**：`SessionToolCreateOptions.workspacePath` / 结果回显 `workspaceId`+`workspacePath`；新增 4 个 workspace 方法（add/list/rename/delete）+ 行类型；错误码加 `web-unreachable`、`workspace-not-found`、`workspace-name-conflict`、`workspace-invalid-path`；
2. **`session-tool-local`**：`Config.webUrl`；新模块 `src/workspace-client.ts`——`WorkspaceHttpClient extends AbstractApiClient`（**import 走 `@deepseek-ai/dsh-host-apiproxy/client` 子路径**，避开主入口连带加载 api-proxy 及全部 host 服务注入，headless 进程安全）；`create` 的 workspacePath 分支：**先**经网关幂等注册（canonical path 复用），**再**以返回的 canonical path 作 `meta.cwd` 建会话——注册失败零本地副作用；wire 业务错误透传，传输层错误统一 `web-unreachable`；
3. **`tool-session`**：`session_create` 加 `workspace_path` 参数与输出回显；
4. **`session-tool-cli`**：`session create --workspace`；新 `workspace` 子命令组（add/list/rename/delete，`--format json` 为 CLI 自有投影）；
5. **bundle patch**：显式 `webUrl: 'http://127.0.0.1:3080'`（可改）；
6. **环境修复**：worktree 迁移后遗留的 `plugin-dev` 旧路径全部改为 `env/session-tool-env`（4 包 package.json link、CLI 锚点、tsconfig.base、vitest WORKTREE、重跑 paths 生成器 434 条）；`session-tool-local` 新增 `@deepseek-ai/dsh-host-apiproxy` peer + link 依赖。

**验证**：单测 58/58 全绿（workspace-client 11：envelope 全链路/错误映射/不可达；provider workspace 12：create 绑定/header cwd/失败零副作用/4 动词；工具 3：参数映射与 schema）；typecheck/build 全过；**真实冒烟**（临时 home + 真实 headless profile + 运行中的 `dsh web` 网关）：`workspace add --title` → `session create --workspace`（回显 canonical workspace_id/path）→ `session read` → `workspace list` 可见 → `workspace delete` 清理，全链路通过。

**独立环境 Chrome DevTools 实测**（2026-08-12，临时 `$DSH_HOME` + 独立 `dsh web --port 3180` + headless bundle + `--patch webUrl`）：API key 加载（复制 `~/.dsh/.env` 后重启 web 进程）；`dsh-session workspace add` 注册的 workspace 在 GUI 侧边栏**即时可见**；`workspace rename` GUI 即时更新；`workspace delete` 即时消失；`session create --workspace` 的 session 持久化在 `sessions/--private-tmp-...-workspace-demo--/session-1`（按 cwd 分目录）；GUI 的"未分组"列出该 session（未入账，见边界）；web 进程关闭后 `workspace list` 报 `[web-unreachable]`。另确认 GUI 自身在 workspace 下新建会话走 attachSession 正常入账（账内出现 GUI blank session）。

**已知边界**（文档化）：跨进程创建的绑定 session **不进 workspace 账**（GUI 显示在"未分组"）——cwd 归属只保证持久化按目录组织与跨进程可访问；入账仅发生在 workspace 域首次初始化 bootstrap 或 GUI/宿主进程内 attachSession；`workspace add --title` 仅新建时生效（复用保留既有标题）；workspace 会话并发写同 session 的 T17 边界不变。上游化建议：给 `host/apiproxy` 增加 `workspace.attachSession` RPC（纯账写入，不触碰 agents），即可实现跨进程即时入账。

### 15. 第四轮：全转 web 进程（2026-08-12，session 对话闭环）

**决策**（用户拍板，在 §14 的 GUI 割裂实测后）：**session 操作也全部围绕 web 进程**——创建/写入/改名/列表经网关 HTTP carrier，`session_write` 直接升级为**对话**（prompt 投递 + 模型回复）；接受改 DSH 核心 worktree（生态根 README 的"平台补丁模式"）。

**上游化（env/session-tool-env）**：

1. **`session.durableCreate` 端点**：`{sessionId?, title?, parentSessionId?, tags?, workspaceId?, cwd?}` → 组成会话 + **agent 待命**（DSH 的会话/agent 生命周期绑定，live session 必须配 live agent；不跑模型直到 prompt）→ title/tags → flush → workspace attachSession（**账即时写入**）→ 返回 `{sessionId, title?, tags?}`；错误码 `workspace-not-found` / `title-invalid` / `tag-invalid` / `workspace-attach-failed`；
2. **`session.rename` 扩展 tags**：`{sessionId, title?, tags?}`（至少一个），**提交前预检**（normalizeSessionTitle/normalizeTags），避免 title 已提交 tags 拒绝的部分提交；`RpcErrorDetailsMap` + `rpc.schema.ts` 加 `tag-invalid`；
3. **web-app bundle 挂 `session-tags` 行**（hiddenPrefixes `~`）+ package.json 依赖；
4. 波及修正：connection fixture（durableCreate stub + rename tags）、runtime `ISession.rename` 契约（title optional）、两个 fake-api。

**插件侧（session-tool）**：

1. 新 `SessionHttpClient`（`session.durableCreate/prompt/list/rename`，`./client` 子路径、错误透传同 workspace-client 模式）；
2. provider 转远程：`create→durableCreate`（先 workspace 注册后绑定）、`write→prompt`（对话，契约去 seq 只回 `sessionId`）、`rename→rename`、`list→session.list`（web 视图 + 本地 scope/血缘/隐藏/标签/标题/状态/分页过滤，`all` 不经本地交集）；**read 保留本地**（persistence.inspect，不 acquire agent、离线可用）；fence/own/tree/all 门槛/隐藏规则全部保留在插件层（基于只读 header 索引）；
3. `Config.hiddenPrefixes`（默认 `['~']`，与 web 组合同步）；CLI/工具 create 传 `cwd`（调用者工作目录），保证 session 进 web 视图；
4. 工具 `session_write` 语义：发 prompt（对话），输出 `{session_id}`。

**验证**：上游 344 例（含 durable/rename-tags 新增 13 例）+ 插件 67 例全绿（session-client 10 / service 21 / workspace 12 / 工具 12 / e2e 1——e2e 改为**无网关 fail-loud fixture**：create/write/rename/list/workspace 全部 `[web-unreachable]`，read 本地 `[session-not-found]`，own scope `[scope-denied]`；webUrl 钉死不可达端口 3999，杜绝开发机正在运行的 GUI 泄漏进 fixture）；typecheck/build 全过。

**独立环境 Chrome DevTools 最终实测**（临时 `$DSH_HOME` + 独立 `dsh web --port 3180` + key + bundle）：`session create --workspace`（durableCreate）→ **GUI 不刷新即时出现 workspace + 会话**（workspace-changed / host/session-added 帧）；`session write`（对话）→ **GUI 会话视图实时显示完整对话流**（用户消息 + 模型回复 + token 统计：LLM 1.9s / 124 tok/s / 9.4K 输入 / 73 输出）；`session rename` → **GUI 标题即时更新**（页面标题 + 侧边栏同步，未刷新）；workspace 账正确（1 个会话）。

**修正后的已知边界**：§14 的"跨进程 session 不入账"已消除（durableCreate 直接 attach）；"运行中不即时刷新"已消除（web 进程内操作全推送）；`session_write` 依赖 web 网关 + 模型 key（`web-unreachable` / `model-unavailable` fail loud）；无 cwd 的会话不出现在 web 视图（工具/CLI create 默认带 cwd，无 cwd 仅"纯日志"场景）；`workspace add --title` 仅新建时生效；T17 并发写边界不变。
