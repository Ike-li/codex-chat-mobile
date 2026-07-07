# Codex App Server 接口地图（合并版）

> 合并自两份独立生成的文档，并对冲突点做了源码级裁决：
> - `claude-fable-5`（2026-07-05）：基于 `openai/codex` **main 分支源码**（`app-server-protocol` crate 协议宏）+ 官方文档
> - `gpt-5-codex`（2026-07-05）：基于**本机 `codex-cli 0.142.5` 默认导出** `generate-ts` 产物 + 官方文档
> 合并与裁决执行：`claude-fable-5`

---

## 1. 先说两版冲突的裁决（本次合并最有价值的部分）

两版对 `process/spawn`、`remoteControl/*`、`thread/realtime/start|stop`、`thread/search`、`thread/items/list`、`thread/backgroundTerminals/*` 等是否存在结论相反。**源码核查结果：两版观察都对，结论各错一半**：

- `codex app-server generate-ts` / `generate-json-schema` **默认 `experimental_api: false`，会从 `ClientRequest.ts` / `ServerRequest.ts` 中过滤全部 `#[experimental]` 门控方法**（`export.rs: filter_experimental_ts` → `EXPERIMENTAL_CLIENT_METHODS` / `EXPERIMENTAL_SERVER_METHODS`）。
- **`ServerNotification.ts` 不在过滤范围内**——所以 gpt-5-codex 在默认导出里"只看到 realtime/remoteControl/process 的通知、看不到对应请求方法"，正是过滤器的行为特征，而非这些方法不存在。
- 完整视图需要：`codex app-server generate-ts --experimental --out DIR`；运行时调用还需 `initialize.capabilities.experimentalApi: true`，否则报 `"<method> requires experimentalApi capability"`。
- 官方文档甚至收录了部分 experimental 门控方法（`process/spawn` 族、`thread/backgroundTerminals/*`、`thread/turns/list`）——即"文档有载但默认导出不可见"的组合是真实存在的。

| 冲突点 | gpt-5-codex 版说法 | 裁决 |
|---|---|---|
| `process/spawn` 等不存在于当前 CLI | ❌ 结论不成立 | 存在，`#[experimental]` 门控，默认导出被过滤；且官方文档有载 |
| `remoteControl/enable|pairing/*` 不可当接口承诺 | ⚠️ 半对 | 方法在源码中存在（experimental）；"不当稳定承诺"这个建议本身正确 |
| Realtime "只有通知没有请求方法" | ❌ 不成立 | `thread/realtime/start|stop|appendAudio|appendText|appendSpeech|listVoices` 均在源码，experimental 门控 |
| `--ws-auth capability-token` / `signed-bearer-token` | ✅ 正确，claude 版遗漏 | 已在 `cli/src/main.rs` 验证 flag 存在，合并收录 |
| ClientRequest 90 / ServerRequest 10 / ServerNotification 69 | ✅ 采信 | 为 0.142.5 **默认导出**（不含 experimental 请求方法）的计数口径 |

---

## 2. 三层集合模型（取代两版各自的二分法）

```
A  官方文档层   developers.openai.com/codex/app-server
B1 默认导出层   generate-ts（不带 --experimental）→ 稳定 API 面（gpt-5-codex 所测）
B2 全量 schema  源码 app-server-protocol / generate-ts --experimental（claude-fable-5 所测）

关系：B1 ⊂ B2；A 的 RPC 方法 ≈ B1 ∪ 少量 experimental（process/*、backgroundTerminals/*、turns/list）
```

产品规则：**主干只用 A∩B1；B2∖B1 一律 feature flag 隔离**；A∖B2 是传输/运维约定（非 RPC 方法），必须遵守。

---

## 3. A∩B1：文档背书 + 默认导出可见（产品主干）

握手：`initialize`（`clientInfo` + `capabilities`：`experimentalApi` / `requestAttestation` / `mcpServerOpenaiFormElicitation` / `optOutNotificationMethods`）→ `initialized`

