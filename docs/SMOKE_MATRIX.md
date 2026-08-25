# 最小浏览器冒烟

把 Web 端每个用户可达的功能拆成一次最小的浏览器操作序列，给出可机器判定的通过判据。

它和别的文档的分工：`docs/WEB_UI_MAP.md` 说页面有哪些区域，`docs/CAPABILITY_MATRIX.md` 说能力的条件与边界，`docs/TESTING.md` 的 TC-\* 是人工验收断言。这份补的是**「怎么用浏览器一步步验证，以及凭什么算通过」**。

## 怎么用

两种后端都能跑，选一种：

| | mock（推荐日常回归） | 真实 Codex |
|---|---|---|
| 启动 | `node scripts/mock-server.js` | `npm start` |
| 地址 | `http://localhost:3232` | `http://127.0.0.1:3001` |
| 认证 | 无（`AUTH_TOKEN=''`） | 需 `AUTH_TOKEN`，或置空后仅 loopback |
| 额度 | 零 | 每条真实 turn 都消耗 |
| 触发方式 | 固定剧本关键词 | 自然语言指令 |

矩阵里「操作序列」列同时给出两种触发输入。mock 的剧本关键词见 `scripts/mock-codex-app-server.js`：`SLOW_TURN`、`FILE_CHANGE_FIXTURE`、`MARKDOWN_FIXTURE`、`RICH_MARKDOWN_FIXTURE`、`REASONING_STREAM_FIXTURE`、`TURN_GROUP_FIXTURE`、`SCROLL_STREAM_FIXTURE`、`PRE_ACK_STREAM`、`approve`。

执行者可以是人，也可以是浏览器自动化（Playwright 或 Claude 的浏览器工具）。

### 三个必须知道的执行陷阱

1. **用 `textContent`，不要用 `innerText`。** 消息刚渲染完时 `innerText` 会因布局未完成返回空串，导致断言假失败。本次实跑就被这个坑过一次。
2. **thread 列表要等。** 抽屉首次打开时 `thread:list` 还在路上，等 700ms 会拿到 0 行。至少轮询到 `.session-item` 出现再断言。
3. **点击可能要 JS 降级。** 若 CDP 的 `Input.dispatchMouseEvent` 不可用（本次实跑环境即如此，连续 30s 超时），退到 `element.click()`。它走同一个 onclick，验证得了功能逻辑，**验证不了遮挡、`pointer-events` 和 hit-testing**。用了降级的用例在「备注」列标 `JS 降级`。键盘输入不受影响，`type` / `Return` 是真实事件。

## 判据约定

**判据一律是形态断言，不断言模型输出内容。** 真实 Codex 的回复不可预测，断言「回复里包含某个词」必然不稳。所以判据写成「出现 `.msg.codex` 且 `#state-label` 回到 `idle`」这种结构性条件。

涉及副作用的用例（审批批准/拒绝）例外：必须去文件系统实地核对，这是安全语义唯一的最终防线，参考 `scripts/smoke-approval-decline.js`。

状态判据的三个锚点：

- `#state-label`：`idle` / `running` / `awaiting approval`
- `#send-btn[data-mode]`：`send` / `stop`
- `.selected` class：列表项的选中态（**不要用 `.popover-item-check`，每一项都有它，靠 CSS 控制可见性**）

## 功能单元矩阵

「E2E 重叠」列指出哪个 Playwright spec 已覆盖同一功能 —— 重叠不是浪费，浏览器冒烟验证的是真实用户可达性，E2E 验证的是回归。

### A. 入口与连接

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-A1 | 口令登录门 | 配置 `AUTH_TOKEN` → 打开页面 → 在 `#auth-token-input` 输入 → `#auth-submit` | `#auth-gate` 消失，主界面可见；错误口令时 `#auth-error` 有文案 | 无 | **仅手工**。凭据输入不自动化 |
| SM-A2 | 设备配对 | 从非 loopback 地址连接 → 服务端 `#pending-panel` 出现 → 批准 | 待批设备解锁，`device_status` 转 approved | 无 | **仅手工**，需第二台设备 |
| SM-A3 | 连接横幅与状态点 | 打开页面等待连接 | `#conn-banner` 已连接时 `hidden`；`#status-dot` class 含 `connected`；`#conn-rtt` 形如 `延迟 Nms` | `header-layout.spec.js` | 有 `data-testid="conn-banner"` |
| SM-A4 | 空态四建议卡 | 新建 thread | `#empty-state` 可见；`.suggestion-card` 恰好 4 张，各有 `data-prompt` | `workspace-and-composer.spec.js` | 点卡片会直接发消息 |

