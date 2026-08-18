# session-marks Spec

> Version: 0.1.0 | Date: 2026-08-18 | Status: Ready 可执行
>
> 本文件是本需求的**唯一事实源**：事实基线、业务合同、技术方案、任务计划、验收协议全部在此。
> 其他文件（handoff.md、tasks.csv）只引用本文件，不复制内容。
>
> 填写三态规则：每个表格单元格只允许三种内容——
> 1. 验证过的事实（注明来源命令）；2. 显式假设 `ASM-xxx`；3. `待勘察`。
> 禁止编造看似合理的命令、symbol、文件名。

---

## 1. 事实基线与假设

### 1.1 需求与运行模式

| 项 | 结论 |
|---|---|
| 原始需求 | 拆掉未发布的 `@deepseek-ai/dsh-session-tags` vendor。特殊会话（vibee 工作流、隐藏、委派、后期 Web 特殊展示）用插件自有标记表当真数据。工具参数仍叫 `tags`。官方 GUI 不承诺显示。后期 Web 走 better-sidebar / conversation.view，本包只留跨插件查询契约。 |
| 输入类型 | description + 对话拍板 |
| Mode | oneclick |
| 置信度 | 高 |
| 输出目录 | `plugin/session-tool/plugin/docs/session-marks/` |

### 1.2 任务类型路由

| 维度 | 结论 |
|---|---|
| 任务类型 | refactor（拆 vendor）+ backend（标记表 + 工具/CLI 接线）+ infra（DSH_HOME 文件） |
| 主要风险 | ① 继续往官方日志写 `session/tags` 被 invariants 拒；② `--tag` 假成功残留；③ 标记表与官方 list 不同步导致 GC/幽灵行；④ 过早做 Web 页偏离范围 |
| 行号引用策略 | 中等：symbol + rg，行号仅 hint |
| 必需验收方式 | unit + CLI 真跑 + 文件落盘抽样；Web 页不在本包验收 |
| 必须覆盖用户场景 | UF-001～007（创建/隐藏/按 kind 滤/替换/委派自动标/非法输入/进程重启）；查询契约 UF-008 |

### 1.3 勘察事实清单

> 每条事实来自实际执行的命令。

| 事实 | 来源命令 | 输出摘要 |
|---|---|---|
| 仓内 4 包：`session-tool` / `session-tool-local` / `tool-session` / `session-tool-cli` | `ls packages` | 四目录存在 |
| workspace 含 `packages/*` 与 `vendor/session-tags` | `cat pnpm-workspace.yaml` | 两行 packages |
| npm 无 `@deepseek-ai/dsh-session-tags` | `npm view @deepseek-ai/dsh-session-tags version` | 404 |
| vendor 源码在 `vendor/session-tags/src/{index,client,invariant,types}.ts` | `ls vendor/session-tags/src` | 4 个 ts |
| `SessionTagsService` 声明 `ctx.sessionTags`，投影 key `tags`，事件 `session/tags` | `rg "session/tags\|SessionTagsService\|key: 'tags'" vendor/session-tags/src/index.ts` | 事件/投影/服务均在 |
| `isTitleHidden` 从 vendor 导入，Config.hiddenPrefixes 默认 `['~']` | `rg "isTitleHidden\|hiddenPrefixes" packages/session-tool-local/src/index.ts` | import L21；Config L95；default L138；list 过滤 L319 |
| create 把 `options.tags` 传给 `durableCreate` | 同文件 L201-L208 | tags 仍传入 client |
| client 注释：rc.7 create/rename **不发送** tags；rename 只改 title | `rg "Tags have no RPC\|not sent" packages/session-tool-local/src/session-client.ts` | L10-13、L219-221 |
| `tagsOf` 扫本地日志 `event.type === 'session/tags'` | `rg "tagsOf\|session/tags" packages/session-tool-local/src/index.ts` | L674-L679 |
| bundle 挂载 session-tags + session-tool-local + tool-session | `cat packages/tool-session/cordis.patch.yml` | insert 三行 |
| 工具名：create/read/wait/collect/write/list/rename | `rg "name: 'session_" packages/tool-session/src/index.ts` | L55/120/178/235/328/361/447 |
| create/list/collect/rename 工具参数含 `tags` | `rg "tags:" packages/tool-session/src/index.ts` | 多处 schema |
| CLI `dsh-session` 在 `packages/session-tool-cli/src/index.ts`，list/rename 形状含 tags | `rg "tags" packages/session-tool-cli/src/index.ts` | L254+ |
| `$DSH_HOME/session-tool` 目录尚不存在 | `ls ~/.dsh/session-tool` | No such file |
| env 启动：`DSH_HOME=$ROOT` + `npx @deepseek-ai/dsh@0.1.0-rc.7 --profile st --port 3080` | `head env/boot.sh` | L11、L36 |
| better-sidebar 0.13 有 `registerTab` / `badge` / `openTab` | `rg "registerTab\|badge\|openTab" .../dsh-better-sidebar/src/client/service.ts` | TabDescriptor L159；badge L224；openTab L389 |
| 官方 sidebar 行无 tags 字段 | `rg "SidebarSessionSummary" -A12 .../context-types.ts` | id/cwd/displayTitle/origin?:subagent/parentId/running |
| 本机无 `~/.dsh/session-tool` 标记文件 | 同上 ls | 不存在 |
| 测试面 | `find packages -name '*.spec.ts'` | 8 个 spec（含 tools/service/session-client/collect/workspace/e2e） |

