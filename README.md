# dsh-session-tool

DSH（DeepSeek Harness）插件：把 **subagent 的一次性受控线程** 换成 **Claude Code 式的原生独立 session**。

DSH 自带的 subagent 是单次运行、用完即弃：continuation manager 管 Activation / ownedChildren / 精确父授权 / child-first drain，thread id 不落盘，父停子停，GUI 也接不住。本仓库把委派执行单元做成**平级持久会话**——可寻址、可恢复、可在侧栏打开续写，父 agent dispose 之后子会话还在。

工具名和 schema 不动（`subagent` / `send_message` / `list_agents` / workflow / ralph）。换的是引擎，不是壳。

| | DSH 原 subagent | 本仓库 |
|---|---|---|
| 生命周期 | 临时线程，跑完即弃 | 持久 session，冷恢复 / 重启仍在 |
| 控制面 | continuation manager（父子运行时锁） | 普通 session 全生命周期 + `parentSession` 血缘 |
| 续写 | 精确父授权，外人 prompt 会被 `agent-busy` | 默认同 workspace 可续写（可配 `creator` / `anyone`） |
| 可见性 | 不进官方会话栏 | GUI 当普通会话打开、发消息、停止 |
| 完成态 | 进程内状态 | 从会话日志投影，崩溃不丢 |

思想对齐 Claude Code / Codex 的原生 session（可寻址 id、append-only transcript、resume、fork 血缘）。只借鉴模型，不封装那些运行时。

操作面两个：agent 工具（`session_*`，以及仍叫原名的 `subagent` 族）和仓内 CLI `dsh-session`。

## 形态

```
session-tool/
├── docs/design.md            # 会话工具设计（含实施记录）
├── docs/research.md          # Claude Code / Codex 等 7 家 CLI 会话模型
├── docs/session-delegation/  # 平级化合同：BR/UF + 真实场景 evidence
├── packages/
│   ├── session-marks/        # 插件标记表：$DSH_HOME/session-tool/marks.jsonl
│   ├── session-tool/         # ctx.sessionTool 契约
│   ├── session-tool-local/   # Provider：fence / 投影 / collect / 网关会话
│   ├── tool-session/         # bundle：session_* 工具
│   └── session-tool-cli/     # bin：dsh-session
└── env/                      # 仓内 DSH_HOME（boot.sh，loopback :3081）
```

## 安装 / 调试

仓内 `env/` 就是这份仓库自己的 `DSH_HOME`，细节见 `env/README.md`。
模型 key 写在 `env/.env` / `env/.credentials.yaml`（git 忽略）。两者都不存在时，`sh env/setup.sh` 会从本机 DSH 默认目录 `~/.dsh/.env` 拷一份。

```sh
pnpm install && pnpm run build
sh env/setup.sh
sh env/boot.sh                 # loopback :3081
```

网关起来后一键 CLI 矩阵（命令 + 退出码 + stdout/stderr，覆盖脚本自己的 UF-001..008；**不是** `docs/dsh-0-1-2-upgrade/spec.md` 的 UF-001..006）。跨进程必须带 launch token：从 `sh env/boot.sh` stdout 的 `dsh web:` URL 取 `token=`，写入 `DSH_LAUNCH_TOKEN`。
会话标题用中文标出【可见】/【标题隐藏】/【标记隐藏】/【委派】，挂在 workspace「手工验收」里，方便在 http://127.0.0.1:3081 侧栏对照。

```sh
export DSH_LAUNCH_TOKEN='<token from dsh web: URL>'
bash scripts/manual-test.sh                 # 默认给每条可查看会话写不同中文提示（走模型；空会话官方栏不出现）
bash scripts/manual-test.sh --no-write      # 只建会话、不打对话
# 或：pnpm env:test
```

`--profile st` 是正在跑的 web（:3081），不要再 boot。CLI 一律 `--profile headless --patch env/cli.patch.yml`（webUrl 也是 :3081）。矩阵会先核网关 `DSH_HOME` 是本仓 `env/`。
起来之后 agent 可用 `session_*` 工具。`hiddenPrefixes` 默认 `~`；`kind:hidden` 是第二道隐藏闸。
官方侧栏应能看到【可见】；`~【标题隐藏】` 官方栏不出现；【标记隐藏】官方栏仍可能看见（不读插件标记）。

### 调试（网关内部状态）

