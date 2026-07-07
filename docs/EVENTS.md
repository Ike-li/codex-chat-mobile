# Socket.IO 事件契约索引

浏览器与 `server.js` 之间的 Socket.IO 事件是前端的稳定契约（协议升级时刻意与 app-server 解耦）。本文件是事件索引，只列「事件 → 方向 → 用途 → 定义位置 → 契约测试」，不重复字段细节——字段以对应契约测试和 `agent-appserver.js` 映射为准。协议方法侧见 [PROTOCOL.md](PROTOCOL.md)。

行号随代码漂移，定位以事件名 grep 为准。

## 客户端到服务端

除注明外均为 `emitWithAck`（带 ack 回执 `{ok:true,...}` / `{ok:false,error}`）。

| 事件 | ack | 用途 | 定义 |
|---|---|---|---|
| `user:message` | 无 | 发送/追加用户消息（busy 时按状态入队或 steer） | `server.js` |
| `user:interrupt` | 无 | 中断当前 turn | `server.js` |
| `user:approval` | 无 | 回传审批决议 | `server.js` |
| `user:approveDevice` / `user:denyDevice` | 无 | 批准/拒绝待审设备 | `server.js` |
| `session:new` / `session:list` / `session:select` / `session:fork` / `session:history` | 有 | 会话创建/列举/切换/分叉/历史 | `server.js` |
| `session:switch` | 无 | 切换当前查看的实例 | `server.js` |
| `catch-up` | 有 | 按最后 seq 增量补发错过的事件 | `server.js` |
| `thread:list` / `thread:select` | 有 | app-server 原生线程列举/加载 | `server.js` |
| `thread:archive` / `thread:unarchive` / `thread:delete` / `thread:rename` | 有 | 线程管理 | `server.js` |
| `thread:compact` / `thread:rollback` | 有 | 压缩上下文 / 回退 N 轮 | `server.js` |
| `models:read` | 有 | 读取可用模型 | `server.js` |
| `account:read` / `account:loginStart` / `account:loginCancel` | 有 | 账号信息 / 设备码登录 / 取消登录 | `server.js` |
| `fs:readDirectory` / `fs:readFile` | 有 | 只读文件系统 | `server.js` |
| `mcp:read` / `skills:read` | 有 | MCP 状态 / skills 列表 | `server.js` |
| `externalAgentConfig:detect` / `externalAgentConfig:import` | 有 | 检测/导入外部 agent 配置 | `server.js` |
| `p3:*`（`capabilities` / `terminalSpawn` / `terminalWrite` / `terminalResize` / `terminalTerminate` / `threadTurns` / `threadSearch`） | 有 | Labs 实验能力；flag 关闭时立即 `{ok:false}` | `server.js` |
| `admin:unlock` / `admin:lock` | 有 | 解锁需固定短语 `ENABLE ADMIN` | `server.js` |
| `admin:*`（`configWrite` / `configBatchWrite` / `pluginInstall` / `pluginUninstall` / `marketplaceAdd` / `marketplaceRemove` / `marketplaceUpgrade` / `fsWriteFile` / `fsRemove` / `fsCopy` / `mcpToolCall` / `accountLogout`） | 有 | 破坏性操作，需 unlock + 逐操作 `adminConfirm === eventName`，写 owner-only 审计 | `server.js` |

## 服务端到客户端

所有服务端事件统一走 `agent:event` 单信封（`{seq, epoch, sessionId, instanceId, cwd, ts, type, payload}`），按 `type` 区分。裸事件仅 `pending_devices` 等设备流。信封类型清单见下一节。

## agent:event 信封类型

| type | 用途 | 生成位置 |
|---|---|---|
| `device_status` / `pending_devices` | 设备认证状态 / 待审列表 | `server.js` |
| `init` | 连接建立、线程选中初始化 | `server.js` |
| `status` / `status_line` | 会话状态快照（busy/idle）/ git+context 状态行 | `agent-appserver.js` `emitStatus()` / `server.js` |
| `instances` / `session_list` | 实例列表 / 会话列表广播 | `server.js` |
| `thread_event` | 原生线程事件（archived/name_updated…） | `agent-appserver.js` |
| `user_message` / `queued_message` / `dequeued_message` / `queue_cleared` | 用户消息落盘 / 队列进出与清空 | `agent-appserver.js` |
| `text_delta` | 助手文本增量 | `agent-appserver.js` |
| `reasoning` | 推理增量/摘要（`channel`/`kind` 分区渲染） | `agent-appserver.js` |
| `tool_use` / `tool_result` / `tool_output_delta` | 命令/工具调用开始/结果/输出增量 | `agent-appserver.js` |
| `mcp_use` / `mcp_result` / `search` | MCP 工具调用/结果 / Web 搜索结果 | `agent-appserver.js` |
| `file_change` / `diff` / `plan` | 文件变更总结 / diff / 计划面板 | `agent-appserver.js` |
| `term_output` / `term_exit` | P3 终端输出/退出 | `agent-appserver.js` |
| `approval_request` / `user_input_request` / `approval_revoked` | 审批请求 / 用户输入请求 / 服务端撤销 | `approval-broker.js` |
| `account_login` / `account_updated` / `rate_limits` / `usage` | 登录状态 / 账号更新 / 限流 / token 用量 | `agent-appserver.js` |
| `compact` / `rollback` | 压缩完成 / 回退完成 | `agent-appserver.js` / `server.js` |
| `mcp_status` / `skills_changed` / `external_agent_config_import` | MCP 状态 / skills 变化 / 外部配置导入进度 | `agent-appserver.js` |
| `realtime` / `remote_control` | P3 实时会话（含 `started`/`sdp`/`transcript_delta` 等子类型）/ 远程控制状态 | `agent-appserver.js` |
| `result` / `error` / `system` | turn 终态 / 错误 / 系统消息 | `agent-appserver.js` / `server.js` |
| `raw_item` | 未识别 item 的可见兜底信封 | `agent-appserver.js` |

`approval_request` / `user_input_request` 的 `kind` 取值即协议审批方法：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、旧式 `applyPatchApproval`、`execCommandApproval`（见 `approval-broker.js`）。

## 契约测试位置

| 范围 | 测试文件 |
|---|---|
| Socket.IO 路由、ack、鉴权边界、loopback 规则、设备信任、Admin/Labs 门控 | `test/server-integration.test.mjs`、`test/server-security.test.mjs` |
| app-server JSON-RPC 生命周期、队列、中断、steer、事件映射 | `test/agent-appserver.test.mjs`、`test/agent-appserver-branches.test.mjs`、`test/protocol-adaptation.test.mjs` |
| 审批分类与决议 | `test/approval-broker.test.mjs` |
| 前端信封渲染契约 | `test/public-ui.test.mjs` |
| E2E 端到端事件流 | `e2e/critical-flows.spec.js`、`e2e/rich-event-rendering.spec.js`、`e2e/native-controls.spec.js`、`e2e/instances.spec.js`、`e2e/browser-runtime.spec.js` |