### B. Composer 与发送

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-B1 | 文本发送与流式 | 聚焦 `#msg-input` → 键入文本 → `Return` | 输入框清空；`.msg.user` +1；随后 `.msg.codex` 出现；`#state-label` 回 `idle` | `critical-flows.spec.js` | 全程真实键盘，无需降级 |
| SM-B2 | 停止/中断 | 运行中点 `#send-btn`（此时 `data-mode="stop"`） | 出现「已中断」；`#state-label` 回 `idle`；`data-mode` 回 `send` | `critical-flows.spec.js` | spinner 用 `style.display` 控制，**别断言它的 `hidden` 属性**（那永远是 false） |
| SM-B3 | 运行中追加（steer） | 运行中在输入框键入内容 → 点 `#followup-btn` | 输入框清空；`.msg.user` +1；`#state-label` 仍为 `running`（是 steer 不是新 turn） | `critical-flows.spec.js` | **前置：必须运行中且输入框有内容**，否则按钮 `hidden` |
| SM-B4 | 斜杠命令面板 | 输入框键入 `/` | `#slash-popup` 可见；`.slash-item` 覆盖 `/help /status /plan /diff /review /compact /permissions` | `popovers-and-shortcuts.spec.js` | 真实键盘触发 |
| SM-B5 | @ 文件引用 | 输入框键入 `@` + 关键字 | `#at-mention-popup` 可见；`.at-mention-item[data-path]` 非空 | `workspace-and-composer.spec.js` | 真实后端命中数远多于 mock |
| SM-B6 | 附件选择与移除 | `#file-input` 喂 `DataTransfer` → 触发 `change` → 点 `.attach-chip-remove` | 出现 `.attach-chip` 带文件名与大小；`#send-btn` 转可见；移除后 `#attach-tray` 隐藏 | `attachments-and-layout.spec.js` | 原生 file chooser 驱动不了，只能喂 `DataTransfer`；移除后 chip 元素仍残留在 DOM |
| SM-B7 | 跳到最新 | **流式输出期间**向上滚动 `#messages` | `#jump-to-latest` 可见；点击后回到底部 | `critical-flows.spec.js` | **静止时上滑不会出现该按钮**，前置必须是流式期间 |

### C. 会话设置

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-C1 | 设置面板开关 | 点 `#composer-defaults` → 点 `#session-settings-close` | `#session-settings` 由 `display:none` 转可见再转回 | `popovers-and-shortcuts.spec.js` | JS 降级 |
| SM-C2 | 对话/计划模式 | `#mode-list` 选 `[data-mode="plan"]` 再选回 `default` | `#mode-trigger-text` 在「计划」「对话」间切换；胶囊文案同步 | `popovers-and-shortcuts.spec.js` | JS 降级。切换只改本地显示：`thread/settings/update` 在 codex-cli 0.142.5 上一律被拒（见「上游限制」），会走 deferred 降级而不报错 |
| SM-C3 | 审批策略与沙箱 | `#approval-list` / `#sandbox-list` 点选 | 点选项获得 `.selected`；`localStorage.codex_cli_settings` 写入对应字段；胶囊文案同步 | 无 | JS 降级。**未点选前列表无任何 `.selected`，而胶囊已显示服务端默认值** |
| SM-C4 | 模型选择 | `#model-list` 点选 `[data-model]` | `#model-trigger-text` 更新；`codex_cli_settings.model` 写入 | `popovers-and-shortcuts.spec.js` | JS 降级 |
| SM-C5 | 思考强度与服务档位 | `#reasoning-list` / `#speed-list` 点选 | `[data-reasoning]` 四档齐全且当前档带 `.selected`；`#speed-section-label` 为「服务档位」 | 无 | JS 降级 |

