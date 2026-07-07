# Codex App Server 接口对照清单（代码/Schema 层 vs 官方文档层）

> 生成模型：`claude-fable-5` ｜ 生成日期：2026-07-05
> 核对基准：`openai/codex` main 分支源码（2026-07-05 克隆）+ 官方文档 https://developers.openai.com/codex/app-server （2026 年最新版）。
> 目标场景：复用 codex CLI 底层能力，经 `codex app-server` 桥接，自建手机浏览器流式 Web UI。

---

## 0. 集合总览（Venn 视图）

```
┌─────────────────────────┬──────────────────────────────┬─────────────────────────────┐
│ 仅官方文档层（A\B）      │ 交集 A∩B（文档背书+Schema）   │ 仅代码/Schema 层（B\A）      │
├─────────────────────────┼──────────────────────────────┼─────────────────────────────┤
│ 非 RPC 方法，是协议约定： │ 产品主干应只用这一区：         │ 可调但未文档化/experimental： │
│ · 传输(stdio/ws/unix)    │ · initialize 握手            │ · remoteControl/* 配对       │
│ · /readyz /healthz 探针  │ · thread/* 会话管理           │ · thread/realtime/* 语音     │
│ · Origin→403 规则        │ · turn/start|steer|interrupt │ · memory/* · settings/*     │
│ · 背压错误码 -32001      │ · item/* 流式事件+delta       │ · thread/search · hooks     │
│ · generate-ts/json 命令  │ · 审批 requestApproval 族     │ · elicitation 族            │
│ · experimentalApi 机制   │ · account/* 登录/限流         │ · plugin/share/*            │
│ · 生命周期语义与示例      │ · exec/process·fs·config     │ · guardian/moderation 通知   │
│ · 日志/RUST_LOG 约定     │ · model·skills·plugin·mcp    │ · v1 遗留 camelCase 方法     │
└─────────────────────────┴──────────────────────────────┴─────────────────────────────┘
```

- **A = 官方文档层**（developers.openai.com/codex/app-server）
- **B = 代码/Schema 层**（`codex-rs/app-server-protocol`，`generate-ts`/`generate-json-schema` 导出）
- 关系：**B ⊋ (A 中全部 RPC 方法)**——文档描述的每个方法都在 schema 里；schema 另有约 60+ 方法/事件文档未收录；A 独有的是传输、运维、语义约定（非方法）。

---

## 1. 两个"接口来源"的定义

| 来源 | 位置 | 性质 |
|---|---|---|
| **代码/Schema 层** | `codex-rs/app-server-protocol` crate（`protocol/common.rs` 中 `client_request_definitions!` / `server_request_definitions!` / `server_notification_definitions!` 宏 + `protocol/v2/*.rs` 类型）| **唯一权威 source of truth**。可用 `codex app-server generate-ts --out DIR` 或 `codex app-server generate-json-schema --out DIR` 导出与当前 CLI 版本严格一致的 TS/JSON Schema |
| **官方文档层** | developers.openai.com/codex/app-server（内容与仓库 `codex-rs/app-server/README.md` 同源）；辅以 `codex-rs/docs/codex_mcp_interface.md`（仓库文档，非官网） | 官方承诺/解释层：协议语义、生命周期、传输、审批流程、示例。**文档未覆盖 schema 中全部方法** |

协议形式：JSON-RPC 2.0（线上省略 `"jsonrpc":"2.0"` 头），双向通信。

---

## 2. 交集：官方文档背书 + Schema 定义（建 Web UI 的稳定核心）

### 2.1 生命周期 / 握手
| 方法 | 方向 | 说明 |
|---|---|---|
| `initialize` | C→S req | 每连接一次；`clientInfo` + `capabilities`（`experimentalApi`、`requestAttestation`、`mcpServerOpenaiFormElicitation`、`optOutNotificationMethods`）；响应含 `userAgent`、`codexHome`、`platformFamily`、`platformOs` |
| `initialized` | C→S notif | 握手完成；此前其他请求会被拒绝 |

### 2.2 Thread（会话）
`thread/start`、`thread/resume`、`thread/fork`（支持 `ephemeral: true` 内存态会话）、`thread/read`、`thread/list`、`thread/loaded/list`、`thread/archive` / `thread/unarchive` / `thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/goal/set|get|clear`、`thread/metadata/update`、`thread/compact/start`（上下文压缩）、`thread/rollback`、`thread/shellCommand`、`thread/inject_items`、`thread/backgroundTerminals/list|clean|terminate`（文档有载，schema 标 experimental）、`thread/turns/list`（schema 标 experimental，文档有载）

对应通知：`thread/started`、`thread/status/changed`、`thread/name/updated`、`thread/goal/updated|cleared`、`thread/archived|unarchived|deleted|closed`、`thread/tokenUsage/updated`、`thread/compacted`