### 1.4 假设清单

| 假设 ID | 内容 | 风险 | 确认方式 |
|---|---|---|---|
| ASM-001 | 标记文件路径为 `$DSH_HOME/session-tool/marks.jsonl`（env 下即 `plugin/env/session-tool/marks.jsonl`） | 低 | P1 落地后 ls 验证 |
| ASM-002 | jsonl last-wins（同一 id 后行覆盖前行）足够，不必 sqlite | 低 | 单测覆盖并发替换 |
| ASM-003 | 官方会话栏永不显示插件标记（已接受） | 无 | INV-003 |
| ASM-004 | 本包不实现 vibee 页 / sidebar Special tab，只提供 `listByKind` 查询 | 中 | 2.8 非目标；P3 只做查询 API + CLI |
| ASM-005 | 后期 Web 展示宿主是 better-sidebar `registerTab` + 既有 `conversation.view` | 低 | 勘察 registerTab 存在 |
| ASM-006 | 工具/CLI 参数名保持 `tags`，存储与类型名用 mark | 低 | 契约写死 |
| ASM-007 | 委派创建时即使官方 header 吃不下 parent/depth，仍打 `kind:delegated` | 中 | P3 单测 |
| ASM-008 | 规范化：trim、去空、去重、排序；上限沿用 vendor 默认 maxTags=20、maxTagBytes=128 | 低 | 与 cordis.patch.yml 现值一致 |

### 1.5 质量记录

- `validate_package.py`（2026-08-18）：**0 FAIL / 0 WARN / 13 PASS**（16 任务、锚点/依赖/回归位合法、ID 闭环 34 个、待勘察+ASM 占比 2%、8 UF 流程脚本齐全、5.2 真实场景任务在位）。

---

## 2. 业务合同

### 2.1 BR 业务规则

| 规则 ID | 规则 | 正例 | 反例 | 影响范围 | 验证方式 |
|---|---|---|---|---|---|
| BR-001 | 标记只存在插件表，禁止写官方会话日志的 `session/tags` 事件 | create `--tag kind:vibee` 后日志无该 type | 再挂 vendor SessionTagsService.accept | session-tool-local / vendor 拆除 | rg session/tags 写入路径为 0；文件在 marks.jsonl |
| BR-002 | create/rename 的 `tags` 整组替换写入标记表后才返回成功 | rename 只改 tags 也落盘 | 只回显不写文件（当前 shim） | create/rename | 读 jsonl |
| BR-003 | 保留名：`kind:vibee`、`kind:delegated`、`kind:hidden`、`ui:aux`；非法/空/超长拒绝，错误码 `tag-invalid` | `kind:hidden` 成功 | `""`、超 128 字节失败 | 规范化 | unit + CLI |
| BR-004 | 默认 list 丢掉：标题匹配 hiddenPrefixes（默认 `~`）**或** 带 `kind:hidden` | `~draft` 与打了 kind:hidden 的「订单同步」都不出现 | 只藏 ~ 不藏 kind:hidden | list | CLI list |
| BR-005 | `include_hidden=true` 两道隐藏都放开 | 两条都出现 | 仍滤掉 kind:hidden | list | CLI |
| BR-006 | list/collect 的 tags 过滤是标记表交集，不读网关投影、不扫 `session/tags` 事件 | 只写表不写日志，collect 仍能聚到 | tagsOf 扫日志 | list/collect | unit |
| BR-007 | 创建委派子会话（传入 parent 或 agent 调用者默认 parent）自动加入 `kind:delegated`（与用户 tags 合并） | agent create 子会话带该 kind | 普通 CLI create 无 parent 却带上 | create | unit |
| BR-008 | 查询 API `listByKind(kind)` / `get(sessionId)` 只读标记表，供后期 vibee / sidebar | CLI `dsh-session marks list --kind kind:vibee` | 只在 local 私有函数里、外部调不到 | session-marks 导出 + CLI | CLI |
| BR-009 | 拆掉 vendor 与 bundle 的 session-tags 挂载后，build/test 不依赖 `@deepseek-ai/dsh-session-tags` | pnpm 无该 file: | workspace 仍含 vendor/session-tags | workspace / patch | rg + pnpm |
| BR-010 | 标记不进入官方 GUI 会话行；后期展示只许 better-sidebar tab / conversation.view | 无官方 list 补丁 | 改 ui-layout / 官方 session browser | INV + 2.8 | 审查 diff |

### 2.2 UF 用户验收场景（索引）