- **Thread**：`thread/start|resume|fork`（`ephemeral: true` 支持内存态）`|read|list|loaded/list|archive|unarchive|delete|unsubscribe|name/set|goal/set|goal/get|goal/clear|metadata/update|compact/start|rollback|shellCommand|inject_items|approveGuardianDeniedAction`
- **Turn**：`turn/start`（可覆盖 model/cwd/sandbox/approval policy）`|steer|interrupt`
- **流式事件**：`item/started` → delta（`item/agentMessage/delta`、`item/plan/delta`、`item/reasoning/summaryTextDelta|summaryPartAdded|textDelta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`）→ `item/completed`；turn 级：`turn/started|completed`、`turn/diff/updated`、`turn/plan/updated`；thread 级：`thread/started|status/changed|name/updated|goal/updated|goal/cleared|archived|unarchived|deleted|closed|tokenUsage/updated|compacted`
- **审批（S→C 请求，必须应答，否则 turn 挂起）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`item/tool/call`、`mcpServer/elicitation/request`、`account/chatgptAuthTokens/refresh`、`attestation/generate`（由 `requestAttestation` 能力门控）+ 撤销通知 `serverRequest/resolved`
- **终端**：`command/exec` + `write|resize|terminate` + `command/exec/outputDelta`
- **账号**：`account/read|login/start|login/cancel|logout|rateLimits/read|rateLimitResetCredit/consume|usage/read|sendAddCreditsNudgeEmail`；登录类型：`apiKey` | `chatgpt` | `chatgptDeviceCode` | `amazonBedrock`（`chatgptAuthTokens` 为 experimental）；通知 `account/login/completed|updated|rateLimits/updated`
- **文件系统**：`fs/readFile|writeFile|createDirectory|getMetadata|readDirectory|remove|copy|watch|unwatch` + `fs/changed`
- **配置/生态**：`config/read|value/write|batchWrite`、`configRequirements/read`、`config/mcpServer/reload`、`externalAgentConfig/detect|import|import/readHistories`（+ `import/progress|completed`）、`model/list`、`modelProvider/capabilities/read`、`experimentalFeature/list|enablement/set`、`skills/list|config/write|extraRoots/set`（+ `skills/changed`）、`marketplace/add|remove|upgrade`、`plugin/list|read|install|uninstall`、`app/list`（+ `app/list/updated`）、`mcpServer/oauth/login|resource/read|tool/call`、`mcpServerStatus/list`（+ `mcpServer/oauthLogin/completed|startupStatus/updated`）、`review/start`、`feedback/upload`、`windowsSandbox/setupStart|readiness`（+ `setupCompleted`）
- **item 类型（wire `type`）**：`userMessage`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch`、`imageView`、`enteredReviewMode`、`exitedReviewMode`、`contextCompaction`；源码另有 `hookPrompt`、`imageGeneration`、`sleep`、`subAgentActivity` —— **前端必须容错未知 type**

## 4. A∖B：仅官方文档层（协议/运维约定，非 RPC 方法）

- 传输：stdio JSONL（默认）| `--listen ws://IP:PORT`（**experimental/unsupported**）| `--listen unix://[PATH]`（`$CODEX_HOME/app-server-control/app-server-control.sock`，配 `codex app-server proxy`）| `--listen off`
- **ws 鉴权 flag**：`--ws-auth capability-token` / `--ws-auth signed-bearer-token`（暴露 ws 时必配）〔gpt-5-codex 版贡献〕
- ws 探针：`GET /readyz`、`GET /healthz`；带 `Origin` 头一律 `403`（浏览器无法直连）
- 背压：`-32001 "Server overloaded; retry later."` → 指数退避
- `clientInfo.name` 用于企业合规日志识别，自研客户端应设置稳定名称〔gpt-5-codex 版贡献〕
- 日志：`RUST_LOG`、`LOG_FORMAT=json`；schema 导出：`generate-ts` / `generate-json-schema`（各带可选 `--experimental`）

## 5. B1∖A：默认导出可见、官方文档未收录（可调用，但无文档承诺）

`plugin/installed`、`plugin/skill/read`、`plugin/share/save|updateTargets|list|checkout|delete`、`hooks/list`（+ `hook/started|completed` 通知）、`permissionProfile/list`、`account/workspaceMessages/read`、`thread/approveGuardianDeniedAction`；v1 遗留 camelCase：`getAuthStatus`、`getConversationSummary`、`gitDiffToRemote`、`fuzzyFileSearch`；旧式审批 `applyPatchApproval`、`execCommandApproval`（保留兜底）；未文档化通知：`error`、`warning`、`guardianWarning`、`deprecationNotice`、`configWarning`、`rawResponseItem/completed`、`model/rerouted|verification|safetyBuffering/updated`、`item/autoApprovalReview/started|completed`、`item/commandExecution/terminalInteraction`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`fuzzyFileSearch/sessionUpdated|sessionCompleted`

> 注：`newConversation` / `sendUserMessage` / `addConversationListener` 已从代码删除，旧教程不可用。并行入口 `codex mcp-server`（MCP 传输，`codex/event/*` 事件流）见仓库 `docs/codex_mcp_interface.md`，标注 experimental。

## 6. B2∖B1：experimental 门控全景（`--experimental` 导出 + `experimentalApi: true` 才可用）

