# codex-chat-mobile 方案

> 由 `claude-sonnet-4-6` 生成，2026-06-28

---

## 调研结论

claude-chat-mobile 的核心思路（WebSocket 流式代理 + 会话管理 + 设备认证）**完全可以移植到 Codex CLI**，主要迁移成本在协议适配层，而非架构根本性障碍。

已有现成验证：**Remodex**（`github.com/Emanuele-web04/remodex`）是一个开源桥接项目 + iOS App，把 Codex 保留在 Mac 上，手机通过 X25519 配对的安全 WebSocket 连接——与本项目思路完全相同，已上架 App Store / Google Play。

---

## Codex CLI 的技术接口

### 路径 A：`codex exec --json`（本项目采用）

```bash
codex exec --json "帮我写一个排序函数"
codex exec --json --resume <thread-id> "改成快速排序"
```

输出换行分隔的 JSON 事件（JSONL）：

```json
{"type":"thread.started","id":"<uuid>"}
{"type":"turn.started","turnId":"<id>"}
{"type":"item.agentMessage/delta","itemId":"<id>","delta":"<text-chunk>"}
{"type":"item.localShellCall","itemId":"<id>","call":{"cmd":"ls","args":[]}}
{"type":"item.localShellCall.output","itemId":"<id>","exitCode":0,"output":"file.txt\n"}
{"type":"turn.completed","turnId":"<id>"}
{"type":"thread.idle"}
```

会话存储在 `~/.codex/sessions/YYYY/MM/DD/`，`--resume <thread-id>` 跨运行恢复。

**已知 bug**：`--json` 在 MCP 工具激活时静默失效（issue #15451）；`--image` 组合挂死（#5773）。

### 路径 B：`codex app-server`（更完整，暂未采用）

```bash
codex app-server   # stdio 上的 JSON-RPC 2.0
```

提供 Thread/Turn/Item 三层原语和完整会话操作（start / resume / fork / list / archive），流式推送 `item/agentMessage/delta` 等通知。WebSocket 传输内置但官方标注「实验性、不支持生产」（PR #14847/#19246 在推进）。功能更丰富，协议更复杂，是后续升级方向。

---

## 与 claude-chat-mobile 的对比

| 维度 | claude-chat-mobile | codex-chat-mobile |
|---|---|---|
| 底层接口 | `@anthropic-ai/claude-agent-sdk` query() | `codex exec --json` spawn |
| 进程模型 | 长驻进程，streaming input | 每轮新进程，`--resume` 续会话 |
| 会话协议 | stream-json JSONL | thread/turn/item JSONL |
| Permission 审批 | 交互弹窗（canUseTool） | OS 级沙箱，无弹窗 |
| 会话存储 | data/sessions.json | `~/.codex/sessions/`（Codex 自管）+ data/sessions.json（元数据指针） |
| Model 切换 | 支持（setModel） | 不支持（暂） |
| Web Push / CF Access | 支持 | 未实现 |

---

## 架构

```
手机浏览器
    ↕ WebSocket (Socket.IO)
server.js  ←→  sessions.js（元数据）
    ↕              devices.js（认证）
agent.js (CodexSession)
    ↕ spawn + stdio
codex exec --json [--resume <id>] "prompt"
    ↓ JSONL 事件流
server.js 解析 → io.emit('agent:event') → 手机
```

每次用户发消息：
1. `CodexSession.send(text)` spawn 新的 `codex exec --json` 子进程
2. 从 stdout 解析 JSONL，把事件转为统一信封广播给所有已连接设备
3. 子进程退出后，CodexSession 实例保留（sessionId 已确立），下条消息 `--resume` 继续

### 事件信封格式（与 claude-chat-mobile 一致）

```json
{
  "seq": 42,
  "epoch": "1719532800000.1",
  "sessionId": "<thread-uuid>",
  "instanceId": "inst_1",
  "cwd": "/Users/you/projects",
  "ts": 1719532800000,
  "type": "text_delta",
  "payload": { "text": "..." }
}
```

### JSONL 事件 → 信封映射

| Codex 事件 | 信封 type | payload |
|---|---|---|
| `thread.started` | `init` | `{ sessionId, cwd }` |
| `item.agentMessage/delta` | `text_delta` | `{ text }` |
| `item.localShellCall` | `tool_use` | `{ name:"ShellCall", inputSummary }` |
| `item.localShellCall.output` | `tool_result` | `{ ok, outputSummary }` |
| 进程退出 | `result` | `{ exitCode, isError }` |

---

## 主要未决问题

1. `codex app-server` WebSocket 传输何时从实验性转为生产支持？（PR #14847/#19246 进展待跟踪）
2. `codex exec --json` + MCP 工具激活的 bug #15451 何时修复？
3. Codex 沙箱（macOS Seatbelt / Linux bubblewrap）是否影响多工作目录的文件访问权限？
4. 能否与 claude-chat-mobile 共用同一套设备指纹认证层，同时桥接两个 CLI？

---

## 参考来源

- 架构来源：[claude-chat-mobile](https://github.com/Ike-li/claude-chat-mobile)
- 现成实现参考：Remodex (`github.com/Emanuele-web04/remodex`)
- Codex CLI 文档：非交互模式（`codex exec --json`）/ app-server JSON-RPC 接口