| 场景 ID | Given | When | Then | 角色 | 验证方式 | Evidence |
|---|---|---|---|---|---|---|
| UF-001 | env 已 boot，标记表空 | `dsh-session session create --title t --tag kind:vibee --tag plan` | 官方会话存在；jsonl 有该 id 且 tags 含二者；list 能看到 plan（无 hidden） | 人/CLI | CLI | EVD-001 |
| UF-002 | 一条 `~secret`、一条 title=可见 + `kind:hidden`、一条普通 | 默认 `session list` | 只出现普通；前两条无 | 人/CLI | CLI | EVD-002 |
| UF-003 | 三条中仅两条 `kind:vibee` | `session list --tag kind:vibee` 与 `session collect --tag kind:vibee` | 仅那两条 | agent/人 | CLI | EVD-003 |
| UF-004 | 已有 tags `[a,b]` | `session rename --tag kind:hidden` | 表变为仅 `kind:hidden`；默认 list 消失；title 未改 | 人/CLI | CLI | EVD-004 |
| UF-005 | agent 身份 create 子会话（有 parent） | create 不传 tag | 表自动含 `kind:delegated` | agent | unit+CLI 能模拟则 CLI | EVD-005 |
| UF-006 | 任意会话 | create/rename 空 tag 或超长 | 失败 `tag-invalid`；表不写半截 | 人/CLI | CLI | EVD-006 |
| UF-007 | UF-001 已写入 | 停进程再 `list --tag kind:vibee` | 仍能滤到（文件还在） | 人/CLI | CLI | EVD-007 |
| UF-008 | 已有 vibee / 普通混合 | `dsh-session marks list --kind kind:vibee` | 只打印 vibee 的 id+tags | 后期 UI 的替身入口 | CLI | EVD-008 |

> UF-001～008 均为用户/执行者可见（CLI）。Web 页 UF 本包不做，见 2.8。

### 2.3 核心业务流程（步骤级交互脚本）

#### UF-001: 创建带特殊 tag 的会话

**前置状态**：`sh env/setup.sh && sh env/boot.sh` 使网关 :3080 可达，或 CLI 在 webUrl 指向该实例；工作目录可写 `$DSH_HOME`。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `dsh-session session create --title "wf" --tag kind:vibee --tag plan` | CLI 阻塞至返回 | 官方 `session.create`；规范化 tags；append jsonl | 打印 session_id |
| 2 | `cat $DSH_HOME/session-tool/marks.jsonl` | — | — | 一行含该 id 与两个 tag |
| 3 | `dsh-session session list` | 表格/json | 网关 list JOIN 表 | 该行 tags 含 kind:vibee,plan |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 网关不可达 | 未 boot | `[web-unreachable]` 非 0 | 不写标记表 | 先 boot 再重试 |
| 非法 tag | `--tag ""` | `tag-invalid` 非 0 | 官方会话若已创建：待勘察是否回滚（ASM：不回滚会话，不写表） | 用户 rename/补标或丢弃会话 |

**界面状态机**：

```text
idle → calling-gateway → writing-marks → printed
         |                    |
         v                    v
    web-unreachable        tag-invalid（无半行 jsonl）
```

**入口接线清单**：

- CLI：`packages/session-tool-cli` `session create --tag`
- 工具：`session_create.tags` → `SessionToolService.create`

#### UF-002: 默认列表双闸隐藏

**前置状态**：三条会话已创建（`~secret` 无 hidden kind；`visible`+`kind:hidden`；`ok` 无隐藏）。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `dsh-session session list` | 列表 | 滤 ~ 与 kind:hidden | 仅 `ok` |
| 2 | `dsh-session session list --include-hidden` | 列表 | 不过滤 | 三条都在 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 标记文件损坏 | jsonl 截断 | 待勘察：fail-loud 或跳过坏行（ASM：跳过坏行打 log，不崩 list） | 坏行忽略 | 修文件 |
| 网关空列表 | 全新 home | 空列表非错误 | — | 先 create |

**界面状态机**：`loading → listed | empty | web-unreachable`

**入口接线清单**：`session list` / `session_list` 默认与 `include_hidden`

#### UF-003: 按 kind 列表与 collect

**前置状态**：2×`kind:vibee` + 1×普通。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `session list --tag kind:vibee` | 两行 | 表交集 | 仅 vibee |
| 2 | `session collect --tag kind:vibee` | 聚合结果 | 同上数据源 | 两个 id |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 无匹配 | 滤一个不存在的 kind | 空列表 0 | 非错误 | — |
| collect 同时传 root 与 tags | 非法组合 | empty-content | 不查询 | 只传一个 |

**界面状态机**：`filter → listed | empty`

**入口接线清单**：`session_list.tags`、`session_collect.tags`

#### UF-004: rename 整组替换 tags

**前置状态**：会话 tags=`[a,b]`。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `session rename --id X --tag kind:hidden` | 打印新 tags | jsonl 新行覆盖 | 仅 kind:hidden |
| 2 | 默认 list | — | 双闸 | 该会话消失 |
| 3 | 看官方 title | — | 未调 rename title | 标题仍是原值 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 无 title 也无 tags | 空 rename | empty-content | 不写 | 补参数 |
| 会话不存在 | 错 id | session-not-found | 不写表 | — |

**界面状态机**：`idle → replaced | error`

**入口接线清单**：`session_rename.tags`

#### UF-005: 委派自动 kind:delegated

