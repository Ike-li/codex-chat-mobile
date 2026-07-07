# Codex App Server 协议参考

本文件是 codex-chat-mobile 对 Codex `app-server` JSON-RPC 2.0 协议的维护型参考。它以 pin 版本（`.codex-version`，当前 `0.142.5`）的 `generate-ts` 导出为准，只覆盖本项目实际关心的接口面，并标出哪些已实现、哪些留作降级或实验。完整协议以 Codex 官方文档和 `.protocol/stable/` 机器基线为最终事实来源；本文冲突时以 `.protocol/stable/` 和 `agent-appserver.js` 为准。

> 底稿与更早的调研过程见 [archive/](archive/)（不再维护）。

## 三层集合模型

同一批方法在不同视角下可见性不同，早期两份调研结论相反，根因是 `generate-ts` 的过滤行为：

```
A  官方文档层    developers.openai.com/codex/app-server
B1 默认导出层    codex app-server generate-ts        → 稳定 API 面
B2 全量 schema   generate-ts --experimental / 源码   → 含 experimental 请求方法
```

- `generate-ts`（不带 `--experimental`）**默认过滤全部 `#[experimental]` 门控的请求方法**（`export.rs` 的 `filter_experimental_ts`），但 **不过滤通知**。因此会出现「看得到 realtime/remoteControl/process 的通知、却看不到对应请求方法」的现象——那是过滤器行为，不代表方法不存在。
- 关系：`B1 ⊂ B2`；本项目的 `.protocol/stable/` 是 **B1（默认导出）**，运行时调用 experimental 方法还需在 `initialize` 声明 `experimentalApi: true`。
- 产品规则：主干只用 `A∩B1`；`B2∖B1` 一律 feature flag 隔离（本项目 `CODEX_P3_EXPERIMENTAL=1`）。

`0.142.5` 默认导出计数口径：ClientRequest 76 · ServerRequest 10 · ServerNotification 66 · ClientNotification 1。

## 产品主干接口

以下是本项目稳定依赖的接口（`A∩B1`）。握手：`initialize`（`clientInfo` + `capabilities`）→ `initialized`。

**Thread 生命周期**：`thread/start`（`ephemeral: true` 支持内存态）、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/name/set`、`thread/compact/start`、`thread/rollback`。

**Turn 生命周期**：`turn/start`（可覆盖 model/cwd/sandbox/approval policy）、`turn/steer`、`turn/interrupt`。

**流式通知**：`item/started` → delta（`item/agentMessage/delta`、`item/reasoning/{summaryTextDelta,textDelta,summaryPartAdded}`、`item/commandExecution/outputDelta`）→ `item/completed`；turn 级 `turn/{started,completed,plan/updated,diff/updated}`；thread 级 `thread/{tokenUsage/updated,archived,unarchived,deleted,name/updated,compacted}`。终态从 `turn/completed.status` 取（`turn/failed` 仅保留一版本周期兼容，见 legacy allowlist）。

**审批（S→C 请求，必须应答，否则 turn 挂起）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`；旧式 `applyPatchApproval`、`execCommandApproval` 保留兜底；撤销通知 `serverRequest/resolved`。`account/chatgptAuthTokens/refresh` 本项目 **显式拒绝**（`-32601`，不透传凭证）。

**账号/模型/只读能力**：`account/{read,usage/read,rateLimits/read,login/start,login/cancel,logout}`（登录用 `chatgptDeviceCode`）、`model/list`、`modelProvider/capabilities/read`、只读 `fs/{readFile,readDirectory}`、`mcpServerStatus/list`、`skills/list`、`externalAgentConfig/{detect,import}`。

**Admin（门控写操作）**：`config/{value/write,batchWrite}`、`fs/{writeFile,remove,copy}`、`plugin/{install,uninstall}`、`marketplace/{add,remove,upgrade}`、`mcpServer/tool/call`、`account/logout`。

