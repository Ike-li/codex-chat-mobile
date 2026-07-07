# Codex App Server 接口地图：官方文档层 vs CLI Schema 层

> 生成模型 ID：`gpt-5-codex`
> 生成日期：2026-07-05
> 目标产品：用 `codex app-server` 复用 Codex CLI 底层能力，自建手机浏览器流式 Web UI。
> 当前本机 CLI：`codex-cli 0.142.5`

## 结论

[KNOWN, HIGH] 官方文档确认 `codex app-server` 是给 rich client 使用的底层接口：它支撑认证、conversation history、approvals、streamed agent events。

[COMPUTED, HIGH] 当前 `codex-cli 0.142.5` 生成的 app-server 协议 schema 暴露：

- `ClientRequest`：90 个客户端可主动调用方法
- `ServerRequest`：10 个服务端反向请求，客户端必须回应
- `ServerNotification`：69 个服务端推送事件

[INFERRED, MED] 做手机 Web UI 时，产品主干应只依赖“官方文档能力交集 + 当前 schema 精确方法名”。仅 schema 层出现、官方未文档化的方法要加 feature flag，不能当长期稳定 API 承诺。

## 证据来源

### 官方文档层

通过 OpenAI Codex manual helper 获取，状态为 `local manual was already current`。

相关官方章节：

- `Codex App Server`：`/codex/app-server`
- `Codex SDK`：`/codex/sdk`
- `Non-interactive mode`：`/codex/noninteractive`

官方 App Server 文档明确说明：

- app-server 用于 rich client，例如 VS Code extension。
- 协议是 JSON-RPC 2.0，wire 上省略 `"jsonrpc":"2.0"`。
- transport 支持 `stdio://`、`ws://IP:PORT`、`unix://`、`unix://PATH`、`off`。
- WebSocket transport 是 experimental / unsupported，远程暴露必须配置 auth。
- ws listener 提供 `GET /readyz`、`GET /healthz`。
- ws ingress 满时返回 JSON-RPC error `-32001` / `"Server overloaded; retry later."`。
- 客户端必须先 `initialize`，再发 `initialized` notification。
- 核心生命周期：`thread/start|resume|fork` -> `turn/start` -> stream events -> `turn/completed` 或 `turn/interrupt`。
- 可用 `codex app-server generate-ts` / `generate-json-schema` 生成与当前 CLI 版本匹配的协议定义。

### CLI 代码 / Schema 层

本轮用当前本机 CLI 生成：

```bash
codex app-server generate-ts --out /tmp/codex-appserver-ts.4XIQrl
codex app-server generate-json-schema --out /tmp/codex-appserver-schema.5Myv2a
```

关键聚合文件：

- `/tmp/codex-appserver-ts.4XIQrl/ClientRequest.ts`
- `/tmp/codex-appserver-ts.4XIQrl/ClientNotification.ts`
- `/tmp/codex-appserver-ts.4XIQrl/ServerRequest.ts`
- `/tmp/codex-appserver-ts.4XIQrl/ServerNotification.ts`

这些生成物来自当前 CLI 内部 app-server protocol 类型定义，是当前版本“可调用方法名和 payload 类型”的精确来源。

## 集合差异总览

这里区分两种“交集”：

- **方法名交集**：官方文档明确写出的方法名，同时也在 schema 中出现。
- **能力交集**：官方文档描述该能力，schema 给出更细的方法名。比如官方说 approvals，schema 精确到 `item/commandExecution/requestApproval`。