**前置状态**：存在父会话；以 agent caller 或 `--parent` create。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | create 子会话（可再加用户 tag） | 返回 id | 合并 `kind:delegated` 写入表 | get(id) 含该 kind |
| 2 | `session list --origin delegated` 或 `--tag kind:delegated` | 列表 | 认标记（origin 实现改为看 kind，不再只看旧 tag `delegated` 或深度） | 子会话在列 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 无 parent 的 CLI create | 普通创建 | 成功 | **不**自动加 delegated | — |
| 深度超限 | maxDelegationDepth | unauthorized | 不建会话、不写表 | 降深度 |

**界面状态机**：`creating → marked-delegated | rejected`

**入口接线清单**：`create` 在认定委派后 `marks.put` 合并

#### UF-006: 非法 tag

**前置状态**：任意。

**成功主路径**：不适用（本 UF 是失败合同）。

**失败分支**（本 UF 的主验证）：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 空字符串 | `--tag ""` | tag-invalid | 表无新行 | 改参数 |
| 超长 | 单 tag >128 字节 | tag-invalid | 同上 | 改参数 |

**界面状态机**：`idle → rejected`

**入口接线清单**：规范化函数，create/rename 共用

#### UF-007: 进程重启仍在

**前置状态**：UF-001 已写盘；杀掉 dsh web 再 `boot.sh`。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 停 web | — | 文件仍在 DSH_HOME | — |
| 2 | 再 boot + `list --tag kind:vibee` | 列表 | 重读 jsonl JOIN 新网关 list | 仍能命中 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 换了 DSH_HOME | 新 env | 空标记 | 正确：表跟 home 走 | 不要混 home |
| 网关有会话、表无行 | 仅官方创建 | tags=[] | 不编造 | 再 rename --tag |

**界面状态机**：`restart → rejoin`

**入口接线清单**：boot 不迁移文件；读路径固定 ASM-001

#### UF-008: 后期 UI 的查询入口

**前置状态**：混合 kinds。

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | `dsh-session marks list --kind kind:vibee` | id + tags | 只读表（可与网关求交丢掉已删会话） | 仅 vibee |
| 2 | `dsh-session marks get --id X` | 一行或 not-found | get(id) | 当前整组 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 未知 id | get 错 id | session-not-found 或空 | 不抛堆栈 | — |
| 无 --kind 的 list | 全表 | 全部有标记的会话 | 允许 | — |

**界面状态机**：`query → rows | empty`

**入口接线清单**：

- CLI `marks` 子命令
- `packages/session-marks` 导出 `listByKind` / `get`（vibee 后期 import）
- **不**在本包 `registerTab`

### 2.4 INV 不变量

| 不变量 ID | 内容 | 关联 BR/UF | 验证方式 |
|---|---|---|---|
| INV-001 | title / cwd / workspace / prompt 仍走官方网关，行为不因拆 vendor 变差 | BR-002 | 无 tag 的 create/write/list 回归 |
| INV-002 | 不向官方日志追加 `session/tags` | BR-001 | rg 写入 + inspect 日志 |
| INV-003 | 不改官方会话栏组件、不补丁 better-sidebar 内置 session list 行模型 | BR-010 | git diff 不含那些文件 |
| INV-004 | hiddenPrefixes 默认 `~` 仍生效 | BR-004 | UF-002 |
| INV-005 | 无 parent 的普通 create 不自动带 `kind:delegated` | BR-007 | UF-005 反例 |
| INV-006 | 拆 vendor 后无 `@deepseek-ai/dsh-session-tags` 依赖 | BR-009 | rg + package.json |

### 2.5 EVD 证据清单

| 证据 ID | 类型 | 期望证据 | 保存位置 |
|---|---|---|---|
| EVD-001 | CLI+file | create 输出 + marks.jsonl 摘录 | `evidence/UF-001/` |
| EVD-002 | CLI | 默认 list vs include-hidden | `evidence/UF-002/` |
| EVD-003 | CLI | list/collect --tag kind:vibee | `evidence/UF-003/` |
| EVD-004 | CLI+file | rename 后 jsonl 与 list | `evidence/UF-004/` |
| EVD-005 | test/CLI | 委派自动 kind | `evidence/UF-005/` |
| EVD-006 | CLI | tag-invalid 退出码与空写 | `evidence/UF-006/` |
| EVD-007 | CLI | 重启后 list | `evidence/UF-007/` |
| EVD-008 | CLI | marks list/get | `evidence/UF-008/` |
| EVD-009 | log | pnpm test / build | `evidence/phase-*/` |
| EVD-010 | log | rg 确认无 vendor、无 session/tags 写入 | `evidence/phase-4/` |

### 2.6 角色与权限矩阵

| 角色 | 可见 | 可操作 | 禁止 | 失败提示 | 验证场景 |
|---|---|---|---|---|---|
| CLI（人） | list 默认隐藏规则内的会话 | create/rename/list/collect/marks | 改别人会话仍受既有 fence（CLI 豁免 owner） | web-unreachable / tag-invalid | UF-001～004,006～008 |
| agent | 同 list 规则 + own/tree/all | 同工具面 | 超 fence / 超深度 | unauthorized / scope-denied | UF-005 |
| 后期 vibee | 仅通过 listByKind | 写自己创建的会话标记 | 改官方 list UI | — | 本包只验查询 API |
| 官方 GUI 用户 | 看不见标记列 | 无 | — | — | INV-003 |

