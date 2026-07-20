# 能力矩阵

本文快速区分“已经实现”“默认可用”“需要配置”和“是否跨重启持久化”。详细操作见 [WEB_CAPABILITIES.md](WEB_CAPABILITIES.md)。

## 状态说明

- **默认**：正常本机配置即可使用；
- **条件**：需要 HTTPS、VAPID、feature flag、账号或 app-server 能力；
- **进程内**：gateway 重启后不保证保留；
- **原生**：由 Codex app-server thread 持久化；
- **浏览器**：保存在当前浏览器 IndexedDB/localStorage。

## 核心聊天与输出

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| 普通对话 | 默认 | 输入框/发送 | ACK + text delta + result | 原生 thread |
| Reasoning | 条件于模型/协议 | 消息区 | summary/full reasoning | 原生事件/历史能力取决于 app-server |
| 命令与工具 | 默认，受权限约束 | Codex 发起 | 卡片、实时输出、exit code | 原生 thread |
| MCP/Search | 条件于配置/模型 | Codex 发起 | MCP/Search 卡片 | 原生 thread |
| File change/Diff/Plan | 默认，取决于任务 | 消息区或 slash 命令 | 结构化卡片 | 原生 thread |
| 中断 | 默认 | `■` | ACK + turn 终态 | 不持久化为浏览器状态 |
| Steer/队列 | 条件于活跃 turn | 运行中继续发送 | steered/queued receipt | runtime 进程内队列 |

## 历史、恢复与多设备

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| Thread 列表/历史/续接 | 默认 | Threads/历史抽屉 | thread/list/read/resume | Codex 原生 |
| Rename/Archive/Delete | 默认 | thread 操作菜单 | ACK + thread event | Codex 原生 |
| Compact/Rollback/Fork | 默认，取决于协议 | 抽屉/标签 | ACK + 更新 thread | Codex 原生 |
| 多 runtime 标签 | 默认 | 顶部标签 | scoped init/events | gateway 进程内 |
| 多设备视图隔离 | 默认 | 各设备独立操作 | 目标 room 事件 | 每 Socket 视图 |
| 短断线 catch-up | 默认 | 自动 | seq/epoch 增量 | runtime 有界 buffer |
| Gap snapshot 重建 | 默认 | 自动 | thread/read snapshot | Codex 原生 |
| Outbox | 默认 | 自动 | pending/reconcile 状态 | 浏览器 IndexedDB |
| Receipt ledger | 默认 | 自动 | duplicate/receipt replay | gateway 进程内 |
| Needs-you 聚合 | 默认 | 顶部待办区 | revisioned snapshot/change | gateway 进程内 |

## 输入、控制面与移动能力

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| 文本 | 默认 | 输入框 | user message + ACK | outbox/原生 thread |
| 文件附件 | 默认 | `+` | mention/localImage | owner-only 临时文件 |
| Workspace mention | 默认 | 结构化输入 | mention | 必须在 runtime cwd 内 |
| Skill | 条件于 enabled skills | Skills | skill input | 发送前重新校验 |
| 模型/reasoning/权限 | 条件于账号/模型 | 输入区弹层 | runtime 配置/ACK | 当前 runtime |
| Files/Account/MCP/Skills | 默认只读，取决于 app-server | 抽屉 | 原生数据面板 | 不复制为第二事实源 |
| 外部配置 Import | 条件于检测结果 | Import | importId/状态事件 | app-server 管理 |
| PWA | 条件于安全上下文 | 浏览器安装 | standalone 页面 | 浏览器安装状态 |
| Web Push | 条件于 HTTPS+VAPID+批准设备 | Push 入口 | 系统通知 | 设备绑定订阅持久化 |

## 条件能力与持久化边界

| 能力 | 默认状态 | 启用条件 | 主要限制 |
|---|---|---|---|
| Remote image URL | 关闭 | `CODEX_ALLOW_REMOTE_IMAGES=1` | 仅公网 HTTPS，DNS pin/SSRF 校验 |
| Labs | 关闭 | `CODEX_P3_EXPERIMENTAL=1` | 实验 API，进程 ID 精确归属 |
| Admin | 关闭 | `CODEX_ADMIN_ENABLED=1` + unlock + 每动作确认 | TTL、限流、owner-only 审计 |
| ChatGPT device login | 条件 | app-server/账号支持 | device code 生命周期 |
| 跨 gateway exactly-once | 不提供 | — | ledger 不持久化；未知写不盲发 |
| 草稿持久化 | 不提供 | — | 未发送文本刷新可能丢失 |
| Needs-you 跨 gateway 恢复 | 不提供 | — | registry 是进程内状态 |

如果页面入口与本表不一致，先检查 feature manifest、`.env` 和本机 app-server 能力，再查看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