```text
官方文档层 A
  A_only:
    transport/运维/安全约定：
    stdio://, ws://, unix://, off
    GET /readyz, GET /healthz
    ws auth flags
    Origin 403 规则
    -32001 背压错误
    generate-ts / generate-json-schema 命令
    experimentalApi 语义
    optOutNotificationMethods 语义
    clientInfo.name 合规日志语义

交集 A ∩ B
  方法名交集：
    initialize
    initialized
    thread/start
    thread/resume
    thread/fork
    turn/start
    turn/steer
    turn/interrupt
    turn/started
    turn/completed
    thread/archived
    thread/unarchived
    item/started
    item/completed
    item/agentMessage/delta

  能力交集：
    rich client 协议
    thread / turn / item 模型
    streaming agent events
    approvals
    conversation history
    model / cwd / sandbox / approval policy override
    interrupt / steer running turn

CLI schema 层 B
  B_only:
    当前 CLI 0.142.5 暴露的大量精确方法名：
    account/*, app/list, command/exec*, config/*, fs/*,
    plugin/*, marketplace/*, skills/*, mcpServer/*,
    review/start, hooks/list, permissionProfile/list,
    windowsSandbox/*, fuzzyFileSearch, getAuthStatus,
    getConversationSummary, gitDiffToRemote, 等。
```

## 官方文档明确命名的接口

### JSON-RPC 方法 / 通知

| 名称 | 方向 | 官方语义 | schema 状态 |
|---|---|---|---|
| `initialize` | client -> server request | 建立连接后第一步握手，传 `clientInfo` 和 capabilities | 存在 |
| `initialized` | client -> server notification | 客户端确认初始化完成 | 存在 |
| `thread/start` | client -> server request | 新建 thread | 存在 |
| `thread/resume` | client -> server request | 恢复已有 thread | 存在 |
| `thread/fork` | client -> server request | 分叉 thread | 存在 |
| `turn/start` | client -> server request | 在 thread 中开始一次用户请求 | 存在 |
| `turn/steer` | client -> server request | 对运行中的 turn 追加输入 | 存在 |
| `turn/interrupt` | client -> server request | 取消/中断运行中的 turn | 存在 |
| `turn/started` | server -> client notification | turn 开始 | 存在 |
| `turn/completed` | server -> client notification | turn 完成 | 存在 |
| `thread/archived` | server -> client notification | thread 被归档 | 存在 |
| `thread/unarchived` | server -> client notification | thread 被恢复 | 存在 |
| `item/started` | server -> client notification | item 开始 | 存在 |
| `item/completed` | server -> client notification | item 完成 | 存在 |
| `item/agentMessage/delta` | server -> client notification | assistant message 流式增量 | 存在 |

### 官方文档提供但不是 JSON-RPC 方法的接口/约定

| 接口/约定 | 用途 | schema 是否体现 |
|---|---|---|
| `--listen stdio://` | JSONL over stdio，本地网关最合适 | CLI flag，不是 JSON-RPC method |
| `--listen ws://IP:PORT` | WebSocket transport | CLI flag；官方标注 experimental / unsupported |
| `--listen unix://` / `unix://PATH` | Unix socket transport | CLI flag |
| `--listen off` | 关闭 local transport | CLI flag |
| `GET /readyz` | ws listener readiness probe | HTTP endpoint，不在 schema method 中 |
| `GET /healthz` | ws listener health probe | HTTP endpoint，不在 schema method 中 |
| Origin header -> `403` | 阻止浏览器跨源直连 ws listener | transport 安全约定 |
| `--ws-auth capability-token` | WebSocket bearer token auth | CLI flag |
| `--ws-auth signed-bearer-token` | signed bearer token auth | CLI flag |
| JSON-RPC error `-32001` | overload/backpressure | 错误语义，不是 method |
| `generate-ts` | 生成 TS bindings | CLI subcommand |
| `generate-json-schema` | 生成 JSON Schema | CLI subcommand |
| `capabilities.experimentalApi` | 启用实验方法/字段 | `InitializeParams` 字段 |
| `capabilities.optOutNotificationMethods` | 按 method name 屏蔽通知 | `InitializeParams` 字段 |
| `clientInfo.name` | 合规日志识别客户端 | `InitializeParams` 字段 |

## 当前 CLI Schema 层接口清单

以下清单来自当前本机 `codex-cli 0.142.5` 生成的 `ClientRequest.ts`、`ServerRequest.ts`、`ServerNotification.ts`。

### ClientRequest：客户端主动调用方法

#### 1. 初始化

- `initialize`

