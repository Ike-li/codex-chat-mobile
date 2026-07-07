# 使用走查

一次端到端的上手：从零启动到在手机上装成 PWA。面向第一次用本项目的人；命令细节和配置项参考 [../README.zh-CN.md](../README.zh-CN.md)，远程/HTTPS 参考 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

## 安装与启动

前置：Node.js >= 20，本机已安装并登录 [Codex CLI](https://github.com/openai/codex)（`codex` 在 `PATH` 上，或用 `CODEX_BIN` 指定）。

```bash
npm install
cp .env.example .env
# 编辑 .env：至少设 WORK_DIR 指向你的工作区
npm start
```

看到服务启动日志后，本机浏览器打开 `http://127.0.0.1:3001` 即是完整体验（本机是安全上下文，PWA/推送都可用）。

## 从手机连接

先决定访问方式：

- **只是想在手机上聊两句**：`.env` 设 `HOST=0.0.0.0` + 强 `AUTH_TOKEN`，手机同一局域网访问 `http://<开发机IP>:3001`。注意纯 `http://` 局域网 **装不了 PWA、收不到推送**。
- **想要完整体验（PWA + 推送）**：必须 HTTPS，推荐 Tailscale Serve，见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

首次连接会出现登录页，输入 `.env` 里的 `AUTH_TOKEN`；通过后保存在该浏览器。新设备可能还需在已信任设备上批准（设备审批流）。

## 第一轮对话

在底部输入框发一条提示词，例如「列出当前目录并解释项目结构」。你会看到：

- 助手文本以流式增量逐字出现；
- 推理过程折叠在单独的 reasoning 区块，不混入正文；
- 命令执行以终端卡片呈现，带实时输出和退出码；
- 顶部状态栏显示 cwd、sandbox、审批策略、队列深度、session 与 context 用量。

turn 进行中可随时用停止按钮中断，或继续输入——按状态进入队列或 steer 当前 turn。

## 审批一条命令

当 Codex 要执行命令或改文件、且审批策略要求确认时，会弹出审批卡片：

- 卡片显示将执行的命令或将变更的文件；
- **批准** → 执行，卡片显示 `exit: 0`（或真实退出码）；
- **拒绝** → 被请求的操作不执行；
- 配好 HTTPS + VAPID 后，审批到达会触发 Web Push，锁屏也能收到。

审批是可用性命门：未应答的审批会让 turn 挂起，所以卡片不会自动决议（安全默认，不自动批准也不自动拒绝）。

## 历史与多实例

- **历史抽屉**：浏览过去的 Codex 会话（读 Codex 原生 session JSONL），可 resume、fork、rename、archive、delete。
- **多工作区**：`.env` 的 `WORK_DIR` + `WORK_DIRS` 白名单决定可切换的工作目录。
- **多实例标签**：顶部标签隔离多个活跃对话，`session:switch` 切换当前查看的实例，互不串流。

## 安装为 PWA

**前提是安全上下文**（本机 `localhost` 或任意 `https://`；纯 `http://` 局域网不行）。满足后：

- iOS Safari：分享 → 添加到主屏幕；
- Android Chrome：菜单 → 安装应用 / 添加到主屏幕。

安装后以 standalone 全屏运行，竖屏/横屏/软键盘弹出时 composer 控件保持可见。装不上基本都是安全上下文没满足，回看 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) 的排错清单。
