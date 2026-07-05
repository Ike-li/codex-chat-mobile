## 结论

**能应用到 Codex，但不要直接照搬 `claude-chat-mobile`。最佳方案是：前端沿用 PWA/手机聊天界面思路，后端改成接 Codex 官方 `app-server` 协议。**

原因：`claude-chat-mobile` 的核心不是远程终端，而是“手机 Web UI → 本机 Node 服务 → SDK 驱动本机 Claude CLI → 流式事件/审批回传”。项目 README 明确说它通过 `claude-agent-sdk` 驱动本机 `claude` CLI，并继承本机的 `CLAUDE.md`、MCP、skills、hooks 和登录态。([GitHub][1])

Codex 侧已经有更对应的官方能力：**Codex App Server**。官方说明它就是给“自建富客户端”用的接口，支持认证、会话历史、审批、流式 agent 事件，并且实现开源。([OpenAI Developers][2])

---

## 这个项目的核心思路

`claude-chat-mobile` 的设计目标是“手机上操作本机 Claude CLI，语义上等价于坐在终端前操作”。它不追求复刻 TUI，而是把 Claude 的输出、工具调用、审批请求映射成移动端 UI。设计文档明确把“终端等价性”作为唯一判据，并列出会话连续、真实改文件/跑命令、权限确认、流式输出、工具卡片、断线续传等 P0 项。([GitHub][3])

它的运行结构是：

| 层        | Claude 项目做法                  | 迁移到 Codex 的对应物                             |
| -------- | ---------------------------- | ------------------------------------------ |
| 手机端      | PWA/Socket.IO 聊天 UI          | 可复用                                        |
| 服务端      | Express + Socket.IO          | 可复用                                        |
| Agent 驱动 | `claude-agent-sdk`           | 换成 Codex App Server / Codex SDK            |
| 会话       | Claude 原生 session            | Codex thread / turn                        |
| 输出流      | text/tool/permission event   | `item/*`、`turn/*`、`serverRequest/resolved` |
| 审批       | Claude permission request    | Codex command/file approval                |
| 配置继承     | `CLAUDE.md`、MCP、skills、hooks | `AGENTS.md`、MCP、skills、hooks、config.toml   |

它自己的 README 也给出了完整的数据流：手机 `user:message` 到服务端，再进入 `AgentSession`，经 SDK 驱动本机 CLI，流式事件被包装成 `{seq, epoch, sessionId...}` 后广播给前端；断线重连时通过 `sync:since` 回放事件。([GitHub][1])

---

## Codex 能不能做同样的事

**可以，而且官方技术接口更直接。**

Codex App Server 官方协议提供：

1. **双向 JSON-RPC 通信**，支持 stdio、Unix socket，WebSocket 也有但标注为 experimental/unsupported；官方特别提醒非 loopback WebSocket 暴露前必须配置认证。([OpenAI Developers][2])
2. **thread / turn / item 模型**：thread 是会话，turn 是一次用户请求，item 是消息、命令、文件变更、工具调用等单元。([OpenAI Developers][2])
3. **流式事件**：`turn/started`、`turn/completed`、`item/agentMessage/delta`、`item/started`、`item/completed`、`turn/diff/updated`、`turn/plan/updated` 等，适合映射成手机端消息、工具卡片、diff 卡片。([OpenAI Developers][2])
4. **审批流**：命令执行审批会带 `command`、`cwd` 等字段；文件变更审批会带 proposed changes；客户端响应后服务端继续或拒绝执行。([OpenAI Developers][2])

所以，`claude-chat-mobile` 的架构可以迁移，但核心替换点是：

```text
原：Phone PWA -> Node/Socket.IO -> claude-agent-sdk -> local claude CLI
新：Phone PWA -> Node/Socket.IO -> Codex app-server JSON-RPC -> local Codex
```

---

## 不建议用 `codex exec` 作为主方案

`codex exec` 适合脚本、CI、一次性自动化任务；官方文档说它用于非交互模式，不打开 TUI，并且适合流水线、生成可管道化输出、预设 sandbox/approval。([OpenAI Developers][4])

它也支持 resume，CLI 参考里写了 `codex exec resume [SESSION_ID]`、`--last`、`--all` 等参数。([OpenAI Developers][5])

但它不是做“手机实时控制活跃 agent”的最佳接口。你的需求里有实时输出、审批、断线续传、多会话、工具卡片，这些更适合走 **Codex App Server**。

---

## Codex 有没有类似技术文档支持

**有，而且文档覆盖面比单纯 CLI 参数更完整。**

关键文档能力如下：