#### 2. Thread / 会话

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/archive`
- `thread/unarchive`
- `thread/delete`
- `thread/unsubscribe`
- `thread/name/set`
- `thread/metadata/update`
- `thread/inject_items`
- `thread/compact/start`
- `thread/rollback`
- `thread/shellCommand`
- `thread/approveGuardianDeniedAction`

#### 3. Goal

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

#### 4. Turn / 流式任务

- `turn/start`
- `turn/steer`
- `turn/interrupt`

#### 5. Review

- `review/start`

#### 6. 终端 / 命令执行

- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `command/exec/resize`

#### 7. 文件系统

- `fs/readFile`
- `fs/writeFile`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`
- `fs/watch`
- `fs/unwatch`

#### 8. 模型与 provider

- `model/list`
- `modelProvider/capabilities/read`

#### 9. 配置

- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `config/mcpServer/reload`

#### 10. 权限 / feature flags

- `permissionProfile/list`
- `experimentalFeature/list`
- `experimentalFeature/enablement/set`

#### 11. MCP

- `mcpServerStatus/list`
- `mcpServer/resource/read`
- `mcpServer/tool/call`
- `mcpServer/oauth/login`

#### 12. Skills / Hooks

- `skills/list`
- `skills/config/write`
- `skills/extraRoots/set`
- `hooks/list`

#### 13. Plugins / Marketplace

- `plugin/list`
- `plugin/installed`
- `plugin/read`
- `plugin/skill/read`
- `plugin/install`
- `plugin/uninstall`
- `plugin/share/save`
- `plugin/share/updateTargets`
- `plugin/share/list`
- `plugin/share/checkout`
- `plugin/share/delete`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`

#### 14. Account / Auth / Usage

- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/read`
- `account/rateLimits/read`
- `account/rateLimitResetCredit/consume`
- `account/usage/read`
- `account/workspaceMessages/read`
- `account/sendAddCreditsNudgeEmail`
- `getAuthStatus`

#### 15. Apps

- `app/list`

#### 16. External agent config import

- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`

#### 17. 其他工具入口

- `feedback/upload`
- `fuzzyFileSearch`
- `getConversationSummary`
- `gitDiffToRemote`
- `windowsSandbox/setupStart`
- `windowsSandbox/readiness`

### ClientNotification：客户端通知

- `initialized`

### ServerRequest：服务端反向请求，客户端必须回应

这些是手机 Web UI 最容易漏掉的部分。服务端发来 request 后，客户端/网关必须回 JSON-RPC response；否则 Codex turn 可能挂起。

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `item/tool/call`
- `mcpServer/elicitation/request`
- `account/chatgptAuthTokens/refresh`
- `attestation/generate`
- `applyPatchApproval`
- `execCommandApproval`

说明：

- `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` 应映射成手机端审批弹窗。
- `item/tool/requestUserInput` 应映射成用户输入表单。
- `mcpServer/elicitation/request` 应映射成 MCP 表单。
- `applyPatchApproval`、`execCommandApproval` 是旧式/兼容审批入口；实现上应保留兜底。

### ServerNotification：服务端事件流

#### 1. 错误 / 警告 / 配置

- `error`
- `warning`
- `guardianWarning`
- `deprecationNotice`
- `configWarning`

#### 2. Thread 状态

- `thread/started`
- `thread/status/changed`
- `thread/archived`
- `thread/unarchived`
- `thread/deleted`
- `thread/closed`
- `thread/name/updated`
- `thread/goal/updated`
- `thread/goal/cleared`
- `thread/settings/updated`
- `thread/tokenUsage/updated`
- `thread/compacted`

#### 3. Turn 状态

- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `turn/moderationMetadata`

#### 4. Item / assistant message / reasoning / plan

- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `rawResponseItem/completed`

#### 5. 命令 / 进程 / 文件修改

- `command/exec/outputDelta`
- `process/outputDelta`
- `process/exited`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`

#### 6. 审批 / 自动审批 / 服务端请求状态

- `serverRequest/resolved`
- `item/autoApprovalReview/started`
- `item/autoApprovalReview/completed`

#### 7. MCP / Skills / Apps / Hooks

