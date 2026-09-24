# session-tool 固定 env

本目录是一份独立的 `DSH_HOME`（loopback）。不要 `--lan`。口固定 **3081**，不要打别人的 3080。

官方 pin：`@deepseek-ai/dsh` / `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 以及仓内每个 `@deepseek-ai/dsh-*` 均为 **0.1.7-rc.1**（`boot.sh` 用 `npx @deepseek-ai/dsh@0.1.7-rc.1 --no-open`）。会话 tags 是插件标记（`$DSH_HOME/session-tool/marks.jsonl`）：平台认 `app:` / `form:` / `parent:` / `child` / `hidden`，历史 `kind:*` 仍可读；官方 GUI 不显示；后期 Web 用 `listByMark` / `listByKind`。

```text
env/
├── setup.sh / boot.sh / gateway-id.sh
├── cli.patch.yml         # headless CLI：关 runner + webUrl :3081
├── dead-web.patch.yml    # UF 死网关：webUrl :3999
├── .env / .credentials.yaml / .anonymous-user-id   # git 忽略
└── profiles/st/          bundles + 仓内 link；overlay 把 webUrl 指到 :3081
```

模型 key 与 `llm-pi-ai` / `agent-default-model` 来自 `~/workspace/dsh/plugin/.shared/`。`setup.sh` 会跑 `apply.sh --home "$PWD"`。不要手改本目录 `settings.yaml` 的共享段。

```sh
pnpm install && pnpm run build && sh env/setup.sh
sh env/boot.sh            # :3081；已起且身份对本仓则直接退出
```

`boot.sh` / 矩阵会核对监听进程的 `DSH_HOME` 是本目录。口被别人占着会失败，不会偷偷打过去。

网关起来后可一键跑 CLI 矩阵。标题带中文【可见】/【标题隐藏】/【标记隐藏】，会话挂在 workspace「手工验收」（`env/manual-view`，不删）。脚本自己的 UF-001..008 **不是** `docs/dsh-0-1-2-upgrade/spec.md` 的 UF-001..006。跨进程须带 launch token（boot stdout 的 `dsh web:` URL 里 `token=`）：

```sh
export DSH_LAUNCH_TOKEN='<token from dsh web: URL>'
bash scripts/manual-test.sh            # 默认写中文提示；结果 env/manual-test-last.txt
bash scripts/manual-test.sh --no-write # 只建会话
```

前台：http://127.0.0.1:3081 侧栏选「手工验收」，检索本轮 `手工YYYYMMDD-…` 前缀。

| 依赖 | 去哪 | bundle 层 |
|---|---|---|
| `@deepseek-ai/dsh-base` / `dsh-web-app` | npm 正式包 | 是 |
| `tool-session` | `../../packages/tool-session` | 是 |
| `session-tool-local` / `session-tool` / `session-marks` | `../../packages/*` | 否（给 loader resolve） |

只 `add tool-session` 不够：邻包不会提升到 profile 根。

```sh
DSH_HOME=$PWD/env npx --yes @deepseek-ai/dsh --profile st --dump-config
```
