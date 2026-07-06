# codex-chat-mobile 架构设计文档

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.0
> 上游依据：《接口地图-合并版》《需求文档 PRD v1.0》；对齐现状基线 `docs/technical-plan.md`
> 性质：在既有生产基线上的目标架构设计，非从零重建

## 1. 需求输入与约束

- 功能：PRD FR-01…FR-35，按 P0–P3 分期；核心是 thread/turn/item 流式模型 + 审批闭环映射到手机浏览器
- 非功能：NFR-1…8（流式 P95≤300ms、断线零丢失、审批可审计、CI 兼容防线）
- 硬约束（来自接口地图）：
  1. 浏览器**不可能**直连 app-server ws（Origin→403 + experimental/unsupported）→ 必须自建网关
  2. 稳定 API 面 = A∩B1；`generate-ts` 默认过滤 experimental 请求方法但**不过滤通知** → 网关可能收到"没有对应请求方法"的通知
  3. S→C 请求（审批族）不应答则 turn 挂起 → 审批通道是可用性命门
- 既有约束：Node.js ESM、Express 5 + Socket.IO 4、零第三方 AI SDK、单文件 SPA、node:test

## 2. 总体架构

```
┌─────────────── 手机浏览器（PWA）───────────────┐
│ index.html SPA：item 状态机 reducer + 渲染层    │
│ sw.js：Web Push（审批到达/任务终态）            │
└───────┬───────────────────────▲───────────────┘
   Socket.IO(WSS) + 设备认证      │ agent:event（统一信封, seq 续传）
   user:message/approval/…        │
┌───────▼───────────────────────┴───────────────┐
│ server.js  网关路由层                           │
│  · agents Map: instanceId → AgentSession        │
│  · 设备审批 / loopback-only 无 token 边界        │
│  · catch-up 重放缓冲（按 seq）                   │
├─────────────────────────────────────────────────┤
│ agent-appserver.js  协议桥（每实例一个）          │
│  · JSON-RPC 客户端: initialize 握手/能力声明      │
│  · 方法拦截链（注册表分派 + 映射表）              │
│  · ApprovalBroker: S→C 请求登记→转发→回填 response│
│  · 事件映射表: 通知 → 统一信封 type               │
├──────────────┬──────────────────────────────────┤
│ uploads.js   │ statusline.js │ history.js │ CI: │
│ 图片落盘→路径 │ git+ctx 状态  │ JSONL 兜底 │ 双导出diff│
└──────┬───────┴───────────────────────────────────┘
  stdio JSONL (spawn 子进程, 每实例一个)
┌──────▼──────────────────────────────────────────┐
│ codex app-server（复用 CLI 全部底层能力）          │
└─────────────────────────────────────────────────┘
```

数据流（发消息）：`user:message` → server.js 按 instanceId 路由 → 桥 `turn/start` → 通知流（`item/started`→deltas→`item/completed`→`turn/completed`）→ 映射为信封 `agent:event`（自增 seq）→ Socket.IO 房间广播 + 写重放缓冲。

## 3. 接口契约策略（网关 allowlist 三环）

| 环 | 来源 | 网关策略 |
|---|---|---|
| 稳定环 | A∩B1 | 直接暴露给前端语义化事件/命令 |
| 容错环 | B1∖A（如 `item/fileChange/patchUpdated`、v1 `applyPatchApproval`） | 可用但必须有降级路径；映射表标注 `fallback` |
| 实验环 | B2∖B1（process PTY、realtime、remoteControl、turns/list…） | 独立模块 + feature flag；握手时才声明 `experimentalApi: true`；类型取自 `generate-ts --experimental` 产物 |

**握手规范**：`initialize` 携带稳定的 `clientInfo.name`（合规日志）；FR-04 已消费 `item/reasoning/textDelta` / `summaryPartAdded`，不再把 full reasoning 作为未消费高频通知处理。

## 4. 关键组件深潜

