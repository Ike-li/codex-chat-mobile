# 代码库 vs 设计文档 差距评估

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.0
> 评估对象：`server.js`(1192行)、`agent-appserver.js`(1187行)、`public/index.html`(3699行) @ 当前工作树
> 对照基准：《需求文档 PRD v1.0》《架构设计文档 v1.0》
> 结论：**继续开发 + 三处定向重构；不重写**

## 1. 总体判定

| 维度 | 评价 |
|---|---|
| 架构同构性 | ✅ 与架构文档 §2 完全同构：统一信封+seq/epoch 续传、agents Map 多实例、stdio 子进程、协议桥分层 |
| 安全边界 | ✅ 符合 §7：loopback-only 默认、timingSafeEqual、CSP、owner-only 落盘、设备审批 |
| 工程卫生 | ✅ node:test 覆盖桥层、Socket.IO、前端静态契约、协议 drift 与安全边界；Playwright 10 流程保留 |
| 债务分布 | ⚠️ P0/P1/P2/NFR-8 功能债务已收敛；剩余主要是真机 smoke 和 P3 feature flag |
| 重写理由 | ❌ 无。骨架正确、卫生良好、债务定向可修 |

## 2. 债务清单（(Impact+Risk)×(6−Effort) 打分）

| # | 债务 | 证据 | I | R | E | 分 | 状态 |
|---|---|---|---|---|---|---|---|
| D1 | 依赖新 schema 已删除的 `turn/failed`；`error` 通知未监听。升级 CLI 后失败终态丢失、错误信息黑洞 | agent-appserver.js L311-317 | 3 | 5 | 1 | 40 | ✅ 已关闭 · R1.1 (e1d4e00) |
| D2 | 未知 S→C 请求一律回 `{}`：`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`account/chatgptAuthTokens/refresh` 被空应答（喂空输入/吞 token 刷新） | L137-140 | 4 | 5 | 2 | 36 | ✅ 已关闭 · R1.2 (e1d4e00) |
| D3 | 审批 `/requestApproval/i` 正则分类；payload 仅 command/cwd/reason，**文件审批 diff 丢失**；旧式 `applyPatchApproval`/`execCommandApproval` 落入回 `{}` 分支 | L126-135 | 4 | 4 | 2 | 32 | ✅ 已关闭 · R2.1 (bdcff9f) |
| D4 | 无 CI 协议 diff 防线（G4；D1 正是此类事故） | — | 3 | 4 | 2 | 28 | ✅ 已关闭 · P3/D4 (4e9fac9) |
| D5 | 审批不触发 Web Push，仅 result/error 推送（G2 要求锁屏 ≤30s 可审批） | server.js L447-452 | 3 | 2 | 1 | 25 | ✅ 已关闭 · R2.2 (bdcff9f) |
| D6 | 未知 item type 桥层静默丢弃，违背 NFR-5 raw 降级 | L407-409 | 2 | 3 | 1 | 25 | ✅ 已关闭 · R2.3 (bdcff9f) |
| D7 | `turn/interrupt` 以 notification 发出，schema 定义为 request | L426 | 2 | 3 | 1 | 25 | ✅ 已关闭 · R1.3 (e1d4e00) |
| D8 | `serverRequest/resolved` 未消费——多端弹窗撤销缺失（FR-07） | — | 2 | 2 | 1 | 20 | ✅ 已关闭 · R1.4 (e1d4e00) |

分类（tech-debt 框架）：D1/D7 = 依赖债务（协议版本漂移）；D2/D3/D8 = 架构债务（审批通道健壮性）；D4 = 基础设施债务；D5/D6 = 代码债务。

**状态（2026-07-06 更新）：D1–D8 全部关闭。** 落点见上表状态列；实测协议事实以 `.protocol/stable`（codex 0.142.5）为准，CI 协议防线（`npm run protocol:check`）拦截后续协议漂移。详见《重构计划》与三阶段提交 e1d4e00 / bdcff9f / 4e9fac9。

## 3. PRD 对账（功能与非功能）

**状态（2026-07-06 更新）：P0 FR-01–FR-07、P1 FR-11–FR-18、P2 FR-21–FR-25 与 NFR-8 已实现并有自动化验证；P3 仍是后续阶段。**

| FR | 结果 | 自动化验证 | 残留 smoke |
|---|---|---|---|
| FR-01 steer | busy + active turn 走 `turn/steer`；无 active turn 保留队列；失败 recoverable 且不破坏当前 turn | agent-appserver + server socket focused tests | 真实长任务中追加指令的人工观察 |
| FR-02 fork | `session:fork` 调 `thread/fork`，创建新 instance 并切换 viewing，广播 init/instances/session_list | agent-appserver + server socket + public UI 字符串测试 | 真机多实例切换体验 |
| FR-03 chatgptDeviceCode | `account/login/start`、`account/login/completed`、`account/updated`、取消路径已映射；token refresh 仍显式拒绝 | agent-appserver + mock app-server socket + public UI 字符串测试 | 真实 ChatGPT 账号输入 device code 后的登录完成 smoke |
| FR-04 reasoning 全量流 | `summaryTextDelta`、`textDelta`、`summaryPartAdded` 均映射到兼容 `reasoning` 信封，前端分 summary/full 渲染 | agent-appserver + public UI + protocol check | 真实模型输出 full reasoning 时的视觉 smoke |
| FR-05 协议版本适配 | 终态以 `turn/completed.status` + `error` 通知为准；`turn/failed` 只保留 legacy 双轨兼容 | protocol-adaptation + protocol-check tests | 升级下一版 Codex CLI 时观察 drift 报告 |
| FR-06 审批精确分派 | ApprovalBroker 按 method 分类命令/文件/权限/工具输入，并保留旧式审批兜底 | approval-broker + protocol-adaptation + server-push tests | 真实文件审批 diff 卡片视觉 smoke |
| FR-07 多端审批一致性 | `serverRequest/resolved` 清 pending 并发 `approval_revoked`，前端幂等移除待审批卡片 | protocol-adaptation + public-ui tests | 两个真实浏览器并发审批一次决议 smoke |
| FR-11 会话管理 | `thread:list/select/archive/unarchive/delete/rename` 走原生 app-server 方法，抽屉合并原生 threads 与历史兜底 | agent-appserver + server socket + public UI tests | 真机原生 thread 批量操作 smoke |
| FR-12 compact/usage | `thread/compact/start`、`thread/compacted`、usage/rate limit 信封与前端提示已接入 | agent-appserver + server socket + public UI tests | 真实长上下文压缩 smoke |
| FR-13 rollback | `thread:rollback` Socket.IO 入口与前端按钮已接入 | agent-appserver + server socket + public UI tests | 真实回退语义 smoke |
| FR-14 模型能力 | `model/list` + `modelProvider/capabilities/read` 聚合展示并可写入本地 `/model` 快捷输入 | agent-appserver + server socket + public UI tests | 真实账号模型能力矩阵 smoke |
| FR-15 只读文件选择 | `fs/readDirectory/readFile` 仅接受绝对路径，文件读取后注入 `@path` 并显示预览 | agent-appserver + server socket + public UI tests | 大目录/权限拒绝 smoke |
| FR-16 账号/用量 | `account/read`、`account/usage/read`、`account/rateLimits/read` 与限流通知已映射 | agent-appserver + server socket + public UI tests | 真实账号限流数据 smoke |
| FR-17 MCP/Skills | `mcpServerStatus/list`、`skills/list` 只读面板与通知已映射 | agent-appserver + server socket + public UI tests | 真实 MCP/skills 配置 smoke |
| FR-18 配置导入 | `externalAgentConfig/detect/import` 与 progress/completed 通知已映射；导入前前端确认 | agent-appserver + server socket + public UI tests | 真实 CLAUDE/AGENTS 迁移项 smoke |
| FR-21 配置写入 | `config/value/write`、`config/batchWrite` 经 Admin unlock + per-action confirm 暴露 | agent-appserver + server socket + public UI tests | 真实配置文件写入/回滚 smoke |
| FR-22 插件/市场管理 | `plugin/install/uninstall`、`marketplace/add/remove/upgrade` 经 Admin-only contract 暴露 | agent-appserver + server socket + public UI tests | 真实 marketplace/plugin install smoke |
| FR-23 文件写操作 | `fs/writeFile/remove/copy` 要求绝对路径、Admin 二次确认并审计摘要 | agent-appserver + server socket + public UI tests | 真实文件破坏性操作 smoke |
| FR-24 MCP 直调 | `mcpServer/tool/call` 要求显式 threadId/server/tool，arguments 不进审计明文 | agent-appserver + server socket + public UI tests | 真实 MCP 工具权限 smoke |
| FR-25 登出 | `account/logout` 经 Admin-only contract 暴露并审计 | agent-appserver + server socket + public UI tests | 真实账号 logout smoke |

| NFR | 对账结果 | 残留 |
|---|---|---|
| NFR-1 流式延迟 | 流式通道已实现 | P95≤300ms 尚缺计时报告 |
| NFR-2 断线恢复 | seq/epoch catch-up 自动化覆盖 | 真机弱网≤2s 恢复 smoke 待跑 |
| NFR-3 审批时效 | Web Push 覆盖审批和工具输入 | 在线≤3s / Push≤30s 尚缺计时 smoke |
| NFR-4 安全边界 | loopback/token/拒绝路径自动化与 smoke 脚本覆盖 | 真实发布前仍需跑拒绝 smoke |
| NFR-5 兼容性 | `.protocol/stable` + `protocol:check` + `raw_item` 降级覆盖 | 每次升级 CLI 需重新生成并审查 drift |
| NFR-6 背压 | `-32001` request 层指数退避、UI 拥塞提示、超限失败提示已实现 | 真实 app-server overload 场景 smoke 待跑 |
| NFR-7 移动体验 | PWA/长日志/键盘布局已有验收资产 | 真机弱网体验仍需人工验证 |
| NFR-8 可观测 | 审批审计 + 通用 JSON-RPC 脱敏 JSONL owner-only 落盘，`rpcStats` 进入 status | 日志保留/轮转策略后续按运维需要补充 |

**非本期交付：** PRD P3（FR-31–FR-35）仍未按产品功能开放，继续保持 feature-flag future 范围。P2 已开放但限定在 Admin unlock + per-action confirm + owner-only 审计路径下；真实破坏性操作仍需人工 smoke。

## 4. 对齐良好、无需改动的部分

信封契约（含 P0/P1 原生 app-server 事件）、eventsSince 续传语义、输入队列、JSON-RPC `-32001` 退避、idle 看门狗、附件安全落盘链路、会话懒开与 resume、TTY/远程双通道设备审批、statusline 4s 轮询、history.js JSONL 兜底（P3 前按设计保留）。

## 5. 判定依据小结

重构收益集中：8 项债务中 6 项的修复落点都在 `handleNotification`/`handleServerRequest` 两个 switch 及其抽取物内；预估 4-6 人日清完 D1-D8，远低于重写成本（信封层+前端+测试资产 ≈ 全部可保留）。执行方案见《重构计划》。
