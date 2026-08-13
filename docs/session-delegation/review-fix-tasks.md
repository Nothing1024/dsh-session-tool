# session-delegation Review Fix Tasks

> 来源：`review-report.md`（2026-08-13）。2026-08-13 现场补跑后全部完成。

| 序号 | 关联 | 名称 | 验证 | 状态 |
|---|---|---|---|---|
| F-001 | BUG-001 / UF-001 | headless 在 web 不可达时现场跑 `subagent` 创建失败 | 报 `web-unreachable`（或等价网关错误）、零新会话；日志进 `evidence/UF-001/fail-create.log` | 已完成 |
| F-002 | BUG-001 / UF-002 | Config=`creator` 下非创建者 `send_message`/`session_write` 现场拒绝 | 投递失败且目标日志无新 `user/message`；进 `evidence/UF-002/fail-auth.log` | 已完成 |
| F-003 | BUG-001 / UF-005 | workflow fan-out 3 真实跑通（不是 1 个 math agent） | 3 个子会话持久 + 收集结果；进 `evidence/UF-005/workflow.log` | 已完成 |
| F-004 | BUG-001 / UF-007 | `session_collect`：wait-n n=2 + cancel-rest；另开慢会话打 timeout | n=2 提前返回且其余 cancelled（不删除）；timeout 返回 `satisfied:false` 不报错 | 已完成 |
| F-005 | BUG-002 / UF-004 | 重启 web 后重截 GUI：侧边栏 + 打开委派会话 transcript | 替换 `evidence/UF-004/restart.png`，画面须能辨认会话 | 已完成 |
| F-006 | BUG-003 | 更新 `tasks.csv`：T-021 改为已完成（已有 phase4-regression.log）；T-003 补跑或注明与 T-001 合并 | CSV 无「待开始」；T-023 备注不再写「全部已完成」除非属实 | 已完成 |
| F-007 | BUG-004 | 改 spec 5.1：env 全量与 apiproxy 344 口径分开；登记允许失败的环境类测试 | 5.1 与 P0 baseline / T-023 数字不再互相打架 | 已完成 |
| F-008 | BUG-005 / BUG-006 | 刷新 `handoff.md`；清 `types.ts` continuation 注释、knip `subagent-spawn`、`docs/subsystems/subagent.md` 过期描述 | rg 无 ContinuationManager 实现引用；handoff 不再要求 T-002 拍板 | 已完成 |

现场环境：`DSH_HOME=/Users/dev/.dsh/review-fix-home`，web `http://127.0.0.1:3299`。原始 JSON：`f003-out.json` / `f004-out.json`。
