# 测试

测试体系分为确定性的本地门禁和可选的真机冒烟检查。日常开发应保持 mock 驱动、零 token；只有任务明确要求真实 Codex CLI 时才运行真实集成检查。

## 必跑门禁

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

- `npm test` 运行原生 `node:test`，覆盖单元、集成、协议、安全、UI 字符串和文档契约。
- `npm run protocol:check` 将桥接覆盖情况与 `.protocol/stable/` 对比。
- `npm run test:e2e` 用 Playwright mobile Chrome 连接 `scripts/mock-server.js`。
- `npm run test:ci` 串联 lint、单元测试、覆盖率检查和 Playwright E2E。

## 自动化覆盖

当前自动化覆盖包括：

- App-server JSON-RPC 生命周期、队列、中断、steer、审批和事件适配。
- Server Socket.IO 路由、鉴权边界、loopback 规则、设备信任、push decision、Admin/Labs 门控。
- 上传校验、owner-only 写入、symlink 防御、状态栏、历史解析和 sanitizer。
- 前端契约：会话状态、附件、状态控件、native 面板、PWA/push 元素、富卡片、reasoning、Admin 和 Labs UI。
- Playwright E2E：浏览器运行时、关键流程、附件/布局、富事件渲染、PWA/Service Worker、native controls、popover/斜杠建议、多实例标签。

## 验收矩阵

每个产品关键场景都按四个维度判断：功能等价、状态可见、失败可恢复、权限可控。矩阵的「代码入口」列同时充当功能盘点，指向承载该场景的主要模块。

| 案例 | 场景 | 代码入口 | 主要证据 |
|---|---|---|---|
| 案例 1 | 创建任务 + 流式输出 + 恢复会话 + 部署或审核结果 | `agent-appserver.js`（turn 生命周期 / 事件映射）、`server.js`（catch-up） | Playwright 关键流程、Socket.IO catch-up 测试、`/status` 和 `/review` 渲染 |
| 案例 2 | 执行命令 + 触发权限 + exit code 可见 | `approval-broker.js`、`agent-appserver.js`（tool 卡片） | approval broker 测试、关键审批 E2E、命令结果渲染 |
| 案例 3 | 产生失败 + 重试恢复 + 长日志移动体验 | `agent-appserver.js`（error/backpressure）、`public/index.html`（retry/copy） | 协议错误测试、UI retry/copy 覆盖、移动视口 E2E |
| 案例 4 | 文件上传 + 附件注入 + 安全落盘 | `uploads.js`、`file-security.js` | uploads 测试、附件 E2E、owner-only 文件断言 |
| 案例 5 | 状态栏 + git 上下文 + token/context usage | `statusline.js`、`agent-appserver.js`（`tokenUsage`） | statusline 测试、public UI 契约测试 |
| 案例 6 | 历史浏览 + app-server thread 主事实源 + Codex App/Web 跨端一致性 | `agent-appserver.js`（`thread/*`）、`server.js`（`thread:history`）、`history.js` fallback | thread history 测试、native thread 面板测试 |
| 案例 7 | 多工作目录 + 实例切换 + 隔离 | `server.js`（`agents` map / workdir 路由）、`sessions.js` | route/workdir 测试、多实例 E2E |
| 案例 8 | Web Push + Service Worker | `push.js`、`public/js`（sw） | push decision 测试、PWA/SW E2E |
| 案例 9 | 模型切换 + 权限档切换 | `agent-appserver.js`（`model/list` / `turn/start` override）、`public/index.html` | model/permission UI 契约测试、popover E2E |
| 案例 10 | PWA 安装 + 全屏/移动体验 | `public/manifest.webmanifest`、`public/js`（sw） | manifest/SW E2E、响应式视口检查 |

## 手工冒烟清单

只在确定性门禁通过后使用这份清单。

- TC-1：基础对话能发送提示词并流式显示响应。
- TC-2：斜杠命令 `/status`、`/diff`、`/review`、`/permissions` 可用。
- TC-3：停止按钮能中断活跃 turn。
- TC-4：busy turn 期间的输入会按状态进入队列或 steer。
- TC-5：审批批准路径会执行，并显示 `exit: 0`。
- TC-6：审批拒绝路径不会执行被请求的操作。
- TC-7：文件上传会显示附件元数据，并注入安全本地路径。
- TC-8：状态栏显示 cwd、sandbox、approval policy、queue、session 和 context 状态。
- TC-9：历史抽屉能浏览过去的 Codex 会话。
- TC-10：多工作区切换遵守配置的 `WORK_DIRS`。
- TC-11：多实例标签隔离活跃对话。
- TC-12：模型控件显示可用模型状态，或显示可恢复的空/错误状态。
- TC-13：权限控件会更新状态，或发送预期斜杠命令。
- TC-14：刷新/重连能 catch up，且不重复近期消息。
- TC-15：失败后复制和 retry 仍可用。
- TC-16：只有配置 VAPID 后，Web Push 订阅才可用。
- TC-17：PWA manifest 支持 standalone 安装。
- TC-18：移动端竖屏、横屏和软键盘布局都能保持 composer 控件可见。

## 真实 Codex 冒烟边界

真实 Codex CLI 冒烟测试不属于默认 E2E 路径。只有在验证本地集成、审批或协议升级时才运行。运行时使用一次性工作区，并显式设置 approval policy。
