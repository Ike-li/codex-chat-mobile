# codex-chat-mobile 需求文档（PRD）

> 生成模型：`claude-fable-5` ｜ 日期：2026-07-05 ｜ 版本：v1.0
> 上游依据：`docs/codex-app-server-接口地图-合并版-claude-fable-5+gpt-5-codex.md`（下称"接口地图"）
> 关联文档：`docs/technical-plan.md`（现状基线）、`docs/scenario-acceptance.md`（四维度验收）、《架构设计文档》

## 1. 背景与目标

**产品定位**：Terminal-equivalent —— 把 Codex CLI 的完整交互能力经 `codex app-server` 桥接映射到手机浏览器，使开发者离开工位后仍能发起、跟进、审批、纠偏 Codex 任务。

**现状**：基线已上线（流式对话、审批、多实例会话、断线续传、PWA/Web Push、设备认证），真机验收基于 codex-cli 0.137.0。本 PRD 定义在接口地图三层模型（A∩B1 稳定面 / B1∖A 无文档承诺 / B2∖B1 experimental）约束下的下一阶段需求。

**目标**（可量化）：
- G1 CLI 核心交互功能覆盖率 ≥90%（以接口地图 §9.1 矩阵 21 项为分母）
- G2 审批请求从产生到手机可操作 ≤3s（在线）/ ≤30s（Web Push 唤醒）
- G3 断线重连后历史零丢失、零重复（现有信封序列号机制延续）
- G4 升级 Codex CLI 版本时，协议不兼容问题在 CI 阶段暴露，而非线上

## 2. 用户与场景

单一用户画像：拥有本机/自托管开发机的 Codex CLI 重度用户（即项目所有者本人这类用户）。

| 场景 | 描述 | 关键需求 |
|---|---|---|
| S1 远程跟进 | 任务在桌面发起，人在外面用手机看进度 | 流式渲染、reasoning 可见、状态栏 |
| S2 远程审批 | Codex 请求执行命令/改文件，人不在电脑前 | Push 通知→弹窗→批准/拒绝，多端一致 |
| S3 移动发起 | 直接在手机上开新会话下达任务 | 会话管理、模型/策略选择、图片输入 |
| S4 运行纠偏 | 任务跑偏，不中断地追加指令 | `turn/steer`、`turn/interrupt` |
| S5 结果审读 | 手机上看 diff、review 结论、命令输出 | diff 视图、review 模式、长日志滚动 |

## 3. 范围与分期

接口选用规则（继承接口地图）：**P0/P1 只用 A∩B1；B1∖A 需降级容错；B2∖B1 一律 feature flag**。

### P0 补齐 MVP 缺口（本期必做）

| ID | 需求 | 接口 | 现状 |
|---|---|---|---|
| FR-01 | 运行中追加指令（steer） | `turn/steer` | ✅ 已实现；agent/socket 自动化验证 |
| FR-02 | 会话分叉 | `thread/fork`（含 `ephemeral`） | ✅ 已实现；agent/socket/UI 入口自动化验证 |
| FR-03 | 设备码登录，替代"先在桌面登录"前置条件 | `account/login/start` type=`chatgptDeviceCode`、`account/login/completed`、`account/updated` | ✅ 已实现；mock app-server 自动化验证，真实账号 smoke 待跑 |
| FR-04 | reasoning 全量流（现仅 summaryTextDelta） | `item/reasoning/textDelta`、`summaryPartAdded` | ✅ 已实现；summary/full reasoning 自动化验证 |
| FR-05 | 协议版本适配：移除对已删除通知的依赖 | 现网映射含新版 schema 已不存在的 `turn/failed`；改用 `turn/completed` 携带的终态 + `error` 通知 | ✅ 已实现；终态以 `turn/completed.status` 为准，`turn/failed` 仅保留一版本 legacy allowlist；`protocol:check` 验证 |
| FR-06 | 审批精确分派：按 method 区分命令/文件/权限审批，弃用 `/requestApproval/i` 正则 | `item/commandExecution\|fileChange\|permissions/requestApproval` + 旧式 `applyPatchApproval`、`execCommandApproval` 兜底 | ✅ 已实现；ApprovalBroker 精确分派并覆盖命令/文件/权限/工具输入/旧式审批 |
| FR-07 | 多端审批一致性：他端已决的弹窗自动撤销 | `serverRequest/resolved` | ✅ 已实现；`approval_revoked` 信封清理 pending 审批，前端幂等撤销 |

### P1 体验完善

