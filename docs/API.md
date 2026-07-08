# 接口参考

本文件是 codex-chat-mobile 对外接口的完整参考：浏览器客户端能调用的 **HTTP 路由** 和 **Socket.IO 事件**（含参数与返回签名），以及服务端回流的 **agent:event 信封**。这是网关自身暴露的接口面；它背后消费的 Codex app-server JSON-RPC 协议见 [PROTOCOL.md](PROTOCOL.md)，端到端数据流见 [ARCHITECTURE.md](ARCHITECTURE.md)。

行号随代码漂移，定位以事件名/路由 grep 为准。字段以 `server.js` 实际读取的 `payload.xxx` 为准，不含未使用字段。

## HTTP 接口

Express 路由集中在 `server.js`。静态资源经 `express.static` 提供 `public/`（`index.html`、`js/sw.js` 带 `Service-Worker-Allowed: /`、`manifest.webmanifest`、图标）。

| 方法 · 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `GET /health` | 需 token | — | `{status, sessionId, busy, sessionState, versions, timestamp}` |
| `GET /push/vapid-public-key` | 无 | — | `{key}`；push 未配置 → `503 {error}` |
| `POST /push/subscribe` | 无 | `application/json`（PushSubscription，≤4kb，须含 `endpoint`） | `{ok:true}`；未配置 → `503`；无 `endpoint` → `400 {error}` |

鉴权由两层中间件承担：`noTokenLocalOnly`（`AUTH_TOKEN` 为空时拒绝非 loopback 请求）与 `httpAuth`（校验 `?token=` 查询参数或 `x-auth-token` 头，timing-safe 比较）。文件上传 **不走 HTTP**，而是随 `user:message` 事件的 `attachments` 内联传输（见下）。

## Socket.IO 客户端到服务端

事件经 `on(socket, 'event', handler)` 注册；handler 抛错会自动回一条 `error` 信封。带 ack 的事件回执统一为 `ackOk`→`{ok:true, ...}` 或 `ackError`→`{ok:false, error}`。多数字段直接读取、无强校验，下表「参数」只列代码实际访问的字段（**必填** / 其余可选）。所有 `*` 读取类事件都接受可选 `cwd` 选择工作区。

### 核心交互

| 事件 | 参数 | 返回 |
|---|---|---|
| `user:message` | `text`（≤50000）、`attachments[]`（可选，二选一非空） | 无 ack，异步经 `agent:event` 回流 |
| `user:interrupt` | — | 无 ack；中断当前 turn（`ai.abort()`） |
| `user:approval` | **approvalId**、**decision**（+ 透传字段） | 无 ack；决议经 `approval_revoked` / 后续事件反映 |

`attachments[]` 每项含 `name` / `mimeType` / `dataBase64`，经 `validateAttachments` 校验后 `saveAttachments` 以 owner-only 落盘，再把绝对路径注入提示词。

### 会话 session:*

| 事件 | 参数 | 返回 |
|---|---|---|
| `session:new` | `cwd` | `{ok:true}` |
| `session:list` | — | `{sessions, codexSessions, currentSessionId}`；无 ack 时改发 `session_list` 信封 |
| `session:select` | **sessionId**（可为字符串） | `{ok:true, sessionId}` |
| `session:fork` | `instanceId`、`threadId`、`ephemeral`、`title` | `{ok:true, sessionId, instanceId}` |
| `session:switch` | **instanceId** | 无 ack；切换 `viewingInstanceId` |
| `session:history` | **sessionId**（可为字符串） | `{messages, title}` |

### 线程 thread:*

映射到 app-server 原生 thread。

| 事件 | 参数 | 返回 |
|---|---|---|
| `thread:list` | `archived`、`limit`(50)、`cursor`、`searchTerm` | `{ok:true, threads, nextCursor, backwardsCursor, archived}` |
| `thread:select` | **threadId**\|**sessionId**、`title` | `{ok:true, sessionId, instanceId}` |
| `thread:history` | **threadId**\|**sessionId**、`cwd` | `{ok:true, thread, messages, source:"thread/read"}` |
| `thread:archive` / `thread:unarchive` / `thread:delete` | **threadId** | `{ok:true, threadId}` |
| `thread:rename` | **threadId**、**name** | `{ok:true, threadId, name}` |
| `thread:compact` | **threadId** | `{ok:true, threadId}` |
| `thread:rollback` | **threadId**、`numTurns` | `{ok:true, thread}` |

### 账号 account:*

| 事件 | 参数 | 返回 |
|---|---|---|
| `account:loginStart` | `type`（须 `chatgptDeviceCode`） | `{ok:true, loginId, verificationUrl, userCode}` |
| `account:loginCancel` | **loginId** | `{ok:true, status}` |
| `account:read` | `cwd` | `{ok:true, account, usage, rateLimits}` |

### 只读资源

| 事件 | 参数 | 返回 |
|---|---|---|
| `models:read` | `includeHidden` | `{ok:true, models, nextCursor, capabilities}` |
| `fs:readDirectory` | `path`(默认 WORK_DIR) | `{ok:true, entries, path}` |
| `fs:readFile` | **path** | `{ok:true, dataBase64, path}` |
| `mcp:read` | `limit`(50) | `{ok:true, servers, nextCursor}` |
| `skills:read` | `forceReload` | `{ok:true, entries}` |
| `externalAgentConfig:detect` | `includeHome` | `{ok:true, items}` |
| `externalAgentConfig:import` | **migrationItems[]** | `{ok:true, importId}` |

### 设备审批与断线恢复

| 事件 | 参数 | 返回 |
|---|---|---|
| `user:approveDevice` / `user:denyDevice` | **deviceId** | 无 ack；仅已授权设备可调用 |
| `catch-up` | **sessionId**、**lastSeq** | `{replayed, gap}`（增量补发错过的事件） |

