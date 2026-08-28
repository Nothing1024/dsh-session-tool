# standards/ —— dsh-community-standard v0.15 对齐面

对齐 [oh-my-dsh/dsh-community-standard](https://github.com/oh-my-dsh/dsh-community-standard)（社区 Draft v0.15，非官方标准）。策略是**先采其纪律、后接其契约**：manifest 静态化、协商前置、fixture 文化、上游触点显式化现在就做；标准坐标等 Registry 定案后做一次映射替换。

```sh
pnpm run standard:check          # = node standards/validate.mjs
node standards/validate.mjs --update-baseline   # 评审后固化 adapter 基线
```

## 内容

| 文件 | 作用 |
|---|---|
| `validate.mjs` | 自包含检查器：manifest 校验 + 纯函数协商 + fixtures 自检 + adapter 审计 |
| `dsh-plugin.schema.json` / `host-descriptor.schema.json` | 上游 schema 本地快照（仅参考；本仓权威校验在 validate.mjs） |
| `host-descriptor.json` | profile `st` 的部署描述（:3081，DSH 0.1.1-rc.2） |
| `adapter-baseline.json` | packages/*/src 的上游 import 基线（新增触点须评审） |
| `fixtures/` | 合法/非法 manifest 样本，每条"必须"配一个违反它的样本 |

manifest 本体在 `packages/<可挂载包>/dsh-plugin.json`（标准文件名带连字符；与官方装载用的 `dsh.plugin.json` 是两份文件、两套生态，互不覆盖）。

## 本仓私有契约坐标（x- 命名空间，未经 Registry 登记）

| 坐标 | kind | 语义 | 提供方 |
|---|---|---|---|
| `x-nothing1024.dsh.tools/v1alpha1` | ToolRegistry | `ctx.tools` 工具注册 | DSH 宿主 |
| `x-nothing1024.dsh.session-stack/v1alpha1` | SessionStack | `ctx.sessions` + `ctx.sessionPersistence`（store、持久化、投影、title） | DSH 宿主 |
| `x-nothing1024.dsh.system-prompt/v1alpha1` | SystemPrompt | `ctx.systemPrompt` | DSH 宿主 |
| `x-nothing1024.dsh.web-gateway/v1alpha1` | WebGateway | `dsh web` HTTP carrier（`Config.webUrl`） | web 进程 |
| `x-nothing1024.session-tool/v1alpha1` | SessionTool | `ctx.sessionTool` 服务契约（packages/session-tool） | tool-session bundle |

跨仓消费方：`dsh-vibee` 的 vibee-host 以 required 契约声明 `SessionTool`。按 v0.15 规则 `provides` 被拒绝，所以提供关系只在 descriptor 侧表达（部署能力），等 RFC 0003（插件间 service 组合）定案后再迁移为 provides/requires.services。

## 已知缺口（对应上游延期 RFC）

- **RFC 0002（client facet）**：本仓无浏览器半身，不受影响。
- **RFC 0003（插件间 service）**：`ctx.sessionTool` 的提供/消费关系是活案例，值得作为反馈提交。
- **RFC 0001 §9 第 1 问**：`session_*` 这类 Tool 注册契约是"第四个契约坐标"的强候选。
- **Adapter 层**：`adapter-baseline.json` 记录的上游触点（重点是 session-tool-local 对 dsh-session/persistence 的直接依赖）是未来抽取版本化 adapter 包的清单；基线只增不减为异常，收敛为常态。