**item wire `type`**：`userMessage`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`webSearch`、`imageView`、`enteredReviewMode`、`exitedReviewMode`、`contextCompaction` 等——前端 **必须容错未知 type**，降级为可见 raw envelope。

## 实验门控接口

`B2∖B1`，仅在 `CODEX_P3_EXPERIMENTAL=1` 声明 `experimentalApi: true` 后可用，隔离在 Labs 面板：

| 分组 | 方法 | 本项目现状 |
|---|---|---|
| 网页终端 | `command/exec` + `write\|resize\|terminate` + `command/exec/outputDelta`；`process/*`（官方文档有载）| 用 `command/exec` PTY 系列承载，映射 `term_output`/`term_exit` 信封 |
| 历史分页/搜索 | `thread/turns/list`、`thread/items/list`、`thread/search` | 请求未导出时降级到 `thread/read(includeTurns)` 和 `thread/list(searchTerm)` |
| 实时语音 | `thread/realtime/*` | 仅跟踪通知，不启动真实音频 |
| 远程控制/配对 | `remoteControl/*` | 仅跟踪 `remoteControl/status/changed` 通知，不做官方 pairing |

`experimentalFeature/list` 是 P3 能力探测入口。

## 传输与运维约定

`A∖B` —— 非 RPC 方法，但必须遵守的传输/运维约定：

- 传输：本项目用 **stdio JSONL 子进程**（每实例一个）。`--listen ws://` 是 experimental/unsupported，且带 `Origin` 头一律 `403`——**浏览器无法直连 app-server**，必须经本项目 Node 网关。
- 背压：JSON-RPC 收到 `-32001 "Server overloaded"` → 指数退避重试（`agent-appserver.js` 的 `backpressureRetries`，见 `-32001` 处理），透出 `backpressure_retry` 状态。
- `clientInfo.name` 用于企业合规日志，本项目设稳定名称。
- 日志：`RUST_LOG`、`LOG_FORMAT=json`（Codex 侧）；本项目自身 JSON-RPC 出入落 owner-only `.codex-chat-rpc.jsonl`。

## 与本项目实现的映射

协议方法集中在 `agent-appserver.js`；`server.js` 只做 Socket.IO 语义化事件到协议方法的路由。Socket 事件到协议方法的完整对照见 [EVENTS.md](EVENTS.md)。

当前对 `.protocol/stable/` 的覆盖（`0.142.5`）：

| 方向 | 定义 | 已用 | 说明 |
|---|---|---|---|
| Client→Server Request | 76 | 37 | 未用的多为 goal/权限档/oauth/windowsSandbox 等主干无关能力 |
| Client→Server Notification | 1 | 1 | `initialized` |
| Server→Client Request | 10 | 7 | 未用：`attestation/generate`、`mcpServer/elicitation/request`、`item/tool/call` |
| Server→Client Notification | 66 | 39 | 未处理的在 `handleNotification` default 分支安全忽略 |

未处理通知走 default 分支不报错，是刻意的宽容策略（未知通知安全忽略，未知 **item** 才降级为 `raw_item` 信封）。`protocol:check` 保证所有 **已用** 方法都在 `.protocol/stable/` 中定义。

## 升级与验证

升级 pin 版本的完整流程见 [PROTOCOL_UPGRADE.md](PROTOCOL_UPGRADE.md)。关键点：

- `npm run protocol:check` 对照 `.protocol/stable/` 检查两件事：**覆盖**（本项目用到的方法都还存在）与 **漂移**（重新 `generate-ts` 后方法/类型/文件 hash 是否变化）。
- legacy allowlist 目前仅 `turn/failed`（0.142.5 遗留兼容）。
- 升级后凡出现 method/type 漂移，先改 `agent-appserver.js`、协议 fixtures 和聚焦测试，再重新生成基线；本文的覆盖表和主干接口清单需随之更新。
