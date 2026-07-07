# codex-chat-mobile

[![CI](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

[English](./README.md) | 简体中文

面向手机的本地 Codex CLI 控制界面。目标是让手机端具备接近终端的 Codex 使用体验：同一个本地工作区、同一套审批边界、同样的流式 agent 事件。

| 流式对话 | 审批卡片 |
|---|---|
| ![手机上的流式对话](docs/assets/chat.png) | ![手机上的审批卡片](docs/assets/approval.png) |

> 截图取自确定性 mock app-server（`npm run test:e2e` 用的 harness），不消耗任何真实 Codex 额度。

## 当前形态

- 本地 Node.js 服务：Express 5 + Socket.IO。
- Codex 桥接：通过 stdio 长驻运行 `codex app-server`，协议为 JSON-RPC 2.0。
- 前端：`public/index.html` 中的单文件移动端 SPA/PWA。
- 核心能力：流式对话、工具卡片、审批卡片、斜杠命令、文件附件、会话历史、多工作区路由、多实例标签、Web Push、PWA 安装。
- 安全默认值：`AUTH_TOKEN` 为空时只允许 loopback；局域网或 tunnel 访问必须设置 token；本地状态 owner-only 落盘；CSP 响应头；上传校验；协议漂移检查。

## 本地运行

前置条件：Node.js >= 20；本机已安装并登录 [Codex CLI](https://github.com/openai/codex)（`codex` 在 `PATH` 上，或用 `CODEX_BIN` 指定），协议基线固定在 `.codex-version`。

```bash
npm install
cp .env.example .env
npm test
npm start
```

常用 `.env` 配置：

```bash
PORT=3001
HOST=127.0.0.1
AUTH_TOKEN=replace-with-a-local-secret
WORK_DIR=/absolute/path/to/workspace
WORK_DIRS=/other/project,/third/project
CODEX_BIN=/absolute/path/to/codex
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
CODEX_INPUT_QUEUE_LIMIT=20
```

本机打开 `http://127.0.0.1:3001`。如果要通过局域网或 tunnel 访问，必须设置 `HOST=0.0.0.0` 和非空 `AUTH_TOKEN`。没有 `AUTH_TOKEN` 时，服务启动会被限制为 loopback host。

## 常用命令

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
npm run test:ci
```

`npm run test:e2e` 使用 Playwright 连接 `scripts/mock-server.js`，不应调用真实 Codex CLI，也不应消耗模型额度。

## 核心文件

- `server.js`：HTTP、Socket.IO、鉴权、路由和实例生命周期。
- `agent-appserver.js`：Codex app-server JSON-RPC 桥接和事件映射。
- `public/index.html`：移动端 UI、PWA 控制、审批卡片和 native 面板。
- `scripts/mock-codex-app-server.js`：用于 E2E 的确定性 Codex 协议 mock。
- `.protocol/stable/`：用于协议漂移检查的 app-server 协议基线。
- `docs/GUIDE.md`：从安装到装成 PWA 的端到端使用走查。
- `docs/REMOTE_ACCESS.md`：从手机连接（HTTPS/PWA/Push 硬限制、Tailscale、隧道）。
- `docs/ARCHITECTURE.md`：当前架构和安全模型。
- `docs/PROTOCOL.md`：Codex app-server 协议参考（方法、事件、覆盖）。
- `docs/EVENTS.md`：Socket.IO 事件契约索引。
- `docs/TESTING.md`：测试门禁、验收矩阵和手工冒烟清单。
- `docs/PROTOCOL_UPGRADE.md`：Codex app-server 协议升级流程。
- `ROADMAP.md`：已完成 / 进行中 / 候选。

## 文档规则

只有当前维护中的文档才作为事实来源。一次性 sprint 计划和过时 QA 上下文已删除；协议文档背后的生成式调研底稿以只读形式保存在 [docs/archive/](docs/archive/) 并明确标注不再维护。存档内容不应重新提升为事实来源，除非被再次明确维护。

双语规则：`README.md`（英文）是开源主入口，`README.zh-CN.md`（本文件）是中文镜像，两者必须同步维护；`docs/` 下的维护文档目前为中文。文档结构由 `test/acceptance-doc.test.mjs` 契约测试守护，调整文档结构时先改契约。

## 许可证

本项目以 [AGPL-3.0-only](LICENSE) 发布：如果你把修改版作为网络服务运行，AGPL 要求向其用户提供修改后的源码。

参与贡献请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（英文），安全边界与漏洞披露见 [SECURITY.md](SECURITY.md)（英文）。Issue 和 PR 中英文皆可。
