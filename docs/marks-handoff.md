# 会话标记交接（接入方）

`session-tool` 的插件标记从「一个 `kind:` 扛所有事」拆成五条互不打架的轴。旧 token 仍可读、旧 API 仍在；**新写入请改用新词**，并丢掉自己仓里的 `get+put+锁`。

本文给已经接入的插件（当前：`vibee`、`dsh-bot` / `dsh-grok-bot`）和后来的接入方。契约实现在本仓；接入方各自改自己的仓。

## 为什么要改

`kind:` 同时回答了五件正交的事：谁的库存、什么形态、哪一个实例、有没有父、要不要藏。于是：

- `listByKind('kind:vibee')` 看起来像按「种类」查，实际是精确 token 匹配。
- `rename({ tags })` / `put` 整行覆盖，接入方只好自己 `get + put + 锁`，以免把 `kind:delegated` / `kind:hidden` 冲掉。
- 后期可视化、按轴过滤、按父会话聚合，都没法从 token 本身读出语义。

平台现在认：**前缀** `app:` / `form:` / `parent:`，**精确词** `child` / `hidden`。历史 `kind:*` / `delegated` 仍是合法别名。

## 五问五短 token

| 问题 | 新写法 | 旧写法（仍可读） | 例子 |
|---|---|---|---|
| 谁的库存？ | `app:<name>` | `kind:vibee` / `kind:dsh-bot` | `app:vibee`、`app:dsh-bot` |
| 什么形态？ | `form:plugin` / `form:agent` / `form:cli` / `form:script` | 没有对应轴 | 插件建的会话写 `form:plugin` |
| 哪一个实例？ | 产品自己的键 | 已有，继续用 | `vibee:<runId>`、`bot:<id>`、`group:`、`group-room:`、`peer:`、`routine:` |
| 有没有父？ | `child` + `parent:<sessionId>` | `kind:delegated` / `delegated` | 有意父时平台会自己写 |
| 要不要藏？ | `hidden` | `kind:hidden` | `hide()` 会双写两套拼写 |

自由标签（没有 `:` 的词，如 `plan`、`wip`）照旧，不进上述轴。

`app:` / `form:` / `parent:` 的冒号后是开放集。`form:` 建议先只用这四个值；以后有新形态再加词，不要再发明一个 `kind:`。

## 兼容性（先读再改）

平台**已经**做的：

- 读：`hidden` ≡ `kind:hidden`；`child` ≡ `kind:delegated` ≡ `delegated`。谓词用 `hasHiddenMark` / `hasChildMark`。
- 写：`create` / `mark` / `hide` / `rename` 对 hidden / child **双写**新词和旧词。
- 删：`unhide` / `mark({ remove: ['hidden'] })` 会把整族拼写一起拿掉（含裸 `delegated`）。
- `listByKind` 仍在，是 `listByMark` 的别名，**仍然是精确 token**，不是按轴前缀查。
- 新查询：`listByMark(token)`、`listByPrefix('app:')`。
- `sessionTool.mark({ add, remove })` 是合并 API；`rename({ tags })` 不再整行覆盖。

平台**不会**自动做的：

- **不会**把 `kind:vibee` 写成 `app:vibee`，也不会把 `kind:dsh-bot` 写成 `app:dsh-bot`。产品归属要接入方自己双写一段时间。
- **不会**给旧行补 `form:` / `parent:`。需要的话自己 `mark({ add })`。
- 官方 GUI **会话栏**仍然不读这张表。打开一条会话后，本仓 `ui-session-tool` 把 marks 投影到 `conversation.session.header.actions`。

## 接入方要改什么

分三档。旧数据先别删。

### 必须改（行为已经变了，或会静默丢信息）

1. **不要再 `get + put` 整行替换。** `put` 仍是 last-wins 整集覆盖。加一个自己的标，用：

   ```ts
   await ctx.sessionTool.mark(caller, sessionId, { add: ['app:dsh-bot', 'bot:xiaobei'] })
   ```

   或 CLI：`dsh-session session mark <id> --add app:dsh-bot --add bot:xiaobei`。

   接入方自己的 `withSessionLock` + `get` + `put`（vibee `markVibeeSession`、dsh-bot `mergeBotMarks`）可以删。平台 `patch` 已经串行。

2. **不要用 `rename({ tags })` 当「只改自由标签、系统标留下」的补丁。** 现在平台自己会 merge：自由标签整组替换；带 `:` 的结构化标以及 `child` / `hidden` / `delegated` 留下；传入的 `app:` / `form:` / `parent:` 只替换那一条轴。若你依赖「rename 清空所有标」，现在不会发生——要摘标用 `mark({ remove })`。

