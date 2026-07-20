# 核心概念

本文解释项目为什么这样设计。它不重复 UI 操作和 Socket 字段；操作见 [GETTING_STARTED.md](GETTING_STARTED.md)，接口见 [API.md](API.md)。

## 从手机到 Codex 的运行链路

```text
手机浏览器 / PWA
        │ HTTPS + Socket.IO
        ▼
Node gateway
  ├─ auth / device / Origin / Push
  ├─ outbox ACK / receipt / recovery
  ├─ ThreadRegistry / NeedsYouRegistry
  └─ 多个 ThreadRuntime
        │ 一个共享 stdio JSON-RPC 连接
        ▼
AppServerHost + AppServerTransport
        ▼
一个 codex app-server 进程
        ▼
工作区、模型、工具与原生 thread
```

浏览器不能直接连接 app-server。网关负责把本地 stdio JSON-RPC 转换为适合浏览器的认证、路由、ACK 和流式事件协议。

一个受支持的主机只运行一个 gateway 服务。该 gateway 拥有一个共享 app-server 子进程，而不是每个标签启动一个子进程。

## Thread、Turn、Item、Request 与 Instance

- **Thread**：持久化的原生对话，是历史事实源；
- **Turn**：thread 中的一轮 agent 执行；
- **Item**：turn 内的消息、命令、文件修改、工具或审批对象；
- **Request**：一次 RPC、用户消息或 server request 的相关标识；
- **Instance**：gateway 内承载一个活动 thread 或 provisional 新会话的 runtime 身份。

关系可以写成：

```text
Thread
  └─ Turn
      ├─ Item: user message
      ├─ Item: reasoning
      ├─ Item: command/tool
      └─ Request: approval or user input

Instance ──在 gateway 生命周期内加载/控制──> Thread
```

路由时，所有已提供标识必须指向同一个 runtime。thread、turn、item 或 request 发生冲突时，系统 fail-closed，而不是猜测目标。

## 原生 Thread 与浏览器视图

thread 是 Codex app-server 的持久化对象；浏览器视图只是“这台设备当前正在看哪个 instance/thread”。因此：

- 两台设备可以看不同 thread；
- 一台设备切换标签不会改变另一台设备；
- 一个历史 thread 可以没有活跃 runtime；
- `thread/status/changed` 可以更新未加载 thread 的活动状态；
- 选择历史 thread 后，runtime 在首次使用时 resume。

浏览器只保存当前 thread 指针和 UI 偏好，不复制标题、cwd、时间或 turn 历史作为第二事实源。

## 可靠投递模型

可靠投递由三层组成：

1. **浏览器 IndexedDB outbox**：先持久化再发送，保留 pending/queued/unknown；
2. **gateway receipt ledger**：按设备、请求 ID 和 payload 指纹单飞、去重和回放 ACK；
3. **app-server thread**：有稳定 thread 时，通过 `thread/read` 查找 `clientUserMessageId`。

这三层解决的不是同一个问题：outbox 防页面关闭丢消息；ledger 防当前 gateway 内重复派发；thread/read 在 ledger 不可用时提供持久化事实核对。

gateway 重启会丢失内存 ledger，因此系统不承诺跨重启 exactly-once。对结果未知的写请求，安全策略是“先核对、停止 FIFO、绝不盲发”。用户确认风险后，重试必须使用新 ID，同时保留来源关系。

## Needs-you 模型

needs-you 是跨 thread 的待处理审批和提问聚合。它与普通消息卡片不同：

- 必须精确绑定 instance/thread/turn/item/request；
- 相同决议可幂等重放，冲突决议被拒绝；
- 上游 resolved 会撤销卡片；
- turn 终态或 runtime 退出会让待办过期；
- Push 只发送泛化正文和定位深链；
- registry 当前是 gateway 进程内状态。

系统不自动处理 needs-you，因为批准、拒绝和回答属于用户权限边界。

## Codex App 与 Web 的关系

Codex App 与 Web 的共享点是 app-server 原生 thread，而不是两套历史文件之间的同步：

- Web 使用 `thread/list` 查看原生历史；
- 使用 `thread/read` 渲染消息或 gap snapshot；
- 使用 `thread/resume` 继续执行；
- 使用 `thread/status/changed` 显示跨端活动状态。

因此 Codex App 创建的 thread 可以在 Web 续接，Web 创建的 thread 也进入同一原生历史。但 Web 不是 Codex App UI 的完整远程镜像：它提供的是针对手机和自托管安全边界设计的控制面。

完整运行架构和威胁边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，产品能力边界见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)。