| 分组 | 方法 |
|---|---|
| 远程控制/配对 ★手机场景 | `remoteControl/enable|disable|status/read|pairing/start|pairing/status|client/list|client/revoke`（+ `remoteControl/status/changed` 通知不被过滤）|
| 实时语音 | `thread/realtime/start|stop|appendAudio|appendText|appendSpeech|listVoices`（+ `thread/realtime/*` 8 个通知）|
| 长驻进程 | `process/spawn|writeStdin|resizePty|kill`（+ `process/outputDelta|exited`）——**官方文档有载** |
| 会话增强 | `thread/turns/list`、`thread/items/list`、`thread/search`、`thread/settings/update`、`thread/memoryMode/set`、`memory/reset`、`thread/backgroundTerminals/clean|list|terminate`（部分官方文档有载）、`thread/increment_elicitation`、`thread/decrement_elicitation` |
| 其他 | `collaborationMode/list`、`environment/add|info`、`fuzzyFileSearch/sessionStart|sessionUpdate|sessionStop`、`currentTime/read`（S→C）、`turn/moderationMetadata`（通知）、`account/login/start` 的 `chatgptAuthTokens` 类型 |

---

## 7. 手机 Web UI 产品分层（吸收 gpt-5-codex 版框架，按裁决修订）

架构（与本项目 `server.js` + `agent-appserver.js` 现状一致）：

```
手机浏览器 ⇄ Socket.IO/WSS（自建鉴权）⇄ Node 网关 ⇄ stdio JSONL ⇄ codex app-server 子进程
```

**Core（MVP 主干，全部来自 A∩B1）**