- `item/mcpToolCall/progress`
- `mcpServer/oauthLogin/completed`
- `mcpServer/startupStatus/updated`
- `skills/changed`
- `app/list/updated`
- `hook/started`
- `hook/completed`

#### 8. Account / usage

- `account/login/completed`
- `account/updated`
- `account/rateLimits/updated`

#### 9. External import / file watch / search

- `externalAgentConfig/import/progress`
- `externalAgentConfig/import/completed`
- `fs/changed`
- `fuzzyFileSearch/sessionUpdated`
- `fuzzyFileSearch/sessionCompleted`

#### 10. Model / safety

- `model/rerouted`
- `model/verification`
- `model/safetyBuffering/updated`

#### 11. Realtime / remote / Windows

- `thread/realtime/started`
- `thread/realtime/itemAdded`
- `thread/realtime/transcript/delta`
- `thread/realtime/transcript/done`
- `thread/realtime/outputAudio/delta`
- `thread/realtime/sdp`
- `thread/realtime/error`
- `thread/realtime/closed`
- `remoteControl/status/changed`
- `windows/worldWritableWarning`
- `windowsSandbox/setupCompleted`

## 差异清单

### 共同都有：官方明确 + schema 存在

这些可以作为产品 MVP 的主干接口。

| 能力 | 方法/事件 |
|---|---|
| 握手 | `initialize`, `initialized` |
| 开始/恢复/分叉会话 | `thread/start`, `thread/resume`, `thread/fork` |
| 发起 turn | `turn/start` |
| 运行中追加输入 | `turn/steer` |
| 中断任务 | `turn/interrupt` |
| turn 状态 | `turn/started`, `turn/completed` |
| 基础 thread 事件 | `thread/archived`, `thread/unarchived` |
| 基础 item 事件 | `item/started`, `item/completed` |
| assistant 流式输出 | `item/agentMessage/delta` |

### 官方有、schema 不是 method 的内容

这些不是你在 JSON-RPC 中调用的方法，但产品必须遵守。

| 官方内容 | 产品含义 |
|---|---|
| transport：`stdio://`, `ws://`, `unix://`, `off` | 手机 Web UI 不应让浏览器直连 app-server；应由 Node 网关走 stdio |
| `GET /readyz`, `GET /healthz` | 只适用于 app-server ws listener 运维探针 |
| Origin -> `403` | 浏览器直接连 app-server ws 会被 Origin 策略卡住 |
| WebSocket experimental / unsupported | 不要把 app-server ws 当生产浏览器协议 |
| ws auth flags | 如果暴露 ws，必须加 capability token 或 signed bearer token |
| `-32001` overload | 网关需要退避重试或向前端显示拥塞 |
| `experimentalApi` | 未文档化/实验字段应隔离 |
| `optOutNotificationMethods` | 手机端可减少高频通知流量 |
| `clientInfo.name` | 自研客户端要设置稳定名字，便于企业合规日志识别 |

### schema 有、官方 App Server 文档未完整列出的内容

这些当前版本可见，但应按“当前 CLI 能力”而不是“长期稳定官方 API”处理。

| 分组 | 方法/事件 | 建议 |
|---|---|---|
| 文件系统 | `fs/*`, `fs/changed` | 只对可信本地网关开放；手机端按钮要谨慎 |
| 配置写入 | `config/value/write`, `config/batchWrite` | 默认不要做成普通用户入口 |
| 插件安装/卸载 | `plugin/install`, `plugin/uninstall`, `marketplace/*` | 高风险，需确认和审计 |
| MCP 直接调用 | `mcpServer/tool/call` | 可做高级页；注意 OAuth 和工具权限 |
| 账号/登录 | `account/login/start`, `account/logout`, `account/read` | 移动端要单独设计登录态和 token 保护 |
| Windows sandbox | `windowsSandbox/*` | 平台特定，Mac/Linux 产品可隐藏 |
| Realtime 通知 | `thread/realtime/*` | 当前只有通知，ClientRequest 没有对应 start/stop 方法；不要承诺完整语音功能 |
| Remote control 通知 | `remoteControl/status/changed` | 当前 ClientRequest 没有 `remoteControl/enable` 等方法；不要按旧文档/旧清单实现 |
| 兼容旧方法 | `getAuthStatus`, `getConversationSummary`, `gitDiffToRemote`, `applyPatchApproval`, `execCommandApproval` | 可以兼容，但新 UI 主线用 v2 slash-style 方法 |