### 2.3 Turn（轮次）——流式核心
| 方法/事件 | 方向 | 说明 |
|---|---|---|
| `turn/start` | C→S req | 发送用户输入；可覆盖 model、cwd、sandbox policy、approval policy 等 |
| `turn/steer` | C→S req | 向运行中的 turn 追加引导输入 |
| `turn/interrupt` | C→S req | 中断当前 turn |
| `turn/started` / `turn/completed` | S→C notif | turn 开始/结束（含 usage） |
| `turn/diff/updated` | S→C notif | 本 turn 累计文件 diff |
| `turn/plan/updated` | S→C notif | 计划(TODO)更新 |

### 2.4 Item 生命周期与流式增量（UI 渲染主体）
统一模式：`item/started` →（可选 delta 流）→ `item/completed`。

Delta/进度事件：`item/agentMessage/delta`、`item/plan/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`

文档载明的 item 类型（wire `type`，camelCase）：`userMessage`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch`、`imageView`、`enteredReviewMode`、`exitedReviewMode`、`contextCompaction`

### 2.5 审批（S→C 请求，客户端必须应答——Web UI 需做成弹窗）
| 方法 | 说明 |
|---|---|
| `item/commandExecution/requestApproval` | 命令执行审批 |
| `item/fileChange/requestApproval` | 文件修改审批 |
| `item/tool/requestUserInput` | 工具请求用户输入 |
| `item/tool/call`（dynamic tool call）| 由客户端实现的动态工具 |
| `serverRequest/resolved` | S→C notif：某个 server 请求已被（其他端）解决，UI 应撤下弹窗 |

### 2.6 终端 / 进程
一次性命令：`command/exec`、`command/exec/write`、`command/exec/resize`、`command/exec/terminate` + `command/exec/outputDelta`
长驻进程（schema 标 experimental，文档有载）：`process/spawn`、`process/writeStdin`、`process/resizePty`、`process/kill` + `process/outputDelta`、`process/exited`

### 2.7 账号 / 认证
`account/read`、`account/login/start`（type：`apiKey` | `chatgpt` | `chatgptDeviceCode` | `amazonBedrock`）、`account/login/cancel`、`account/logout`、`account/chatgptAuthTokens/refresh`、`account/rateLimits/read`、`account/usage/read`、`account/rateLimitResetCredit/consume`、`account/sendAddCreditsNudgeEmail`
通知：`account/login/completed`、`account/updated`、`account/rateLimits/updated`

### 2.8 模型 / 配置 / 技能 / 插件 / MCP / 其他
- 模型：`model/list`、`modelProvider/capabilities/read`
- 实验特性开关：`experimentalFeature/list`、`experimentalFeature/enablement/set`；协作模式 `collaborationMode/list`（experimental）
- 配置：`config/read`、`config/value/write`、`config/batchWrite`、`configRequirements/read`、`config/mcpServer/reload`
- 外部 Agent 配置导入（CLAUDE.md 等）：`externalAgentConfig/detect|import|import/readHistories` + `import/progress`、`import/completed` 通知
- Skills：`skills/list`、`skills/config/write`、`skills/extraRoots/set` + `skills/changed` 通知
- 插件/市场：`marketplace/add|remove|upgrade`、`plugin/list|read|install|uninstall`
- Apps：`app/list` + `app/list/updated`
- MCP：`mcpServer/oauth/login`、`mcpServerStatus/list`、`mcpServer/resource/read`、`mcpServer/tool/call` + `mcpServer/oauthLogin/completed`、`mcpServer/startupStatus/updated`
- 文件系统（v2）：`fs/readFile|writeFile|createDirectory|getMetadata|readDirectory|remove|copy|watch|unwatch` + `fs/changed`
- 其他：`review/start`（代码评审）、`feedback/upload`、`windowsSandbox/setupStart|readiness` + `setupCompleted`
- 模糊文件搜索通知：`fuzzyFileSearch/sessionUpdated`、`fuzzyFileSearch/sessionCompleted`

---

## 3. 仅官方文档层：协议约定与运维接口（不在 schema 内）

- 传输：stdio JSONL（默认）；`--listen ws://IP:PORT`（**experimental/unsupported，官方明示勿用于生产**）；`--listen unix://`（`$CODEX_HOME/app-server-control/app-server-control.sock`，配 `codex app-server proxy` 使用）；`--listen off`
- ws 监听时的 HTTP 探针：`GET /readyz`、`GET /healthz`；带 `Origin` 头一律 `403`
- 背压：入口饱和时返回 JSON-RPC 错误 `-32001 "Server overloaded; retry later."`（应指数退避重试）
- 日志：`RUST_LOG`、`LOG_FORMAT=json`
- Schema 导出命令：`codex app-server generate-ts` / `generate-json-schema`
- Experimental 开启方式：`initialize.capabilities.experimentalApi: true`，未开启调用实验方法报错 `"<method> requires experimentalApi capability"`
- 生命周期语义、审批流程说明、最佳实践与示例代码

---

## 4. 仅 Schema/代码层：官方文档未收录（多数带 `#[experimental]` 门控）

> 这些方法真实可调（开 `experimentalApi` 后），由 `generate-ts`/`generate-json-schema` 导出可见，但官网文档不提及，随时可能变更。

