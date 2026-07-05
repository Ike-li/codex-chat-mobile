# Codex Chat Mobile 场景验收矩阵

本文按场景验收，而不是按页面存在性验收。每个案例都记录四个结论维度：

- 功能等价：手机操作是否等价于桌面 Codex CLI 输入/输出流。
- 状态可见：运行中、排队、审批、退出码、错误原因、会话状态是否清楚。
- 失败可恢复：失败后是否能复制、重试、重连或恢复会话。
- 权限可控：审批、沙箱、工作目录、设备访问是否不被绕过。

## 本轮证据

- 2026-06-29 浏览器验收：`scripts/scenario-server.js` + 手机竖屏 390x844 + 横屏 844x390。
- 验证范围：真实前端、真实 Socket.IO、真实移动布局；后端为 Codex-like mock 事件流，不消耗真实 Codex 额度，不代表真实部署已经完成。
- 2026-06-29 真实浏览器 + 真实后端验收：`PORT=3230 WORK_DIR=/tmp/codex-ccm-browser-real CODEX_SANDBOX=read-only CODEX_APPROVAL_POLICY=on-request node server.js` + 手机竖屏 390x844。
  - 普通提示 `Reply with exactly REAL_BROWSER_OK.` 从 Web UI 进入真实 Codex app-server，Codex 输出气泡为 `REAL_BROWSER_OK`，状态回到 `idle`。
  - 快捷 `/status` 从 Web UI 进入同一真实 session，Codex 输出 `当前没有活跃目标或正在执行的任务。`。
  - 刷新页面模拟重连后，历史消息、真实 session 前缀 `019f1243`、`read-only/on-request` 状态均恢复。
  - 当前内置浏览器环境拒绝直接写剪贴板；UI fallback 显示只读 textarea，内容为最新 Codex 输出并已自动选中。
- 2026-06-29 真实浏览器 + 真实后端 `/review`：`PORT=3231 WORK_DIR=/Users/raylee/code/codex-chat-mobile CODEX_SANDBOX=read-only CODEX_APPROVAL_POLICY=on-request node server.js` + 手机竖屏。
  - `/review` 从 Web UI 进入真实 Codex session，header 显示 `read-only · on-request · q:0 · 019f124c · 0.137.0`。
  - Codex 输出真实审核结果：1 个 High（无 token 时未强制本地边界）和 2 个 Medium（push 动态导入、E2EE 身份承诺）；审核过程没有出现审批绕过。
  - 已按 High 结果修复：默认 `HOST=127.0.0.1`；无 `AUTH_TOKEN` 时拒绝非 loopback 绑定；HTTP/Socket 均要求 loopback socket + loopback Host。
  - 运行态验证：`HOST=0.0.0.0 AUTH_TOKEN=` 启动失败；`127.0.0.1` Host 访问 `/` 和 `/health` 为 200；伪 `Host: public.example.com` 访问 `/` 和 `/health` 为 403。
- 2026-06-29 软键盘布局补强：前端使用 `visualViewport` 同步 `--app-height` / `--keyboard-inset`；390x844 与 390x520（键盘弹起高度模拟）均确认输入框和发送按钮在视口内、quick actions 与 composer 不重叠。
- 2026-06-29 真实 Codex CLI smoke：
  - `node scripts/smoke-appserver.js /tmp/codex-ccm-appserver` 通过：真实 `codex app-server` 握手、thread/start、流式 delta、result，输出 `PONG`。
  - `node scripts/smoke-server.js` 通过：真实 Express + Socket.IO + CodexAppServerSession 全栈输出 `PONG`。
  - `node scripts/smoke-approval.js` 通过：真实审批请求出现，批准后 tool_result `ok:true exitCode:0 status:completed`，`/tmp/codex-ccm-approval/approve-me.txt` 内容为 `hi`。
  - `node scripts/smoke-approval-decline.js` 通过：真实审批请求出现，拒绝后 tool_result `ok:false status:declined`，无成功工具执行，`/tmp/codex-ccm-decline/decline-me.txt` 不存在。
- 自动测试：`npm test` 通过 178/178，Playwright E2E 10/10（2026-06-29 首轮为 42/42，套件后续扩充）。

## 案例 1：创建任务 + 恢复会话 + 审核结果

