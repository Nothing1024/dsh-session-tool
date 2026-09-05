# Evidence Directory

本目录保存 `docs/dsh-0-1-2-upgrade` 的执行和验收证据。没有 evidence，不视为完成。

## 建议结构

```text
evidence/
  phase-0/
    typecheck-before.log
    typecheck-after-isolation.log
    test-baseline.log
  phase-1/
    typecheck.log
    build.log
  phase-2/
    in-process.log
    http-auth.log
  phase-3/
    unit.log
  phase-4/
    standard-check.log
    boot.log
    plugin-active.log
  UF-001/
    success.log
    fail-inject.log
  UF-002/
    success.log
    fail-401.log
  UF-003/
    wait-success.log
    collect-timeout.log
  UF-004/
    hide.log
  UF-005/
    boot.log
    ui.png
  UF-006/
    dead-web.log
```

## Evidence 命名

- `EVD-xxx` 必须能在 `spec.md` 第 2.5 节中找到。
- 截图文件名包含 UF 编号和状态：`UF-005-success.png`。
- 命令输出保存完整命令、时间、结果摘要。

## Phase Summary 模板

```markdown
# Phase {N} Summary

## 完成任务

- Task ...

## 验证命令

| 命令 | 结果 | 日志 |
|---|---|---|

## 用户路径 / API 验证

| UF/API | 结果 | Evidence |
|---|---|---|

## 剩余风险

- ...
```
