# Web 端快速入门

这是一份首次使用教程。目标是在不修改产品代码的前提下，从本机启动走到手机上的第一轮 Codex 对话、一次审批、一次历史续接，以及可选的 PWA/Push。

## 完成后的结果

完成后，你应该能够：

- 在开发机上启动一个共享 `codex app-server` 网关；
- 从本机浏览器发送消息并看到流式响应；
- 从手机通过 HTTPS 登录并完成设备配对；
- 在手机上批准或拒绝 Codex 请求；
- 查看并续接 Codex App 与 Web 共用的原生 thread；
- 把页面安装为 PWA，并在配置完整时接收 Push。

## 第一步：准备环境

要求：

- Node.js 20 或更高版本；
- 本机已安装与 `.codex-version` 一致的 Codex CLI；
- Codex CLI 已完成登录；
- 一个允许 Codex 操作的本地工作区。

安装依赖并创建配置：

```bash
npm install
cp .env.example .env
```

至少编辑：

```dotenv
HOST=127.0.0.1
AUTH_TOKEN=
WORK_DIR=/absolute/path/to/your/project
```

先保持 loopback，不要为了手机访问立即绑定 `0.0.0.0`。运行确定性门禁：

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

日常 E2E 使用 mock，不调用真实 Codex。只有下一步手工启动服务后，真实对话才使用本机 Codex 登录状态。

## 第二步：完成本机首次对话

启动服务：

```bash
npm start
```

打开 `http://127.0.0.1:3001`。成功时应看到主聊天界面、状态栏、输入框和新会话入口。

输入：

```text
只读分析当前项目结构，并说明主要入口文件。
```

点击发送。预期结果：

1. 用户消息先显示发送状态；
2. 页面收到 queued、submitted 或 steered ACK；
3. 助手正文、reasoning、工具或命令卡片按 thread 流式出现；
4. 顶部状态栏显示 cwd、sandbox、approval、thread 和 context；
5. turn 最终显示 result 或明确 error。

如果没有返回，先查看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)，不要立即重发结果未知的写操作。

## 第三步：连接手机

本机对话跑通之后，手机只推荐一条路径：同机 Tailscale Serve 把 loopback 发布为 tailnet 内 HTTPS。其它 HTTPS 反代不是入门选项，见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

在开发机：

```bash
tailscale serve 3001
```

保持 `HOST=127.0.0.1`，并至少配置：

```dotenv
AUTH_TOKEN=<至少 32 字符的随机值>
CODEX_ALLOWED_ORIGINS=https://<机器名>.<tailnet>.ts.net
CODEX_TRUSTED_PROXY_IPS=127.0.0.1,::1
```

把 Origin 写成 Serve 打印的精确 URL。用 Serve，不要用 Funnel。

手机打开 HTTPS 地址后：

1. 输入 `AUTH_TOKEN`；
2. 浏览器用它换取绑定设备的 HttpOnly session，然后丢弃输入；
3. 新设备进入 pending；
4. 在已批准设备或开发机上批准该设备；
5. 手机页面从 locked/pending 变为可操作状态。

如果手机能打开页面但不能发送，优先检查设备是否仍为 pending，以及 Origin 是否精确匹配。

## 第四步：完成一次审批

在一个安全、可丢弃的工作区中输入：

```text
运行 pwd，并告诉我当前目录。执行前如果需要审批就等待我处理。
```

当页面出现审批卡片时：

- 查看命令和目标 thread；
- 点击批准，预期看到命令输出和 exit code；或
- 点击拒绝，预期命令不执行，turn 收到拒绝结果。

同一审批在另一台设备处理后，本设备的旧卡片会被撤销。系统不会自动批准未处理请求。

## 第五步：续接历史 Thread

打开左侧抽屉并点击 Threads：

1. 找到刚才的 thread；
2. 点击 thread，页面通过 `thread/read` 显示历史；
3. 再发送一条消息，首次使用时通过 `thread/resume` 续接；
4. 如果本机 Codex App 可用，也可以在那里打开该 thread，验证双方共享同一原生历史。

你还可以重命名、归档、取消归档、删除、Compact、Rollback 或 Fork。历史事实源只来自 app-server，不来自 `sessions.json` 或本地 JSONL fallback。

## 第六步：安装 PWA 与 Push

PWA 和 Push 要求可信 HTTPS。安装方式：

- iOS Safari：分享 → 添加到主屏幕；
- Android Chrome：菜单 → 安装应用或添加到主屏幕。

Push 还要求服务端配置完整 VAPID：

```dotenv
VAPID_SUBJECT=mailto:you@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

设备已批准且 session 有效时，点击页面 Push 入口并允许通知。随后审批/提问可以生成不含正文的 needs-you 通知，点击通知会通过 thread + need 深链打开对应卡片。

下一步：阅读 [WEB_UI_MAP.md](WEB_UI_MAP.md) 认识界面，或按 [RECIPES.md](RECIPES.md) 完成具体任务。