CLI 矩阵之外，想直接看「插件挂上了没」或某条会话日志，打本仓网关的 HTTP RPC。0.1.2 起 `/api` 要浏览器 cookie：先 `GET /?token=` 换 cookie（**不要跟随 303**，curl 不要加 `-L`），再 POST。typert 方法是斜杠路径，payload 包在 `{ args }` 里。`session.history` 已删除。

```sh
# 确认 :3081 的 DSH_HOME 是本仓 env/（别人占口会失败）
export DSH_HOME="$PWD/env" GW_PORT=3081 EXPECTED_HOME="$PWD/env"
. env/gateway-id.sh && gateway_require && echo "pid=$GW_PID home=$GW_HOME"

# launch token 来自 boot stdout：dsh web: http://127.0.0.1:3081/?token=...
: "${DSH_LAUNCH_TOKEN:?set from dsh web: URL token=}"

# 换 cookie：默认 curl 不跟随重定向，才能读到 303 的 Set-Cookie
COOKIE=$(curl -sS -D - -o /dev/null "http://127.0.0.1:3081/?token=${DSH_LAUNCH_TOKEN}" \
  | awk 'BEGIN{IGNORECASE=1} /^set-cookie:/{sub(/\r$/,""); sub(/^[^:]+:[[:space:]]*/,""); split($0,a,";"); print a[1]; exit}')

# 插件是否 active
curl -sS -X POST http://127.0.0.1:3081/api/pluginInventory/list \
  -H 'Content-Type: application/json' \
  -H "Cookie: ${COOKIE}" \
  -d '{"type":"client-request","rpcId":"dbg","method":"pluginInventory/list","payload":{"args":{}}}'

# 某条会话的一页日志（session/page；throughSeq 必须是已有 seq，一般用 follow 首帧 cursor）
curl -sS -X POST http://127.0.0.1:3081/api/session/page \
  -H 'Content-Type: application/json' \
  -H "Cookie: ${COOKIE}" \
  -d '{"type":"client-request","rpcId":"dbg","method":"session/page","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"<id>"},"throughSeq":0,"maxMessages":20}}}}'

# 冷会话排障也可以本地 inspect，不打 HTTP：
# node packages/session-tool-cli/lib/bin.js --profile headless --patch env/cli.patch.yml session read <id>
```

## CLI 用法

```sh
node packages/session-tool-cli/lib/bin.js session create [--title T] [--tag T] [--parent ID] [--workspace PATH] [--profile <name>] [--token TOKEN]
node packages/session-tool-cli/lib/bin.js session read <session_id> [--since-seq N] [--max-blocks N]
node packages/session-tool-cli/lib/bin.js session write <session_id> <text...>
node packages/session-tool-cli/lib/bin.js session list [--scope own|tree|all] [--root ID] [--tag T] [--title T] [--status live|idle] [--include-hidden] [--cursor C] [--limit N]
node packages/session-tool-cli/lib/bin.js session rename <session_id> [--title T] [--tag T]
node packages/session-tool-cli/lib/bin.js marks list [--kind K]
node packages/session-tool-cli/lib/bin.js marks get --id ID
node packages/session-tool-cli/lib/bin.js workspace add <path> [--title T] [--profile <name>] [--token TOKEN]
node packages/session-tool-cli/lib/bin.js workspace list [--profile <name>] [--token TOKEN]
node packages/session-tool-cli/lib/bin.js workspace rename <workspace_id> --title <title> [--profile <name>] [--token TOKEN]
node packages/session-tool-cli/lib/bin.js workspace delete <workspace_id> [--profile <name>] [--token TOKEN]
```

仓内未 link 全局 `dsh-session`；上面的 `bin.js` 就是 CLI。参数与工具 output 同构。

- 默认 boot `headless` profile（自动初始化），`--profile` 可覆盖；安装锚点可用 `DSH_SESSION_ANCHOR` 覆盖；打已运行 GUI 时设 `DSH_LAUNCH_TOKEN` 或 `--token`（boot stdout `dsh web:` URL 的 `token=`）；
- 默认人类可读输出；`--format json` 输出与工具 output 同构的 JSON（workspace 子命令为 CLI 自有 JSON 投影）；
- CLI 是人工身份（`kind: cli`），豁免 owner fence；`own` scope 仅 agent 可用。
- `marks` 子命令只读 `$DSH_HOME/session-tool/marks.jsonl`，不 boot profile。后期 Web 只许吃 `listByKind` / `get`，不要改官方会话栏。

## 插件标记（tags）