步骤：
1. 在手机视口打开 Web UI，确认工作目录、沙箱、审批策略和会话状态可见。
2. 新建会话，发送普通自然语言创建任务。
3. 断开并重连浏览器连接，使用 catch-up 恢复历史输出。
4. 发送 `/status` 和 `/review` 或等价审核请求，记录审核/结果输出。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 普通提示和斜线命令都按 Codex CLI turn 顺序发送 | 通过 mock 浏览器验收：普通任务生成 plan/diff；model/reasoning 控件均发送 `/model`；真实浏览器验收：普通提示输出 `REAL_BROWSER_OK`，`/status` 输出中文状态，`/review` 输出真实 Findings |
| 状态可见 | header 显示 cwd、sandbox、approval policy、queue、session、Codex 版本 | 通过 mock 浏览器验收；真实浏览器验收：header 显示 `/tmp/codex-ccm-browser-real · read-only · on-request · q:0 · 019f1243 · 0.137.0`，`/review` session 显示 `read-only · on-request · q:0 · 019f124c · 0.137.0` |
| 失败可恢复 | 重连后 catch-up 不重复、不丢近期历史 | 通过 mock 浏览器验收：场景服务重启后，页面仍保留创建任务、权限结果和失败历史；真实浏览器刷新后恢复 `REAL_BROWSER_OK` 与 `/status` 历史 |
| 权限可控 | 会话限定在 WORK_DIR 与当前 sandbox | 通过 mock 浏览器验收；真实浏览器/CLI smoke 均在受控目录运行；`/review` 在当前仓库以 `read-only/on-request` 运行；无 token 监听边界已修为 loopback-only |

## 案例 2：执行命令 + 触发权限 + 退出码可见

步骤：
1. 使用 read-only 或 workspace-write + on-request 策略启动服务。
2. 发送需要 shell 执行的任务，确认命令卡片出现。
3. 触发权限请求，先拒绝再批准或按测试脚本自动审批。
4. 记录命令实时输出、最终 status、exit code 和错误/成功摘要。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 审批前命令不执行；批准后才继续 | 通过 mock 浏览器验收；真实 `smoke-approval.js` 证明批准后才执行并创建文件 |
| 状态可见 | approval card、command status、exit code、stdout/stderr 可见 | 通过 mock 浏览器验收；真实批准 smoke 记录 `ok:true exitCode:0 status:completed` |
| 失败可恢复 | 拒绝/失败后可以复制输出并重试最近失败提示 | 通过 mock 浏览器验收失败/复制/重试；真实拒绝 smoke 记录 `status:declined` 且文件不存在 |
| 权限可控 | 权限请求通过 `user:approval` 回传，不存在隐藏自动批准路径 | 真实批准/拒绝 smoke 均证明审批请求先出现；拒绝后无成功工具执行且目标文件不存在；无 token 下非 loopback host/绑定被拒绝 |

## 案例 3：产生失败 + 重试恢复 + 长日志/移动体验

步骤：
1. 发送会失败的命令或任务，产生非零退出码。
2. 检查错误原因、失败状态、退出码和 retry 控制是否可见。
3. 通过 retry 恢复任务，再发送长日志输出，检查滚动、复制、横竖屏和软键盘布局。
4. 记录最终部署或审核结果；如未实际部署，记录审核结果作为验收输出。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 失败、重试、斜线命令与桌面 CLI 顺序一致 | 通过 mock 浏览器验收：失败提示重复发送后，失败原因出现两次 |
| 状态可见 | 错误原因、失败标识、重试入口、长日志滚动都可见 | 通过 mock 浏览器验收：`Command failed with exit code 1`、`status: failed`、`exit: 1`、retry 按钮、长日志滚动区域均可见 |
| 失败可恢复 | retry 保留原始失败提示，恢复后历史仍在 | 通过 mock 浏览器验收：retry 后原失败提示计数为 2；服务重启后历史仍在当前页面 |
| 权限可控 | 重试不会跳过原审批和沙箱策略 | 通过 mock 浏览器和真实拒绝 smoke：拒绝不会绕过审批执行；真实 `/review` 在 read-only/on-request 下完成 |

## 移动体验检查项

