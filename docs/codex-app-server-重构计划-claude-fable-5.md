# 协议桥重构计划

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.1
> 输入：《差距评估》D1-D8 ｜ 输出承诺：清完后代码与《架构设计文档》§4 一致（含 DoD-4 所列文档小修）
> 总预估：4-6 人日（≈5），三个阶段，每阶段可独立合并发布
> v1.1 修订：按本机 codex 0.142.5 `generate-ts` 实测产物逐条校正协议事实——各节【实测修订】标注；执行时机由"下次升级前"改为"立即"（本机 CLI 已删除 `turn/failed`，D1 当下已生效）

## 0. 目标与非目标

**目标**：修复协议桥健壮性债务（D1-D8），为 PRD P0 新功能（steer/fork/deviceCode）打地基。
**非目标**：不重写、不换框架、不破坏信封契约（前端 27 个 type 全部向后兼容，只增不改）、不引入 experimental 能力（本计划全部在 A∩B1 稳定面内）。

**执行原则**（遵循 TDD 规则）：每项先写一个失败测试表达外部可观察行为 → 最小实现 → 通过后才重构；mock 仅用于 codex 子进程边界（伪造 stdio JSON-RPC 消息序列，测试资产 `test/agent-appserver*.test.mjs` 已有此模式可复用）。

## 阶段 1：协议版本适配与应答完整性（D1/D2/D7/D8，~1.5 人日）

> 【实测修订】执行时机=**立即**：本机 codex 已是 0.142.5，`turn/failed` 在其 `ServerNotification` 导出中 0 命中——现网 `turn/failed` case 已是死代码，`error` 通知正被静默忽略。同时校准影响面：现有 `turn/completed` case 对任意 status 都复位 busy 并 drain（agent-appserver.js:304-310），故不会卡死；本阶段修复的是失败语义与错误信息呈现，不是解卡。

### R1.1 移除 `turn/failed` 依赖，接管 `error` 通知（D1）
- 失败测试：`test/protocol-adaptation.test.mjs` ——
  注入 `error {error:{message}, willRetry:false}` + `turn/completed {turn:{status:'failed', error:{message}}}` 序列 → 断言信封出 `error` 事件（失败原因优先取 `turn.error`）、`busy=false`、队列继续 drain；
  **【实测修订】注入 turn 中途 `error {willRetry:true}` → 断言 busy 保持 true、队列不 drain、仅出"重试中"级告警**——`ErrorNotification` 实测含 `willRetry: boolean`，终态必须一律由 `turn/completed` 驱动、`error` 通知只供信息，否则 codex 内部重试时桥会并发起队列中的下一个 turn，击穿 FIFO 语义；
  注入旧版 `turn/failed` 仍兼容（双轨）。
- 实现：`handleNotification` 增加 `error` case（只透出消息与 willRetry，不改 busy/队列；`ErrorNotification` 带 threadId/turnId，可区分 turn 级/连接级）；`turn/completed` 按 `status ∈ {completed, failed, interrupted}` 分发终态（failed 时取 `turn.error` 作失败原因）；保留 `turn/failed` case 一个版本周期后删除。
- 验收（四维度）：失败可恢复——失败原因可见且 retry 入口不变。

### R1.2 未知 S→C 请求：从回 `{}` 改为注册表分派（D2）
- 失败测试：注入未注册方法（编造方法名，另加 `item/tool/requestUserInput`——阶段 2 收编前暂走同一路径）→ 断言回 JSON-RPC `error {code:-32601}`（而非 `{}`）且信封发出 `system` 告警；注入 `account/chatgptAuthTokens/refresh` → **断言回 JSON-RPC error 且不落盘任何凭证**。
- 【实测修订】v1.0 原文"透传 codex 自管 token 流"不成立：`ChatgptAuthTokensRefreshResponse` 实测要求 `{accessToken, chatgptAccountId, …}`——桥无 token 可供、无从透传。该请求仅在 client-managed token 登录（experimental，本产品不用）下才会出现，注册为"已知无法履约 → error"。
- 实现：`serverRequestHandlers` 注册表：已知无法履约方法 → 显式 error；审批族 → 交 ApprovalBroker（阶段 2 前暂走现有路径）；未注册 → `error {code:-32601}` + 告警信封。**禁止再出现默认回 `{}`**。
- 风险：某些未知请求被拒绝可能中断 turn——比静默错误行为可取，且告警可见。