### D. 抽屉与 Thread

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-D1 | 抽屉开合 | 点 `#menu-btn` → 点 `#drawer-overlay` | `#drawer` 获得再失去 `.open`；`.drawer-project-block` 非空 | `instances.spec.js` | JS 降级 |
| SM-D2 | 目录树展开态 | 点 `.dir-toggle` → 刷新页面 | `.dir-subtree` 切换 `.expanded`；`localStorage.codex_expanded_dirs` 跨刷新保持 | 无 | JS 降级。折叠会连带隐藏该项目下的 thread 列表 |
| SM-D3 | Thread 列表 | 打开抽屉，**轮询等待** `.session-item` | 行数非空；当前 thread 带 `.active`；`.thread-status-dot` 反映 `idle`/`not-loaded`；每行有 Rename/Archive/Delete | `instances.spec.js` | 首开需等 `thread:list` 返回，勿用固定短延时 |
| SM-D4 | 新建会话入口 | 检查四个入口存在 | `#new-session-btn` `#drawer-fab-new` `#header-new` `#header-home` 均存在；`.dir-new` 每个项目一个 | `header-layout.spec.js` | — |

### E. 顶栏与工作区

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-E1 | 顶栏项目与改动徽标 | 观察顶栏 | `#header-project` 显示目录名；`#header-changes` 显示改动数；`#conn-rtt` 显示延迟 | `header-layout.spec.js` | 徽标数含未跟踪文件，与 `git status` 未暂存数可不等 |
| SM-E2 | 工作区面板 | 点 `#header-context` → 切 `#workspace-tab-changes` → 点一个改动行 | 文件 tab：`.workspace-row[data-kind][data-path]` 非空；改动 tab：`#git-changes-branch` 显示分支，行用 `[data-git-path][data-git-side]`；点开后 `.diff-add`/`.diff-del` 出现 | `workspace-and-composer.spec.js` | JS 降级。**两个 tab 的 dataset 命名不同**。mock 的工作区不是 git 仓库，改动 tab 只有真实后端能验 |

### F. 转录渲染

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-F1 | Markdown 与代码块 | 发送会产生 Markdown 的指令（mock：`MARKDOWN_FIXTURE`） | 出现 `.bubble.md`；代码块包在 `.code-block-wrap` 内且有 `.code-copy-btn` | `markdown-typography.spec.js` | 流式期间保持纯文本，完成后才渲染 |
| SM-F2 | Reasoning 折叠 | 发送需要推理的指令（mock：`REASONING_STREAM_FIXTURE`） | 出现 `.reasoning-card`，`.reasoning-fold` 默认收起，点 `.reasoning-toggle` 展开 | `critical-flows.spec.js` | 真实 Codex 经 `item/started\|completed` 送 `type:"reasoning"` 的 item，且 `summary`/`content` 均为空——推理文本根本不下发。因此真实后端下**不会有 reasoning 卡，也不该有 Raw 卡**；本条只能在 mock 上验证 |
| SM-F3 | 命令卡与退出码 | 触发一次命令执行 | 出现 `.tool-card.command-card`；`.tool-exit` 显示 `exit: N`；成功为 `.tool-output.tool-ok`，失败为 `.tool-err` | `rich-event-rendering.spec.js` | mock 永远 `exit: 0`，非零退出码只有真实后端能验 |
| SM-F4 | 文件变更卡 | mock：`FILE_CHANGE_FIXTURE`；真实：让 Codex 修改文件 | 出现 `.tool-card.file-change-card`，含路径与变更类型，可展开 diff | `rich-event-rendering.spec.js` | 真实后端下依赖模型主动走 apply_patch，不易稳定构造 |