3. **隐藏判定不要只 `tags.includes('kind:hidden')`。** 改用 `hasHiddenMark(tags)`（`session-marks` 导出）。`hide()` / `unhide()` 已经双写 / 双删，不要再手写 `put(..., ['kind:hidden'])`。

4. **子会话判定不要只看 `kind:delegated`。** 改用 `hasChildMark(tags)`。有意父（`create({ parentSessionId })`，或 agent 默认父=自己）时，平台已经写入 `child` + `kind:delegated` + `parent:<id>`。接入方 create 时不必再塞 `delegated`。

### 应该改（新写入对齐，旧行继续能查到）

5. **产品归属双写一段时间。** 新会话同时打新词和旧词，旧 `listByKind('kind:…')` 不立刻断：

   | 产品 | 新写入 | 过渡期一并写上 |
   |---|---|---|
   | vibee | `app:vibee` | `kind:vibee` |
   | dsh-bot | `app:dsh-bot` | `kind:dsh-bot` |

   查库存：过渡期 `listByMark('app:…')` 与 `listByMark('kind:…')` 取并集；迁移完成后只查 `app:`。不要用 `listByKind` 当「按种类前缀查」。

6. **形态打 `form:`。** 插件建的会话写 `form:plugin`；agent 自己开的写 `form:agent`；脚本 / CLI 各自写 `form:script` / `form:cli`。可视化以后按这个轴着色，不要再塞进 `kind:`。

7. **产品键保持现有前缀，不要改成 `kind:`。** `bot:` / `vibee:` / `group:` / `group-room:` / `peer:` / `routine:` 已经是实例键，接着用。按人设列表继续 `listByMark('bot:<id>')`（或现有的 `listByKind(botMark(id))`，名字而已）。

8. **create 一次写齐，不要 create 后再 merge 同一批标。** 平台 `create({ tags })` 会 `expandWriteAliases`。有意父时还会并上 `child` + `parent:<id>`。create 后再 `mergeBotMarks` / `markVibeeSession` 是重复劳动。

### 可以先不动

- 标题隐藏前缀 `~` / `~dsh-bot: ` / `~dsh-bot-group:`：这是第二道闸（`hiddenPrefixes`），和 `hidden` 标记正交，继续有效。
- `ui:aux`：历史保留名，仍合法；新代码不要再写。
- 只读 CLI：`marks list --kind kind:dsh-bot` 仍可用；新脚本用 `--mark` / `--prefix`。

## 接入方对照

### vibee（`plugin/packages/vibee-host`）

现状：

- `marks.ts`：`VIBEE_KIND = 'kind:vibee'`，`get + put + 锁` 合并。
- `nodes/delegated-session.ts`：`create({ parentSessionId, tags: ['delegated', 'vibee:<runId>'] })`，再 `markVibeeSession`，再 `hide({ syncToArchived: false })`。

建议：

```ts
await ctx.sessionTool.create(caller, {
  parentSessionId,
  title,
  tags: ['app:vibee', 'kind:vibee', 'form:plugin', `vibee:${runId}`],
})
await ctx.sessionTool.hide(caller, sessionId, { syncToArchived: false })
```

`parentSessionId` 在时不必写 `delegated` / `child`。`markVibeeSession` 和那把锁可以删。查 run 仍用 `listByMark('vibee:' + runId)`；查库存过渡期并上 `kind:vibee` 与 `app:vibee`。

### dsh-bot（`plugin/packages/dsh-bot-host`）

现状：

- `marks.ts`：`DSH_BOT_KIND = 'kind:dsh-bot'`，`DSH_BOT_HIDDEN_KIND = 'kind:hidden'`，`DSH_BOT_CHAT_KIND = 'kind:dsh-bot-chat'`，`mergeBotMarks` = `get + put + 锁`。
- `ask.ts` / `workbench-sessions.ts`：create 已带 tags，随后又 `mergeBotMarks` 同一批。
- 列表：`listByKind('kind:dsh-bot')` / `listByKind(botMark(id))`。
- 辅助会话：`tags.includes('kind:hidden')`。

建议：

```ts
export const DSH_BOT_APP = 'app:dsh-bot'
export const DSH_BOT_KIND = 'kind:dsh-bot' // 过渡期双写

const tags = [DSH_BOT_APP, DSH_BOT_KIND, 'form:plugin', botMark(botId)]
await sessionTool.create(caller, { title, tags, parentSessionId })
// 隐藏走 hide()，不要再往 tags 里塞 kind:hidden 再 merge
await sessionTool.hide(caller, sessionId, { syncToArchived: false })
```