单一产品无登录角色差异；权限沿用既有 session-tool fence。

### 2.7 负向 / 破坏性场景

| 场景 | Given | When | Then | Evidence |
|---|---|---|---|---|
| 空/非法 tag | 任意 | 空或超长 | tag-invalid，无半行 | EVD-006 |
| 网关失败 | 未 boot | create --tag | web-unreachable，不写表 | UF-001 失败 |
| 空数据 | 新 home | list / marks list | 空成功 | UF-002 |
| 重复 rename tags | 已有一组 | 再 rename 同一组 | 幂等覆盖，一行有效（last-wins） | EVD-004 |
| 旧数据 | 日志里曾有 session/tags 事件 | list --tag | **不**再读该事件，只认表（旧标签不迁移，ASM：不写迁移器） | EVD-010 说明 |
| 损坏 jsonl | 截断行 | list | 跳过坏行（ASM-002 补充：不崩） | phase 单测 |

### 2.8 非目标

- 不实现 vibee 对话页签或 better-sidebar「Workflows」tab（后期另包）。
- 不修改官方会话栏行、不给官方 list 打徽章。
- 不发布 `@deepseek-ai/dsh-session-tags`，不向官方提 tags RPC。
- 不把 parentSessionId / delegationDepth 存进标记表冒充 header。
- 不做 `session_mark`/`unmark` 加减口（整组替换）。
- 不迁移历史 `session/tags` 日志事件到 jsonl。
- 不启用 `boot.sh --lan`。

---

## 3. 技术方案

### 3.1 架构 Before / After

```text
Before:
  session_* --tag --> local --> SessionHttpClient
                                  丢弃 tags（假成功）
                    --> isTitleHidden(vendor)
                    --> tagsOf() 扫 session/tags 日志
                    --> bundle 挂 @deepseek-ai/dsh-session-tags

After:
  session_* --tag --> local --> 官方网关（title/cwd/workspace）
                            --> session-marks 文件表（真 tags）
                    --> isTitleHidden(本地十几行)
                    --> list JOIN 表；kind:hidden 与 ~ 双闸
                    --> 委派 create 合并 kind:delegated
                    --> listByKind / CLI marks   （后期 UI 入口）
                    --> vendor 与 bundle 行删除
```

### 3.2 模块改造

| 模块 | 职责 | 改造说明 |
|---|---|---|
| `packages/session-marks`（新建） | jsonl 存取、规范化、listByKind/get/put、懒 GC | 无 cordis 服务；纯库 |
| `session-tool-local` | 工具实现 | create/rename/list/collect 改走 marks；抄 isTitleHidden；删 vendor import |
| `session-client` | 网关 | 去掉 tags 回显假装写入；rename 只发 title |
| `tool-session` | bundle | 删除 session-tags insert 行；工具 schema 的 tags 语义改为「插件标记」文案 |
| `session-tool-cli` | CLI | create/list/rename/collect 接线不变；新增 `marks list/get` |
| `vendor/session-tags` | 旧平台仿品 | 删除目录并从 workspace 移除 |
| 后期 vibee / sidebar | 展示 | 本包不改；只保证能 import listByKind |

### 3.3 三段式定位清单

| 文件 | 稳定定位 | 搜索定位 | 行号 hint | 备注 |
|---|---|---|---|---|
| `packages/session-tool-local/src/index.ts` | `async create` / `async list` / `async rename` / `async collect` / `tagsOf` / `Config` | `rg "async create\|isTitleHidden\|tagsOf" packages/session-tool-local/src/index.ts` | L163 / L263 / L367 / L406 / L674 | 行号会因改动漂移 |
| `packages/session-tool-local/src/session-client.ts` | `class SessionHttpClient` `durableCreate` `rename` | `rg "Tags have no RPC\|durableCreate" packages/session-tool-local/src/session-client.ts` | L73 / L95 / L223 | 去掉假 tags 回写 |
| `packages/session-tool/src/index.ts` | `SessionToolCreateOptions.tags` | `rg "readonly tags" packages/session-tool/src/index.ts` | L38 | 注释改为插件标记 |
| `packages/tool-session/src/index.ts` | `name: 'session_create'` 等 | `rg "name: 'session_" packages/tool-session/src/index.ts` | L55+ | schema 文案 |
| `packages/tool-session/cordis.patch.yml` | `id: session-tags` | `rg "session-tags" packages/tool-session/cordis.patch.yml` | 文件内 insert 块 | 整段删除 |
| `packages/session-tool-cli/src/index.ts` | `command('create')` | `rg "command\\('create'\\)\|tags" packages/session-tool-cli/src/index.ts` | L403 | 加 marks 子命令 |
| `pnpm-workspace.yaml` | `vendor/session-tags` | `rg vendor/session-tags pnpm-workspace.yaml` | 文件首段 | 删除该行 |
| `vendor/session-tags/src/index.ts` | `isTitleHidden` `SessionTagsService` | `rg "export function isTitleHidden" vendor/session-tags/src/index.ts` | 函数在 vendor | 抄到 session-marks 后删仓 |
| `env/boot.sh` | `DSH_HOME` `npx ... rc.7` | `rg DSH_HOME env/boot.sh` | L11 L36 | 不改启动；表落此 home |
| better-sidebar `TabDescriptor` | `registerTab` `badge` `openTab` | 已勘察 | L159+ | 本包不改；handoff 写给后期 |