### G. 审批与 needs-you

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-G1 | 审批批准与真实副作用 | 设 `approval=on-request` + `sandbox=read-only` → 让 Codex 写文件 → 点 `.approve-btn[data-d="accept"]` | `#state-label` 先转 `awaiting approval`；批准后卡片显示「已批准」，出现 `exit: 0`；**去文件系统确认文件确实被创建** | `critical-flows.spec.js` | JS 降级。批准即授权覆盖沙箱：`read-only` 下批准后仍会写入 |
| SM-G2 | 审批拒绝与副作用不发生 | 同上但点 `.deny-btn` | 卡片显示「已拒绝」；出现 `.tool-output.tool-err`；**去文件系统确认文件未被创建** | `rich-event-rendering.spec.js` | JS 降级。安全语义的最终防线，mock 验不了 |
| SM-G3 | 跨 thread needs-you | 审批挂起时观察顶部面板 | `#needs-you-panel` 可见，`.needs-you-row` 计数正确，有 `[data-need-action="open"]`；决议后行数归零 | `needs-you-recovery.spec.js` | 决议后自动撤销 |

### H. 可靠投递

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-H1 | 送达状态气泡 | 制造一条发送失败的消息 | 被拒记录显示 `.offline-label` 文案「已被运行时拒绝」并带 `.outbox-discard-btn`；后续消息显示「弱网等待同步」 | `outbox-recovery.spec.js` | 被拒记录会按序阻塞同 thread 后续消息，这是保序设计 |
| SM-H2 | 手工处置卡死记录 | 点 `.outbox-discard-btn` → `#confirm-ok` | 记录从 IndexedDB 移除，气泡消失；**被阻塞的后续消息立即发出** | `outbox-recovery.spec.js` | JS 降级。outbox 按 thread 隔离，需切到对应 thread 才看得到 |
| SM-H3 | 刷新后历史重建 | 有内容的 thread 上刷新页面 | thread 标题恢复；`.msg.user` 与 `.msg.codex` 文本重建 | `workspace-and-composer.spec.js` | **工具卡不重建，且这是上游限制**：`thread/read` 即使 `itemsView:"full"` 也只返回 `userMessage`/`agentMessage`/`fileChange`，从不返回 `commandExecution`/`reasoning`。命令卡与审批卡无法重建，客户端改不了 |

### I. 通用对话框

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-I1 | 确认/输入对话框 | 触发任一危险操作 | `#confirm-modal` 打开，`#confirm-title`/`#confirm-body` 有文案，危险操作 `#confirm-ok[data-danger="true"]`，取消与确定两个按钮 | `outbox-recovery.spec.js` | JS 降级 |

### J. 条件可达

| 编号 | 功能单元 | 操作序列 | 通过判据 | E2E 重叠 | 备注 |
|---|---|---|---|---|---|
| SM-J1 | Web Push 订阅 | 打开抽屉查看 `#push-subscribe-btn` | 未配 VAPID 三件套时保持 `hidden`；配齐且 HTTPS 且设备已批准时可见可点 | 无 | 订阅与推送投递需 HTTPS，**仅手工** |
| SM-J2 | PWA 与 Service Worker | 读 `/manifest.webmanifest`，查 `navigator.serviceWorker` | manifest 的 `display` 为 `standalone`、`start_url` 为 `/`、图标非空；SW 已激活且 scope 为 `/` | `pwa-sw.spec.js` | 安装为独立应用需安全上下文 |
| SM-J3 | Labs 默认关闭 | 打开抽屉查看 `#native-p3-btn` | `CODEX_P3_EXPERIMENTAL=0` 时 `hidden` | `feature-flags.spec.js` | 开启后的行为只有单测覆盖 |
| SM-J4 | Admin 默认关闭 | 打开抽屉查看 `#native-admin-btn` | `CODEX_ADMIN_ENABLED=0` 时 `hidden` | `feature-flags.spec.js` | 解锁需短语 `ENABLE ADMIN` 且逐操作确认 |

## 非用户可达

这一节存在的意义：**别把 `dispatchEvent` 的绿灯当成用户可用。**

| 编号 | 对象 | 事实 |
|---|---|---|
| SM-K1 | `#drawer-tools` 九键 | 容器 `#drawer-tools` 硬编码 `hidden`（`public/index.html`），`app.js` 从不解除。Threads / Compact / Rollback / Models / Files / Account / MCP / Skills / Import 九个按钮**自身** `display:block`、`hidden:false`，但 `offsetParent` 全为 `null` —— 真人和浏览器自动化都点不到。`e2e/native-controls.spec.js` 用 `dispatchEvent` 绕过遮挡才点得动。这九项只能冒烟「存在且不可达」 |