| 需求                   | Codex 官方支持                                                                         |
| -------------------- | ---------------------------------------------------------------------------------- |
| 本机 Codex 可编程控制       | Codex SDK，支持 TS/Python，能创建 thread、继续 thread、resume thread。([OpenAI Developers][6]) |
| 自建富客户端               | Codex App Server，支持认证、历史、审批、流式事件。([OpenAI Developers][2])                          |
| 手机远程控制               | Remote connections，官方支持用 ChatGPT 手机端连接 Codex App 主机。([OpenAI Developers][7])       |
| 安全与审批                | sandbox mode + approval policy 两层模型。([OpenAI Developers][8])                       |
| 项目指令                 | `AGENTS.md`，可作为仓库或用户级持久指令。([OpenAI Developers][9])                                 |
| MCP / skills / hooks | Codex 文档明确支持 MCP、skills、hooks、subagents 等定制层。([OpenAI Developers][10])             |

另外，OpenAI 官方已经发布“Work with Codex from anywhere”，说明 Codex 在 ChatGPT mobile app 中可以连接你的 Mac、devbox 或远程环境，查看输出、批准命令、切换模型、开始新任务；文件、凭据、权限和本地工具仍留在运行 Codex 的机器上。([OpenAI][11])

---

## 关键差异

### 1. Claude 项目是“自建公网入口”

`claude-chat-mobile` 推荐通过 LAN 或 Cloudflare Tunnel 暴露本机服务，并明确警告这是“公网可访问的本地 shell 代码执行通道”。([GitHub][1])

Codex 官方远程连接则走 OpenAI 的连接/中继体系，官方说它通过 secure relay 让可信机器跨设备可达，而不需要直接把机器暴露到公网。([OpenAI][11])

### 2. Claude 用 `CLAUDE.md`，Codex 用 `AGENTS.md`

Codex 的持久项目指令是 `AGENTS.md`，官方定义它用于仓库或用户级指导，适用于 App、CLI、IDE extension、Cloud。([OpenAI Developers][12])

### 3. Claude 审批继承 `permissions.allow`，Codex 是 sandbox + approval policy

Codex 官方把安全控制拆成两层：sandbox 决定命令技术上能做什么，approval policy 决定何时必须询问用户。([OpenAI Developers][8])

---

## 最佳落地判断

**推荐方案：基于 Codex App Server 重写后端桥接层，前端复用 `claude-chat-mobile` 的产品思路。**

最小实现路径：

```text
1. 启动 codex app-server
2. Node 服务通过 stdio / Unix socket 连接 app-server
3. 手机端消息 -> turn/start
4. Codex 事件 -> 转成前端 agent:event
5. item/agentMessage/delta -> 流式文本
6. item/started / item/completed -> 工具卡片、命令卡片、diff 卡片
7. item/commandExecution/requestApproval -> 手机审批弹窗
8. thread/resume -> 会话恢复
9. 服务端维护 seq ring buffer -> 断线续传
```

不建议直接 fork 后硬改，因为 Claude SDK 和 Codex App Server 的事件模型不同；可复用的是**产品结构、PWA 交互、安全边界、断线续传设计**，不是 agent 驱动层代码。

一句话判断：**Codex 不仅能做，而且官方已经给了比 `claude-chat-mobile` 更适合自建客户端的 App Server 文档；但普通使用场景应优先用官方 Remote connections，自建只适合你要做私有 Web/PWA 控制台的场景。**

[1]: https://github.com/Ike-li/claude-chat-mobile "GitHub - Ike-li/claude-chat-mobile: Use your real local Claude CLI from your phone — same CLAUDE.md, MCP, skills & login. Self-hosted, locked by default. · GitHub"
[2]: https://developers.openai.com/codex/app-server "App Server – Codex | OpenAI Developers"
[3]: https://raw.githubusercontent.com/Ike-li/claude-chat-mobile/master/docs/design.md "raw.githubusercontent.com"
[4]: https://developers.openai.com/codex/noninteractive "Non-interactive mode – Codex | OpenAI Developers"
[5]: https://developers.openai.com/codex/cli/reference "Command line options – Codex CLI | OpenAI Developers"
[6]: https://developers.openai.com/codex/sdk "SDK – Codex | OpenAI Developers"
[7]: https://developers.openai.com/codex/remote-connections "Remote connections – Codex | OpenAI Developers"
[8]: https://developers.openai.com/codex/agent-approvals-security "Agent approvals & security – Codex | OpenAI Developers"
[9]: https://developers.openai.com/codex/guides/agents-md?utm_source=chatgpt.com "Custom instructions with AGENTS.md – Codex"
[10]: https://developers.openai.com/codex/concepts/customization?utm_source=chatgpt.com "Customization – Codex"
[11]: https://openai.com/index/work-with-codex-from-anywhere/ "Work with Codex from anywhere | OpenAI"
[12]: https://developers.openai.com/codex/glossary?utm_source=chatgpt.com "Glossary – Codex"