### 3.4 API / 数据 / 权限 / 路由影响

| 类型 | 是否影响 | 说明 | 兼容策略 |
|---|---|---|---|
| API | 是 | 工具参数名不变；语义从「平台 tags」改为「插件标记」；新增 CLI `marks` | 旧假成功变为真写入 |
| 数据 | 是 | 新文件 `$DSH_HOME/session-tool/marks.jsonl` | 不迁移旧日志事件 |
| 权限 | 否 | 沿用 fence / webUrl | — |
| 路由 | 否 | 无 HTTP 新路由；后期 sidebar 自建 | 本包不注册 tab |

---

## 4. Phase 计划与任务详情

> Phase 依赖链：

```text
P0 基线锁定
  → P1 session-marks 库
  → P2 接线 create/rename/list/collect + 双闸隐藏
  → P3 委派自动标 + listByKind/CLI marks
  → P4 拆除 vendor
  → P5 文档与回归
  → P6 真实场景全套 + 总回归
```

状态板：`tasks.csv`。

### Phase 0: 基线锁定

> 你在哪里：rc.7 已钉，tags 假写，vendor 仍在。
> 做完之后：基线测试记录 + 保留名写进仓库注释草案，工作区脏文件不误伤。

### Task 1: 记录测试与依赖基线

- **关联**：INV-001 / EVD-009 / UF NA（基线）
- **前置任务**：无
- **风险等级**：P0

**为什么做**：拆包前必须有「无 tag 路径」对照。

**涉及文件与定位**：`packages/**/tests/*.spec.ts`（见 1.3 find）

**具体操作**：

1. `cd plugin/session-tool/plugin && pnpm test` 记录通过/跳过数到 `evidence/phase-0/baseline-test.log`
2. `rg "dsh-session-tags|session/tags" packages vendor` 存 `evidence/phase-0/before-rg.txt`

**验证**：日志文件存在且含 vitest 汇总

**Evidence**：`evidence/phase-0/`

**注意事项**：不要在本任务改业务代码；工作区已有 rc.7 未提交改动，本需求 diff 只加 session-marks 相关

### Task 2: 执行 Phase 0 回归验证

- **关联**：Phase 0
- **前置任务**：1

**验证**：基线两份文件齐全

**Evidence**：`evidence/phase-0/phase-0-summary.md`

### Phase 1: session-marks 库

> 你在哪里：无标记存储。
> 做完之后：纯库可单测 put/get/listByKind/规范化/坏行。

### Task 3: 新增 packages/session-marks

- **关联**：BR-001 / BR-003 / BR-008 / EVD-009
- **前置任务**：2
- **风险等级**：P0

**为什么做**：跨插件契约的唯一写入点。

**涉及文件与定位**：新建 `packages/session-marks/src/index.ts`（`put`/`get`/`listByKind`/`normalizeMarks`）；`packages/session-marks/package.json` 加入 workspace

**具体操作**：

1. 实现 jsonl last-wins；路径 `join(dshHome, 'session-tool', 'marks.jsonl')`（dshHome 入参，默认 `process.env.DSH_HOME`）
2. 规范化 ASM-008；保留名当普通合法 token（无额外魔法，除文档）
3. 坏行跳过；`put` 原子写（tmp+rename）
4. vitest：规范化失败、覆盖、listByKind、GC 掉未知 id 集合

**验证**：`pnpm --filter session-marks test` 全绿

**Evidence**：`evidence/phase-1/unit.log`

**注意事项**：不要依赖 cordis；不要 import vendor

### Task 4: 执行 Phase 1 回归验证

- **关联**：BR-003 / BR-008
- **前置任务**：3

**验证**：`pnpm --filter session-marks test && pnpm --filter session-marks typecheck`（若有）

**Evidence**：`evidence/phase-1/`

### Phase 2: 接线工具实现

> 你在哪里：库有了，create 仍假写 tags。
> 做完之后：create/rename/list/collect 走表；双闸隐藏；client 不再假装写 tags。

### Task 5: local create/rename 写标记表

- **关联**：BR-002 / UF-001 / UF-004 / UF-006 / INV-001
- **前置任务**：4
- **风险等级**：P0

**为什么做**：纠错假成功。

**涉及文件与定位**：`async create` / `async rename` in `session-tool-local/src/index.ts`；`SessionHttpClient.rename`

**具体操作**：

1. create：网关成功后 `marks.put`；失败则不写表；tag 非法在调网关前拒绝（避免孤儿会话，若已采用「先网关」则文档化不回滚——优先先校验 tags）
2. rename：有 tags 则只写表；有 title 才调网关 rename
3. client 删除 tags 回显冒充写入
4. 改 service.spec / session-client.spec / tools.spec

**验证**：`pnpm --filter session-tool-local test` + `pnpm --filter tool-session test`

**Evidence**：`evidence/phase-2/write.log`

**注意事项**：先 normalize 再 create，避免孤儿

### Task 6: list/collect JOIN 标记表 + 双闸

