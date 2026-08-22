# session-tool 固定 env

本目录是一份独立的 `DSH_HOME`（loopback）。不要 `--lan`。口固定 **3081**，不要打别人的 3080。

官方 pin：`@deepseek-ai/dsh` / `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 以及仓内每个 `@deepseek-ai/dsh-*` 均为 **0.1.1-rc.2**（`boot.sh` 用 `npx @deepseek-ai/dsh@0.1.1-rc.2 --no-open`）。会话 tags 是插件标记（`$DSH_HOME/session-tool/marks.jsonl`）：保留名 `kind:vibee` / `kind:delegated` / `kind:hidden` / `ui:aux`；官方 GUI 不显示；后期 Web 用 `listByKind`。

```text
env/
├── setup.sh / boot.sh / gateway-id.sh
├── cli.patch.yml         # headless CLI：关 runner + webUrl :3081
├── dead-web.patch.yml    # UF 死网关：webUrl :3999
├── .env / .credentials.yaml / .anonymous-user-id   # git 忽略
└── profiles/st/          bundles + 仓内 link；overlay 把 webUrl 指到 :3081
```

模型 key：`$DSH_HOME/.credentials.yaml` 优先于 `$DSH_HOME/.env`（官方 Models 页写前者）。都 git 忽略。`setup.sh` 若本地没有 `.env`，会从 `~/.dsh/.env` 拷一份并生成凭据文件。

```sh
pnpm install && pnpm run build && sh env/setup.sh
sh env/boot.sh            # :3081；已起且身份对本仓则直接退出
```

`boot.sh` / 矩阵会核对监听进程的 `DSH_HOME` 是本目录。口被别人占着会失败，不会偷偷打过去。

网关起来后可一键跑 CLI 矩阵。标题带中文【可见】/【标题隐藏】/【标记隐藏】，会话挂在 workspace「手工验收」（`env/manual-view`，不删）：

```sh
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