| 分组 | 方法/事件 |
|---|---|
| **远程控制/配对**（对手机场景最值得关注）| `remoteControl/enable|disable`、`remoteControl/status/read`、`remoteControl/pairing/start|status`、`remoteControl/client/list|revoke` + `remoteControl/status/changed` 通知 |
| **实时语音 Realtime** | `thread/realtime/start|stop|appendAudio|appendText|appendSpeech|listVoices` + `thread/realtime/started|itemAdded|transcript/delta|transcript/done|outputAudio/delta|sdp|error|closed` |
| **记忆/设置** | `thread/memoryMode/set`、`memory/reset`、`thread/settings/update` + `thread/settings/updated` |
| **检索/枚举** | `thread/search`、`thread/items/list`、`permissionProfile/list`、`hooks/list` |
| **Elicitation** | `thread/increment_elicitation`、`thread/decrement_elicitation`、`mcpServer/elicitation/request`（S→C）、`item/permissions/requestApproval`（S→C 审批）|
| **插件分享** | `plugin/installed`、`plugin/skill/read`、`plugin/share/save|updateTargets|list|checkout|delete` |
| **环境/系统** | `environment/add|info`、`attestation/generate`（S→C）、`currentTime/read`（S→C）、`account/workspaceMessages/read` |
| **模糊搜索会话（请求侧）** | `fuzzyFileSearch/sessionStart|sessionUpdate|sessionStop` |
| **仅代码层的通知** | `error`、`warning`、`guardianWarning`、`deprecationNotice`、`configWarning`、`rawResponseItem/completed`、`turn/moderationMetadata`、`model/rerouted`、`model/verification`、`model/safetyBuffering/updated`、`item/autoApprovalReview/started|completed`、`item/commandExecution/terminalInteraction`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`thread/approveGuardianDeniedAction`（请求）、`hook/started`、`hook/completed`、`windows/worldWritableWarning` |
| **仅代码层的 item 类型** | `hookPrompt`、`imageGeneration`、`sleep`、`subAgentActivity`（UI 解析 item 时需容错未知 type）|

### 4.1 v1 兼容遗留方法（camelCase，无斜杠；仅存于代码 + 仓库文档 `docs/codex_mcp_interface.md`）
- 请求：`getConversationSummary`、`getAuthStatus`、`gitDiffToRemote`、`fuzzyFileSearch`
- S→C 审批（旧式）：`applyPatchApproval`、`execCommandApproval`
- 说明：早期的 `newConversation` / `sendUserMessage` / `addConversationListener` 一套 **已从当前代码删除**，网上旧教程不可再用
- 另有并行入口 `codex mcp-server`（MCP 传输跑同一套类型，含 `codex/event/*` 事件流），仓库文档明确标注 experimental

---

## 5. 面向手机浏览器 Web UI 的落地建议

```
手机浏览器 ⇄ (WSS/SSE, 自定义鉴权) ⇄ 自建网关(Node/Go/Rust)
                                        ⇄ stdio JSONL ⇄ codex app-server
```

1. **不要直接依赖 `--listen ws://`**：官方标注 experimental/unsupported，且带 Origin 的请求被 403（浏览器必带 Origin，等于禁止浏览器直连）。用自建网关起 `codex app-server` 子进程走 stdio，向浏览器转发。
2. **握手**：连接后 `initialize`（按需开 `experimentalApi`，用 `optOutNotificationMethods` 裁剪不需要的通知量）→ `initialized`。
3. **最小流式闭环**：`thread/start` → `turn/start` → 渲染 `item/started` / `item/agentMessage/delta` / `item/reasoning/*Delta` / `item/commandExecution/outputDelta` / `item/completed` → `turn/completed`；配 `turn/interrupt`（停止按钮）与 `turn/steer`（追加输入）。
4. **审批即 S→C JSON-RPC 请求**：网关须把 `item/*/requestApproval` 转成前端弹窗并回传 response；监听 `serverRequest/resolved` 撤销弹窗（多端一致性）。
5. **登录**：手机场景优先 `account/login/start` 的 `chatgptDeviceCode` 类型（设备码，无需回调 URL）；`chatgpt` 类型返回 authUrl 需本机回环端口，跨设备不适用。
6. **类型安全**：CI 中跑 `codex app-server generate-ts --out src/protocol`，前端直接消费生成的 TS 类型，随 CLI 版本升级重新生成。
7. **稳态选型**：产品主干只用第 2 节（交集）接口；第 4 节实验接口（remoteControl 配对、realtime 语音）做隔离的 feature flag。

---

## Sources
- 官方文档 App Server：https://developers.openai.com/codex/app-server
- 同源 README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- 协议 schema（source of truth）：https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol
- 仓库文档（MCP 接口 / v1 遗留）：https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md
- 官方博客（App Server 设计背景）：https://openai.com/index/unlocking-the-codex-harness/
- Codex 文档首页/changelog：https://developers.openai.com/codex 、https://developers.openai.com/codex/changelog