- **关联**：BR-004 / BR-005 / BR-006 / UF-002 / UF-003 / INV-004
- **前置任务**：5
- **风险等级**：P0

**为什么做**：读路径离开日志和网关投影。

**涉及文件与定位**：`async list` L263；`async collect` L406；`tagsOf` L674；`isTitleHidden` import L21

**具体操作**：

1. 把 `isTitleHidden` 拷到 session-marks 或 session-tool-local 私有函数，删除 vendor import
2. `tagsOf` 改为 `marks.get`
3. list 行 `tags` 来自表；过滤 `~` 或 `kind:hidden`；include_hidden 放开
4. origin=delegated 改为含 `kind:delegated`（可兼容旧光杆 `delegated` 字符串一次，但不必读日志）

**验证**：同上 test + 新用例双闸

**Evidence**：`evidence/phase-2/list.log`

**注意事项**：网关投影 tags 忽略

### Task 7: 执行 Phase 2 回归验证

- **关联**：UF-001～004 / INV-001 / INV-004
- **前置任务**：6

**验证**：local + tool-session 测试全绿

**Evidence**：`evidence/phase-2/`

### Phase 3: 委派种类 + 查询面

> 你在哪里：手打 tags 已真。
> 做完之后：委派自动 kind；CLI/库可按 kind 查询。

### Task 8: 委派 create 合并 kind:delegated

- **关联**：BR-007 / UF-005 / INV-005
- **前置任务**：7
- **风险等级**：P1

**为什么做**：特殊会话种类位的第一个系统写入者。

**涉及文件与定位**：`async create` 判定 parent / agent caller

**具体操作**：有 parentSessionId（显式或 agent 默认）则 tags 并入 `kind:delegated`；CLI 无 parent 不并入

**验证**：service.spec 正反例

**Evidence**：`evidence/phase-3/delegated.log`

**注意事项**：不要把 depth 写入标记表

### Task 9: 导出 listByKind/get + CLI marks

- **关联**：BR-008 / UF-008 / ASM-004
- **前置任务**：8
- **风险等级**：P1

**为什么做**：后期 vibee/sidebar 的唯一入口。

**涉及文件与定位**：`session-marks` 导出；`session-tool-cli/src/index.ts` 新子命令 `marks`

**具体操作**：

1. CLI：`dsh-session marks list [--kind K]`、`dsh-session marks get --id ID`
2. README 写清后期 Web 只许吃这个 API
3. 测试 CLI 形状（不必真网关）

**验证**：`pnpm --filter session-tool-cli test`（若 e2e 仍跳过 worktree bin，至少 unit/解析）

**Evidence**：`evidence/phase-3/marks-cli.log`

**注意事项**：不要 registerTab

### Task 10: 执行 Phase 3 回归验证

- **关联**：UF-005 / UF-008
- **前置任务**：9

**验证**：相关单测绿

**Evidence**：`evidence/phase-3/`

### Phase 4: 拆除 vendor

> 你在哪里：新路径已接线。
> 做完之后：仓库不再有 session-tags 包。

### Task 11: 删除 vendor 与 bundle 挂载

- **关联**：BR-009 / INV-002 / INV-006 / EVD-010
- **前置任务**：10
- **风险等级**：P0

**为什么做**：去掉假平台包。

**涉及文件与定位**：`vendor/session-tags/`；`pnpm-workspace.yaml`；各 package.json `file:`；`cordis.patch.yml` session-tags 块；workspace.spec 若直接 import SessionTagsService

**具体操作**：

1. 删目录与 workspace 行
2. 所有 `@deepseek-ai/dsh-session-tags` 依赖去掉
3. `workspace.spec.ts` 等改为不挂该服务
4. `rg` 确认 packages 内无引用

**验证**：`rg "dsh-session-tags|vendor/session-tags" --glob '!docs/**'` 仅历史 md 或 0；`pnpm install && pnpm test && pnpm run build`

**Evidence**：`evidence/phase-4/remove-rg.txt` + test.log

**注意事项**：不要误删 session-title

### Task 12: 执行 Phase 4 回归验证

- **关联**：INV-006
- **前置任务**：11

**验证**：全仓 build+test

**Evidence**：`evidence/phase-4/`

### Phase 5: 文档

> 你在哪里：代码已齐。
> 做完之后：README/env 不再教 vendor。

### Task 13: 更新 README 与工具描述

- **关联**：BR-001 / BR-010 / ASM-006
- **前置任务**：12
- **风险等级**：P2

**为什么做**：避免执行者按旧 design.md 去挂 session-tags。

**涉及文件与定位**：`plugin/README.md`、`env/README.md`、`packages/session-tool/src/index.ts` 文件头「零新事件」表述、tool-session 工具 description

**具体操作**：写明 tags=插件标记；保留名列表；官方 GUI 不显示；后期 Web 用 listByKind

**验证**：人工读；`rg "零新增事件类型|session/tags 都是现成" packages` 无误导句

**Evidence**：`evidence/phase-5/`

### Task 14: 执行 Phase 5 回归验证

- **关联**：Phase 5
- **前置任务**：13

**验证**：build+test 仍绿

**Evidence**：`evidence/phase-5/`

### Phase 6: 真实场景与总回归

