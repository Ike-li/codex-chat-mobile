# 协议桥重构计划

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.0
> 输入：《差距评估》D1-D8 ｜ 输出承诺：清完后代码与《架构设计文档》§4 一致
> 总预估：4-6 人日，三个阶段，每阶段可独立合并发布

## 0. 目标与非目标

**目标**：修复协议桥健壮性债务（D1-D8），为 PRD P0 新功能（steer/fork/deviceCode）打地基。
**非目标**：不重写、不换框架、不破坏信封契约（前端 27 个 type 全部向后兼容，只增不改）、不引入 experimental 能力（本计划全部在 A∩B1 稳定面内）。

**执行原则**（遵循 TDD 规则）：每项先写一个失败测试表达外部可观察行为 → 最小实现 → 通过后才重构；mock 仅用于 codex 子进程边界（伪造 stdio JSON-RPC 消息序列，测试资产 `test/agent-appserver*.test.mjs` 已有此模式可复用）。

## 阶段 1：协议版本适配与应答完整性（D1/D2/D7/D8，~1.5 人日）

### R1.1 移除 `turn/failed` 依赖，接管 `error` 通知（D1）
- 失败测试：`test/protocol-adaptation.test.mjs` —— 注入 `turn/completed {status:'failed'}` + `error {message}` 序列，断言信封出 `error` 事件、`busy=false`、队列继续 drain；注入旧版 `turn/failed` 仍兼容（双轨）。
- 实现：`handleNotification` 增加 `error` case（区分 turn 级/连接级）；`turn/completed` 按 `status ∈ {completed, failed, interrupted…}` 分发终态；保留 `turn/failed` case 一个版本周期后删除。
- 验收（四维度）：失败可恢复——失败原因可见且 retry 入口不变。

### R1.2 未知 S→C 请求：从回 `{}` 改为注册表分派（D2）
- 失败测试：注入 `item/tool/requestUserInput` 请求 → 断言回 JSON-RPC error（而非 `{}`）且信封发出 `system` 告警；注入 `account/chatgptAuthTokens/refresh` → 断言按协议正确应答（透传 codex 自管 token 流，不落盘）。
- 实现：`serverRequestHandlers` 注册表：已知无 UI 方法 → 正确应答；审批族 → 交 ApprovalBroker（阶段 2 前暂走现有路径）；未注册 → `error {code:-32601}` + 告警信封。**禁止再出现默认回 `{}`**。
- 风险：某些未知请求被拒绝可能中断 turn——比静默错误行为可取，且告警可见。

### R1.3 `turn/interrupt` 改为 request（D7）
- 失败测试：断言中断走 `request()` 且带 id、等待 response；进程无响应时超时降级 SIGTERM 路径不变。
- 实现：`abort()` 中 `notify` → `request`（带 2s 超时容错）。

### R1.4 消费 `serverRequest/resolved`（D8）
- 失败测试：pending 审批中注入 `serverRequest/resolved {requestId}` → 断言 pendingApprovals 清除、信封发 `approval_resolved`。
- 实现：通知 case + 新信封 type `approval_resolved`；前端撤销对应弹窗（index.html 增一个 case，幂等）。

## 阶段 2：ApprovalBroker 抽取（D3/D5/D6，~2 人日）

### R2.1 新模块 `approval-broker.js`
- 失败测试：`test/approval-broker.test.mjs` 按 method 精确分派——
  `item/commandExecution/requestApproval` → payload 含 command/cwd/reason；
  `item/fileChange/requestApproval` → **payload 含 changes[]（path/kind/diff 截断）**；
  `item/permissions/requestApproval` → 权限描述；
  旧式 `applyPatchApproval`/`execCommandApproval` → 映射为同一信封结构并按 v1 格式回 `{decision}`；
  重复决议/已撤销决议幂等无副作用。
- 实现：从 `handleServerRequest` 抽出；信封 `approval_request` payload 扩展字段（向后兼容，旧字段不动）；审计日志落盘（NFR-8，owner-only 文件复用 `file-security.js`）。
- 前端：审批卡片渲染 diff/权限详情（现有卡片扩展，不改交互流）。

### R2.2 审批触发 Web Push（D5）
- 失败测试：`approval_request` 信封 → 断言 pushNotify 被调用（title 含"待审批"）；`approval_resolved` 不推。
- 实现：server.js `onEvent` 推送条件增加 `approval_request`。
- 验收：G2——锁屏收到审批推送 ≤30s（真机 smoke 复跑 `smoke-approval.js`）。

### R2.3 未知 item 降级 raw（D6）
- 失败测试：注入 `item/completed {type:'somethingNew'}` → 断言信封出 `raw_item`，不丢弃不崩溃。
- 实现：`handleItem` default 分支 emit `raw_item`（截断 payload）；前端 default 渲染折叠 JSON 卡片。

## 阶段 3：CI 协议防线（D4，~1 人日）

- `scripts/protocol-check.mjs`：`codex app-server generate-ts --out .protocol/stable` + `--experimental --out .protocol/experimental` → 与上次提交的产物 diff → 输出新增/删除/改名方法报告；映射表覆盖检查（`agent-appserver.js` 消费的每个通知名必须存在于导出产物，**D1 类事故在此拦截**）。
- `npm run protocol:check` 接入 CI；`.protocol/` 产物入库以便 diff。
- 升级 runbook：升级 CLI → 跑 check → 更新映射 → 四维度回归 → 真机 smoke。

## 4. 发布与回滚

- 每阶段独立分支 + PR，合并前提：全部既有 230 用例绿 + 新增用例绿 + Playwright 10 流程绿。
- 信封只增不改：任一阶段可单独回滚，前端旧版本兼容新桥。
- 阶段 1 优先级最高（D1 是升级 CLI 的阻塞项），建议在下次升级 codex-cli 前完成。

## 5. 完成定义（DoD）

1. D1-D8 全部关闭，差距评估文档更新状态
2. `handleServerRequest` 中不存在回 `{}` 的默认路径（代码审查断言）
3. 真机 smoke 三件套复跑通过：批准、拒绝、review
4. 《架构设计文档》§4.1 描述与代码一致，无需修订文档

## 6. 衔接（本计划之后）

按 PRD P0 顺序实施 FR-01 steer（依赖阶段 1 的终态适配）、FR-02 fork、FR-03 deviceCode 登录（依赖阶段 1 的 S→C 注册表）、FR-04 reasoning 全量流（依赖阶段 2 的降级机制）。