### R1.3 `turn/interrupt` 改为 request（D7）
- 失败测试：断言中断走 `request()` 且带 id、等待 response（实测响应体为空对象）；响应超时（2s）→ 断言仍执行本地复位（busy/清队列）并透出 `system` 告警。
- 实现：`abort()` 中 `notify` → `request`（带 2s 超时容错）。
- 【实测修订】删除 v1.0"超时降级 SIGTERM 路径不变"表述——现 `abort()` 并无 SIGTERM 路径（仅 `dispose()` 有），本项不新增进程终止行为。

### R1.4 消费 `serverRequest/resolved`（D8）
- 失败测试：pending 审批中注入 `serverRequest/resolved {requestId}` → 断言 pendingApprovals 清除、信封发 `approval_revoked`。
- 实现：通知 case + 新信封 type `approval_revoked`；前端撤销对应弹窗（index.html 增一个 case，幂等）。
- 【实测修订】type 不叫 approval_resolved：与现有 status reason `'approval_resolved'`（agent-appserver.js:154，语义=本端决议）撞名，此处语义=他端已决/服务端撤销。

## 阶段 2：ApprovalBroker 抽取（D3/D5/D6 + 收编 requestUserInput，~2.5 人日）

### R2.1 新模块 `approval-broker.js`
- 失败测试：`test/approval-broker.test.mjs` 按 method 精确分派——
  `item/commandExecution/requestApproval` → payload 含 command/cwd/reason（实测三者皆为可选字段，缺省容错）；
  `item/fileChange/requestApproval` → 【实测修订】**审批参数不含 changes[]**（实测仅 `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`，v1.0 断言的字段不存在）——测试序列改为：先注入 `item/started {type:'fileChange', id, changes[]}`，再注入审批请求 `{itemId}` → 断言 broker 按 itemId 从进行中 item 缓存 join 出 changes[]（path/kind/diff 截断）；缓存 miss → 降级仅显示 reason/grantRoot，不阻塞审批；
  `item/permissions/requestApproval` → 权限描述（`permissions` + cwd/reason）；
  `item/tool/requestUserInput` → 【实测修订】收编为分派项（对齐架构 §4.1"工具输入"与接口地图 §7 Core；该方法在默认导出内、地图归入 A∩B1，类型注释标 EXPERIMENTAL，字段做容错）：信封 `user_input_request`（questions[]/options/autoResolutionMs 截断透传）→ 前端问答卡片 → 回 `{answers}`；不作答由服务端 autoResolution 兜底，撤销复用 `approval_revoked`；
  旧式 `applyPatchApproval`/`execCommandApproval` → 映射为同一信封结构；**【实测修订】v1/v2 decision 词表不同，必须映射并断言线上精确字符串**：accept→`approved`、acceptForSession→`approved_for_session`、decline→`denied`、cancel→`abort`（v2 方法原样 `accept|acceptForSession|decline|cancel`）——只写"按 v1 格式回 {decision}"会把 v2 词表发给 v1 方法，反序列化失败；
  重复决议/已撤销决议幂等无副作用。
- 实现：从 `handleServerRequest` 抽出；新增进行中 item 缓存（`item/started` 时登记，turn 终态清理）供 fileChange 审批 join；信封 `approval_request` payload 扩展字段（向后兼容，旧字段不动）；审计日志落盘（NFR-8，owner-only 文件复用 `file-security.js`）。
- 前端：审批卡片渲染 diff/权限详情 + requestUserInput 问答卡片（现有卡片扩展，不改交互流）。

