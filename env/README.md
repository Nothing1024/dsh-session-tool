# session-tool 固定 env（rc.6）

本目录是一份独立的 `DSH_HOME`。通用配方见 skill
[`dsh-plugin-debug-env`](../../../../.agents/skills/dsh-plugin-debug-env/SKILL.md)。

下面只写本插件私货。

```text
env/                          ← DSH_HOME
├── setup.sh / boot.sh
├── lan.patch.yml             仅 session-tool-local.webUrl
├── lan-uuid → skill scripts/lan-uuid
└── profiles/st/              bundles + 仓内 link；用户 overlay 空 []
```

## 一次装好

```sh
pnpm install && pnpm run build && sh env/setup.sh
```

| 依赖 | 去哪 | bundle 层 |
|---|---|---|
| `@deepseek-ai/dsh-base` / `dsh-web-app` | npm rc.6 | 是 |
| `tool-session` | `../../packages/tool-session` | 是（三行 patch） |
| `session-tool-local` / `session-tool` | `../../packages/*` | 否（给 loader resolve） |
| `@deepseek-ai/dsh-session-tags` | `../../vendor/session-tags` | 否 |
| `dsh-lan-uuid` | skill `scripts/lan-uuid` | 否（仅 `--lan` 挂） |

只 `add tool-session` 不够：邻包不会提升到 profile 根。

## 启动

```sh
sh env/boot.sh            # loopback :3080，对齐 bundle webUrl
sh env/boot.sh --lan      # 0.0.0.0 :3083；LAN_IP= / PORT= 可改
```

`--lan` 额外把 `session-tool-local.webUrl` 指到 `http://127.0.0.1:$PORT`（`DSH_SESSION_WEB_URL`）。不改的话 `session_*` 会打到另一份 3080。

起来之后树里应有：`dsh-base`（subagent） / `dsh-web-app`（api-gateway） / `tool-session`（tags + local + tools）。

```sh
DSH_HOME=$PWD/env npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile st --dump-config
```