| UI 功能 | 方法/事件 |
|---|---|
| 新建/恢复会话 | `initialize`+`initialized`、`thread/start`、`thread/resume`、`thread/list`、`thread/read` |
| 发送/追加/停止 | `turn/start`、`turn/steer`、`turn/interrupt` |
| 流式气泡 | `item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed` |
| 计划/diff 面板 | `turn/plan/updated`、`item/plan/delta`、`turn/diff/updated`、`item/fileChange/patchUpdated`* |
| 命令输出卡片 | `item/commandExecution/outputDelta`、`command/exec/outputDelta` |
| 审批弹窗 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput` + `serverRequest/resolved` 撤销 |
| 状态栏 | `thread/status/changed`、`thread/tokenUsage/updated`、`account/rateLimits/updated` |
| 登录 | `account/login/start`（手机优先 `chatgptDeviceCode`；`chatgpt` 类型的 authUrl 需本机回环端口，跨设备不适用）|

\* `item/fileChange/patchUpdated` 属 B1∖A，无文档承诺，做好降级。

**Phase 2（加权限边界）**：`review/start`、`model/list`、`modelProvider/capabilities/read`、`account/read|usage/read|rateLimits/read`、`skills/list`、`mcpServerStatus/list`、`plugin/list`、`config/read`、`fs/readDirectory|readFile|watch`

**Admin（二次确认 + 审计日志）**：`config/value/write|batchWrite`、`fs/writeFile|remove|copy`、`plugin/install|uninstall`、`marketplace/*`、`mcpServer/tool/call`、`account/logout`

**Feature flag 实验区（B2∖B1）**：`remoteControl/*` 配对、`thread/realtime/*` 语音、`process/*`、`thread/search`——修订 gpt-5-codex 版的"Observe-only"结论：请求方法存在，可以做，但须 `--experimental` 导出 + `experimentalApi` 能力 + 独立开关。

## 8. 实现注意事项（合并两版）

1. 浏览器永远不直连 `--listen ws://`（experimental/unsupported + Origin 403）；若非要暴露 ws，必配 `--ws-auth`。
2. 所有 S→C 请求必须按 method 精确应答；本项目 `agent-appserver.js` 对未知 server request 回 `{}` 只是 MVP 兜底，产品化要区分命令/文件/权限审批与旧式 `applyPatchApproval`、`execCommandApproval`，弃用 `/requestApproval/i` 正则匹配。
3. 用 `optOutNotificationMethods` 裁剪高频通知（如 `item/reasoning/*Delta`），降低移动端流量。
4. 前端把未知 item type / notification 降级为 raw 卡片，不崩溃。
5. CI 版本锁定，diff 两套产物：

```bash
codex app-server generate-ts --out src/protocol/stable
codex app-server generate-ts --experimental --out src/protocol/experimental
codex app-server generate-json-schema --out docs/protocol-schema
rg -o '"method": "[^"]+"' src/protocol/stable/ClientRequest.ts | sed 's/.*"method": "//; s/"$//' | sort
```

## 9. CLI 功能 → 手机端映射矩阵

### 9.1 稳定接口可直接映射（A∩B1，产品主干）

| Codex CLI 功能 | app-server 接口 | 手机端形态 |
|---|---|---|
| 交互式流式对话 | `thread/start` + `turn/start` + `item/agentMessage/delta` | 聊天气泡（已实现）|
| 推理过程展示 | `item/reasoning/summaryTextDelta\|textDelta` | 可折叠"思考中"块 |
| 命令执行实况 | `item/commandExecution/*` + `outputDelta` | 终端卡片 |
| y/n 审批 | `item/commandExecution\|fileChange\|permissions/requestApproval` + `serverRequest/resolved` | 弹窗；配合 sw.js Web Push，锁屏可收审批 |
| `/diff` | `turn/diff/updated`、`item/fileChange/patchUpdated`* | diff 视图 |
| 计划显示 | `turn/plan/updated`、`item/plan/delta` | 任务清单面板 |
| `codex resume` / `/new` / fork | `thread/list\|read\|resume\|fork\|archive\|delete` | 会话列表（可替代 history.js 部分职责）|
| `/compact` | `thread/compact/start` + `thread/compacted` | 一键压缩 |
| 回退 | `thread/rollback` | 消息长按回退 |
| `/model` | `model/list` + `turn/start` 覆盖参数 | 模型选择器 |
| `/approvals` 沙箱/审批策略 | `turn/start` 的 sandbox/approvalPolicy override | 设置页 |
| `codex login/logout` | `account/login/start`（手机用 `chatgptDeviceCode`）、`account/logout` | 登录页 |
| `/status` token/限流 | `thread/tokenUsage/updated`、`account/rateLimits/read\|updated`、`account/usage/read` | 状态栏（statusline.js 改造接事件）|
| `/mcp` | `mcpServerStatus/list`、`mcpServer/oauth/login`、`config/mcpServer/reload` | MCP 管理页 |
| Skills / 插件 | `skills/list\|config/write`、`plugin/list`、`marketplace/*`（Admin 层）| 管理页 |
| `/review` | `review/start` + `enteredReviewMode/exitedReviewMode` item | 代码评审模式 |
| 图片输入 | `turn/start` 的 image 输入（uploads.js 落盘后传路径）| 拍照/相册上传 |
| `!` 直接跑命令 | `thread/shellCommand` 或 `command/exec` 族 | 快捷终端 |
| `@` 文件提及 | `fs/readDirectory\|readFile`（v1 `fuzzyFileSearch` 兜底）| 文件选择器 |
| CLAUDE.md 导入 | `externalAgentConfig/detect\|import` | 一键导入向导 |
| 运行中追加/中断 | `turn/steer` / `turn/interrupt` | 输入框直发 / 停止按钮 |

\* `item/fileChange/patchUpdated` 属 B1∖A（无文档承诺），做好降级。

### 9.2 experimental 门控（B2∖B1，feature flag + `--experimental` 导出 + `experimentalApi: true`）

| Codex CLI 功能 | app-server 接口 | 备注 |
|---|---|---|
| 完整网页终端（真 terminal-equivalent）| `process/spawn\|writeStdin\|resizePty\|kill` + `outputDelta\|exited` | PTY 级，官方文档有载 |
| 后台终端管理 | `thread/backgroundTerminals/clean\|list\|terminate` | |
| 历史分页拉取 | `thread/turns/list`、`thread/items/list` | 比 history.js 解析 JSONL 更正规 |
| 会话搜索 | `thread/search` | |
| 语音对话 | `thread/realtime/*` + Web Audio | |
| 手机配对/远程控制 | `remoteControl/pairing/*`、`remoteControl/enable\|disable` | 官方在做的正是本产品方向，持续关注 |

### 9.3 映射不了 / 不经 app-server

- `codex cloud` 云任务：走 ChatGPT 后端，不经 app-server
- `codex exec` 批处理：独立子命令；等价物 = `ephemeral: true` thread + `turn/start`
- TUI 本地渲染细节（transcript 滚动、快捷键、onboarding）
- OS 级沙箱本身（seatbelt/landlock 由 server 端进程处理，UI 只透出策略选择）

### 9.4 当前项目缺口（对照 CLAUDE.md 模块现状）

reasoning 流渲染、`turn/steer`、`thread/fork`、`/review` 模式、`chatgptDeviceCode` 登录流。

## Sources

- 官方文档：https://developers.openai.com/codex/app-server （同源 `codex-rs/app-server/README.md`）
- 协议源码（source of truth）：https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol （方法宏：`protocol/common.rs`；experimental 过滤：`src/export.rs`；`--ws-auth`：`cli/src/main.rs`）
- 仓库文档（v1 遗留 / MCP 入口）：https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md
- 官方博客：https://openai.com/index/unlocking-the-codex-harness/
- 被合并文档：`docs/codex-app-server-接口对照清单-claude-fable-5.md`、`codex-app-server-interface-map-gpt-5-codex.md`（0.142.5 默认导出计数：ClientRequest 90 / ServerRequest 10 / ServerNotification 69）