### R2.2 审批触发 Web Push（D5）
- 失败测试：`approval_request` 信封 → 断言 pushNotify 被调用（title 含"待审批"）；`approval_revoked` 不推；`user_input_request` 同样推送（同为"需要人到场"信号）。
- 实现：server.js `onEvent` 推送条件增加 `approval_request`。
- 验收：G2——锁屏收到审批推送 ≤30s（真机 smoke 复跑 `smoke-approval.js`）。

### R2.3 未知 item 降级 raw（D6）
- 失败测试：注入 `item/completed {type:'somethingNew'}` → 断言信封出 `raw_item`，不丢弃不崩溃。
- 实现：`handleItem` default 分支 emit `raw_item`（截断 payload）；前端 default 渲染折叠 JSON 卡片。
- 边界：未知**通知**维持安全忽略——通知无应答义务，把 69 个通知方法的长尾全部 raw 化对移动端是噪声；架构 §4.1"未知通知→raw"的措辞差随 DoD-4 文档修订对齐。

## 阶段 3：CI 协议防线（D4，~1 人日）

- **【实测修订】CLI 版本 pin（前置）**：版本号唯一出处 `.codex-version`（或 package.json devDependencies `@openai/codex`）；本地与 CI 统一用 pinned 版本生成产物——否则不同开发机重新生成 `.protocol/` 产生噪声 diff，防线失真。现 CI（test.yml，ubuntu + npm）**没有 codex 二进制**，需增加安装步骤（如 `npm i -g @openai/codex@$(cat .codex-version)`）。
- `scripts/protocol-check.mjs`：`codex app-server generate-ts --out .protocol/stable` + `--experimental --out .protocol/experimental` → 与上次提交的产物 diff → 输出新增/删除/改名方法报告；映射表覆盖检查（`agent-appserver.js` 消费的每个通知名必须存在于导出产物，**D1 类事故在此拦截**）。
- `npm run protocol:check` 接入 CI；`.protocol/` 产物入库以便 diff（diff 只应在 pin 升级时出现，出现即为预期信号）。
- 升级 runbook：改 pin → 跑 check → 更新映射 → 四维度回归 → 真机 smoke。

## 4. 发布与回滚

- 每阶段独立分支 + PR，合并前提：全部既有 230 用例绿 + 新增用例绿 + Playwright 10 流程绿。
- 信封只增不改：任一阶段可单独回滚，前端旧版本兼容新桥。
- 阶段 1 优先级最高且**立即执行**【实测修订】：本机 codex 已是 0.142.5、`turn/failed` 已不在其导出中——D1 不是"下次升级"的预防项，而是当下已生效的缺口（失败原因与 `error` 通知正被静默丢弃）。

## 5. 完成定义（DoD）

1. D1-D8 全部关闭，差距评估文档更新状态
2. `handleServerRequest` 中不存在回 `{}` 的默认路径（代码审查断言）
3. 真机 smoke 三件套复跑通过：批准、拒绝、review
4. 《架构设计文档》§4.1 与代码一致——【实测修订】v1.0"无需修订文档"不成立，随阶段 PR 做三处文档小修：(a)"拦截链（透明代理）"措辞改为"注册表分派 + 映射表"（与实现一致）；(b)"未知通知→raw"改为"未知 item→raw_item、未知通知安全忽略"；(c) 登录状态机段标注"FR-03 范围，本计划不实施"
5. 协议断言以 `.protocol/`（0.142.5 pin）实测产物为准，测试中不得出现产物中不存在的字段——本次 v1.1 修订的直接教训：v1.0 曾断言审批参数携带不存在的 changes[]

## 6. 衔接（本计划之后）

按 PRD P0 顺序实施 FR-01 steer（依赖阶段 1 的终态适配）、FR-02 fork、FR-03 deviceCode 登录（依赖阶段 1 的 S→C 注册表）、FR-04 reasoning 全量流（依赖阶段 2 的降级机制）。
