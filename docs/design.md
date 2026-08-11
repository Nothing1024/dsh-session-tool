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