### Labs 实验 p3:*（需 `CODEX_P3_EXPERIMENTAL=1`）

flag 关闭时立即 `{ok:false, error}`。

| 事件 | 参数 | 返回 |
|---|---|---|
| `p3:capabilities` | — | `{ok:true, capabilities}` |
| `p3:terminalSpawn` | `processId`、`command[]`、`cols`(80)、`rows`(24) | `{ok:true, processId, result}` |
| `p3:terminalWrite` | **processId**、`text`、`closeStdin` | `{ok:true, processId}` |
| `p3:terminalResize` | **processId**、`cols`、`rows` | `{ok:true, processId}` |
| `p3:terminalTerminate` | **processId** | `{ok:true, processId}` |
| `p3:threadTurns` | **threadId** | 透传 agent 响应 |
| `p3:threadSearch` | **query**、`limit`(20)、`cursor`、`archived` | 透传 agent 响应 |

### Admin 管理 admin:*（需 unlock + 逐操作确认）

除 `admin:unlock` 外，每个都要求 `socket.adminMode === true` 且 `payload.adminConfirm` 等于该 action 名，否则 `{ok:false}` 并写 denied 审计。成功/失败均写 owner-only Admin 审计（正文/base64/MCP 参数不落明文）。

| 事件 | 参数 | 返回 |
|---|---|---|
| `admin:unlock` | **confirmText**（须 `ENABLE ADMIN`） | `{ok:true, adminMode:true}` |
| `admin:lock` | — | `{ok:true, adminMode:false}` |
| `admin:configWrite` | **keyPath**、`mergeStrategy`、`filePath`… | `{ok:true, result}` |
| `admin:configBatchWrite` | **edits[]**、`filePath` | `{ok:true, result}` |
| `admin:pluginInstall` | **pluginName**、`remoteMarketplaceName`、`marketplacePath` | `{ok:true, result}` |
| `admin:pluginUninstall` | **pluginId** | `{ok:true, result}` |
| `admin:marketplaceAdd` | **source**、`refName` | `{ok:true, result}` |
| `admin:marketplaceRemove` | **marketplaceName** | `{ok:true, result}` |
| `admin:marketplaceUpgrade` | `marketplaceName` | `{ok:true, result}` |
| `admin:fsWriteFile` | **path**、**dataBase64** | `{ok:true, result}` |
| `admin:fsRemove` | **path**、`recursive`、`force` | `{ok:true, result}` |
| `admin:fsCopy` | **sourcePath**、**destinationPath**、`recursive` | `{ok:true, result}` |
| `admin:mcpToolCall` | **server**、**tool**、**arguments**、`threadId`、`_meta` | `{ok:true, result}` |
| `admin:accountLogout` | — | `{ok:true, result}` |

## Socket.IO 服务端到客户端

服务端一律通过单一 `agent:event` 信封下发，按 `type` 区分（少数设备流如 `pending_devices` 为裸事件）。信封结构（`server.js` 的 `emitServerEnvelope` 及广播点）：

```jsonc
{
  "seq": 0,                 // 自增序号，用于 catch-up 增量补发
  "epoch": "server",        // 服务端 epoch 标识
  "sessionId": "…|null",
  "instanceId": "…|null",
  "cwd": "…",
  "ts": 1720000000000,      // Date.now()
  "type": "text_delta",     // 见下节
  "payload": { }            // 类型相关载荷
}
```

## agent:event 信封类型

| type | 用途 | 生成位置 |
|---|---|---|
| `device_status` / `pending_devices` | 设备认证状态 / 待审列表 | `server.js` |
| `init` | 连接建立、线程选中初始化 | `server.js` |
| `status` / `status_line` | 会话状态快照（busy/idle）/ git+context 状态行 | `agent-appserver.js` / `server.js` |
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

## 门控与鉴权

- **连接鉴权**：`AUTH_TOKEN` 为空时只接受 loopback；非 loopback 必须带正确 token（握手 `auth.token` 或 HTTP `?token=`/`x-auth-token`），timing-safe 比较。
- **设备信任**：新设备可能需已信任设备批准（`user:approveDevice`）；未授权设备的事件被丢弃。
- **Admin 门控**：`admin:*` 需先 `admin:unlock`（短语 `ENABLE ADMIN`）再逐操作 `adminConfirm`，全程写 owner-only 审计。
- **Labs 门控**：`p3:*` 需 `CODEX_P3_EXPERIMENTAL=1`，并在 `initialize` 声明 `experimentalApi: true`。
- 详见 [../SECURITY.md](../SECURITY.md) 与 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

## 契约测试位置

| 范围 | 测试文件 |
|---|---|
| Socket.IO 路由、ack、鉴权边界、loopback 规则、设备信任、Admin/Labs 门控 | `test/server-integration.test.mjs`、`test/server-security.test.mjs` |
| HTTP push 订阅与 push decision | `test/server-push.test.mjs` |
| app-server JSON-RPC 生命周期、队列、中断、steer、事件映射 | `test/agent-appserver.test.mjs`、`test/agent-appserver-branches.test.mjs`、`test/protocol-adaptation.test.mjs` |
| 审批分类与决议 | `test/approval-broker.test.mjs` |
| 上传校验与 owner-only 落盘 | `test/file-security.test.mjs` |
| 前端信封渲染契约 | `test/public-ui.test.mjs` |
| E2E 端到端事件流 | `e2e/critical-flows.spec.js`、`e2e/rich-event-rendering.spec.js`、`e2e/native-controls.spec.js`、`e2e/instances.spec.js`、`e2e/browser-runtime.spec.js` |