| ID | 需求 | 接口 | 对账状态（2026-07-06） |
|---|---|---|---|
| FR-11 | 会话列表/归档/删除/重命名 UI | `thread/list\|archive\|unarchive\|delete\|name/set` | ✅ 已实现；bridge/socket/UI 控件与原生 thread 操作自动化覆盖，真机批量操作 smoke 待跑 |
| FR-12 | 上下文压缩与用量可视化 | `thread/compact/start`、`thread/compacted`、`thread/tokenUsage/updated` | ✅ 已实现；compact 入口、compacted 通知、usage/rate limit 信封已覆盖，真实长会话压缩 smoke 待跑 |
| FR-13 | 消息回退 | `thread/rollback` | ✅ 已实现；Socket.IO `thread:rollback` 与前端入口自动化覆盖，真实回退语义 smoke 待跑 |
| FR-14 | 模型/策略选择器（读能力矩阵） | `model/list`、`modelProvider/capabilities/read` | ✅ 已实现；读取模型列表与 provider capabilities 后展示/选择，真实账号模型矩阵 smoke 待跑 |
| FR-15 | 文件选择器（@ 提及） | `fs/readDirectory\|readFile`（只读）| ✅ 已实现；只读目录/文件读取与 `@path` 注入自动化覆盖，不开放写文件 |
| FR-16 | 账号/用量页 | `account/read\|usage/read\|rateLimits/read` + `rateLimits/updated` | ✅ 已实现；账号/用量/限流面板与更新通知覆盖，真实账号限流数据 smoke 待跑 |
| FR-17 | MCP/Skills 状态页（只读） | `mcpServerStatus/list`、`skills/list` | ✅ 已实现；只读 MCP/Skills 面板和通知信封覆盖，不开放 MCP tool call |
| FR-18 | CLAUDE.md/AGENTS.md 导入向导 | `externalAgentConfig/detect\|import` + 进度通知 | ✅ 已实现；detect/import 入口与进度/完成通知覆盖，真实迁移项 smoke 待跑 |

### P2 管理面（Admin 模式，二次确认 + 审计日志）

对账状态（2026-07-06）：✅ 已实现。P2 统一走 Admin unlock（`ENABLE ADMIN`）+ 每次 action 精确确认（`adminConfirm` 必须等于事件名）+ owner-only `admin-audit.jsonl` 审计日志；普通会话面不直接暴露危险协议方法。

| ID | 需求 | 接口 | 对账状态（2026-07-06） |
|---|---|---|---|
| FR-21 | 配置写入 | `config/value/write\|config/batchWrite` | ✅ 已实现；Admin-only Socket.IO contract、bridge 参数和审计覆盖，真实配置文件 smoke 待跑 |
| FR-22 | 插件/市场管理 | `plugin/install\|uninstall`、`marketplace/add\|remove\|upgrade` | ✅ 已实现；Admin-only 操作与审计覆盖，真实 marketplace/plugin smoke 待跑 |
| FR-23 | 文件写操作 | `fs/writeFile\|remove\|copy` | ✅ 已实现；绝对路径校验、Admin 二次确认和审计覆盖，真实文件破坏性操作需人工 smoke |
| FR-24 | MCP 工具直调 | `mcpServer/tool/call` | ✅ 已实现；要求显式 threadId/server/tool，参数不写入审计明文，真实 MCP 工具权限 smoke 待跑 |
| FR-25 | 登出 | `account/logout` | ✅ 已实现；Admin-only 登出入口和审计覆盖，真实账号 logout smoke 待跑 |

### P3 实验区（feature flag，默认关闭）

对账状态（2026-07-06）：✅ 已实现为默认关闭的 `CODEX_P3_EXPERIMENTAL=1` 实验面。当前 pin 的 `.protocol/stable/ClientRequest` 尚未导出 `process/spawn`、`thread/turns/list`、`thread/items/list`、`thread/search`、`thread/realtime/*` 启动请求或 `remoteControl/pairing/*` 请求，因此 P3 按可用协议做降级实现与状态跟踪，不伪造不存在的请求方法。

| ID | 需求 | 当前协议落点 | 对账状态（2026-07-06） |
|---|---|---|---|
| FR-31 | 网页终端 | `command/exec` + `command/exec/write\|resize\|terminate`，兼容 `command/exec/outputDelta` 与 `process/outputDelta\|exited` 通知 | ✅ 已实现；Labs 面板 + `term_*` 独立信封，不与聊天流混流；真实 PTY smoke 待跑 |
| FR-32 | 历史分页正规化 | `thread/read({includeTurns:true})` | ✅ 已实现降级读取 turns；当前无 `thread/turns/list` / `thread/items/list` 请求，分页正规化待协议补齐后替换 |
| FR-33 | 会话搜索 | `thread/list({searchTerm})` | ✅ 已实现降级搜索；当前无 `thread/search` 请求，结果仍复用 thread list 页 |
| FR-34 | 语音对话 | `thread/realtime/*` 通知 | ✅ 已实现 realtime 独立信封和前端状态渲染；当前无启动/音频输入请求，真实语音链路待协议补齐 |
| FR-35 | 官方配对跟踪 | `remoteControl/status/changed` 通知 | ✅ 已实现 remote-control 状态信封和前端提示；当前无 `remoteControl/pairing/*` 请求，替代自建通道仍待官方能力成熟 |

