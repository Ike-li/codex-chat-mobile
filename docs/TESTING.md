# 测试

测试体系分为确定性的 mock 门禁和明确隔离的真实 Codex 冒烟。日常开发保持零模型额度：服务端集成使用 fake stdio app-server，Playwright 使用 `scripts/mock-server.js`。

## 必跑门禁

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

- `npm test` 以 `--test-concurrency=1` 运行 `node:test`，覆盖单元、集成、协议、安全、UI 和文档契约。
- `npm run protocol:check` 要求本机 Codex 版本等于 `.codex-version`，并检查 `.protocol/stable/` 的覆盖与漂移；版本不匹配就是失败，不能跳过后宣称门禁通过。
- `npm run test:e2e` 用 Playwright mobile Chrome 连接 mock gateway，不启动真实 Codex。
- `npm run test:ci` 串联 lint、单测、覆盖率门禁和 E2E；协议门禁仍需按上面的四条命令单独运行。

## 自动化覆盖

当前自动化覆盖以下关键边界：

- **共享 app-server**：Transport 单进程/单 request-id 空间、Host single-flight initialize、多 runtime 交错通知、ThreadRegistry 对 thread/turn/request 的一致性校验、无法路由的 server request fail-closed、共享进程退出通知与恢复。
- **原生 thread 事实源**：`thread/list/read/resume` 跨 Codex App/Web 读取续接，`thread/status/changed` 驱动活动状态，契约测试禁止恢复 `sessions.js`、`history.js` 和旧 session history/list 事件。
- **可靠投递**：稳定 `clientRequestId`、payload fingerprint、single-flight、重复 ACK 回放、id 冲突、ledger 容量、`clientUserMessageId` 透传；浏览器 IndexedDB outbox 的先持久化、FIFO、ACK timeout 隔离、gateway epoch、无 thread 的 ledger reconciliation、`thread/read` fallback、provisional instance 恢复、从未尝试记录原 id 重绑、已尝试记录 fresh-id 确认重试，以及 reconcile/retry 互斥防旧 id 复活；fresh-gateway 集成测试断言核对期间 `turn/start` 总计仍为一次。
- **断线恢复**：同 epoch 连续 buffer 增量补发，buffer gap/epoch mismatch 触发精确 `thread/read` snapshot，客户端按 `throughSeq` watermark 缓冲并去重恢复期间的 live events。
- **结构化输入**：attachments 类型、10/20 MiB 业务限制、32 MiB Socket wire cap、0700 上传目录/0600 文件，图片→`localImage`、文件→`mention`，workspace mention、enabled skill、显式门控的 HTTPS image URL 与完整 IPv4/IPv6 DNS/SSRF 拒绝路径。
- **审批与 needs-you**：approval/question 分类、精确 target、snapshot/revision、进程内幂等重放与 conflict/stale/unknown、resolved/expired/revoked 广播和脱敏深链。
- **自托管安全**：HTTPS fail-closed、Origin allowlist、可信代理、HttpOnly device-bound session、query token 拒绝、配对/撤销、外部 trusted-file 原子变更、认证/Admin/Push 容量限制、rate-limit 审计聚合、O_APPEND + bounded rotation、Admin sink 脱敏，以及 Push DNS pin/总超时/响应上限与持久化失败。
- **产品门控**：Admin/Labs default-off 的 feature manifest、服务端拒绝、Admin unlock/Lock/TTL/失败窗口/逐操作确认。
- **移动端**：流式气泡、thinking、命令/工具/diff/审批/提问卡片、状态栏、PWA/Service Worker、needs-you 恢复、outbox 存储与多实例/多视图隔离。

主要证据分布在 `test/app-server-{transport,host}.test.mjs`、`test/thread-{registry,runtime,source-of-truth,status}.test.mjs`、`test/message-{receipt-ledger,outbox,request}.test.mjs`、`test/recovery-state.test.mjs`、`test/{user-inputs,input-parts}.test.mjs`、`test/server-{integration,security,push}.test.mjs`、`test/service-worker.test.mjs` 和 `e2e/*recovery*.spec.js`。

## 验收矩阵

每个产品场景都按四个维度判断：**功能等价**、**状态可见**、**失败可恢复**、**权限可控**。矩阵的「代码入口」同时是当前功能盘点；文件被删除后必须从这里移除，不能把历史方案继续写成事实。

