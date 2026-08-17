# 使用走查

这是一条从零启动到手机 PWA 对话的最短路径，面向第一次部署的单用户。配置参考 [../README.zh-CN.md](../README.zh-CN.md)，HTTPS/反代和故障码参考 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

## 安装与启动

前置条件：Node.js >= 20；本机已安装并登录 [Codex CLI](https://github.com/openai/codex)（`codex` 在 `PATH`，或用 `CODEX_BIN` 指定）。项目协议基线固定在 `.codex-version`。

```bash
npm install
cp .env.example .env
# 编辑 .env，至少把 WORK_DIR 指向允许 Codex 操作的工作区
npm test
npm start
```

本机浏览器打开 `http://127.0.0.1:3001`。loopback 是安全默认；没有 `AUTH_TOKEN` 时服务不会绑定非 loopback。Web Push 还需要 VAPID 三项和浏览器授权。

日常自动化不要调用真实 Codex：`npm run test:e2e` 使用 mock app-server。只有手工启动 `npm start` 的真实会话才会使用本机 Codex 登录状态和工作区。

## 从手机连接

手机访问必须优先完成 HTTPS 部署。远程明文 HTTP 默认被网关拒绝，不再支持“先用局域网 HTTP 临时聊天”的普通路径。推荐让同机 Tailscale Serve、Caddy 或受访问策略保护的 tunnel 反代 `127.0.0.1:3001`，并至少设置：

```dotenv
HOST=127.0.0.1
AUTH_TOKEN=<openssl rand -hex 32 的结果>
CODEX_ALLOWED_ORIGINS=https://你的精确域名
CODEX_TRUSTED_PROXY_IPS=127.0.0.1,::1
CODEX_ALLOW_INSECURE_REMOTE=0
```

如果代理在另一台主机/容器且必须直接访问 Node，才把 `HOST` 改为合适的非 loopback 地址，并把 `CODEX_TRUSTED_PROXY_IPS` 限定为实际直接对端 IP。

首次打开会显示登录页：

1. 输入 `AUTH_TOKEN`。浏览器用它调用 `POST /auth/session`，成功后立即丢弃输入；服务器签发绑定当前 `deviceToken` 的 HttpOnly cookie，host token 不写入 localStorage。
2. 新浏览器会进入 pending。可在已批准设备点批准，或在开发机运行 `node scripts/device.js list` 后 `node scripts/device.js approve <ID>`。
3. 批准成功落盘后网关才解锁上行事件。调用 `DELETE /auth/session` 会注销当前 session；设备 deny/revoke 会撤销该设备全部 session、Push 并断开 socket。

浏览器 localStorage 只保留随机 device token 和 UI 偏好，不保存 `AUTH_TOKEN`。带 `?token=` 的 URL 只会被页面作为 bootstrap 输入读取后移除，不是 HTTP API 鉴权方式，也可能进入浏览器/代理日志，因此不推荐分享这种链接。

## 第一轮对话

在底部输入框发送「列出当前目录并解释项目结构」。正常链路是：

- 消息先以稳定 `clientRequestId` 写入 IndexedDB outbox；
- 网关 ACK 返回 `queued` 时 outbox 继续保留，等待后续 receipt；只有 `submitted` / `steered` 等已交给 app-server 的确认状态才移除对应项；
- 助手正文、thinking/reasoning、命令/工具输出和 diff 按目标 thread 流式出现；
- 顶栏显示工作区名、连接点和测到的往返延迟；模型/权限/思考在输入区胶囊；
- ACK 丢失或页面刷新后先以同一 `clientRequestId` 做只读 reconciliation；服务端 receipt ledger 在当前进程和保留期内去重，有稳定 thread 时还能用 `thread/read` 核对。服务重启不会恢复 ledger，因此不能把它描述成跨重启 exactly-once，也不能盲发结果未知的请求；只有警告确认后的人工重试才创建带 provenance 的新 id。

turn 进行中主按钮变为停止，可精确中断该 turn。输入框仍可打字；有草稿时旁边出现第二颗发送钮，把这句话追加进当前 turn 或排到下一轮。停止会清掉还没执行的排队输入。

文件附件不会把绝对路径拼到提示词：已验证图片发送为 `localImage`，普通文件发送为 `mention`。显式 mention 必须在当前 workspace 内；skill 必须来自 enabled `skills/list`；远程图片默认关闭。

## 审批一条命令

当 Codex 请求命令、文件变更、权限或用户输入时，移动端生成 needs-you 卡片：

- 卡片精确绑定 `instanceId + threadId + turnId + itemId + requestId`；
- 批准/拒绝或回答只提交一次；重复 ACK 可安全重放，冲突/过期/撤销会明确失败；
- 另一台设备解决后，本设备通过 `needs_you_changed` 撤销旧卡片；
- HTTPS + VAPID + 有效 session + 已批准设备全部满足时可收到 Web Push。通知使用泛化正文，点击按 `thread + need` 深链打开，不泄露命令、问题或回答正文。

未应答的 app-server server request 会让 turn 等待，因此系统不自动批准或拒绝。设备离线重连后通过 needs-you snapshot 恢复待处理项。

## 历史与多实例

- **历史抽屉**：只通过 app-server `thread/list` 和 `thread/read` 浏览；`thread/resume` 续接。Codex App 创建的 thread 可在 Web 看到，Web 创建的 thread 也由 Codex App 看到。
- **唯一事实源**：标题、cwd、时间、turn 和活动状态不再复制到 `sessions.json`，也没有 JSONL history fallback；本地只保存当前 thread 指针、UI 偏好和 IndexedDB outbox，当前版本不提供草稿持久化。
- **多工作区**：只能在 `.env` 的 `WORK_DIR` + `WORK_DIRS` allowlist 中切换。`WORK_DIRS` 可以写成逗号分隔路径，或指向 `workdirs.json` 这类 JSON 数组文件。
- **多实例标签**：多个 `ThreadRuntime` 共享一个 app-server 进程，但由 registry 和每 socket 视图精确隔离；两个设备可同时查看不同 thread，不串文本、工具、审批或状态。
- **断线恢复**：普通短断线按 `seq/epoch` 补增量；buffer gap 或服务端 epoch 改变时自动用 `thread/read` snapshot 重建。

Admin 和 Labs 默认隐藏且服务端拒绝对应调用。显式启用 Admin 后仍需限时 unlock、显式 Lock、失败限流和逐操作确认；它们都不是核心聊天的前置条件。

## 安装为 PWA

前提是安全上下文：手机必须使用可信 `https://`；只有同机浏览器可把 `http://localhost` 视为安全上下文。满足后：

- iOS Safari：分享 → 添加到主屏幕；Web Push 还要求受支持的系统版本并从主屏幕 PWA 授权；
- Android Chrome：菜单 → 安装应用 / 添加到主屏幕。

standalone 模式支持竖屏、横屏和软键盘布局。安装或推送不可用时，先检查 HTTPS/证书，再检查 Origin、可信代理、session/设备批准和 VAPID，按 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) 的状态码清单排错。