### 不在范围

`codex cloud` 云任务（不经 app-server）、`codex exec` 批处理（等价物：ephemeral thread）、TUI 本地渲染细节、OS 级沙箱实现（UI 仅透出策略选择）、多租户/公网 SaaS 化。

## 4. 非功能需求

| ID | 需求 | 指标 / 对账状态（2026-07-06） |
|---|---|---|
| NFR-1 流式延迟 | delta 通知到达网关 → 手机渲染 | 🟡 流式链路已实现；P95≤300ms 尚缺实测报告 |
| NFR-2 断线恢复 | 重连 catch-up | ✅ 信封 seq/epoch 与 `eventsSince` 自动化覆盖；≤2s 仍需真机弱网 smoke |
| NFR-3 审批时效 | 见 G2 | 🟡 Web Push 覆盖审批/工具输入；在线≤3s/Push≤30s 尚缺计时 smoke |
| NFR-4 安全边界 | 无 token 仅 loopback 监听（现状保持）；浏览器永不直连 app-server ws（Origin 403 + unsupported）；审批不存在隐藏自动批准路径 | ✅ 自动化覆盖 loopback/token/拒绝路径；真实拒绝 smoke 脚本保留 |
| NFR-5 兼容性 | CI 协议导出 diff，未知 item type 降级为 raw 卡片不崩溃 | ✅ `.protocol/stable` + `npm run protocol:check` 覆盖；`turn/failed` 仅 legacy allowlist |
| NFR-6 背压 | 收到 `-32001` 指数退避重试并向 UI 透出拥塞态 | ✅ 已实现；JSON-RPC request 层最多 5 次指数退避，发 `system`/`status` 拥塞提示，超限失败可见 |
| NFR-7 移动体验 | PWA 可安装、长日志虚拟滚动、弱网可用 | 🟡 PWA/长日志/键盘布局有自动化或场景验收；弱网真机 smoke 待跑 |
| NFR-8 可观测 | 网关记录 JSON-RPC 出入日志（脱敏）、审批审计日志 | ✅ 已实现；审批审计与通用 JSON-RPC 脱敏 JSONL 均 owner-only 落盘，status 暴露 `rpcStats` 计数；日志保留/轮转策略后续按运维需要补充 |

## 5. 依赖与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| B2∖B1 experimental 接口变更无告知 | P3 功能破裂 | feature flag + CI diff（NFR-5）|
| 已观测到通知增删（如 `turn/failed` 消失） | 事件映射失效 | FR-05 + `.protocol/stable` pin 与 `protocol:check`；`turn/failed` 仅 legacy 双轨兼容 |
| B1∖A 无文档承诺（如 `item/fileChange/patchUpdated`） | diff 视图退化 | 降级路径：`turn/diff/updated` 全量 diff |
| 官方 `remoteControl` 配对成熟 | 自建通道重复建设 | FR-35 持续评估，架构上把"浏览器↔网关"通道做成可替换层 |
| deviceCode 登录依赖 ChatGPT 侧流程 | FR-03 真实链路 smoke 仍需人工账号操作 | 自动化使用 mock app-server 覆盖 request/notification/UI；保留 apiKey 登录与"桌面预登录"兜底 |

## 6. 验收方式

延续 `docs/scenario-acceptance.md` 四维度判定（功能等价 / 状态可见 / 失败可恢复 / 权限可控）：每个 FR 必须给出 mock 浏览器 + 真机双证据；P0 完成时新增场景案例：S4 纠偏（steer 后 agent 输出反映新指令）、FR-03 登录（无桌面前置条件冷启动）、FR-07 多端（两浏览器并发审批一次决议）。

**P0/P1/P2/P3 自动化验证状态（2026-07-06）：** FR-01–FR-07、FR-11–FR-18、FR-21–FR-25、FR-31–FR-35 已通过 agent/socket/public-ui/protocol focused tests；NFR-6 背压退避、NFR-8 JSON-RPC 脱敏观测已补充 focused test。完整门禁以本地最终执行结果为准。FR-03 的真实 ChatGPT device-code 账号流程、P1/P2/P3 原生 app-server 真机操作、真机多端审批撤销、真机弱网/PWA smoke 未由自动化替代，仍需人工输入设备码或连接真实 Codex 环境后验证。