| 检查项 | 期望 | 当前证据 |
|---|---|---|
| 软键盘 | composer sticky，不遮挡发送/中断/快捷命令 | 已补 `visualViewport` 适配；390x844 与 390x520 键盘高度模拟下，输入框和发送按钮均在视口内且不与 quick actions 重叠；真机键盘仍需设备复核 |
| 缩放 | viewport 禁止意外缩放，控件可触摸 | 通过浏览器验收：390x844 下按钮与输入框可点击；页面 viewport 禁用缩放 |
| 长日志 | tool output 有独立滚动，高度受控 | 通过浏览器验收：80 行日志保留，`scrollHeight 1085 > clientHeight 179` |
| 复制 | copy 按钮复制最近 Codex 输出；剪贴板受限时提供可选中文本 | mock 浏览器验收：clipboard 读取到 `Command failed with exit code 1`；真实浏览器验收：直接写剪贴板被拦截时，fallback textarea 内容为 `当前没有活跃目标或正在执行的任务。` 且自动选中 |
| 滚动 | 新输出自动滚到底，历史仍可向上查看 | 通过浏览器验收：长日志完成后输出区独立滚动，页面历史仍保留 |
| 横竖屏 | 主要控件不重叠、不裁切 | 通过浏览器验收：390x844 与 844x390 下 header/messages/quick-actions/composer 均无垂直重叠 |

## 案例 4：文件上传 + 附件注入 + 安全落盘

步骤：
1. 在手机 Web UI 点击 📎 按钮，选择本地文件（文本/图片/代码）。
2. 附件预览托盘显示文件名和大小；可移除已选文件。
3. 输入提示文字并发送；服务端校验文件数量和大小。
4. codex 收到 prompt 包含 `[附件] 已上传到工作目录，可用 Read 读取：` 及绝对路径。
5. codex 用 Read 工具读取文件内容并据此回复。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 手机选文件 ≈ 终端拖文件进 codex 窗口 | 前端 📎 按钮 + FileReader → base64；后端 saveAttachments 落盘 + buildPromptText 注入路径 |
| 状态可见 | 附件名称、大小和预览可确认后再发送 | attach-tray 芯片显示文件名 + 估算大小 + ✕ 移除按钮 |
| 失败可恢复 | 超限文件（>10MB/单、>20MB/总量、>10 个）返回明确错误 | validateAttachments 拒绝并回错误信息到系统消息 |
| 权限可控 | 文件落盘到 WORK_DIR/.ccm-uploads/，0600 owner-only，路径不穿越 | O_NOFOLLOW + resolve 双重检查 + rejectableSymlinkComponent；toEventMeta 剥 absPath |

## 案例 5：状态栏实时信息 + git 上下文 + ctx 用量

步骤：
1. 启动服务在 git 仓库目录下，确认 header 下方 status-detail 行显示。
2. 观察项目名、沙箱模式、审批策略、git 分支名和变更数。
3. 发送任务后，观察 ctx token 用量随 codex 处理更新。
4. 多工作目录切换后，git 信息跟随变化。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 手机上看到的信息 ≈ 终端 `git status` + codex 状态 | statusline.js 采集 git symbolic-ref/status/diff/remote；agent.lastUsage 提供 ctx 用量 |
| 状态可见 | 一行显示 📁项目 · 🛡沙箱 · ⎇分支 Δ变更 · 📐ctx · sessionId · q:n · 状态灯 | status-detail DOM 实时更新 |
| 失败可恢复 | git 不可用时状态栏优雅缺席而非崩溃 | execGit 返回 null → git 段不渲染；cwd 无效时 catch |
| 权限可控 | 只暴露 cwd 和沙箱名，不泄露绝对路径细节 | project 只取末段名；sandbox/policy 只展示配置名 |

## 案例 6：历史浏览 + Codex 原生会话 + 跨端一致性

步骤：
1. 打开会话抽屉，确认列表同时显示服务端会话和 Codex 原生会话（📁 标签）。
2. 点击 Codex 原生会话条目，在聊天区加载该会话的历史消息。
3. 验证用户消息和 assistant 回复均可正确渲染。
4. 确认消息去重（相邻相同内容不重复显示）。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 手机上可查看所有 Codex 会话（含终端直接创建的） | history.js 递归扫描 ~/.codex/sessions/ + 解析 event_msg/response_item |
| 状态可见 | 会话列表显示标题、模型、日期、来源标识 | renderSessionList 显示 date · model · 📁 标签 |
| 失败可恢复 | 损坏/截断 JSONL 行不崩溃，返回空或部分结果 | JSON.parse 逐行 try/catch；missing file 返回 [] |
| 权限可控 | 只扫描 Codex 原生会话目录，不泄露其他路径 | 仅读取 ~/.codex/sessions/ 下文件 |

