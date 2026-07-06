# 代码库 vs 设计文档 差距评估

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.0
> 评估对象：`server.js`(772行)、`agent-appserver.js`(514行)、`public/index.html`(2995行) @ commit 2af5ab1
> 对照基准：《需求文档 PRD v1.0》《架构设计文档 v1.0》
> 结论：**继续开发 + 三处定向重构；不重写**

## 1. 总体判定

| 维度 | 评价 |
|---|---|
| 架构同构性 | ✅ 与架构文档 §2 完全同构：统一信封+seq/epoch 续传、agents Map 多实例、stdio 子进程、协议桥分层 |
| 安全边界 | ✅ 符合 §7：loopback-only 默认、timingSafeEqual、CSP、owner-only 落盘、设备审批 |
| 工程卫生 | ✅ 9 个测试文件 230 用例 + Playwright 10 流程、ESLint 9、近期提交在补分支覆盖率 |
| 债务分布 | ⚠️ 集中在 agent-appserver.js 协议桥一层的健壮性细节，改动面小 |
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

## 3. 功能缺口（非债务，按 PRD P0 排期）

**状态（2026-07-06 更新）：FR-01–FR-04 已实现。**

| FR | 结果 | 自动化验证 | 残留 smoke |
|---|---|---|---|
| FR-01 steer | busy + active turn 走 `turn/steer`；无 active turn 保留队列；失败 recoverable 且不破坏当前 turn | agent-appserver + server socket focused tests | 真实长任务中追加指令的人工观察 |
| FR-02 fork | `session:fork` 调 `thread/fork`，创建新 instance 并切换 viewing，广播 init/instances/session_list | agent-appserver + server socket + public UI 字符串测试 | 真机多实例切换体验 |
| FR-03 chatgptDeviceCode | `account/login/start`、`account/login/completed`、`account/updated`、取消路径已映射；token refresh 仍显式拒绝 | agent-appserver + mock app-server socket + public UI 字符串测试 | 真实 ChatGPT 账号输入 device code 后的登录完成 smoke |
| FR-04 reasoning 全量流 | `summaryTextDelta`、`textDelta`、`summaryPartAdded` 均映射到兼容 `reasoning` 信封，前端分 summary/full 渲染 | agent-appserver + public UI + protocol check | 真实模型输出 full reasoning 时的视觉 smoke |

## 4. 对齐良好、无需改动的部分

信封契约（27 个 type 前端已消费）、eventsSince 续传语义、输入队列与背压上限、idle 看门狗、附件安全落盘链路、会话懒开与 resume、TTY/远程双通道设备审批、statusline 4s 轮询、history.js JSONL 兜底（P3 前按设计保留）。

## 5. 判定依据小结

重构收益集中：8 项债务中 6 项的修复落点都在 `handleNotification`/`handleServerRequest` 两个 switch 及其抽取物内；预估 4-6 人日清完 D1-D8，远低于重写成本（信封层+前端+测试资产 ≈ 全部可保留）。执行方案见《重构计划》。
