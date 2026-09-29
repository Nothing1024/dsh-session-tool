# Evidence Directory

本目录用于保存执行和验收证据。没有 evidence，不视为完成；空文件（0 字节）不算证据，校验脚本会判失败。

## 本包结构（以 spec.md 5.3 为准）

```text
evidence/
  phase-0/exit.log
  phase-1/task-2.log task-3.log exit.log early-timing.log [profile.log]
  UF-001/before-timing.log before-ids.txt
         after-timing.log after-ids.txt ids.diff v3-rows.log fallback.log
  UF-002/before-cli.json after-cli.json cli-diff.log tool.log status-filter.log cold-fallback.log
  UF-003/before-panel.tsv after-panel.tsv panel.diff status-filter.tsv error.json browser.log
  final/regression.log
```

不得写入 `DSH_LAUNCH_TOKEN`、带 token 的 launch URL、cookie jar 或登录 cookie。3084 `listSessions` 与 3081 面板接口的响应原文含真实会话标题，只放 `/tmp/session-list-perf/`，这里只存 id 列表和 `sessionId → delegationStatus` 映射。

## Evidence 命名

- `EVD-xxx` 必须能在 `spec.md` 第 2.5 节中找到。
- 截图文件名包含 UF 编号和状态：`UF-001-success.png`。
- API 文件名包含场景和状态：`API-permission-denied-response.json`。
- 命令输出保存完整命令、时间、结果摘要。

## Phase Summary 模板

每个 Phase 最后一条任务完成后写 `phase-{N}/summary.md`：

```markdown
# Phase {N} Summary

## 完成任务

- Task ...

## 验证命令（含出口检查）

| 命令 | 结果 | 日志 |
|---|---|---|

## 用户路径 / API 验证

| UF/API | 结果 | Evidence |
|---|---|---|

## 剩余风险

- ...
```
