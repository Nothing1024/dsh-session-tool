# BR/UF/INV 逐条核销（T-023，2026-08-12）

## BR（行为需求）
| ID | 核销 |
|---|---|
| BR-001 持久平级会话 | ✓ 委派=durableCreate 平级会话（parentSession + delegationDepth）；父 dispose 后子会话仍可 prompt（UF-004 重启后 GUI 续写）；无 ownedChildren 残留（continuation 删除） |
| BR-002 生态契约零破坏 | ✓ 工具名/schema 不变（INV-002 测试）；SubagentProvider/SubagentRun 形状不变（契约测试）；subagent.list/history/prompt 形状不变（T-019 测试）；workflow/ralph 调用方式不变（provider 名换 session，配置值属部署） |
| BR-003 元数据持久可查 | ✓ delegationDepth/来源入 header；状态由 delegation 投影推导；tags 可过滤（session_list tags 过滤单测） |
| BR-004 状态从日志推导 | ✓ delegation 投影纯函数（turn/user/assistant 折叠）；重启后 session_list 状态正确（UF-004 restart.png） |
| BR-005 约束在插件层 | ✓ assertContinuationAllowed 仅插件工具路径；Config 默认 workspace；ASM-009 边界文档写明；单测覆盖 |
| BR-006 零新增事件类型 | ✓ 全程无新增 session/* 事件（coordinator 归因 = 既有 MessageSource 合并） |
| BR-007 收集声明式求值 | ✓ evaluateCollectPredicate 纯谓词（all/any/n/first-failed × continue/cancel-rest × timeout）；无依赖图/调度/重试 |

## UF（用户流程）
| ID | 核销 |
|---|---|
| UF-001 前台委派 | ✓ 真实回放（evidence/UF-001/success.log）：7×8 委派 → "7×8 等于 56。" coordinator 归因 |
| UF-002 后台续写 | ✓ 真实回放（evidence/UF-002/success.log）：send_message "9×9" → 子代理答 81；list_agents [complete] |
| UF-003 任务管理 | ✓ 真实回放（evidence/UF-003/success.log）：session_list 清单 + session_wait completed |
| UF-004 GUI | ✓ 浏览器实测（evidence/UF-004/）：侧边栏可见→打开→发送→实时回复；重启恢复；console 无应用错误 |
| UF-005 workflow/ralph | ✓ 真实回放（evidence/UF-005/workflow.log）：workflow 委派成功；ralph 失败分支正确；主路径单测 9 例 |
| UF-006 外部后端 | ✓ 单测回归（evidence/UF-006/backends.log）：acp 47/codex 35/claude 21/sdk 31 例 |
| UF-007 扇出收集 | ✓ 真实回放（evidence/UF-007/all.log）：wait-all satisfied + wait-n 提前返回；超时快照单测 |

## INV（不变量）
| ID | 核销 |
|---|---|
| INV-001 日志词汇不变 | ✓ rg 无新增 session/* 事件；append-only/surface 语义不变（env 全量） |
| INV-002 工具名/schema 不变 | ✓ tool-subagent/control 测试全绿（schema pin） |
| INV-003 RPC 形状不变 | ✓ api-proxy-subagents.spec.ts 14 例 pin |
| INV-004 旧日志只读 | ✓ list-children 62 例（descriptor fold）；descriptor 类型保留 |
| INV-005 provider 配置值不变 | ✓ workflow/ralph 的 subagentProvider 配置键不变（值 session 为部署配置） |

## EVD 对照
EVD-001 (UF-001/002) ✓ | EVD-002 (UF-003) ✓ | EVD-003 (UF-004) ✓ | EVD-004 (UF-005) ✓ |
EVD-005 (UF-006) ✓ | EVD-006 (phase-1) ✓ | EVD-007 (phase-2) ✓ | EVD-008 (重启) ✓ (UF-004/restart + phase-2/restart) | EVD-009 (UF-007) ✓
