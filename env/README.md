# session-tool 固定 env

本目录是一份独立的 `DSH_HOME`（loopback）。不要 `--lan`。

官方 pin：`@deepseek-ai/dsh` / `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 以及仓内每个 `@deepseek-ai/dsh-*` 均为 **0.1.0-rc.7**（`boot.sh` 用 `npx @deepseek-ai/dsh@0.1.0-rc.7`）。`@deepseek-ai/dsh-session-tags` 未发布，继续用仓内 `vendor/session-tags`。

```text
env/
├── setup.sh / boot.sh
└── profiles/st/          bundles + 仓内 link；用户 overlay 空 []
```

```sh
pnpm install && pnpm run build && sh env/setup.sh
sh env/boot.sh            # :3080
```

| 依赖 | 去哪 | bundle 层 |
|---|---|---|
| `@deepseek-ai/dsh-base` / `dsh-web-app` | npm 正式包 | 是 |
| `tool-session` | `../../packages/tool-session` | 是 |
| `session-tool-local` / `session-tool` | `../../packages/*` | 否（给 loader resolve） |
| `@deepseek-ai/dsh-session-tags` | `../../vendor/session-tags` | 否 |

只 `add tool-session` 不够：邻包不会提升到 profile 根。

```sh
DSH_HOME=$PWD/env npx --yes @deepseek-ai/dsh --profile st --dump-config
```