## 案例 7：多工作目录 + 实例切换 + 隔离

步骤：
1. 配置 WORK_DIRS 逗号分隔多个项目目录，重启服务。
2. header 显示工作目录下拉选择器，切换后会话列表刷新。
3. 在不同工作目录下各启动一个会话，确认 instances tab 栏显示。
4. 切换 tab 查看不同会话，确认事件不串扰。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 手机切目录 ≈ 终端 `cd /other/project && codex` | workdir-select 下拉 → session:list(cwd) → 会话列表按 cwd 过滤 |
| 状态可见 | 每个实例 tab 显示 busy/idle 状态灯和 sessionId 前缀 | renderInstanceTabs 渲染 ⚡busy/○idle + sessionId[:8] + + 新会话按钮 |
| 失败可恢复 | 切换目录后原会话不丢失，切回即可继续 | agents Map 保持所有实例；viewingInstanceId 只切换视图、不 dispose |
| 权限可控 | 不能切换到白名单外的目录 | routeCwd() 检查 workDirs.includes(cwd)，不在白名单回退 WORK_DIR |

## 案例 8：Web Push 离线通知 + Service Worker

步骤：
1. 配置 VAPID 密钥到 .env，重启服务。
2. 手机 Chrome/Safari 打开 Web UI，点击 🔔 订阅推送。
3. 发送任务并切到后台/锁屏。
4. turn 完成时收到系统推送通知，点击通知回到 Web UI。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | codex 任务完成时手机收到通知 ≈ 终端窗口一直在眼前 | server.js onEvent 中 result/error 类型触发 pushNotify；web-push 发送 VAPID |
| 状态可见 | 通知包含标题和状态摘要 | pushNotify('Codex 完成', status) → sw.js showNotification |
| 失败可恢复 | 过期订阅自动剔除，不影响其他设备 | pushNotify 捕捉 410/404 并 filter 失效 endpoint |
| 权限可控 | 推送仅通知完成状态，不泄露对话内容 | payload 只含 title + body 状态文本 |

## 案例 9：运行时模型切换 + 权限档切换

步骤：
1. header 右侧 model 输入框输入模型名并回车。
2. 确认 `/model <name>` 作为 turn 发送给 codex。
3. header 右侧 perm-select 选择 `on-request` / `unlessTrusted` / `never`。
4. 确认 `/approval-policy <value>` 发送给 codex。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 手机切换模型/权限 ≈ 终端 `/model` `/approval-policy` 命令 | model-input onchange → fill `/model <value>` → sendMessage；perm-select 同理 |
| 状态可见 | 当前模型和权限档在 header 可见 | model-input 显示当前值；perm-select 显示上次选择 |
| 失败可恢复 | codex 不支持的模型名返回错误，不阻塞后续操作 | codex 返回的错误经 error 事件投递到前端气泡 |
| 权限可控 | 权限档切换即时生效 | 下次 turn/start 透传新 policy |

## 案例 10：PWA 安装 + 全屏体验

步骤：
1. 手机 Safari/Chrome 打开 Web UI，「添加到主屏幕」。
2. 从主屏幕图标启动，确认全屏无浏览器地址栏。
3. 确认主题色、图标、应用名与 manifest 一致。
4. 确认 viewport-fit=cover 适配刘海屏。

判定记录：
| 维度 | 期望 | 当前证据 |
|---|---|---|
| 功能等价 | 独立应用体验 ≈ 原生 App（全屏、无地址栏） | manifest.webmanifest: display=standalone；apple-mobile-web-app-capable meta |
| 状态可见 | 应用名和图标与配置一致 | name: "Codex Chat Mobile"；short_name: "Codex"；icon.svg |
| 失败可恢复 | PWA 壳加载失败回退浏览器模式 | manifest/ meta 为渐进增强，不装也不影响浏览器使用 |
| 权限可控 | PWA 安装不改变安全边界 | Web Push 订阅需用户主动点击 🔔；SW 只处理 push 事件 |

## 尚未完成的验收

- 真机软键盘：浏览器视口验证不能完全替代 iOS/Android 软键盘弹起行为。