## 面向手机浏览器 Web UI 的推荐映射

### 推荐架构

```text
手机浏览器
  <-> Socket.IO / WebSocket / SSE（你自己的鉴权、E2EE、设备审批）
Node 网关 server.js
  <-> stdio JSONL
codex app-server 子进程
```

[KNOWN, HIGH] 当前项目已经走这个方向：`agent-appserver.js` 通过 `spawn(codex, ['app-server'])` 走 stdio JSON-RPC，`server.js` 通过 Socket.IO 对手机浏览器提供事件层。

### MVP 必需映射

| UI 功能 | app-server 方法/事件 |
|---|---|
| 新建会话 | `initialize`, `initialized`, `thread/start` |
| 恢复会话 | `thread/resume`, `thread/read`, `thread/list` |
| 发送消息 | `turn/start` |
| 追加输入 | `turn/steer` |
| 停止按钮 | `turn/interrupt` |
| 流式 assistant bubble | `item/agentMessage/delta`, `item/completed` |
| 计划面板 | `turn/plan/updated`, `item/plan/delta` |
| diff 面板 | `turn/diff/updated`, `item/fileChange/patchUpdated` |
| 命令输出卡片 | `item/commandExecution/outputDelta`, `command/exec/outputDelta` |
| 审批弹窗 | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` |
| 弹窗撤销/多端同步 | `serverRequest/resolved` |
| 状态栏 | `thread/status/changed`, `thread/tokenUsage/updated`, `account/rateLimits/updated` |
| Review | `review/start` |
| 模型选择 | `model/list`, `modelProvider/capabilities/read` |

### Phase 2 可做，但要加权限边界

| UI 功能 | app-server 方法/事件 | 风险 |
|---|---|---|
| 文件浏览器 | `fs/readDirectory`, `fs/readFile`, `fs/watch` | 路径越权、敏感文件暴露 |
| 文件编辑器 | `fs/writeFile`, `fs/remove`, `fs/copy` | 高风险写入 |
| Skills 管理 | `skills/list`, `skills/config/write`, `skills/extraRoots/set` | 改变 agent 行为 |
| MCP 管理 | `mcpServerStatus/list`, `mcpServer/resource/read`, `mcpServer/tool/call` | 外部工具权限 |
| Plugin 管理 | `plugin/list`, `plugin/read`, `plugin/install`, `plugin/uninstall` | 安装/执行供应链风险 |
| Account 页 | `account/read`, `account/usage/read`, `account/rateLimits/read` | 隐私和账号态 |
| Config 页 | `config/read`, `config/value/write`, `config/batchWrite` | 持久配置破坏 |

### 不建议直接做成普通手机 UI 入口

- `config/batchWrite`
- `fs/remove`
- `plugin/install`
- `plugin/uninstall`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`
- `account/logout`
- `account/sendAddCreditsNudgeEmail`
- `windowsSandbox/setupStart`
- 任何未验证 payload 的 `mcpServer/tool/call`

这些入口要么破坏性强，要么涉及账号/供应链/平台特定状态，应放到管理员模式或显式确认流。

## 当前 schema 与旧清单可能不同的点

[COMPUTED, HIGH] 当前 `codex-cli 0.142.5` 生成的 `ClientRequest.ts` 没有以下旧清单中常见的方法：

- `remoteControl/enable`
- `remoteControl/disable`
- `remoteControl/status/read`
- `remoteControl/pairing/start`
- `process/spawn`
- `process/writeStdin`
- `process/resizePty`
- `process/kill`
- `thread/realtime/start`
- `thread/realtime/stop`
- `thread/search`
- `thread/items/list`

