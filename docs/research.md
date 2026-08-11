# 第三方 CLI 会话管理能力调研（Task/Session 工具选型）

> 调研日期：2026-08-10（源码均按当日 HEAD 核对；引用的 URL 均已实际访问验证）。
> 用途：为 DSH「任务/会话管理工具」设计讨论提供一手资料。DSH 现状：`packages/acp` 已有自动化 ACP server（最小 v1 面：session/new、session/prompt、session/update），`packages/subagent` 已有 subagent-acp / subagent-codex / subagent-claude-code 等 provider，`packages/session` 已有持久化（jsonl/sqlite）、投影与 `session-tags`；DSH subagent 目前是单次运行、非交互。
> 本文件取代先前 82 行讨论稿；原稿要点（DSH 插件落地草图、待确认问题）已并入 [3.3](#33-既有讨论稿的落地形态插件草图保留) 与第四节。

## 调研目标

DSH 想构建一个 task/session 管理工具，能力需求：

1. **创建会话**（create a session）
2. **读取会话对话内容**（read session conversation content）
3. **写入/注入内容到会话**（write/inject content into a session）
4. **列出会话**（list sessions）
5. **重命名会话**，且支持**基于规则的筛选**（如 tagged 会话从前端展示中排除）
6. **复用现有 UI 查看 subagent 会话**（view subagent conversations by reusing the existing UI）

本次调研逐一核对了 7 个候选（Codex CLI、Claude Code CLI、Gemini CLI、OpenCode、Aider、Cline、ACP 协议）的会话管理表面：ID 体系、存储位置与格式、读取、写入/注入、列表/查询、resume/fork/continue、headless/脚本化、重命名/元数据/筛选。**同时验证假设：「Cx」指 Codex CLI，其 JSONL transcript 记录同时含 session_id 与 thread_id 字段。**

**假设验证结论（先行给出）**：基本成立，有一个命名细节。Codex 当前版（2026-08）JSONL 的 `session_meta` 首行记录同时含 `session_id`（SessionId）与 `id`（ThreadId，即线程标识）两个字段，二者同值（UUIDv7，可互转）；但 JSONL 里线程标识的**键名是 `id` 而非 `thread_id`**——显式 `thread_id` 键只出现在 wire 事件（`SessionConfiguredEvent`、`codex exec --json` 的 `thread.started`）中。旧版（2025-05 首个 commit）只有单一 `id` 字段，无 session/thread 之分。详见 [1.1 假设验证](#11-假设验证cx--codex-cli)。

---

## 一、候选 CLI 逐个分析

### 1. OpenAI Codex CLI（openai/codex，Rust）

源码：<https://github.com/openai/codex>（codex-rs/，2026-08-10 HEAD `8cabf5a6`）；官方文档根：<https://learn.chatgpt.com/docs>（原 developers.openai.com/codex 已 301 重定向）。

#### 1.1 假设验证（Cx = Codex CLI）

| 事实 | 引用 |
|---|---|
| `SessionId` 与 `ThreadId` 均为 `uuid: Uuid`，UUIDv7 生成 | [session_id.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/session_id.rs#L15-L23)、[thread_id.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/thread_id.rs#L13-L18) |
| 两者可无损互转（同一 UUID）：`From<ThreadId> for SessionId` 及反向 | [session_id.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/session_id.rs#L55-L65) |
| JSONL 首行 `SessionMeta`：`session_id: SessionId` + `id: ThreadId` + `forked_from_id?`/`parent_thread_id?` + `timestamp`/`cwd`/`originator`/`cli_version`/`source` | [protocol.rs L3084-3141](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3084-L3141) |
| 序列化样例证实 `session_meta` 行同时含 `"session_id"` 与 `"id"` 两键（同值） | [recorder_tests.rs L103-133](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder_tests.rs#L103-L133) |
| JSONL 中线程键名是 `id`；读旧文件缺 `session_id` 时反序列化器将 `id` 复制为 `session_id`（兼容逻辑） | [protocol.rs L3198-3204](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3198-L3204) |
| 显式 `thread_id` 键：wire 事件 `SessionConfiguredEvent`（session_id + thread_id）、`codex exec --json` 的 `thread.started` 事件 | [protocol.rs L3935-3945](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3935-L3945)、[exec_events.rs L40-45](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs#L40-L45) |
| 旧版对照（2025-05-31 commit `7896b10`）：`SessionMeta { id, timestamp, instructions }` 仅一个 id | [旧 rollout.rs L26-31](https://github.com/openai/codex/blob/7896b1089dbf702dd07929910504e9558a20d085/codex-rs/core/src/rollout.rs#L26-L31) |

**结论**：「Cx」指 Codex CLI 成立；「JSONL 记录同时含 session_id 与 thread_id」按语义成立（会话标识 + 线程标识并存），但 JSONL 字面键为 `session_id` + `id`（=thread），`thread_id` 字面键仅见于 wire 事件。双字段体系是 2025 年重构后的新格式。

#### 1.2 会话管理各维度

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | 创建 = 任意对话（TUI/exec）；ID = UUIDv7。`SessionId`/`ThreadId` 两个类型、新会话同值；fork 产生新 thread（`forked_from_id`/`parent_thread_id` 记录血缘）[protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3084-L3141) |
| **存储位置与格式** | `~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread_id>.jsonl`，**每会话一个文件**、按天分目录、append-only；`CODEX_HOME` 可改根目录；另有 `archived_sessions/` [recorder.rs L1553-1578](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs#L1553-L1578)、[rollout/lib.rs L26-27](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs#L26-L27)、[config/mod.rs L4678-4691](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs#L4678-L4691)。每行 `{timestamp, ordinal?, item}`，item 按 `type` 内联展开：`session_meta` / `response_item` / `event_msg` / `turn_context` / `compacted` / `world_state` / `inter_agent_communication` [protocol.rs L3406-3413](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3406-L3413)、[protocol.rs L3211-3226](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3211-L3226)。另有 SQLite `state` 库镜像 rollout 元数据（服务会话列表），JSONL 仍是 transcript 本体 [state/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/state/src/lib.rs#L1-L6) |
| **读取会话** | 无「导出/读取」命令；读取 = `resume`（交互）或直接解析 JSONL。用户消息在 `event_msg.user_message`，模型回复/工具调用在 `response_item`（`Message`/`FunctionCall`/`LocalShellCall`）[models.rs L816-890](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs#L816-L890) |
| **写入/注入** | 官方仅两种：`resume`（末尾追加一条用户消息并继续，写同一 jsonl）、`fork`（分支成新会话）；无「注入任意消息」命令 [developer-commands](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)。手工追加 JSONL 行技术可行（loader 跳过坏行、自动补换行），但非官方支持 [recorder.rs L996-1002](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs#L996-L1002) |
| **列表/查询** | **无列出会话命令**；列表能力只在 `resume`/`fork` 的交互 picker 内（`--all` 跨 cwd；`resume` 无参开 picker）[main.rs L319-339](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs#L319-L339)、[main.rs L2532](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs#L2532)。`archive`/`unarchive`/`delete` 管理会话 [main.rs L346-401](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs#L346-L401) |
| **resume/fork/continue** | `codex resume [SESSION_ID\|名称] [--last] [--all]`；headless 续写拼写为 **`codex exec resume <ID>\|--last [PROMPT]`** 与 `codex exec fork <ID>`；**没有 `--session`/`--continue` flag** [exec/cli.rs L147-157](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs#L147-L157)、[exec/cli.rs L180-248](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs#L180-L248)；resume 以 append 模式打开同一 rollout 文件 [recorder.rs L789-792](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs#L789-L792) |
| **headless/脚本化** | `codex exec [PROMPT]`：`--json`（事件流：`thread.started`(含 thread_id)、`turn.started/completed/failed`、`item.*`、`error`）、`--ephemeral`（不落盘）、`--output-last-message/-o`、`--sandbox/-s`、`--yolo` 等 [exec/cli.rs L30-73](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs#L30-L73)、[exec_events.rs L13-35](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs#L13-L35)、[non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)。⚠️ 文档称 `--full-auto` 为 deprecated flag，但当前源码已无此 flag（文档滞后） |
| **重命名/元数据/筛选** | **无重命名能力**；会话无标题字段，resume 可按「会话名」匹配（实现内部）；`tui.resume_cwd` 等配置影响 picker 范围 [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| **许可证/平台** | Apache-2.0 [LICENSE](https://github.com/openai/codex/blob/main/LICENSE)；macOS 12+、Ubuntu 20.04+/Debian 10+、Windows 11（官方文档列 via WSL2）[docs/install.md](https://github.com/openai/codex/blob/main/docs/install.md#L7)；另有原生 Windows sandbox crate [windows-sandbox-rs](https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs) |

**短评**：JSONL transcript 设计（每会话一文件、首行元数据、append-only、可跳过坏行）是四个 CLI 里最规整的，且 `session_id`+thread 的双 ID 体系与 DSH 的「会话/线程」概念最接近；但**无列表命令、无重命名/标题、无消息注入**，只适合作为「存储格式参考 + 子进程续写」的候选。

#### 1.3 命令速查（均为源码/文档核实）

```bash
codex                        # 交互 TUI
codex exec "prompt"          # headless 新建（落盘到 ~/.codex/sessions/YYYY/MM/DD/）
codex exec --json "prompt"   # headless + 事件流（thread.started 带 thread_id）
codex exec resume <SESSION_ID> "follow-up"   # headless 续写既有会话（官方拼写，无 --session/--continue flag）
codex exec resume --last "follow-up"          # headless 续最近会话
codex exec fork <SESSION_ID> "prompt"        # headless 分支
codex resume [SESSION_ID|名称] [--last] [--all]   # 交互恢复；无参 = picker（唯一"列表"途径）
codex archive|unarchive|delete <SESSION_ID>  # 会话管理（delete 可 --force）
```
来源：[main.rs L319-401](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs#L319-L401)、[exec/cli.rs L147-248](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs#L147-L248)。

### 2. Anthropic Claude Code CLI（anthropics/claude-code）

官方文档：<https://code.claude.com/docs>（sessions 页：<https://code.claude.com/docs/en/sessions>，cli-reference：<https://code.claude.com/docs/en/cli-reference>）。注意：仓库 main 分支已**不再含 `cli/` 源码**（仅 docs/examples/plugins/scripts），CLI 以原生二进制分发（npm `@anthropic-ai/claude-code`，optionalDependencies 为 8 个平台二进制包）；源码级证据取自旧版 npm tarball（1.0.69 的 cli.js）+ 官方文档 + 本机 `claude --help` 实测 [仓库](https://github.com/anthropics/claude-code)、[npm registry](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | 会话 ID = UUID；`--session-id <uuid>` 可为本次对话指定具体 UUID（须合法 UUID）[cli-reference](https://code.claude.com/docs/en/cli-reference)。`sessionId` 字段出现在 JSONL 每行与 `stream-json` 事件中 |
| **存储位置与格式** | `~/.claude/projects/<项目编码>/<session-id>.jsonl`，官方原文 "transcripts are stored as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`"；项目编码 = 工作目录路径非字母数字字符替换为 `-`（旧版 cli.js 源码 `replace(/[^a-zA-Z0-9]/g,"-")` 证实）[sessions](https://code.claude.com/docs/en/sessions)。每行一个 JSON 对象（消息/工具调用/元数据），`type` 取值实测含 `user`/`assistant`/`system`/`attachment`/`ai-title`/`last-prompt`/`mode`/`permission-mode`/`file-history-snapshot`；user/assistant 行含 `message`、`uuid`、`parentUuid`、`timestamp`、`sessionId`、`cwd`、`version`、`gitBranch`。**官方明确警告 entry format 是内部格式、跨版本可变**。存储可配置：`CLAUDE_CONFIG_DIR`、`cleanupPeriodDays`（默认 30 天）、`--no-session-persistence` |
| **读取会话** | 无官方导出命令；程序化读取途径：`claude -p --resume <id> ... --output-format json` 单次结果 + session ID；hooks/statusline 可拿 `transcript_path`；**JSONL 直读是唯一完整 transcript 途径**（无格式保证）；人类可读导出用会话内 `/export` [sessions](https://code.claude.com/docs/en/sessions) |
| **写入/注入** | **官方支持向既有会话追加消息**：`claude -p --resume <session-id> "prompt"`，官方示例 `claude -p --resume <session-id> --output-format json "summarize what we changed" \| jq -r '.result'`；另有 `--input-format stream-json` 流式输入 [sessions](https://code.claude.com/docs/en/sessions)、[cli-reference](https://code.claude.com/docs/en/cli-reference)。直接编辑 JSONL 官方不背书 |
| **列表/查询** | **无非交互式列表命令**（`claude --help` 无 sessions 子命令）；`--resume` 无参 = 交互 picker（搜索、Ctrl+A/W/B 扩范围、Ctrl+R 重命名）；`claude agents --json` 只列后台 agent 会话；`claude project purge` 是删除不是列表 [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| **resume/fork/continue** | `-r/--resume [id\|name]`（v2.1.223+ ID 跨全机项目搜索）、`-c/--continue`（当前目录最近会话）、`--fork-session`（resume/continue 时生成新 session ID，原会话不动）；会话内 `/branch` 等价 [cli-reference](https://code.claude.com/docs/en/cli-reference)、[sessions](https://code.claude.com/docs/en/sessions) |
| **headless/脚本化** | `-p/--print` 非交互；`--output-format text\|json\|stream-json`（json 含 result/session ID/total_cost_usd；stream-json 为 NDJSON 事件流、事件含 session_id）；`--input-format text\|stream-json`；`-p` 创建的会话不进 picker 但可按 ID resume [cli-reference](https://code.claude.com/docs/en/cli-reference)、[headless](https://code.claude.com/docs/en/headless) |
| **重命名/元数据/筛选** | **无 `--rename` flag**；官方途径：`claude -n <name>` 启动命名、会话内 `/rename <name>`（-p 模式亦可）、picker `Ctrl+R`；之后可按**名字** `--resume <name>`。未命名会话有默认显示名（`my-app-3f` 式）与 AI 生成标题，二者均非 resume handle [sessions](https://code.claude.com/docs/en/sessions) |
| **许可证/平台** | **非 OSI 开源**：LICENSE.md 全文 "Use is subject to Anthropic's Commercial Terms of Service" [LICENSE.md](https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md)；npm 安装已标 deprecated，推荐 install.sh/Homebrew/winget；原生二进制覆盖 darwin/linux/win32 × x64/arm64 [README](https://raw.githubusercontent.com/anthropics/claude-code/main/README.md) |

**短评**：**7 个候选中唯一官方支持「headless 向既有会话追加消息」的 CLI**（`-p --resume`），加上 stream-json 输入输出、fork-session、按名 resume，几乎覆盖全部需求；短板是无非交互列表、JSONL 格式官方声明不稳定、许可证专有（可包装不可内嵌）。

#### 2.1 命令速查（cli-reference + 本机 claude --help v2.1.212 核实）

```bash
claude -p "prompt"                                     # headless 新建（-p 创建的会话不进 picker，但可按 ID resume）
claude -p --resume <session-id> "follow-up"            # ★官方支持的 headless 追加消息（唯一一家）
claude -p --resume <session-id> --output-format json "..." | jq -r '.result'
claude -p --continue --fork-session "prompt"           # 复制最近会话到新 session ID 后继续
claude --resume [id|name]                              # 交互恢复；无参 = picker（唯一"列表"途径）
claude -c / --continue                                 # 当前目录最近会话
claude -n <name>                                       # 启动时命名；会话内 /rename；picker Ctrl+R
claude --session-id <uuid> -p "prompt"                 # 为本次对话指定 UUID（新建语义，非恢复）
claude -p --input-format stream-json                   # 流式输入
```
来源：[cli-reference](https://code.claude.com/docs/en/cli-reference)、[sessions](https://code.claude.com/docs/en/sessions)。

### 3. Google Gemini CLI（google-gemini/gemini-cli）

源码：<https://github.com/google-gemini/gemini-cli>（main HEAD `cf22ac7e`，npm 最新 0.54.4）；README 即主要文档。

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | 会话 ID = UUID（文件名取前 8 位）；`--session-id <uuid>` 语义是**用指定 UUID 新建会话**（非恢复；ID 已存在则报错提示改用 --resume），ID 字符白名单 `[a-zA-Z0-9-_]` [config.ts L425-443](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/config.ts)、[gemini.tsx L294-303](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/gemini.tsx) |
| **存储位置与格式** | **不是 `~/.gemini/sessions/`**（该布局在全部历史 tag 中不存在）。主会话文件 = `<projectTempDir>/chats/session-<YYYY-MM-DDTHH-MM>-<sessionId前8位>.jsonl`，projectTempDir = `~/.gemini/tmp/<projectShortId>`；`GEMINI_CLI_HOME` 覆盖基目录 [chatRecordingService.ts L479-519](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts)、[storage.ts L275-279](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/storage.ts)。append-only JSONL：首行元数据 `{sessionId, projectHash, startTime, lastUpdated, kind:'main'\|'subagent', directories}`，后续行 `MessageRecord {id, timestamp, content, type:'user'\|'info'\|'error'\|'warning'\|'gemini', toolCalls?...}` [chatRecordingTypes.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingTypes.ts)。**子代理会话嵌套于 `chats/<父会话完整sessionId>/<sessionId>.jsonl`**（与 DSH 子代理需求直接相关）[chatRecordingService.ts L484-517](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts)。旧 `.json` 自动迁移为 `.jsonl` |
| **读取会话** | 无导出命令；JSONL 直读；`--session-file <path>` 可从 JSON 导入为新会话 |
| **写入/注入** | 官方机制 = `--session-file <path>`（导入任意符合格式的会话 JSON 为新会话，插入一条 "Imported session from ..." 消息）[gemini.tsx L220-290](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/gemini.tsx)；文件级：按 MessageRecord schema 追加行即可被读回（首行须含 sessionId/projectHash）[chatRecordingTypes.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingTypes.ts) |
| **列表/查询** | 无子命令；`--list-sessions` 列出当前项目会话（`N. <displayName> (<相对时间>, current) [<sessionId>]`），`--delete-session <索引\|uuid>` 删除（连带清 logs/tool-outputs）[sessions.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/utils/sessions.ts)、[sessionOperations.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/utils/sessionOperations.ts) |
| **resume/fork/continue** | `-r/--resume <latest\|UUID\|索引>`（不带值=latest；数字为 1-based 索引）；**`--continue`/`--fork` 从未存在**（历史版本核实）[config.ts L400-419](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/config.ts)、[sessionUtils.ts L500-534](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/utils/sessionUtils.ts)。TUI 内 `/resume` 浏览、`/restore` checkpoint 恢复 [checkpointing 文档](https://www.geminicli.com/docs/cli/checkpointing) |
| **headless/脚本化** | `-p/--prompt <text>` 非交互（usage 原文 "Use -p/--prompt for non-interactive (headless) mode"）；**`-p` 可与 `--resume` 组合**（解析先于交互分支，headless 拿到历史后 resumeChat）；stdin 管道输入前置拼入 prompt；JSON 输出 = `-o/--output-format <text\|json\|stream-json>`（**无 `--json`**）[config.ts L293-299](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/config.ts)、[nonInteractiveCli.ts L242-248](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/nonInteractiveCli.ts)、[README](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md) |
| **重命名/元数据/筛选** | **无重命名**；会话有 displayName（`--list-sessions` 展示）；无 tag/筛选概念 |
| **许可证/平台** | Apache-2.0 [LICENSE](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/LICENSE)；npm 全局分发（Node ≥20）+ Homebrew/MacPorts/conda |

**短评**：与 DSH 最像的点是**子代理会话嵌套在父会话目录下**；headless `-p --resume` 组合可行；但无 fork、无重命名、无 tags，`--session-id` 语义反直觉（新建而非恢复）。适合参考其「子代理会话按父会话组织」的存储布局。

#### 3.1 命令速查（config.ts 核实）

```bash
gemini -p "prompt"                            # headless（-p = --prompt，非 --print）
gemini -p --resume <latest|UUID|索引> "..."   # headless 恢复并继续
gemini --list-sessions                        # 列表（当前项目；`N. <displayName> (<相对时间>, current) [<sessionId>]`）
gemini --delete-session <索引|uuid>           # 删除
gemini --session-id <uuid> -p "..."           # 用指定 UUID 新建（非恢复！）
gemini --session-file <path> -p "..."         # 从 JSON 文件导入为新会话
gemini -p "..." -o stream-json                # NDJSON 事件输出（无 --json flag）
```
来源：[config.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/config.ts)、[sessions.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/utils/sessions.ts)。

### 4. OpenCode（sst/opencode）

源码：<https://github.com/sst/opencode>（dev 分支，包版本 1.18.16）；文档：<https://opencode.ai/docs/>、<https://opencode.ai/docs/cli/>、<https://opencode.ai/docs/server>。

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | ID 前缀 `ses_`/`msg_`/`prt_` + 时间序（新 ID 排前）[id.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/id/id.ts)；创建 = TUI 新会话 / `run` 单次运行 / 子会话 |
| **存储位置与格式** | **单一 SQLite 库** `~/.local/share/opencode/opencode.db`（WAL；`OPENCODE_DB` 可覆盖路径）；表：`session`（id/project_id/parent_id/slug/title/summary_*/cost/agent/model/time_* 等）、`message`/`part`（data JSON 列）、事件溯源日志 `session_message`（每会话单调 seq）、prompt 收件箱 `session_input` [database.ts](https://github.com/sst/opencode/blob/dev/packages/core/src/database/database.ts)、[sql.ts](https://github.com/sst/opencode/blob/dev/packages/core/src/session/sql.ts)。旧版每会话 JSON 文件（`<data>/storage/session/<projectID>/<sessionID>.json`）只剩迁移代码 [storage.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/storage/storage.ts)。官方查看入口：`opencode db [query]` / `opencode db path` [db.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/db.ts) |
| **读取会话** | `session list --format json` 列元数据；完整对话内容走 SQLite 查询（`opencode db`）或 HTTP API；`export` 命令导出会话（share 格式） |
| **写入/注入** | 官方路径 A：`opencode import <file.json\|share-url>`（`{info: Session, messages:[{info: Message, parts:[Part]}]}` 直接 INSERT）[import.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/import.ts)；路径 B：HTTP `POST /session/:id/prompt`（送入 `session_input` 收件箱）[server 文档](https://opencode.ai/docs/server)。**关键机制：agent 运行循环只从 `session_input` 表消费输入**（`promoteNextQueued` 事件溯源）[llm.ts](https://github.com/sst/opencode/blob/dev/packages/core/src/session/runner/llm.ts)；直接改 SQLite 会绕过事件溯源、有破坏投影风险（推断） |
| **列表/查询** | **`opencode session list`（`--max-count/-n`、`--format table\|json`）与 `session delete <id>` 是仅有的会话子命令**（无 session resume/rename）[session.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/session.ts) |
| **resume/fork/continue** | flag 制：`--continue/-c`、`--session/-s <id>`（run/TUI/attach 均有）；fork = `run --fork`（须配 --continue/--session）或 SDK `session.fork({sessionID, messageID?})`（可指定消息点分叉，标题自动加 `(fork #N)`）；**无 fork 子命令** [run.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)、[sdk.gen.ts](https://github.com/sst/opencode/blob/dev/packages/sdk/js/src/v2/gen/sdk.gen.ts) |
| **headless/脚本化** | `opencode run [message..]` 默认非交互（单次 prompt → 事件流 → idle 退出），文档明言适合 scripting；stdin 非 TTY 时读管道输入；`--format json` 每事件一行 JSON（`{type,timestamp,sessionID,...}`，以 idle 结束）——**注意没有 `--json` flag**；`--auto` 自动批准权限 [run.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)、[docs cli](https://opencode.ai/docs/cli/) |
| **重命名/元数据/筛选** | 默认标题 `New session - <ISO时间>`；首条真实用户消息后由 `title` agent 自动生成（>100 字符截断）[prompt.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/prompt.ts)；重命名 = TUI `ctrl+r` 或 HTTP `PATCH /session/:id {title}`（`session.setTitle`），**无 CLI rename** [handlers/session.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)；`run --title <t>` 显式设标题。无 tag 机制（有 archived 标志） |
| **许可证/平台** | **MIT**（非 Apache-2.0）[LICENSE](https://github.com/sst/opencode/blob/dev/LICENSE)；curl/npm/bun/pnpm/yarn/Homebrew/AUR/Docker，Windows 推荐 WSL [docs](https://opencode.ai/docs/) |

**短评**：**管理面最完整**（session list/delete/import、SQLite 可查询、HTTP API 全套：prompt/rename/fork），headless 脚本化成熟；事件溯源 + `session_input` 收件箱的注入模型值得 DSH 借鉴；但存储是单库 SQLite（非文件型），直接互操作依赖其 schema。

#### 4.1 命令速查（run.ts / session.ts 核实）

```bash
opencode session list [--max-count -n] [--format table|json]   # ★唯一非交互列表
opencode session delete <sessionID>
opencode run "prompt" [--format json]                          # headless 新建（默认非交互，idle 退出）
opencode run --session <id> "follow-up"                        # 恢复并继续（--continue/-c 同义于最近会话）
opencode run --fork --session <id> "prompt"                    # 分叉后继续
opencode run --title "标题" "prompt"                           # 显式标题
opencode import <file.json|share-url>                          # 注入整个会话
opencode db path / opencode db "SELECT ..."                    # 直接查 SQLite
```
来源：[session.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/session.ts)、[run.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)、[db.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/db.ts)。

### 5. Aider（Aider-AI/aider）

源码：<https://github.com/Aider-AI/aider>（main，commit `5dc9490b`）；文档：<https://aider.chat/docs/>（options：<https://github.com/Aider-AI/aider/blob/main/aider/website/docs/config/options.md>）。

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | **无命名会话、无会话 ID**；「会话」= 一个聊天历史文件 |
| **存储位置与格式** | 默认单文件 `.aider.chat.history.md`（git 仓库内放 git 根目录，否则 cwd）；`.aider.input.history` 存输入历史 [args.py L271-276](https://github.com/Aider-AI/aider/blob/main/aider/args.py)、[io.py L336](https://github.com/Aider-AI/aider/blob/main/aider/io.py)。格式为可读 Markdown：`# aider chat started at <时间>` 头、`#### <用户消息>`、`> <助手输出>`（blockquote）[io.py L775,905-923](https://github.com/Aider-AI/aider/blob/main/aider/io.py)；官方 FAQ 建议直接复制该文件分享，佐证可读性 [faq.md](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/faq.md) |
| **读取会话** | 直接读 Markdown 文件；`--restore-chat-history` 把该文件解析回上下文（`split_chat_history_markdown`：`#### `→user、`> `→assistant）[utils.py L148](https://github.com/Aider-AI/aider/blob/main/aider/utils.py) |
| **写入/注入** | 历史文件以 `open("a")` 追加写入；手动按格式追加的内容可被 `--restore-chat-history` 读回（**事实上的注入途径**）[io.py L1117-1139](https://github.com/Aider-AI/aider/blob/main/aider/io.py) |
| **列表/查询** | **`--list-sessions` 不存在**，无任何会话管理命令（grep 全仓库无命中）[args.py](https://github.com/Aider-AI/aider/blob/main/aider/args.py) |
| **resume/fork/continue** | **`--session <name>` 不存在**（用户命题中的假设有误）；「多会话」只能靠 `--chat-history-file <file>` 指向不同文件（env `AIDER_CHAT_HISTORY_FILE`）；`--restore-chat-history`（BooleanOptionalAction，**无 `--restore` 别名**）恢复 [args.py L283-294](https://github.com/Aider-AI/aider/blob/main/aider/args.py) |
| **headless/脚本化** | `-m/--message`、`-f/--message-file`、`--yes-always`（代码里**无 `-y`/`--yes` 别名**，docs 的 scripting.md 是过期文档）、`--no-stream`（`--stream` 的反向形式）；**`--json` 不存在**；`--llm-history-file` 可记录完整 LLM 请求/响应 [args.py L639-655](https://github.com/Aider-AI/aider/blob/main/aider/args.py)、[args.py L760-764](https://github.com/Aider-AI/aider/blob/main/aider/args.py)、[args.py L322-327](https://github.com/Aider-AI/aider/blob/main/aider/args.py) |
| **重命名/元数据/筛选** | **不支持重命名**；无元数据；`/clear` 清历史、`/reset` 丢文件并清历史 [commands.md](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/commands.md) |
| **许可证/平台** | Apache-2.0 [LICENSE.txt](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt)；Python 3.10–3.14，跨平台终端 CLI [pyproject.toml](https://github.com/Aider-AI/aider/blob/main/pyproject.toml) |

**短评**：会话管理能力最弱（无 ID/列表/重命名/headless resume），「会话」仅是单文件 Markdown 历史；对 DSH 的唯一参考价值是**人类可读历史格式 + 可被解析回读的追加写入**。用户命题中 `--session`/`--list-sessions`/`--json` 均不存在（已核实）。

#### 5.1 命令速查（args.py 核实）

```bash
aider --message "prompt"                 # headless 单发（-m / --msg / -f 文件版）
aider -m "prompt" --yes-always           # 自动确认（注意：无 -y/--yes 别名，docs 过期）
aider --restore-chat-history             # 恢复上次历史（无 --restore 别名）
aider --chat-history-file <file>         # 指定历史文件 = 事实上的"多会话"（env AIDER_CHAT_HISTORY_FILE）
aider --no-stream                        # 关闭流式
```
来源：[args.py](https://github.com/Aider-AI/aider/blob/main/aider/args.py)。

### 6. Cline（cline/cline，VS Code 扩展）— 简要核实

源码：<https://github.com/cline/cline>；文档：<https://docs.cline.bot/>。

| 事实 | 引用 |
|---|---|
| **前提修正：Cline 现在有官方 CLI**（正式功能，非实验性）：npm 包 `cline`（3.x 起；注意 0.x 的 `cline` 包属于无关项目），仓库 `apps/cli/`，与 VS Code 扩展/JetBrains 插件共享同一 agent core；文档有完整 CLI 章节（CLI Overview / CLI Reference / Headless） | [apps/cli/README.md](https://github.com/cline/cline/blob/main/apps/cli/README.md)、[CLI Overview](https://docs.cline.bot/cline-cli/overview)、[CLI Reference](https://docs.cline.bot/cli/cli-reference) |
| headless：`--json`（NDJSON 输出）、`--yolo`（自动批准）、stdin 管道输入、stdout 重定向即触发 headless；适合 CI/CD 与 scripting | [apps/cli/README.md](https://github.com/cline/cline/blob/main/apps/cli/README.md) |
| 会话存储：共享文件型持久层 `~/.cline/data/sessions/<taskId>/`（每个 task 一个目录）；`CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_SESSION_DATA_DIR` 可覆盖 [paths.ts L130-170](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts)；VS Code 扩展旧数据仍在 `globalStorage`（扩展 ID `saoudrizwan.claude-dev` 的 tasks/、state/taskHistory.json、checkpoints/），尚未迁到共享层 [vscode-to-file-migration.ts](https://github.com/cline/cline/blob/main/apps/vscode/src/hosts/vscode/vscode-to-file-migration.ts) | |
| 社区 `cline/cline-cli` 仓库不存在（404），无需考虑 | [github.com/cline/cline-cli](https://github.com/cline/cline-cli) |
| 许可证 Apache-2.0 | [LICENSE](https://github.com/cline/cline/blob/main/LICENSE) |

**短评**：Cline 已不是「纯 VS Code 扩展」，官方 CLI 支持 headless 脚本化；但会话管理命令面（list/resume/rename 的 CLI 形态）本次未深入，如需选型可单独调研其 `apps/cli` 命令面。对 DSH 参考价值中等。

### 7. Agent Client Protocol（ACP，Zed/Anthropic 主导）

规格站点：<https://agentclientprotocol.com/>（旧 acp.zed.dev）；仓库：<https://github.com/agentclientprotocol/agent-client-protocol>（原 zed-industries/agent-client-protocol 已 301 迁移，main @ `97ea47d8`）；当前稳定协议版本 **1**，v2 为 draft（schema/v2 + docs/protocol/v2 + [migration.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)）。许可证 Apache-2.0 [LICENSE](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/LICENSE)。

| 维度 | 事实（引用） |
|---|---|
| **会话创建/ID 体系** | `session/new`：params = `cwd`（绝对路径，必填）+ `additionalDirectories?` + `mcpServers`；返回 `sessionId`（+ 可选 modes/configOptions）[session-setup.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx#creating-a-session)。`SessionId` = string（"unique identifier for a conversation session"），schema 无格式约束 [schema.json SessionId](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| **方法全集（v1）** | agentMethods：`initialize`、`authenticate`、`session/new`、`session/load`、`session/set_mode`、`session/set_config_option`、`session/prompt`、`session/cancel`、`session/list`、`session/delete`、`session/resume`、`session/close`、`logout`；clientMethods：`session/request_permission`、`session/update`、`fs/*`、`terminal/*`、`elicitation/*`；protocolMethods：`$/cancel_request` [meta.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/meta.json)。**⚠️ v1 中没有 `session/read`、也没有 `session/save`**（用户命题中的方法名已过时）：读取历史走 `session/load`（Agent 以 `session/update` 通知重放 `user_message_chunk`/`agent_message_chunk` 等流式块），续写走 `session/resume`（**禁止重放历史**）[session-setup.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx#loading-sessions)、[#resuming-sessions](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx#resuming-sessions) |
| **会话对象 schema** | `SessionInfo`（session/list 返回项）：`sessionId`（必填）、`cwd`、`additionalDirectories`、`title`（string\|null，Human-readable title）、`updatedAt`（ISO 8601）、`_meta` [schema.json SessionInfo](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)；`ListSessionsResponse` 支持 `nextCursor` 分页，`ListSessionsRequest` 可带 `cwd` 过滤 [schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| **写入/注入** | 唯一注入途径 = `session/prompt`（params：sessionId + `prompt: ContentBlock[]`；带 id 的请求；流式输出全部走 `session/update` 通知；响应只有 `stopReason`：`end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled`）[prompt-turn.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx)；`session/cancel` 为 notification，Agent 中止后必须以 `cancelled` stop reason 响应原 prompt |
| **列表/查询** | `session/list`（须能力 `sessionCapabilities.list`；`cwd` 过滤 + 游标分页）；`session/delete`（须 `sessionCapabilities.delete`）[schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| **resume/fork/continue** | `session/resume`（`sessionCapabilities.resume` 门控，禁止重放历史）；`session/load`（顶层 `agentCapabilities.loadSession` 门控，默认 false，须重放完整历史）；**协议层无 fork 概念**（v1 无 fork 方法） |
| **headless/脚本化** | JSON-RPC 2.0，传输 = **stdio**（换行分隔，MUST NOT 含内嵌换行；Agent stdout 只许 ACP 消息）+ Streamable HTTP（draft 提案）+ 自定义传输 [transports.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/transports.mdx)；初始化时 `initialize` 交换 `protocolVersion` 与 capabilities（所有 Agent **MUST** 支持 session/new、session/prompt、session/cancel、session/update）[schema.json SessionCapabilities](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| **重命名/元数据/筛选** | **title 更新 = `session/update` 通知的 `session_info_update` 变体**（Agent→Client，字段 `title`（null 即清除）、`updatedAt`，部分更新；"Agents send this notification to update session information like title or custom metadata"）[schema.json SessionInfoUpdate](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)；即重命名是 **Agent 驱动的元数据通知**，客户端不能直接改名；`_meta` 为双方扩展元数据保留（extensibility） |
| **session/update 变体（v1）** | `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update` [schema.json SessionUpdate](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| **v2（draft）关键变化** | 删 `session/load`（改 `session/resume` + `replayFrom`）、删 `fs/*`、`terminal/*`、`session/set_mode`；`session/list`、`session/resume`、`session/close` 变为必选；`session/prompt` 响应不再结束回合（进度走 `state_update` 通知）；更新语义改为按 ID upsert；`authenticate`/`logout` 改名 `auth/login`/`auth/logout`；v2 整体仍标 draft，须显式协商 protocolVersion 2 [migration.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx) |

**短评**：ACP 是**协议层**答案：create/read(load 重放)/write(prompt)/list/delete/resume 全覆盖，title 走 `session_info_update`（Agent 驱动）——「重命名 + 按规则筛选」需在 DSH 侧实现（session/list 返回 title/updatedAt，可叠加自己的 tag 逻辑）。DSH `packages/acp` 已实现最小 v1 server（session/new、session/prompt、session/update 的 agent_message_chunk）[packages/acp/acp/README.md](../../packages/acp/acp/README.md)，扩展 `session/list`/`session/load`/`session/resume`/`session_info_update` 即可对齐需求。

#### 7.1 会话生命周期 JSON-RPC 流程示意（字段取自 schema.json，非虚构示例）

```jsonc
// 1. 创建
→ {"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/abs/path"}}
← {"jsonrpc":"2.0","id":1,"result":{"sessionId":"<sid>"}}
// 2. 注入/提问（唯一写入途径）
→ {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"<sid>","prompt":[{"type":"text","text":"..."}]}}
// 3. 流式输出：Agent → Client 通知（多次）
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<sid>","update":{"sessionUpdate":"agent_message_chunk","messageId":"...","content":[...]}}}
// 4. 回合结束
← {"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
// 5. 列表（需能力 sessionCapabilities.list；可带 cwd 过滤 + nextCursor 分页）
→ {"jsonrpc":"2.0","id":3,"method":"session/list","params":{"cwd":"/abs/path"}}
← {"jsonrpc":"2.0","id":3,"result":{"sessions":[{"sessionId":"<sid>","cwd":"/abs/path","title":"...","updatedAt":"..."}]}}
// 6. 读取完整历史（需能力 agentCapabilities.loadSession；Agent 以 session/update 重放 chunk 后响应）
→ {"jsonrpc":"2.0","id":4,"method":"session/load","params":{"sessionId":"<sid>","cwd":"/abs/path"}}
// 7. 标题更新：Agent 主动通知（session_info_update，title 为 null 即清除）
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<sid>","update":{"sessionUpdate":"session_info_update","title":"新标题"}}}
```
来源：[schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)、[prompt-turn.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx)、[session-setup.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)。

---

## 二、关键结论与对比表

### 2.1 需求覆盖度总表

| 需求 | Codex | Claude Code | Gemini | OpenCode | Aider | Cline | ACP (v1) |
|---|---|---|---|---|---|---|---|
| 创建会话 | ✅（任意对话） | ✅（`-p`/TUI） | ✅ | ✅ | ✅（=历史文件） | ✅ | ✅ `session/new` |
| 读取会话内容 | ✅ JSONL 直读 | ⚠️ JSONL 直读（格式不稳定） | ✅ JSONL 直读 | ✅ SQLite/API | ✅ Markdown 直读 | ⚠️ 未深入 | ✅ `session/load` 重放 |
| 写入/注入消息 | ⚠️ 仅 resume 追加 | ✅ **`-p --resume` 官方支持** | ⚠️ `--session-file` 导入 | ✅ import / HTTP prompt | ⚠️ 手动追加可读回 | ⚠️ 未深入 | ✅ `session/prompt` |
| 列表会话 | ❌（仅 picker） | ❌（仅 picker） | ✅ `--list-sessions` | ✅ **`session list`** | ❌ | ⚠️ 未深入 | ✅ `session/list` |
| 重命名会话 | ❌ | ✅ `/rename`/`-n`/Ctrl+R（按名 resume） | ❌ | ✅ TUI ctrl+r / HTTP PATCH（无 CLI） | ❌ | ⚠️ 未深入 | ⚠️ `session_info_update`（Agent 驱动） |
| 规则筛选（tag 等） | ❌ | ❌ | ❌ | ❌（有 archived 标志） | ❌ | ❌ | ⚠️ 协议留 `_meta`；需自己实现 |
| resume/continue | ✅ `exec resume`/`--last` | ✅ `--resume`/`--continue` | ✅ `--resume latest\|UUID\|索引` | ✅ `--session`/`--continue` | ⚠️ 单文件恢复 | ⚠️ | ✅ `session/resume`/`session/load` |
| fork | ✅ `exec fork`/`fork` | ✅ `--fork-session`/`/branch` | ❌ | ✅ `--fork`/SDK（可指定消息点） | ❌ | ⚠️ | ❌（无协议方法） |
| headless JSON 输出 | ✅ `--json` 事件流 | ✅ `--output-format json\|stream-json` | ✅ `-o json\|stream-json` | ✅ `--format json`（无 `--json`） | ❌（无 `--json`） | ✅ `--json` NDJSON | ✅（协议本身即结构化） |
| 存储格式 | JSONL 每会话一文件 | JSONL 每会话一文件 | JSONL 每会话一文件 | SQLite 单库 | Markdown 单文件 | 每 task 目录 | 不规定（由 Agent 实现） |
| 许可证 | Apache-2.0 | **专有（Commercial Terms）** | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 |

### 2.2 可脚本化子进程 vs TUI-only

- **完全可脚本化（headless 子进程 + 结构化输出）**：Claude Code（`-p` + `--output-format json|stream-json` + `--input-format stream-json`）、Codex（`exec --json`，含续写 `exec resume`）、Gemini（`-p` + `-o json|stream-json`，可 `--resume`）、OpenCode（`run --format json`，默认非交互）、Cline（`--json`/`--yolo`）。
- **半脚本化**：Aider（`-m` + `--yes-always`，但无结构化输出，仅文本）。
- **纯协议/非 TUI**：ACP（本身就是给程序客户端用的 JSON-RPC 协议）。
- **列表能力全部偏弱**：唯一非交互列表命令是 OpenCode `session list` 与 Gemini `--list-sessions`；Codex/Claude Code 只有交互 picker。

### 2.3 会话文件逐行结构示例（示意，字段来自各 schema/源码）

以下为**示意行**（字段名与类型均取自源码/schema，值系构造；用于对比各家格式，不可当真实文件）：

```jsonc
// Codex rollout JSONL —— 首行 session_meta（session_id 与 id=thread 并存，同 UUIDv7）
{"timestamp":"2026-08-10T00:00:00Z","item":{"type":"session_meta","payload":{"session_id":"<uuid>","id":"<uuid>","forked_from_id":null,"parent_thread_id":null,"timestamp":"...","cwd":"/abs/path","originator":"codex-cli","cli_version":"...","source":"local"}}}
// Codex —— 用户消息行（event_msg.user_message）
{"timestamp":"...","ordinal":1,"item":{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[]}}}
// Claude Code JSONL —— 每行一个对象，type: user/assistant/system/ai-title/...（官方声明内部格式、跨版本可变）
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"uuid":"<uuid>","parentUuid":null,"timestamp":"...","sessionId":"<uuid>","cwd":"/abs/path","version":"2.1.212","gitBranch":"main"}
// Gemini JSONL —— 首行元数据 + 消息行 MessageRecord
{"sessionId":"<uuid>","projectHash":"...","startTime":"...","lastUpdated":"...","kind":"main","directories":[]}
{"id":"<uuid>","timestamp":"...","type":"user","content":{"parts":[{"text":"hello"}]}}
// Aider Markdown（人类可读历史，`####`=用户、`>`=助手、`#`=时间头）
# aider chat started at 2026-08-10 00:00:00
#### hello
> 你好！有什么可以帮你？
```
来源：Codex [recorder_tests.rs L103-133](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder_tests.rs#L103-L133)、[protocol.rs L3406-3413](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L3406-L3413)；Claude Code [sessions](https://code.claude.com/docs/en/sessions)；Gemini [chatRecordingTypes.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingTypes.ts)；Aider [io.py L775,905-923](https://github.com/Aider-AI/aider/blob/main/aider/io.py)。

### 2.4 假设/命题核实小结

- 「Cx = Codex CLI」**成立**；Codex JSONL `session_meta` 同时含 `session_id` 与 `id`(thread)（新版格式，旧版仅一个 id）；字面 `thread_id` 键仅见于 wire 事件。细节见 [1.1](#11-假设验证cx--codex-cli)。
- Aider 命题中的 `--session`/`--list-sessions`/`--json` **均不存在**（已按源码核实）。
- ACP 命题中的 `session/read`/`session/save` **在 v1/v2 中都不存在**（读取 = `session/load` 重放；无 save 方法）。
- Cline「无 CLI」前提**已过时**：官方 CLI 存在且支持 headless。

---

## 三、对 DSH 的启示

### 3.1 三种可选的实现路线

**路线 A：包装第三方 CLI 为子进程**（subprocess wrapper）

- Claude Code 是最佳包装对象：`claude -p --resume <id> "msg" --output-format json` 一条命令覆盖「创建/续写/注入/读结果」，`--fork-session` 覆盖分支，`stream-json` 覆盖流式事件（事件含 session_id）。DSH 已有 `subagent-claude-code` provider，可扩展出「任务管理」子命令层。代价：专有许可证（只能黑盒包装）、JSONL 格式不稳定（不能依赖直读）、每次调用要付 Claude 的费用与认证（需 ANTHROPIC_API_KEY 或账号登录）。
- Codex 可作第二候选：`codex exec resume <ID> [PROMPT] --json` 续写，`codex exec` 新建；无列表/重命名是硬伤，列表要靠自己扫 `~/.codex/sessions/YYYY/MM/DD/*.jsonl` 的 `session_meta` 行（`session_id`、`cwd`、`timestamp` 都有——**正好说明 Codex 的 JSONL 元数据行可以当列表索引**，DSH 侧扫文件即可）。
- OpenCode 的 `opencode run --session <id> --format json` + `session list --format json` 是最完整的「纯命令行任务管理器」形态，但跑的是 OpenCode 自己的 agent 栈，与 DSH agent 无关。

**路线 B：复用/对齐其存储格式**（storage format alignment）

- 若 DSH 的任务/session 需要被第三方生态读取，**对齐 Codex 的 JSONL 约定**最省事：每会话一个文件、首行 `session_meta`（含 session_id + thread 双 ID + cwd + timestamp）、append-only、坏行跳过容忍。Claude Code 的 JSONL 官方声明不稳定，不适合作为互操作基准。
- Gemini 的「子代理会话嵌套于 `chats/<父会话ID>/`」布局值得借鉴——DSH 的 subagent 会话天然是父子结构，`packages/session` 的 jsonl provider 可直接照此组织。
- Aider 的 Markdown 历史格式说明「人类可读 + 可解析回读」是可行设计，但功能面太弱，不建议学。

**路线 C：用 ACP 作为协议层（推荐主路线）**

- DSH 已投入 ACP（`packages/acp` server + `subagent-acp` provider），扩展成本最低、且**协议层与 UI 解耦**：任务管理工具 = ACP client，对任意 ACP Agent（包括 DSH 自己的 server）做 create/read/write/list。
- 需求映射：创建 = `session/new`；读取会话内容 = `session/load`（Agent 重放 `user_message_chunk`/`agent_message_chunk`）或自持 JSONL；写入/注入 = `session/prompt`（对 DSH 自己的 server，prompt 即注入，因为 DSH 侧消息全部落 session log——契合 DSH「model-visible ⟺ logged」约束）；列表 = `session/list`（title/updatedAt/cwd 都有，可叠加 DSH 的 tag 筛选）；重命名 = Agent 侧实现 `session_info_update` 的 title 更新（**DSH 的 server 需要新增这个变体**，目前只发 `agent_message_chunk`）；「tagged 会话从前端排除」= 前端基于 DSH 自己的 tags 元数据过滤（协议 `_meta` 或 DSH 侧自有字段）。
- 注意 v1 基线方法（session/new、session/prompt、session/cancel、session/update 必须支持），`session/list`/`session/delete`/`session/resume`/`session/load` 均为可选能力（capability 门控）——DSH server 的扩展顺序建议：`session/list` → `session/resume` → `session/load` → `session_info_update`。
- v2 是 draft（删 load/fs/terminal、prompt 语义大改），**短期不追 v2**，v1 稳定且生态兼容面广（v2 migration 文档也建议双版本并存）。

### 3.2 对 DSH 现有包的具体落点

- `packages/acp`：扩展 server 方法面（list/delete/resume/load + session_info_update + 分页 cursor）。
- `packages/subagent`：`subagent-claude-code`/`subagent-codex` 可加「续写/查询既有会话」的 provider 语义；`subagent-acp` 本身即任务管理工具的 client 侧。
- `packages/session`：`session-tags` 已覆盖「tagged 会话排除显示」的筛选基础；`session-persistence-jsonl` 的文件布局可参考 Codex（每会话一文件 + 首行元数据）与 Gemini（子代理嵌套目录）。
- 「复用现有 UI 查看 subagent 会话」：DSH 会话投影 + 上述 list/load 数据面即可支撑，无需新协议。

### 3.3 既有讨论稿的落地形态（插件草图，保留）

**原则**（先前讨论已与用户确认）：**不封装第三方 CLI 为 DSH 的运行时依赖**；第三方 CLI 只作方法论参考与（可选）辅助操作面。据此：

1. **会话服务（核心）**：在现有 `ctx.sessions` / session-persistence / session-tags 之上提供：
   - `create()`：新建会话（可选指定父会话/标签/标题规则）
   - `read(id)`：读取会话对话内容（事件流 → 对话视图）
   - `write(id, content)`：向会话写入/插入内容（复用 continuable followup 链路）
   - `list(filter)`：列出会话（标题、标签、时间、状态），**应用 session-tags 可见性规则**
   - `rename(id, title)` / 规则化重命名（标签前缀 → filter）
2. **agent-facing 工具**：`session_create` / `session_read` / `session_write` / `session_list` / `session_rename`（形态对齐现有 `task_output` / `task_list` / `task_kill`，tool-tasks 是模板）。
3. **CLI 辅助操作面（可选）**：`dsh session <create|read|write|list|rename>` 子命令，或经 ACP 暴露给外部 CLI 客户端——"CLI 辅助操作 DSH"。
4. **不要重复造**：ctx.tasks（TaskId 注册表）、session-tags 规则、session-title、listChildren/listDescendants、continuable followup、SDK/ACP 协议层都已存在；**要新增的**是会话级"创建/读取/写入/列出/重命名"的统一工具面，以及"会话可寻址公开 id"的对外契约（对齐 Codex session_id/thread_id 的可寻址性）。

---

## 四、待确认问题

1. **认证**：Claude Code headless 需要 Anthropic 账号登录或 `ANTHROPIC_API_KEY`；Codex 需 ChatGPT 登录或 API key（`codex login`）；Gemini 需 `GEMINI_API_KEY`；OpenCode/Aider 需各自 provider key。DSH 侧包装时认证流程与凭据存放（`packages/credentials` 能否复用）待定。
2. **许可证边界**：Claude Code 专有（Commercial Terms）——只能子进程包装，不能阅读/复制其分发产物内部实现做借鉴（本次证据链用的是旧版 npm tarball）；Codex/Gemini/Aider Apache-2.0、OpenCode MIT、ACP Apache-2.0，可自由参考源码。
3. **格式稳定性**：Claude Code JSONL 官方声明内部格式、跨版本可变；Codex JSONL schema 2025 年重构过一次（旧 `id` → 新 `session_id`+`id`）；依赖直读第三方格式有维护风险——DSH 自持 JSONL（`SESSION_FORMAT_VERSION=0`）更可控。
4. **平台**：Codex Windows 官方路径是 WSL2（虽有 windows-sandbox crate）；OpenCode Windows 推荐 WSL；Claude Code 有原生 win32 二进制；Gemini/Aider 纯 npm/pip 跨平台。
5. **并发语义**：Claude Code 文档明示两个终端不 fork 同时 resume 同一会话会把消息交错进同一 transcript——DSH 若做并发续写需先定「每会话单写者」或 fork 语义。
6. **CLI 稳定性**：各 CLI flag 有文档滞后（Codex `--full-auto` 文档有源码无；Aider docs 的 `--yes` 过期，代码只认 `--yes-always`；OpenCode 的 `--json` 实为 `--format json`）——自动化包装时必须按源码/实测为准，不能照抄文档。
7. **ACP 版本**：v1 稳定 vs v2 draft（方法集大改）；是否要支持 `session/load`（默认能力关闭）及其重放成本；`SessionId` 无格式约束，DSH 是否沿用 UUID。
8. **列表的规模问题**：Codex/Claude Code 的列表只有交互 picker；OpenCode/Gemini 的非交互列表是否分页/可过滤（OpenCode `--max-count`；Gemini 按项目隔离；ACP `cwd` 过滤 + cursor 分页）——DSH 的「tagged 排除」筛选落在哪一层（查询层 vs UI 层）待定。
9. **会话工具的服务对象**：仅 DSH 自身会话（含 subagent 树），还是也要把第三方 CLI 会话（如 codex 自己的 transcript）纳管？（旧稿遗留问题）

---

## 附录：执行摘要（Top 3 候选）

**Top 1 — Claude Code CLI（包装路线首选）**：唯一官方支持 headless 向既有会话追加消息的 CLI（`claude -p --resume <id> "prompt" --output-format json`），配合 `--continue`、`--fork-session`、`--input-format stream-json` 与按名 resume，create/read/write/resume/rename 五项能力全覆盖；JSONL 直读可补足完整 transcript 读取。代价：专有许可证（只可黑盒包装）、无非交互列表（列表需 DSH 自己扫 `~/.claude/projects/`）、JSONL 格式官方声明不稳定、依赖 Anthropic 认证与计费。

**Top 2 — ACP（协议层首选，DSH 已有投入）**：`session/new` / `session/load`（重放读取）/ `session/prompt`（注入）/ `session/list`（title/updatedAt/cwd + 分页）/ `session/delete` / `session/resume` 构成完整生命周期；`session_info_update` 通知提供 Agent 驱动的标题更新；`_meta` 与 DSH 自有 tags 可支撑「tagged 会话排除显示」。DSH `packages/acp` 已实现最小 v1 server，扩展 list/resume/load/session_info_update 即对齐需求；v1 稳定，v2 尚为 draft 不追。

**Top 3 — OpenCode（管理面最完整的参考实现）**：唯一同时具备非交互 `session list --format json`、`session delete`、`import`、HTTP `POST /session/:id/prompt` 与 `PATCH /session/:id {title}` 重命名的候选；SQLite 单库 + 事件溯源（agent 只消费 `session_input` 收件箱）的注入模型值得 DSH 借鉴；MIT 可自由读源码。但其 agent 栈与 DSH 无关，定位是「管理语义与注入模型」的参考而非复用对象。

**Honorable mention — Codex**：假设验证对象（JSONL 同时含 session_id + thread 双 ID）；其「每会话一文件 + 首行 session_meta 元数据 + append-only + 坏行容忍」的 rollout 格式是最干净的互操作基准，DSH 自持 JSONL 可直接对齐；但无列表/重命名/注入，只适合做格式与 ID 体系参考。

---

*调研方法：全部论断来自一手资料（官方文档、GitHub 源码、npm 分发产物、规格 schema），URL 均经 curl 验证；无法确认的条目一律标注而非猜测。部分 CLI 存在文档与源码不一致（Codex `--full-auto`、Aider `--yes`），以源码/实测为准。*
