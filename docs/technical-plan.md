# codex-chat-mobile 综合技术方案（基线）

> 本文是项目的**权威技术基线**，取代 `docs/` 下四份由不同模型生成的提案（它们保留为历史提案）。
> 最后更新：2026-06-28 · 维护：随架构演进同步更新。**当前状态：app-server 唯一后端，阶段 0-3 已完成。**

---

## 标注约定

本文对外部事实标注**依据 + 置信度**：

- 依据：`[KNOWN]` 已联网核实 / 来自实读代码 · `[INFERRED]` 推论 · `[GUESS]` 无根据
- 置信度：`HIGH` ≥80% · `MED` 50–80% · `LOW` 20–50%

凡涉及 Codex 接口的字段、事件名、协议，均已对照官方 `codex app-server` README 与 `codex exec --json` 文档核实（见 [§9 参考来源](#9-参考来源)）；凡涉及本项目现状，均对照实际代码并标注行号。

---

## 1. 概述与定位

**项目目标**：把**本机 codex CLI** 投送到手机——追求"终端等价性"：在手机上打字与坐在电脑前对 codex CLI 打字效果一致（会话连续、真实改文件/跑命令、权限审批、流式输出、断线续传）。

**一句话结论** `[KNOWN, HIGH]`：技术可行性已核实。项目已从 `codex exec --json` 渐进演进到 **`codex app-server`** 作为唯一后端——长驻 JSON-RPC、原生流式、手机端审批、富事件渲染全部落地。

**本文回答三个问题**：
1. 现状是什么？（[§3](#3-现状基线app-server-生产基线)）
2. 目标是什么、协议长什么样？（[§4](#4-目标架构codex-app-server)、[§5](#5-可抄的蓝本remodex)）
3. 怎么从现状走到目标？（[§6](#6-演进路线全部完成)）

---

## 2. 背景：四份提案的核实结论

项目早期由四个模型各自产出了一份提案。经联网核实（官方文档 + npm + GitHub + App Store 交叉验证），可靠性排序如下：

| 提案 | 主张路线 | 核实后评价 | 采纳 |
|---|---|---|---|
| `gpt-5.5-plan.md` | **app-server** JSON-RPC | 最准确，引用全部为真，路线判断与官方定位一致 | ✅ **目标架构蓝本** |
| `claude-sonnet-4-6-plan.md` | `codex exec --json` 子进程 | 务实准确，先例（Remodex）与 bug（#5773）引用为真 | ✅ **曾为 MVP 基础（已于 2026-06-28 退役）** |
| `codex-migration-plan-gemini-3.5-flash.md` | `@openai/codex-sdk` | SDK 核心属实；"100% 移植"过于乐观，裸 stdin 写 `y\n` 审批方式偏脆弱 | ◐ 取其第三方 provider / OSS 配置思路 |
| `deep-research-plan.md` | 云端 Responses API | ❌ **核心前提错误**："Codex 没有 agent SDK" 不成立；该路线偏离"本机 CLI 等价"目标，变成 API 套壳 | ✗ **弃用** |

**核实要点** `[KNOWN, HIGH]`：

- `codex app-server`、`@openai/codex-sdk`（npm 真实，spawn CLI + JSONL）、`codex exec --json`、Remote connections **全部真实存在**。
- `@openai/codex-sdk` 的本质是 **spawn `codex` CLI 并通过 stdin/stdout 交换 JSONL** —— 因此 "SDK 路线" 与 "exec 路线" 底层同源；真正的分野是 **轻量层（exec / SDK，官方定位 CI/自动化）** vs **重量层（app-server，官方定位 "power rich clients"，含原生审批 + 会话历史 + 流式事件）**。
- 本项目是 rich client，**app-server 是正确答案**；这一判断被 Remodex（3.2k★、已上架、其 bridge 正是走 app-server）实战验证。

---

## 3. 现状基线（app-server 生产基线）

项目当前是一个完整可用的 rich client，**app-server 是唯一后端**（`CODEX_BACKEND` 环境变量已移除，exec 模式于 2026-06-28 退役）。

### 3.1 现状架构

```
 手机浏览器 / PWA (public/index.html, ~750 行)
     │  Socket.IO  (事件名: user:message / agent:event / catch-up …)
     ▼
 server.js (~530 行) ── Express 5 静态托管 + Socket.IO 契约层
     │   · AUTH_TOKEN 鉴权(timingSafeEqual)  · 设备白名单 + pending 审批  · CSP 头
     │   · 单活跃会话 activeSession  · io.emit('agent:event') 多设备同看
     ▼
 agent-appserver.js (349 行) ── CodexAppServerSession
     │   长驻子进程，JSON-RPC over stdio (NDJSON)：
     ▼
 codex app-server
     │   initialize → thread/start(resume) → turn/start
     │   通知: item/agentMessage/delta, item/started|completed, turn/completed …
     └─► handleLine() 解析 → emit 统一信封 → server.js 广播 → 手机
```

### 3.2 已实现清单（全部完成）

| 文件 | 行数 | 职责 |
|---|---|---|
| `agent-appserver.js` | 349 | `CodexAppServerSession`：长驻 `codex app-server`、JSON-RPC 双向通信、原生流式 `item/agentMessage/delta`、手机端审批、富事件映射（fileChange/plan/reasoning） |
| `server.js` | 533 | Express + Socket.IO 契约层、鉴权、设备认证、会话路由、事件广播 |
| `sessions.js` | 102 | 会话元数据指针（按 cwd 维护当前会话），单 JSON 持久化 |
| `devices.js` | 129 | 设备信任白名单 + 待审核队列，原子写入 |
| `file-security.js` | 107 | symlink 穿越防御 + owner-only(0600) 权限 |
| `sanitizer.js` | 63 | 日志脱敏（掩盖 token） |
| `public/index.html` | 750 | 完整 PWA：会话列表、消息时间线、工具卡片、审批弹窗、file_change/plan/reasoning 富卡片、设备审批 UI、Dark/Light |
| `scripts/doctor.js` | ~40 | 启动自检（codex 二进制、WORK_DIR、AUTH_TOKEN） |

依赖极简：`express@5` + `socket.io@4` + `compression` + `dotenv`，**无任何 SDK**。
配置（`.env`）：`PORT` / `AUTH_TOKEN` / `WORK_DIR` / `CODEX_BIN` / `IDLE_TIMEOUT_MS` / `CODEX_APPROVAL_POLICY` / `CODEX_SANDBOX`。

### 3.3 统一事件信封 + 断线续传（与底层接口解耦，**可整层复用**）

`CodexAppServerSession.emit()`（`agent-appserver.js:319-336`）把每个事件包成统一信封：

```js
{ seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- `seq` 单调递增；`epoch` 标识进程代次；写入 ring buffer（`BUFFER_CAP=500`）。
- `eventsSince(lastSeq)`（`agent-appserver.js:338-343`）支持断线重连回放：返回 `{events, gap, epoch}`，`gap` 标记缓冲被截断导致的丢失。
- `server.js` 的 `catch-up` socket 事件（`server.js:487-496`）据此回放。

> 这套信封 + ring buffer 与"底层是 exec 还是 app-server"**无关**，迁移时整层保留。

> 这套信封 + ring buffer 与底层协议无关，从 exec 迁移到 app-server 时整层保留。

### 3.4 事件映射表（`agent-appserver.js`，✅ app-server 通知映射已真机校验）

app-server JSON-RPC 通知为 camelCase 模型（`item/started`/`item/completed`/`item/agentMessage/delta` 等）：

| app-server 通知 | item.type / method | 信封 type | payload |
|---|---|---|---|
| `item/agentMessage/delta` | — | `text_delta` | `{text: delta}`（流式，按序拼接） |
| `item/started` | `commandExecution` | `tool_use` | `{toolUseId: item.id, name:'ShellCall', inputSummary: item.command}` |
| `item/completed` | `commandExecution` | `tool_result` | `{toolUseId, ok: item.exitCode===0, outputSummary: item.aggregatedOutput}` |
| `item/completed` | `fileChange` | `file_change` | `{files:[{path,kind,diff}]}` |
| `item/completed` | `mcpToolCall` | `mcp_use` / `mcp_result` | `{toolUseId, serverName, toolName, inputSummary/outputSummary}` |
| `item/completed` | `webSearch` | `search` | `{query, results:[{title,url,snippet}]}` |
| `item/reasoning/summaryTextDelta` | — | `reasoning` | `{text: delta}`（流式） |
| `turn/plan/updated` | — | `plan` | `{plan:[{step,status}]}` |
| `turn/diff/updated` | — | `diff` | `{diff}`（cumulative unified diff） |
| `turn/completed` | — | `result` | `{ok, status}` |
| `turn/failed` | — | `error` | `{message, recoverable:true}` |
| `thread/tokenUsage/updated` | — | `usage` | `{usage}` |
| `item/*/requestApproval` | — | `approval_request` | `{approvalId, command, cwd, reason, availableDecisions}`（server→client 请求） |

### 3.5 鉴权与设备认证（`server.js`）

- **Token / 监听边界**：`AUTH_TOKEN` 经 `timingSafeEqual` 恒时比较；`AUTH_TOKEN` 为空时默认绑定 `127.0.0.1`，并要求 loopback socket + loopback Host；需要局域网/隧道时必须设置非空 `AUTH_TOKEN` 并显式 `HOST=0.0.0.0`。
- **设备信任**：本地连接免审；远程设备凭 `deviceToken` 查白名单，未知设备进入 pending，通过 TTY 回车一键批准 / `scripts/device.js` / 已信任设备远程批准 / `watch(trusted-devices.json)` 自动解锁（`server.js:211-307`, `499-514`）。

### 3.6 演进历程（全部已解决）

| # | 原局限 | 解决方案 | 状态 |
|---|--------|---------|------|
| 1 | 无手机端命令审批 | app-server JSON-RPC 双向通信，`*/requestApproval` → `approval_request` ↔ `user:approval` | ✅ 阶段2 |
| 2 | 每轮新进程、一问一答 | 长驻 `codex app-server` 子进程，JSON-RPC 长连接 | ✅ 阶段1 |
| 3 | exec snake_case 事件映射 | 真机采样校正 + 单测锁定 | ✅ 阶段0 |
| 4 | exec 双后端维护成本 | 移除 `agent.js` 和 `CODEX_BACKEND` 环境变量，app-server 唯一后端 | ✅ 2026-06-28 |

---

## 4. 目标架构（Codex app-server）

### 4.1 定位与传输 `[KNOWN, HIGH]`

官方原文：app-server 是 "the interface Codex uses to **power rich clients**"（如 VS Code 扩展），用于深度集成——提供 **authentication、conversation history、approvals、streamed agent events**，实现开源于 `openai/codex/codex-rs/app-server`。

协议：类似 MCP 的**双向 JSON-RPC 2.0**（线上省略 `"jsonrpc":"2.0"` 头）。传输：

| 传输 | 启动 | 说明 |
|---|---|---|
| **stdio** | `--listen stdio://`（默认） | 换行分隔 JSON（JSONL/NDJSON）—— **本项目首选** |
| unix socket | `--listen unix://[PATH]` | 默认 `$CODEX_HOME/app-server-control/app-server-control.sock`，HTTP Upgrade 后的 WebSocket |
| websocket | `--listen ws://IP:PORT` | **实验性、不支持生产**；非 loopback 默认允许未认证连接，暴露前须配置 auth |
| off | `--listen off` | 不暴露本地传输 |

> 本项目应采用 **stdio** 子进程模式（与现状 spawn 习惯一致、最稳），把 JSON-RPC 包在我们自己的 Socket.IO 之上，不直接用 app-server 的实验性 ws。

### 4.2 thread / turn / item 模型 `[KNOWN, HIGH]`

- **thread** = 一段会话；**turn** = 一次用户请求；**item** = turn 内的单元（消息 / 命令 / 文件变更 / 工具调用 / 推理…）。
- 所有 item 共用生命周期：`item/started` → （类型专属 delta）→ `item/completed`。

`ThreadItem.type` 枚举（节选）：`userMessage` · `agentMessage` · `reasoning` · `commandExecution`（含 `command/cwd/status/exitCode/aggregatedOutput`）· `fileChange`（含 `changes:[{path,kind,diff}]/status`）· `mcpToolCall` · `webSearch` · `imageView` · `plan` · `contextCompaction`。

### 4.3 初始化 / 认证

`initialize` 必须先于一切请求（随后发 `initialized` 通知）：

```json
{ "method": "initialize", "id": 0, "params": {
    "clientInfo": { "name": "codex-chat-mobile", "title": "Codex Chat Mobile", "version": "0.1.0" },
    "capabilities": {
      "experimentalApi": false,
      "optOutNotificationMethods": []
    }
}}
```

- 响应含 `codexHome` / `platformFamily` / `platformOs` / user-agent。
- 重复 initialize → `"Already initialized"`；未 initialize 即发请求 → `"Not initialized"`。
- **登录**：`account/login/start`，params 三选一 `{type:"apiKey", apiKey}` / `{type:"chatgpt"}` / `{type:"chatgptDeviceCode"}`；另有 `account/logout` / `account/read`。

### 4.4 thread 操作

| method | 用途 / 关键参数 |
|---|---|
| `thread/start` | 新建：`model` / `cwd` / `approvalPolicy` / `sandbox` / `personality` … |
| `thread/resume` | 恢复：`threadId`（+ 可覆盖项） |
| `thread/fork` | 分叉：`threadId` / `lastTurnId?` / `excludeTurns?` |
| `thread/list` | 分页列出：`cursor` / `limit` / `cwd` / `searchTerm` / `archived` … |
| `thread/read` | 只读取（不 resume）：`threadId` / `includeTurns?` |
| `thread/archive` · `thread/delete` · `thread/name/set` | 归档 / 删除 / 命名 |

关键通知：`thread/started` · `thread/status/changed`（status：`notLoaded` / `idle` / `active` / `systemError`）· `thread/tokenUsage/updated`。

### 4.5 turn 生命周期

**发起一轮**（真实示例，可直接用）：

```json
{ "method": "turn/start", "id": 30, "params": {
    "threadId": "thr_123",
    "input": [ { "type": "text", "text": "Run tests" } ],
    "cwd": "/Users/me/project",
    "approvalPolicy": "unlessTrusted",
    "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": ["/Users/me/project"], "networkAccess": true },
    "model": "gpt-5.1-codex",
    "effort": "medium"
}}
```

> 示例中的 `model` 名以实际可用模型为准。`input` 还支持 `{type:"image"|"localImage"|"skill"|"mention"}`。

turn 通知：`turn/started` · `turn/completed`（`turn.status`：`completed` / `interrupted` / `failed`）· **`turn/diff/updated`**（`{threadId,turnId,diff}`，每次 fileChange 后的 unified diff 快照）· **`turn/plan/updated`**（`{turnId, plan:[{step,status}]}`）。
中断：`turn/interrupt` `{threadId, turnId}`。

### 4.6 流式事件（→ 映射到现有信封 type）

| app-server 事件 | 拟映射信封 type | 说明 |
|---|---|---|
| `item/agentMessage/delta` | `text_delta` | 正文流（同 itemId 的 delta 按序拼接） |
| `item/commandExecution/outputDelta` | `tool_output_delta`（新增） | 命令实时 stdout/stderr |
| `item/reasoning/summaryTextDelta` | `reasoning_delta`（新增） | 思考摘要流 |
| `item/started` · `item/completed` | `tool_use` · `tool_result` | 命令 / 文件变更 / 工具卡片 |
| `turn/diff/updated` | `diff`（新增） | diff 卡片 |
| `turn/plan/updated` | `plan`（新增） | 计划卡片 |
| `turn/completed` | `result` | 一轮结束 |

### 4.7 审批协议（命门，自包含字段） `[KNOWN, HIGH]`

审批是 **server→client 的 JSON-RPC request**，客户端回 response；处理后服务端发 `serverRequest/resolved {threadId, requestId}`。

**① 命令执行审批** `item/commandExecution/requestApproval`，请求字段：

| 字段 | 说明 |
|---|---|
| `itemId` / `threadId` / `turnId` | 定位 |
| `environmentId` | 运行环境，可为 `null` |
| `command` / `cwd` / `commandActions` | 正常命令审批时包含（友好展示用） |
| `reason` | 申请理由 |
| `approvalId` | 可选，subcommand 回调用 |
| `availableDecisions` | 可选，服务端希望暴露的选项集 |
| `additionalPermissions` | `experimentalApi` 时可能含，路径为绝对路径，网络表示为 `additionalPermissions.network.enabled` |
| `networkApprovalContext` | network-only 审批时替代 command 字段 |

**② 文件变更审批** `item/fileChange/requestApproval`：`itemId` / `threadId` / `turnId` / `reason?` / `grantRoot?`（unstable，申请 session 级写权限根）。

**③ 权限审批** `item/permissions/requestApproval`（完整示例）：

```json
{ "method": "item/permissions/requestApproval", "id": 61, "params": {
    "threadId": "thr_123", "turnId": "turn_123", "itemId": "call_123",
    "environmentId": "local", "cwd": "/Users/me/project",
    "reason": "Select a workspace root",
    "permissions": { "fileSystem": { "write": ["/Users/me/project", "/Users/me/shared"] } }
}}
```

**客户端响应 —— decision 枚举**（命令审批支持全部；文件/权限审批支持前四个）：

```jsonc
{ "decision": "accept" }
{ "decision": "acceptForSession" }
{ "decision": "decline" }
{ "decision": "cancel" }
// 命令审批还支持带修正的复杂变体：
{ "decision": { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": [ /* … */ ] } } }
{ "decision": { "applyNetworkPolicyAmendment": { "network_policy_amendment": { "host": "example.com", "action": "allow" } } } }
```

权限审批响应另含 `scope`：`"session"`（持久到本会话）/ `"turn"`（默认）。

### 4.8 错误码与背压

- `-32001` "Server overloaded; retry later."（背压，客户端应指数退避）
- `-32601` method not supported
- 调试：`RUST_LOG` 控制日志，`LOG_FORMAT=json` 输出 JSON 日志到 stderr。
- 类型自助：`codex app-server generate-ts --out DIR` / `generate-json-schema --out DIR`（加 `--experimental` 含实验 API）—— **落地时用它生成权威类型，胜过手抄**。

---

## 5. 可抄的蓝本：Remodex

**Remodex**（`Emanuele-web04/remodex`，Apache-2.0，3.2k★，已上架 App Store）做的就是同一件事：Codex 跑在 Mac、手机配对后远程控制。`[KNOWN, HIGH]`

> ⚠️ Apache-2.0 允许借鉴/复用，但需保留 attribution（NOTICE）。

### 5.1 关键发现：bridge 是纯 Node.js

- **bridge 本体 = `phodex-bridge`**（Node, CommonJS），运行时仅依赖 `ws` + `qrcode-terminal`，加密全用 Node 内置 `crypto`，**零第三方加密库**。
- Swift 的 `RemodexMenuBar` 只是菜单栏 GUI 壳（shell out 调 `remodex` CLI），**不是 bridge**。
- 它对接 codex 的方式（`codex-transport.js`）：**`spawn("codex", ["app-server"])` + stdin/stdout 收发 NDJSON JSON-RPC** —— 印证了本项目的 app-server 目标路线。

### 5.2 核心模式：透明 JSON-RPC 代理 + 方法拦截链（**最该抄**）

`bridge.js` 的 `handleApplicationMessage`：手机来的每条消息，先让一组 `handleXRequest`（git / workspace / auth / project…）挨个尝试认领；**没人认领的，原样 `codex.send()` 透传给 app-server**；codex 回来的事件原样转发回手机。

> 这正是"终端等价性"的实现关键：**不用枚举 codex 的所有方法，只拦截你要增强的几个，其余全透传。** 审批同理——`bridge.js` 识别 `*/requestApproval` 这类 server→client 请求，透传给手机，手机回答后再透传回 codex（bridge 不自动批准）。

### 5.3 安全与传输（按需借鉴）

- **E2EE**（`secure-transport.js`）：X25519 ECDH + Ed25519 签名 + AES-256-GCM + HKDF-SHA256，4 步握手（clientHello → serverHello → clientAuth → secureReady），12 字节 nonce（方向位 + 单调 counter）防重放。全用 Node 内置 `crypto`，可逐行复用。
- **身份/信任**：`~/.remodex/device-state.json`（0600）存长期 Ed25519 身份 + `trustedPhones`（只信任一台手机）。
- **传输**：手机与 bridge 各自连到一个自托管 **WebSocket relay**（`relay/relay.js`，~250 行），按 `/relay/<sessionId>` 房间转发、`x-role` 区分 mac/iphone，**relay 看不到明文**（E2EE 叠在其上）；公网穿透推荐 Tailscale / Cloudflare tunnel；OSS 不内置公网 relay。

### 5.4 直接抄 / Apple 特有需替换

| 能力 | Remodex | 移植到本项目 |
|---|---|---|
| codex 对接 | `spawn codex app-server` + NDJSON | ✅ 直接抄（`codex-transport.js`） |
| 代理分发 | 责任链拦截 + 透传 | ✅ **直接抄（架构精髓）** |
| E2EE | Node `crypto`，4 步握手 | ◐ 可逐行抄；浏览器端见 [§7 风险③](#7-关键决策与风险登记) |
| relay | `ws` 房间转发 | ◐ 单进程可并入主服务 |
| 守护进程 | launchd plist | ❌ 换 `pm2` / `systemd --user` / 前台 |
| 离线推送 | APNs（ES256 JWT） | ❌ 换 **Web Push (VAPID)** |
| 身份存储 | 0600 文件 + Keychain 镜像 | ◐ 只用 0600 文件即可 |
| 桌面联动 | AppleScript / `codex://` / 桌面 IPC | ❌ 丢弃（纯 CLI 场景不需要） |

---

## 6. 演进路线（全部完成）

### 6.1 三层划分

```
┌─ 不变层（整层复用，无需改动）────────────────────────────────────┐
│  PWA 前端骨架 · Socket.IO 契约 · 统一信封 + ring buffer 断线续传  │
│  AUTH_TOKEN 鉴权 · 设备认证 · sanitizer · file-security · sessions │
├─ 替换层（已完成）──────────────────────────────────────────────┤
│  agent-appserver.js 的 CodexAppServerSession：                     │
│    exec spawn(每轮新进程)  ──►  app-server 长连接 JSON-RPC        │
├─ 新增层（app-server 解锁的新能力）────────────────────────────┤
│  手机端审批弹窗 · file_change/plan/reasoning 卡片 · mcpToolCall/webSearch · diff │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 分阶段实施（全部 ✅）

> 原则：每阶段独立可验证；信封格式不变，改动限制在会话内核与前端渲染。

**阶段 0 — 现状加固** ✅ 已完成
- ✅ 真机采样 `codex exec --json` 校正事件映射、stdin 挂起修复、resume 子命令用法。
- 交付：`agent.js`、`test/agent.test.mjs`、`scripts/smoke-codex.js`（已于 2026-06-28 退役）。

**阶段 1 — app-server 内核** ✅ 已完成
- ✅ 新增 `agent-appserver.js`：`spawn codex app-server` → `initialize` → `thread/start(resume)` → `turn/start`；JSON-RPC over stdio。
- 交付：`agent-appserver.js`、`test/agent-appserver.test.mjs`、`scripts/smoke-appserver.js`。

**阶段 1.5 — exec 模式移除** ✅ 已完成（2026-06-28）
- ✅ 删除 `agent.js`、`test/agent.test.mjs`、`scripts/smoke-codex.js`。
- ✅ `server.js` 移除 `CODEX_BACKEND` 切换，硬编码 `CodexAppServerSession`。
- ✅ 清理所有 smoke 脚本和 `.env.example` 中的 `CODEX_BACKEND` 引用。

**阶段 2 — 审批闭环** ✅ 已完成
- ✅ `*/requestApproval` → `approval_request` ↔ `user:approval`；未知 server 请求安全兜底。
- 交付：审批卡片 + `scripts/smoke-approval.js`（E2E PASS）。

**阶段 3 — 富事件渲染** ✅ 已完成
- ✅ `fileChange` → `file_change`、`turn/plan/updated` → `plan`、`item/reasoning/summaryTextDelta` → `reasoning`、`turn/diff/updated` → `diff`、`mcpToolCall` → `mcp_use/mcp_result`、`webSearch` → `search`。
- 交付：前端卡片 + `test/agent-appserver.test.mjs`（15+ 测试）+ `scripts/smoke-rich.js`。

**阶段 4 —（可选）安全增强** ⬜
- E2EE（X25519 + AES-256-GCM）、自托管 relay、Web Push 离线通知。
- 仅在"需要公网安全暴露给多设备"时做；单用户 LAN + token 可不做。

---

## 7. 关键决策与风险登记

| # | 项 | 结论 / 风险 | 依据 |
|---|---|---|---|
| 1 | exec vs app-server | **已决：app-server 唯一后端**。exec 模式于 2026-06-28 退役 | 已落地 |
| 2 | 事件名真机校验 | ✅ **已解决**：app-server 通知映射已探针采样确认，15 个单测锁定 | `[KNOWN, HIGH]` |
| 3 | ⚠️ 浏览器端 E2EE | WebCrypto 对 **X25519 / Ed25519** 支持较新，旧设备可能缺失；如做 PWA 端 E2EE 需实测目标设备，或用 **libsodium.js (WASM)** 兜底（Remodex iOS 用 CryptoKit 不受此限） | `[INFERRED, MED]` |
| 4 | exec `--json` + `--image` | ❌ 不再适用（exec 模式已退役） | — |
| 5 | exec `--json` + MCP | ❌ 不再适用（exec 模式已退役，app-server 原生支持 MCP） | — |
| 6 | 单会话 vs 多设备并发 | 现状单 `activeSession`、多设备同看一份；如需多会话并发需扩展 `server.js` 会话表 | 现状 |
| 7 | app-server ws 传输 | 官方标"实验性、不支持生产"，**不要直接用**；用 stdio 子进程 + 自有 Socket.IO | `[KNOWN, HIGH]` |
| 8 | 类型来源 | 用 `codex app-server generate-ts` 生成权威类型，避免手抄字段漂移 | `[KNOWN, HIGH]` |

---

## 8. 验证策略

**日常验证**
- `node scripts/doctor.js` 自检；`npm run dev` 起服务，手机连入端到端发消息。
- `npm test`：`node --test test/*.test.mjs`（15 个 app-server 事件映射 + 审批测试）。

**app-server 专项**
- `scripts/smoke-appserver.js`：JSON-RPC 握手 + 流式 delta + turn/completed。
- `scripts/smoke-server.js`：全栈 E2E（server.js + socket.io-client）。
- `scripts/smoke-approval.js`：审批闭环（read-only 沙箱 → on-failure 审批 → 决策生效）。
- `scripts/smoke-rich.js`：富事件（file_change / plan / reasoning 到达客户端）。

**通用**
- 协议字段以官方 `generate-json-schema` 输出为准；本文字段若与真机/新版本不一致，以真机为准并回填本文。

---

## 9. 参考来源

**已核实（官方）** `[KNOWN, HIGH]`
- App Server 协议：<https://developers.openai.com/codex/app-server> · 开源实现 README：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Codex SDK：<https://developers.openai.com/codex/sdk> · npm：<https://www.npmjs.com/package/@openai/codex-sdk>
- 非交互模式（`codex exec --json`）：<https://developers.openai.com/codex/noninteractive>
- Remote connections：<https://developers.openai.com/codex/remote-connections>
- 已知 bug #5773：<https://github.com/openai/codex/issues/5773>

**现成蓝本** `[KNOWN, HIGH]`
- Remodex（Apache-2.0）：<https://github.com/Emanuele-web04/remodex> · App Store：<https://apps.apple.com/us/app/remodex-remote-ai-coding/id6760243963>

**本项目代码**
- 现状内核：`agent-appserver.js`、`server.js`、`sessions.js`、`devices.js`、`file-security.js`、`sanitizer.js`、`public/index.html`、`scripts/doctor.js`
- 历史提案：`docs/gpt-5.5-plan.md`、`docs/claude-sonnet-4-6-plan.md`、`docs/codex-migration-plan-gemini-3.5-flash.md`、`docs/deep-research-plan.md`
- 参考架构来源：`claude-chat-mobile`（<https://github.com/Ike-li/claude-chat-mobile>）
