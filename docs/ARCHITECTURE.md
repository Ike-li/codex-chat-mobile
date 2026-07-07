# 架构

`codex-chat-mobile` 是 Codex CLI 的本地 rich client。它不把工作代理到托管后端；浏览器连接本机 Node 服务，Node 服务再连接本机 `codex app-server` 进程。

## 运行链路

```text
手机浏览器 / PWA
  <-> Socket.IO
server.js
  <-> agent-appserver.js 中的 CodexAppServerSession
  <-> stdio JSON-RPC 帧
codex app-server
```

`server.js` 负责 HTTP、Socket.IO、鉴权、设备状态、工作目录路由、实例路由、上传、Web Push、广播和 catch-up 行为。`agent-appserver.js` 负责 JSON-RPC 请求 ID、initialize/thread/turn 生命周期、app-server 通知、服务端请求、审批响应、队列、中断和兜底信封。

前端刻意保持为 `public/index.html` 中的单一 PWA 界面。它渲染文本增量、reasoning、命令/工具卡片、文件变更、审批、native app-server 面板、斜杠建议、附件、实例标签和移动端安全布局。

## 关键数据流

浏览器与网关之间的完整 Socket.IO 事件契约见 [EVENTS.md](EVENTS.md)，app-server 协议面见 [PROTOCOL.md](PROTOCOL.md)。四条主链路：

- **发消息**：`user:message` → `server.js` 按 `instanceId` 路由 → 桥 `turn/start`（turn 运行中且可 steer 时改发 `turn/steer`，否则按状态入队）→ app-server 通知流（`item/started` → deltas → `item/completed` → `turn/completed`）→ 映射为带自增 `seq` 的 `agent:event` 信封 → Socket.IO 广播 + 写重放缓冲。
- **审批**：app-server 发来 S→C 审批请求 → `ApprovalBroker` 按 method 精确分类并登记 `approvalId` → 推送 `approval_request` 信封（+ Web Push）→ 前端 `user:approval` 决议 → 桥回填 JSON-RPC response → 广播决议；监听 `serverRequest/resolved` 撤销他端已决弹窗。不存在自动决议路径。
- **断线恢复**：客户端重连后发 `catch-up` 带最后 `seq` → 网关从环形重放缓冲增量补发，避免重复近期消息；子进程崩溃则标记实例、重启并 `thread/resume` 续接。
- **上传**：`uploads.js` 校验、限量、限大小、owner-only 落盘后，把绝对路径注入 `turn/start`，不把原始字节塞进协议帧。

## 实例生命周期

`server.js` 的 `agents` map 以 `instanceId` 为键，每个实例对应一个独立的 `codex app-server` 子进程和一条 `CodexAppServerSession`。新建/fork（`session:fork` → `thread/fork`）挂载新实例并切换 `viewingInstanceId`，广播 `instances` / `session_list`；空闲超过 `IDLE_TIMEOUT_MS` 的实例回收。多实例标签因此互相隔离，一条 turn 的流不会串到另一个标签。

## 状态模型

- `server.js` 中的 `agents` map：按 `instanceId` 维护活跃 app-server 会话。
- `viewingInstanceId`：当前浏览器壳正在查看的实例。
- `sessions.js`：轻量工作区/会话元数据指针。
- Codex 原生历史：通过 `history.js` 读取 Codex session JSONL。
- 上传和审计文件：本地 owner-only 文件。
- 协议基线：`.protocol/stable/`，由当前 pin 住的 Codex CLI 版本生成。

## 协议边界

产品依赖 `codex app-server`，不依赖旧的 `codex exec --json` 行为。稳定主链路是：

1. `initialize`
2. `initialized`
3. `thread/start`、`thread/resume` 或 `thread/fork`
4. `turn/start` 或 `turn/steer`
5. 服务端流式通知
6. `turn/completed`、`error` 或中断处理

审批和用户输入这类 server request 必须显式应答。未知 server request 会作为协议事件处理，不能静默卡住应用。未知 item type 会降级为可见的 raw envelope，而不是直接丢失。

experimental app-server 方法必须留在 Admin 或 Labs 这类产品门控之后。除非仓库明确标记为支持，否则它们不属于普通移动端聊天路径。

## 安全模型

- `AUTH_TOKEN` 为空时，只允许 loopback host 和 loopback socket。
- 任何非本机或 tunnel 部署都必须使用非空 `AUTH_TOKEN`。
- token 比较使用 timing-safe 方式。
- 设备信任和 pending 审批状态都只保存在本机。
- 上传文件要校验、限量、限大小，并以 owner-only 权限保存。
- 日志和事件表面会脱敏本地路径与密钥。
- 服务端设置 CSP 和 frame 限制。
- 破坏性/Admin 操作必须先 unlock，再逐操作确认。

这是控制真实开发机器的本地控制面。任何远程暴露都应按高风险处理。

## 维护中的设计决策

- app-server 是唯一后端。
- Socket.IO 信封层保持为前端稳定契约。
- 日常回归优先使用确定性的 mock app-server 测试。
- 只有在刻意验证本地 CLI 集成时，才运行真实 Codex 冒烟测试。
- 接受 Codex CLI 升级前必须运行协议漂移检查。
