# Evidence Directory

本目录用于保存执行和验收证据。没有 evidence，不视为完成。

## 结构

```text
evidence/
  phase-{0..5}/      # 每 Phase 命令输出、Phase summary
  UF-{001..006}/     # 真实场景回放:success/fail-{分支}/restart 等
  baseline.md        # P0 基线(两处 git HEAD + 测试数量)
  decisions.md       # P0 决策记录(continuable A/B、授权强度、等待语义、清理策略)
```

## 与 spec 2.5 EVD 清单对应

| EVD | 位置 |
|---|---|
| EVD-001 | evidence/UF-001/ |
| EVD-002 | evidence/UF-003/ |
| EVD-003 | evidence/UF-004/ |
| EVD-004 | evidence/UF-005/ |
| EVD-005 | evidence/UF-006/ |
| EVD-006 | evidence/phase-1/ |
| EVD-007 | evidence/phase-2/ |
| EVD-008 | evidence/phase-2/ |

规则：证据文件命名含场景与状态（如 `UF-001-success.log`、`UF-004-restart.png`）；
Phase 证据含命令输出 + summary；真实场景任务未完成时不得在 5.2 矩阵对应行标记完成。