> 你在哪里：命令级绿。
> 做完之后：5.2 矩阵全过。

### Task 15: 执行 spec 5.2 真实场景全套测试

- **关联**：UF-001～008 全部主路径与失败分支 / EVD-001～008
- **前置任务**：14
- **风险等级**：P0

**为什么做**：CLI 真跑才算完成。

**涉及文件与定位**：按 5.2 环境准备

**具体操作**：按 5.2 矩阵逐行；每行落 evidence

**验证**：矩阵全过

**Evidence**：`evidence/UF-001/` … `evidence/UF-008/`

**注意事项**：禁止只交单测

### Task 16: 执行 Phase 6 回归验证

- **关联**：全部 BR/UF/INV
- **前置任务**：15

**验证**：5.1 命令再跑一遍 + 5.2 已归档 + `validate_package.py` 证据闸门

**Evidence**：`evidence/phase-6/`

---

## 5. 验收与 Review 协议

### 5.1 命令级验证（入场券）

| 验证项 | 命令 | 期望 | Evidence |
|---|---|---|---|
| 全仓测试 | `cd plugin/session-tool/plugin && pnpm test` | 业务 spec 全绿；CLI e2e 若仍缺 bin 可 skip 并在备注写明 | EVD-009 |
| 构建 | `pnpm run build` | exit 0 | EVD-009 |
| 无 vendor | `rg "dsh-session-tags" packages pnpm-workspace.yaml env` | 无依赖命中 | EVD-010 |

PATH 含 `/Users/dev/.nvm/versions/node/v24.18.0/bin`。

### 5.2 真实场景全套测试（Real-Run，完成的唯一标准）

**环境准备**：

| 项 | 值 |
|---|---|
| 启动命令 | `cd /Users/dev/workspace/dsh/plugin/session-tool/plugin && sh env/setup.sh && sh env/boot.sh` |
| 访问入口 | CLI：`pnpm exec dsh-session` 或包 bin（以 package.json `bin` 为准，待执行时 `cat packages/session-tool-cli/package.json` 确认） |
| 测试账号/数据 | 复制 `~/.dsh/.env` 到 `env/.env`（权限 600）；不提交密钥 |
| 干净状态定义 | 删 `$DSH_HOME/session-tool/marks.jsonl`；新会话用独立 title 前缀 `sm-` |
| 可用测试工具 | CLI + 读 jsonl；无浏览器自动化要求（本包无 Web 页） |

**执行矩阵**：

| UF | 执行方式 | 操作来源 | 必须核对的点 | Evidence |
|---|---|---|---|---|
| UF-001 主路径 | CLI | 2.3 UF-001 | jsonl 有行；list 含 tags | `evidence/UF-001/success.txt` + `marks.jsonl` 摘录 |
| UF-001 网关不可达 | CLI | 失败分支 | 非 0；无新 jsonl 行 | `evidence/UF-001/fail-web.txt` |
| UF-002 主路径 | CLI | 2.3 | 默认 1 条；include-hidden 3 条 | `evidence/UF-002/success.txt` |
| UF-002 空 home list | CLI | 失败 | 空成功 | `evidence/UF-002/empty.txt` |
| UF-003 主路径 | CLI | 2.3 | list 与 collect 都是 2 | `evidence/UF-003/success.txt` |
| UF-003 无匹配 | CLI | 失败 | 空非错误 | `evidence/UF-003/empty.txt` |
| UF-004 主路径 | CLI | 2.3 | 表替换；title 不变；默认 list 消失 | `evidence/UF-004/` |
| UF-004 空 rename | CLI | 失败 | empty-content | `evidence/UF-004/fail-empty.txt` |
| UF-005 主路径 | unit+能则 CLI | 2.3 | 自动 kind:delegated | `evidence/UF-005/` |
| UF-005 普通 create | CLI | 反例 | 无该 kind | `evidence/UF-005/plain.txt` |
| UF-006 两失败 | CLI | 2.3 | tag-invalid；文件无半行 | `evidence/UF-006/` |
| UF-007 主路径 | CLI | 2.3 | 重启后仍滤到 | `evidence/UF-007/` |
| UF-008 主路径 | CLI | 2.3 | marks list/get | `evidence/UF-008/` |
| UF-008 错 id | CLI | 失败 | not-found/空 | `evidence/UF-008/miss.txt` |

**通过标准**：上表全部行有 evidence 且行为与 2.3 一致。

### 5.3 Evidence 目录结构与命名

```text
evidence/
  phase-{N}/
  UF-{xxx}/
```

### 5.4 Review 专项检查清单

- [ ] `$DSH_HOME/session-tool/marks.jsonl` 是唯一持久化
- [ ] packages 内无 `@deepseek-ai/dsh-session-tags`
- [ ] 无代码向会话日志 append `session/tags`
- [ ] `isTitleHidden` 与 `kind:hidden` 双闸都测到
- [ ] 无 better-sidebar / 官方 list UI 改动
- [ ] `listByKind` 可被仓外 import（package exports）
- [ ] 5.2 矩阵全过，evidence 齐
- [ ] 2.3 入口（CLI + session_* 工具）均接线
- [ ] 保留名四枚写在 README
- [ ] 所有 BR/UF/INV 可对第 2 章核销