三个只用于负向断言的选择器，别当可用控件：`#interrupt-btn`、`#instance-tabs`、`#native-controls-toggle`，三者 `querySelectorAll` 均应为 0。

需要人工完成、不进自动化的：SM-A1（凭据输入）、SM-A2（第二台设备）、SM-J1 的订阅与投递（HTTPS）。

## 最近一次实测

- 日期：2026-08-25
- 后端：真实 Codex（`codex-cli 0.142.5`，`.codex-version` 一致），`127.0.0.1:3001`，`AUTH_TOKEN` 临时置空
- 驱动：Claude 浏览器工具。键盘为真实事件；点击因 `Input.dispatchMouseEvent` 连续超时而全部 JS 降级
- 结果：34 条中 **26 条通过**、**5 条带保留通过**、**1 条无法验证**、**2 条仅手工未跑**

带保留或未过的：

| 编号 | 现象 |
|---|---|
| SM-B7 | 静止上滑时 `#jump-to-latest` 不出现，只在流式期间可见 |
| SM-C3 | 未点选前审批/沙箱列表无 `.selected`，胶囊却已显示服务端默认值 |
| SM-F2 | 真实 Codex 的 reasoning 落入 `raw_item` 兜底，渲染成「🧾 Raw」 |
| SM-F4 | 本次未能稳定触发，未验证 |
| SM-H3 | 文本重建正常，但 `.tool-card` 全部丢失（刷新前 8 个 → 刷新后 0 个） |
| SM-B6 | 移除附件后 tray 隐藏，`.attach-chip` 元素仍残留在 DOM |

实测中暴露的问题，**已逐条核实并处理**：

| 现象 | 核实结论 | 处理 |
|---|---|---|
| `collaborationMode` 让 `turn/start` 报 `missing field \`model\`` | 真缺陷。`.protocol/stable/v2/TurnStartParams.ts` 里**没有这个字段**，多带一个未知字段会让整体反序列化失败并回报一个指向别处的错误 | 已修：`buildTurnStartOverrides` 不再输出它 |
| 首次发送不带 model override，回落到 `gpt-5.6-sol` 并 400 | 真缺陷。显示层有服务端 fallback（胶囊、模型列表），发送层用裸的 `selectedModel`（空串） | 已修：新增 `effectiveComposerSettings`，显示与发送共用同一份有效设置 |
| 审批/沙箱列表无 `.selected` | 与上一条同源 | 已修（同上） |
| reasoning 落入 `raw_item`，显示「🧾 Raw」 | 真缺陷。`handleItem` 不认 `type:"reasoning"` | 已修：新增 reasoning 分支；因真实 item 不带文本，效果是消除空的噪音卡 |
| 移除附件后 `.attach-chip` 残留 | 真缺陷。空态分支直接 return，不清 DOM，残留 chip 还带着指向旧下标的闭包 | 已修：空态先清空再隐藏 |
| 刷新后工具卡全丢 | **不是客户端缺陷**，见 SM-H3 | 不修，已在矩阵里写明上游限制 |
| 中断后 spinner 未隐藏 | **原判定有误**：它用 `style.display` 控制，`hidden` 属性本来就恒为 false | 不修，已在 SM-B2 备注纠正 |

### 上游限制（客户端改不了，勿当缺陷重复排查）

1. **`thread/read` 不返回工具类 item。** 即使 `itemsView` 为 `full`，也只有 `userMessage` / `agentMessage` / `fileChange`。命令卡、审批卡、`exit:` 在刷新后无法重建。
2. **`thread/settings/update` 无法用局部参数调用。** 它不在 stable v2 协议里（`protocol:check` 将其列入实验白名单），仓库中没有它的 params 契约；codex-cli 0.142.5 要求完整的 `ThreadSettings`，而 `thread/read` 并不返回 settings，客户端无从构造。因此「对话/计划」模式切换只改本地显示，不会下发到 app-server —— 该调用已被判为「形态不受支持」并走 deferred 降级，不再把红错误抛给用户。
3. **真实 reasoning item 不携带文本。** `summary` 与 `content` 都是空的，推理内容不下发。