### 4.1 协议桥（agent-appserver.js）
- **注册表分派 + 映射表**（实测校正：非透明代理）：S→C request 经 `handleServerRequest` 注册表分派（审批族 → ApprovalBroker；已知无法履约如 `account/chatgptAuthTokens/refresh` → JSON-RPC `-32601`；未知 → `-32601` + `system` 告警，**不再默认回 `{}`**）；通知经 `handleNotification` 映射表分发。新增/未知方法有显式兜底，schema 升级由 CI `protocol:check` 拦截。
- **ApprovalBroker（FR-06/07）**：S→C request 到达 → 按 method 精确分类（命令/文件/权限/工具输入/旧式兜底）→ 生成 approvalId 登记 pending 表 → 信封推送 + Web Push → 前端决议 `user:approval` → 回填 JSON-RPC response → 清表并广播 `approval:resolved`；同时监听服务端 `serverRequest/resolved` 撤销他端已决弹窗。超时策略：不自动决议（安全默认），仅提醒。
- **事件映射表（FR-05）**：以 pin 版本 `codex app-server generate-ts --out .protocol/stable` 导出为唯一映射源（实测校正：`generate-ts` 无 `--experimental` flag，stable 产物已含 EXPERIMENTAL 类型；CI `protocol:check` 校验桥消费方法均在产物中）；未知 **item** → `raw_item` 信封（NFR-5），未知**通知**安全忽略；删除对 `turn/failed` 的依赖，终态取 `turn/completed.status`（completed/failed/interrupted）+ `error` 通知（`turn/failed` 保留一版本周期双轨兼容）。
- **登录状态机（FR-03）**：`account:loginStart` → 桥层 `account/login/start({type:"chatgptDeviceCode"})` → `account_login` 信封透出 `userCode` / `verificationUrl` / pending 状态 → `account/login/completed` 与 `account/updated` 映射为前端登录完成和账号状态。`account:loginCancel` 调用 `account/login/cancel`。实测校正：`account/chatgptAuthTokens/refresh`（S→C）本桥**显式拒绝**（`-32601`，不落盘/不透传凭证），非静默应答。自动化已用 mock app-server 覆盖；真实账号 device-code smoke 需人工完成。
- **P1 原生能力桥（FR-11–FR-18）**：桥层仅暴露稳定 app-server 方法：thread 管理、compact/rollback、model/capability read、只读 fs、account/usage/rate limit、只读 MCP/Skills、externalAgentConfig detect/import。所有入参在桥层收敛（threadId 必填、fs path 必须绝对路径、空字段剔除），通知映射为 `thread_event` / `compact` / `rate_limits` / `mcp_status` / `skills_changed` / `external_agent_config_import` 信封；P2 写文件、配置写、插件安装、MCP tool call、logout 不在普通会话面暴露。
- **JSON-RPC 可观测（NFR-8）**：所有 client request/response、server request/response、notification 进入统一脱敏 JSONL 日志，默认落到会话 cwd 下 `.codex-chat-rpc.jsonl`，目录/文件 owner-only；同时 `statusPayload()` 暴露 `rpcStats` 计数，便于前端/日志侧定位请求量、通知量和错误数。敏感 key、正文、base64/data、token、路径均按 sanitizer 规则裁剪或脱敏。

### 4.2 网关路由层（server.js）
- agents Map 多实例不变；fork 路由：`session:fork` → `thread/fork` → 新 `instanceId` 挂载并切换 `viewingInstanceId`，广播 `init` / `instances` / `session_list`（FR-02 已实现）。
- steer 语义（FR-01）：turn 运行中且有 `currentTurnId` 时收到 `user:message` 发 `turn/steer`；无活跃 turn 或无法 steer 的边界保留队列。steer 失败发 recoverable error，不复位当前 turn。队列深度透出到状态栏（现有 `q:n`）。
- P1 Socket.IO contract：`thread:*`、`models:read`、`fs:*`、`account:read`、`mcp:read`、`skills:read`、`externalAgentConfig:*` 均返回 `{ok:true,...}` / `{ok:false,error}` ack；路由层只做语义化参数归一、实例选择和信封转发，协议细节仍集中在 `agent-appserver.js`。
- 重放缓冲：按 (instanceId, seq) 环形缓冲，`catch-up` 按客户端最后 seq 增量下发（现有机制，容量参数化）。

### 4.3 前端 SPA
- item 状态机 reducer：`started(id,type)` 建卡 → delta 按 id 追加 → `completed` 定稿替换（plan 类以 completed 为准，delta 仅预览——schema 注释明示两者可不一致）。
- 渲染注册表：item type → 卡片组件；未注册 type → raw JSON 卡片（NFR-5）。
- 审批卡片携 approvalId 幂等：重复决议、已撤销决议均无副作用。
- Reasoning 渲染（FR-04）：继续使用向后兼容的 `reasoning` 信封，`payload.text` 保留；新增 `channel` / `kind` / index 元数据，将 summary 与 full reasoning 分区渲染，不混入普通 assistant 文本。
- P1 控制面（FR-11–FR-18）：顶部原生控制条提供 Threads/Compact/Rollback/Models/Files/Account/MCP/Skills/Import；会话抽屉合并 app-server 原生 threads 与历史兜底列表，原生 thread 行内提供 rename/archive/unarchive/delete；P1 面板均为普通用户只读或低风险操作，危险 Admin 操作留在 P2。