工具 / CLI 参数名仍是 `tags`。真数据在 `$DSH_HOME/session-tool/marks.jsonl`（last-wins），**不**写入官方会话日志。委派会话会自动带 `kind:delegated`；这是分类，不是运行时锁。

保留名（普通合法 token）：`kind:vibee`、`kind:delegated`、`kind:hidden`、`ui:aux`。

- 官方 GUI 会话栏不显示这些标记。
- 默认 `session list` 丢掉标题匹配 `hiddenPrefixes`（默认 `~`）**或**带 `kind:hidden` 的行。
- 后期 Web 用 `session-marks` 的 `listByKind`（CLI：`node packages/session-tool-cli/lib/bin.js marks list --kind kind:vibee`）。

## Workspace（围绕 web 进程）

独立 session 要进 GUI，创建/写入必须走 **web 进程**的网关，而不是 headless 本地 store。workspace 注册表也归 web 进程；跨进程经 HTTP carrier（`POST /api/workspace/create` 等 / `POST /api/session/create` 等，须带 cookie）操作，同进程走 `sessionController` / `workspaceController`，插件进程内不持有这些状态：

- `session_create` 的 `workspace_path` / CLI `session create --workspace <path>`：先经网关幂等注册（同 canonical path 复用），再以网关返回的 **canonical path 作为新会话 header 的 `cwd`** 建会话；
- `dsh-session workspace add/list/rename/delete`：注册 / 列表 / 改名 / 删除（保留目录与会话日志）；
- 网关不可达或拒绝时 fail loud：`[web-unreachable]` / 透传网关 wire 错误码（`workspace-not-found` / `workspace-name-conflict` / `workspace-invalid-path`）；
- 网关地址 = `session-tool-local` 的 `Config.webUrl`（官方包默认 `http://127.0.0.1:3080`；本仓 overlay / CLI patch 指到 `http://127.0.0.1:3081`）。

## 开发

```sh
pnpm install
pnpm run build
pnpm test
pnpm run standard:check   # dsh-community-standard v0.15 对齐检查（见 standards/README.md）
```

## 社区标准对齐（standards/）

对齐 [dsh-community-standard](https://github.com/oh-my-dsh/dsh-community-standard) v0.15 的静态声明面：`packages/tool-session/dsh-plugin.json` 是标准 manifest（与官方装载用的 `dsh.plugin.json` 并存），`standards/` 内有部署 Host Descriptor（profile `st`）、纯函数协商、fixtures 与上游触点基线（adapter 审计）。私有坐标用 `x-nothing1024.*` 命名空间，Registry 定案后做映射替换。详见 `standards/README.md`。

## 关键设计

- **委派 = 普通持久会话**：`parentSession` 只记录血缘，不形成运行时父子锁。父停子不停。
- **换引擎不换壳**：`subagent` / `send_message` / `list_agents` / workflow / ralph 的名字和 schema 保持原样，底层改走 session 栈。
- **session_write 是对话**：经网关 `session/prompt`（同进程则 `sessionController.prompt`）投递并拿模型回复；冷会话可 resume。`session_read` 读本地持久日志，不 acquire agent。
- **完成态从日志推导**：delegation 投影（idle/running/completed/failed/aborted/max-tokens）纯函数折叠，进程重启不丢。
- **续写授权在插件工具层**：默认 `workspace`；`creator` / `anyone` 只约束 `session_write` / `session_collect`，不改官方 GUI 既有会话。
- **list 三作用域**：`own`（调用者 + 后代，agent 专用）、`tree`（指定根）、`all`（Config：`allowAllScope` + `cliAllowAll`）；默认双闸隐藏（`~` 标题或 `kind:hidden`）。
- **session_collect**：对血缘树或 tags 做声明式完成条件（wait-all/any/n/first-failed + cancel-rest + 超时），不做 DAG/调度。
- **错误码**：`session-not-found` / `unauthorized` / `scope-denied` / `empty-content` / `limit-exceeded` / `title-invalid` / `tag-invalid` / `web-unreachable` / `workspace-not-found` / `workspace-name-conflict` / `workspace-invalid-path`。

合同与真实场景证据：`docs/session-delegation/`。会话工具细节：`docs/design.md`。

## 注意事项

- **同一会话请勿并发写**：DSH 会话是单主模型（一个会话同时只由一个进程写入，协调器的串行化锁是进程内的）。并行写同一个 `session_id` 是未定义行为，可能产生重复 seq。读可以任意并发（`session_read` / `session_list`）。