- `kind:dsh-bot-chat` 是产品自己的形态细分，可以留，或收成自由标签 / 另一个产品键（例如继续当精确 token）。**不要**把它理解成平台 `form:`。
- `isAuxiliaryBotSession`：`hasHiddenMark(tags)`，不要只认 `kind:hidden`。
- `mergeBotMarks` 改成 `sessionTool.mark({ add })`；补标对账（`reconcile.ts`）同样用 `mark`，不要 `put` 整行。
- 过渡期列表：`listByMark('app:dsh-bot')` ∪ `listByMark('kind:dsh-bot')`。`bot:` / `group:` / `peer:` / `routine:` 查询不用改。

## 推荐写入形状

一条插件建的、有父的、要藏的会话，落盘后大致是：

```text
app:dsh-bot
kind:dsh-bot          ← 过渡期
form:plugin
bot:xiaobei
child
kind:delegated        ← 平台双写
parent:session-…
hidden
kind:hidden           ← hide() 双写
```

 vibee 把 `app:dsh-bot` / `bot:` 换成 `app:vibee` / `vibee:<runId>`。

## 查询怎么写

| 目的 | 用这个 |
|---|---|
| 某一条精确标 | `listByMark('app:dsh-bot')` 或仍可用的 `listByKind(...)` |
| 某一轴全部 | `listByPrefix('app:')` / `listByPrefix('parent:')` / `listByPrefix('bot:')` |
| 是否隐藏 | `hasHiddenMark(tags)` 或 `sessionTool.getVisibility` |
| 是否子会话 | `hasChildMark(tags)`；父 id 用 `parseParentMark(tags)` |
| CLI 调试 | `marks list --mark app:dsh-bot`；`marks list --prefix app:`；`--kind` 仍是精确匹配 |

`sessionTool.list({ tags: [...] })` 仍是**交集**（行必须同时带上列出的每一个 token）。过渡期不要把 `app:` 和 `kind:` 都放进同一个 `tags` 过滤——旧行只有其中一个。

## 不要做

- 不要再发明 `kind:hidden-from-rail`、`kind:aux`、`kind:child`。隐藏用 `hidden` / `hide()`，子会话用 `child` + `parent:`。
- 不要把产品键写进 `app:`（`app:bot-xiaobei` 是错的；`app:dsh-bot` + `bot:xiaobei` 才对）。
- 不要把形态写进 `app:`（`app:plugin` 是错的；`form:plugin` 才对）。
- 不要直接改 `$DSH_HOME/session-tool/marks.jsonl`。走 `sessionTool.mark` / `session-marks.patch`。
- 不要在官方 `session/tags` 事件里写这些标。插件表与官方日志是两套东西。
- 不要假设 `listByKind('kind')` 能列出所有 `kind:*`。它只会列出刚好等于 `kind` 的行。

## 接入方自检

- [ ] 新 create 带 `app:<自己>`，过渡期仍带旧 `kind:<自己>`。
- [ ] 插件会话带 `form:plugin`（或对应形态）。
- [ ] 实例键仍用自己的前缀，没有改成 `kind:`。
- [ ] 有意父只传 `parentSessionId`，不再手写 `delegated`。
- [ ] 隐藏走 `hide()` / `unhide()`，判定走 `hasHiddenMark`。
- [ ] 仓内没有 `get + put + 锁` 的合并函数。
- [ ] 没有调用 `put` 覆盖整行（除非你真的要清空重写，并且自己拼好所有轴）。
- [ ] 列表过渡期对 `app:` 与旧 `kind:` 取并集。
- [ ] 单测改认双写后的集合（`hidden` **和** `kind:hidden`；`child` **和** `kind:delegated`）。
- [ ] README / 运维命令把 `--kind kind:…` 旁注成「精确匹配，过渡期」；新示例用 `--mark` / `--prefix`。

## 本仓入口

- 契约：`packages/session-tool/src/index.ts`（`create` / `rename` / `mark` / `hide` / `unhide` / `list`）
- 标记库：`packages/session-marks/src/index.ts`（前缀、别名、`listByMark` / `listByPrefix`、`hasHiddenMark` / `hasChildMark`）
- CLI：`dsh-session session mark`、`dsh-session marks list --mark|--prefix|--kind`
- 仓内说明：根目录 `README.md`「插件标记（tags）」