## 5. 状态与存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 会话历史（权威） | Codex 侧 rollout JSONL（`$CODEX_HOME`） | 网关不做第二权威源；恢复走 `thread/resume`/`thread/read` |
| 重放缓冲 | 网关内存（环形） | 只为断线 catch-up，非持久 |
| 历史列表兜底 | history.js 解析 JSONL | P3 FR-32 用 `thread/turns/list` 替代后降级为 fallback |
| 审批 pending 表 | 网关内存 + 审计日志落盘 | NFR-8：审批请求/决议 owner-only 留痕 |
| JSON-RPC 观测日志 | 会话 cwd 下 `.codex-chat-rpc.jsonl` | NFR-8：通用出入 JSON-RPC 脱敏 JSONL，owner-only 落盘；`rpcStats` 进入状态信封 |
| 上传文件 | uploads.js 安全落盘 | 传绝对路径给 `turn/start` |
| 前端 | 内存 + PWA 缓存壳 | 不缓存会话内容，避免多端不一致 |

## 6. 可靠性与规模

- **规模假设**：单用户单机，≤5 并发实例，每 turn 通知峰值 ~50 msg/s —— 单 Node 进程余量充足，无需水平扩展；瓶颈在移动端渲染（长日志虚拟滚动）。
- **背压（NFR-6）**：JSON-RPC request 收到 `-32001` → 指数退避重试（默认最多 5 次，250ms 起步，单次上限 5s）→ `system` + `status` 透出拥塞态；超过上限后失败可见。桥→前端方向的高频 delta 合并仍属后续性能优化，不计入当前完成项。
- **进程失效**：app-server 子进程退出 → 桥标记实例 `crashed` → 自动重启 → `thread/resume` 续接 → 信封通告；网关重启 → 前端重连 catch-up + `session:list` 重建。
- **监控**：当前已有 pending 审批状态、子进程存活状态、`deprecationNotice`/`warning` 通知上报、审批审计日志、通用 JSON-RPC 脱敏日志与 `rpcStats` 计数；延迟直方图/集中式日志保留策略属于后续运维增强，不阻塞 NFR-8 功能闭环。

## 7. 安全架构

1. 网络边界：网关默认 loopback-only；远程访问走用户自管隧道（Tailscale 等）；无 token 非 loopback 拒绝（现状保持，已 smoke 验证）
2. 设备层：新设备须经既有设备审批（`user:approveDevice`）
3. 操作分层：P2 Admin 方法（config 写、plugin 安装、fs 写、mcp 直调、logout）走独立确认流 + 审计日志；普通会话面不暴露
4. 审批完整性：不存在自动批准路径；桥对未知 S→C 请求**不再回 `{}`**，改为显式拒绝并告警（修订 MVP 兜底）
5. 凭证：ChatGPT token 由 codex 自管（`$CODEX_HOME`），网关不落盘任何凭证；`attestation/generate` 仅在声明 `requestAttestation` 能力时应答

## 8. Trade-off 决策表

| 决策 | 选择 | 代价 | 备选与否决理由 |
|---|---|---|---|
| 传输 | stdio JSONL 子进程 | 需自管进程生命周期 | ws listener：官方 unsupported + Origin 403；unix socket+proxy：多一跳无收益 |
| 浏览器通道 | Socket.IO | 依赖库 | 原生 WS：需自写心跳/重连/房间；SSE：单向，审批回传仍需通道 |
| 事件语义 | 统一信封（与协议解耦） | 双层映射维护成本 | 直透协议：CLI 升级即破坏前端；信封已证明可整层复用 |
| 前端 | 单文件 SPA | 文件大（~3000 行） | 框架化：违反项目零构建约束；移动端加载反而更重 |
| 历史 | Codex JSONL 为权威 + 内存缓冲 | 网关无独立历史库 | 自建 DB：双写一致性问题，且 `thread/read` 已够用 |
| 审批超时 | 不自动决议 | 可能长挂 | 自动拒绝：破坏"重试不跳过审批"验收；自动批准：绝对禁止 |
| 实验功能 | flag + 双导出类型 | 两套类型产物 | 全量开 experimentalApi：稳定面被实验字段污染，CI 噪声大 |

## 9. 演进与重访点

- **官方 remoteControl 配对成熟时**：本架构"浏览器↔网关"通道被设计为可替换层（信封不变，通道换实现）——届时评估以官方配对替代自建设备认证
- **FR-31 网页终端**：`process/*` PTY 独立 namespace（`term:*` 信封），不与聊天流混流
- **FR-34 语音**：`thread/realtime/*` 走独立 WebRTC/音频帧路径，评估 SDP 通知转发
- **schema 升级节奏**：每次升级 CLI → CI 双导出 diff 报告 → 更新映射表 → 跑四维度回归；`deprecationNotice` 通知出现即建升级任务
- **规模重访**：若走向多用户，重访点=实例池隔离（每用户 CODEX_HOME）、审批审计外置存储、重放缓冲持久化