当前 schema 中只看到相关通知，例如 `remoteControl/status/changed`、`process/outputDelta`、`process/exited`、`thread/realtime/*`。因此不能把这些旧方法当作当前 `codex-cli 0.142.5` 的可调用接口承诺。

## 实现注意事项

1. **不要让浏览器直连 `codex app-server --listen ws://...`**  
   官方文档说 WebSocket experimental / unsupported；并且带 `Origin` 的请求会被 `403`。手机 Web UI 应通过自建网关连接。

2. **所有 server request 都要回应**  
   当前项目的 `agent-appserver.js` 对未知 server request 回 `{}` 可以避免 agent 挂死，但产品化时应按 method 分别实现 UI，而不是一律空响应。

3. **审批 payload 不要只看 `requestApproval` 字符串**  
   当前项目用正则匹配 `/requestApproval/i`，适合 MVP。产品化建议按精确 method 区分命令审批、文件审批、权限审批、旧式 `applyPatchApproval`、旧式 `execCommandApproval`。

4. **Schema 要版本锁定**  
   每次升级 Codex CLI 后，在 CI 中重新跑：

   ```bash
   codex app-server generate-ts --out src/protocol/codex-app-server
   codex app-server generate-json-schema --out docs/protocol-schema
   ```

   然后 diff 生成物，明确新增/删除/改名的 method。

5. **前端要容错未知 item / notification**  
   app-server 会新增事件；手机 UI 应把未知事件降级成 raw event 卡片，而不是崩溃。

6. **把破坏性方法放进管理员模式**  
   `fs/remove`、config 写入、插件安装、marketplace 修改、MCP tool call 都应有二次确认和审计日志。

## 建议的产品接口分层

### Core：首版必须稳定

- `initialize`
- `initialized`
- `thread/start`
- `thread/resume`
- `thread/list`
- `thread/read`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `item/agentMessage/delta`
- `item/started`
- `item/completed`
- `turn/completed`
- `turn/plan/updated`
- `turn/diff/updated`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `serverRequest/resolved`

### Productive：第二阶段

- `review/start`
- `model/list`
- `modelProvider/capabilities/read`
- `account/read`
- `account/usage/read`
- `account/rateLimits/read`
- `skills/list`
- `mcpServerStatus/list`
- `plugin/list`
- `config/read`
- `fs/readDirectory`
- `fs/readFile`
- `fs/watch`

### Admin：仅管理员/高级模式

- `config/value/write`
- `config/batchWrite`
- `fs/writeFile`
- `fs/remove`
- `plugin/install`
- `plugin/uninstall`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`
- `mcpServer/tool/call`

### Observe-only：先只渲染，不主动承诺控制

- `thread/realtime/*`
- `remoteControl/status/changed`
- `process/outputDelta`
- `process/exited`
- `rawResponseItem/completed`
- `model/rerouted`
- `model/verification`
- `model/safetyBuffering/updated`

## 复现命令

```bash
codex --version

tmp_ts="$(mktemp -d /tmp/codex-appserver-ts.XXXXXX)"
tmp_schema="$(mktemp -d /tmp/codex-appserver-schema.XXXXXX)"

codex app-server generate-ts --out "$tmp_ts"
codex app-server generate-json-schema --out "$tmp_schema"

rg -o '"method": "[^"]+"' "$tmp_ts/ClientRequest.ts" \
  | sed 's/.*"method": "//; s/"$//' | sort

rg -o '"method": "[^"]+"' "$tmp_ts/ServerRequest.ts" \
  | sed 's/.*"method": "//; s/"$//' | sort

rg -o '"method": "[^"]+"' "$tmp_ts/ServerNotification.ts" \
  | sed 's/.*"method": "//; s/"$//' | sort
```

## Sources

- 官方 App Server 文档：<https://developers.openai.com/codex/app-server>
- 官方 SDK 文档：<https://developers.openai.com/codex/sdk>
- 官方 Non-interactive 文档：<https://developers.openai.com/codex/noninteractive>
- 当前 CLI 生成 schema：`codex app-server generate-ts` / `codex app-server generate-json-schema`
- 当前项目桥接实现：`agent-appserver.js`