| 案例 | 场景 | 代码入口 | 主要证据 |
|---|---|---|---|
| 案例 1 | 创建任务 + 流式输出 + ACK/outbox + provisional orphan/fresh-id 恢复 + gap 后恢复会话 + 部署或审核结果 | `server.js`、`message-receipt-ledger.js`、`public/js/message-{request,outbox}.js`、`public/js/{indexeddb-outbox,outbox-recovery,recovery-state}.js` | receipt/dedup 集成测试、outbox 与 recovery 单测、关键流程和 outbox recovery E2E |
| 案例 2 | 执行命令 + 触发权限 + 审批/提问跨 thread 聚合 + exit code 可见 | `approval-broker.js`、`needs-you-registry.js`、`agent-appserver.js` | broker/needs 幂等与冲突测试、关键审批与 needs-you recovery E2E |
| 案例 3 | 产生失败 + 重试恢复（同 id 只读核对 / fresh-id 确认重试）+ backpressure + 长日志移动体验 | `agent-appserver.js`、`message-receipt-ledger.js`、`public/index.html` | 协议错误/结果未知测试、retry/copy UI 契约、移动视口 E2E |
| 案例 4 | 文件上传 + 结构化附件输入（替代路径字符串“附件注入”）+ transport/business 双层上限 + 0700/0600 安全落盘 | `uploads.js`、`file-security.js`、`user-inputs.js`、`input-parts.js` | user-inputs/input-parts/file-security 单测、>1 MiB wire 集成、附件 E2E |
| 案例 5 | 状态栏 + `thread/status/changed` + git/token/context 状态 | `statusline.js`、`agent-appserver.js` | statusline、thread_status 与 public UI 测试 |
| 案例 6 | 历史浏览 + app-server thread 唯一事实源 + Codex App/Web 双向续接 | `app-server-host.js`、`thread-runtime.js`、`server.js` 的 `thread:*` | thread source-of-truth、native thread、跨端 history/resume 集成测试 |
| 案例 7 | 多工作目录 + 实例切换 + 双设备/双 thread 零串流 + 共享单进程 | `app-server-host.js`、`thread-registry.js`、`thread-runtime.js`、`public/js/view-routing.js` | shared-host spawn/initialize、stale target、route/workdir、多实例 E2E |
| 案例 8 | Web Push + DNS/address pinning + bounded response + needs-you 脱敏深链 + device revoke | `server.js`、`push-sender.js`、`network-address.js`、`needs-you-registry.js`、`public/js/sw.js` | Push DNS/mixed-IP/timeout/body-cap 单测、authenticated persist/prune、service worker 和 needs-you E2E |
| 案例 9 | 模型切换 + 权限档切换 + Admin/Labs default-off | `agent-appserver.js`、`server.js` feature manifest、`public/index.html` | model/permission UI、feature flag、Admin TTL/limit 测试 |
| 案例 10 | PWA 安装 + HTTPS/auth session + 全屏/移动体验 | `server-security.js`、`public/manifest.webmanifest`、`public/js/sw.js` | transport security/session/SW 测试、响应式和 PWA E2E |

## 手工冒烟清单

只在确定性门禁通过后使用。涉及真实 Codex 的项必须由维护者明确授权。

- TC-1：基础对话生成一个稳定 request id，收到 ACK 后流式显示完整响应。
- TC-2：斜杠命令 `/status`、`/diff`、`/review`、`/permissions` 可用。
- TC-3：停止按钮只中断目标 thread 的活跃 turn。
- TC-4：busy turn 期间输入按协议能力进入队列或 steer，其他 thread 不受影响。
- TC-5：审批批准只决议一次，并显示真实命令退出码。
- TC-6：审批拒绝不执行请求；另一个设备上的同一 need 同步撤销。
- TC-7：文件/图片显示附件元数据，并分别以 `mention` / `localImage` 发送，不向 text 拼路径。
- TC-8：状态栏显示 cwd、sandbox、approval policy、queue、thread 和 context；`thread/status/changed` 能跨设备更新忙闲状态。
- TC-9：历史抽屉使用 `thread/list/read` 浏览，并能双向续接 Codex App 与 Web 创建的 thread。
- TC-10：多工作区切换只接受 `WORK_DIR` / `WORK_DIRS` allowlist。
- TC-11：两个设备分别查看两个活跃 thread 时，文本、工具、审批和状态均不串流。
- TC-12：模型控件显示可用模型，或显示明确且可恢复的空/错误状态。
- TC-13：权限控件只更新目标 runtime 的 model/sandbox/approval 状态。
- TC-14：普通刷新以 seq/epoch catch up，不重复已应用事件。
- TC-15：人为丢 ACK 后，以相同 `clientRequestId`/payload 重试只执行一次；冲突 payload 被拒绝。
- TC-16：VAPID 配齐、HTTPS、有效 session 且设备已批准时才能订阅 Web Push；通知不含命令/问题正文并打开精确 need 深链。
- TC-17：安全上下文中的 PWA manifest 支持 standalone 安装。
- TC-18：移动端竖屏、横屏和软键盘布局都保持 composer 控件可见。
- TC-19：离线发送后关闭/重开页面，IndexedDB outbox 保留并在重连后按 FIFO 发送一次。
- TC-20：强制 event buffer gap 或 epoch mismatch 后由 `thread/read` 重建；恢复期间 live event 不丢不重。
- TC-21：新设备登录后保持 pending；批准后解锁，deny 后 cookie/socket/Push 同时失效。
- TC-22：远程 HTTP、错误 Origin、缺失可信 `X-Forwarded-Proto` 和撤销后的 session 均 fail-closed。
- TC-23：Admin/Labs 默认隐藏且服务端拒绝；显式 flag 后才显示，Admin Lock/TTL 生效。
- TC-24：workspace mention、enabled skill 可发送；越界路径、未启用 skill 和默认关闭的远程图片被拒绝。
- TC-25：ACK 丢失后重启 gateway，客户端只调用 `message:reconcile`；无 thread 时仍先查 receipt ledger，有 thread 时 `thread/read` 命中 `clientRequestId` 后清除 outbox 且 `turn/start` 总计一次。消失 instance 的未尝试记录保留原 id 重绑；已尝试且无法核对时保持 `needs_reconcile`，用户确认后使用新 id，旧 id 不得复活。

## 真实 Codex 冒烟边界

真实 Codex CLI 不属于默认 E2E。只有在验证本地集成、审批或协议升级且用户明确授权时才运行；使用一次性工作区、受限 sandbox/approval policy，并单独记录它与 mock 门禁的结果。版本与 `.codex-version` 不一致时先走 [PROTOCOL_UPGRADE.md](PROTOCOL_UPGRADE.md)，不要用当前安装版本覆盖基线。
