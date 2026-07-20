# Web 界面地图

本文是页面区域参考。它说明每个区域显示什么、可以点击什么，以及操作后影响哪个 thread 或设备视图。

## 页面区域总览

```text
┌ 顶部状态区：菜单 / thread 标题 / 模式 / cwd / 账号 / 连接状态 ┐
├ Thread 与实例区：活跃 runtime 标签 / Fork / 新建              ┤
├ Needs-you：跨 thread 审批和提问聚合                           ┤
├ 消息区：用户、助手、reasoning、工具、diff、审批、结果         ┤
├ 输入区：附件 / 权限 / 模型 / 文本 / 发送或中断                ┤
└ 左侧抽屉：历史 thread、原生控制、工作区、Admin/Labs 条件入口 ┘
```

页面上显示的 session/thread 状态属于当前 Socket 视图；切换标签不会改变另一台设备正在查看的 runtime。

## 顶部状态区

顶部包含：

- 菜单按钮：打开左侧抽屉；
- thread 标题和状态点：running、needs-you、error、not-loaded 等；
- Chat/Plan 模式入口；
- session meta：cwd、thread 和连接信息；
- 可展开状态详情：sandbox、approval、queue、context 等；
- 工作区选择器：仅显示 `WORK_DIR`/`WORK_DIRS` allowlist；
- 账号登录按钮；
- Socket 连接状态点。

点击标题区域可展开或收起状态详情。host-scope `thread/status/changed` 能更新未加载 thread 的状态，但不会为它创建 runtime。

## Thread 与实例区

横向标签代表当前 gateway 中的活跃 `ThreadRuntime`：

- 点击标签：只切换本设备当前 Socket 的视图；
- `⎇`：Fork 当前 thread，返回新的 thread 和 instance；
- `+`：创建 provisional instance，首次发送后绑定新 thread；
- 标签状态：显示 busy、idle、needs-you 或错误状态。

instance 是网关运行时视图，不是历史事实源。历史中的 thread 可以暂时没有活跃 instance。

## 消息区

消息区可能显示：

| 卡片 | 内容 |
|---|---|
| 用户消息 | 文本、附件/skill 元数据和发送状态 |
| 助手消息 | 流式 text delta |
| Reasoning | summary 或 full reasoning |
| 命令/工具 | 输入、实时输出、状态和 exit code |
| MCP/Search | 调用参数摘要和结果 |
| File change/Diff | 文件列表、change kind 和 diff |
| Plan | 当前 turn 的步骤计划 |
| Approval | 批准或拒绝操作 |
| User input | 选项或自由文本回答 |
| Result/Error/System | turn 终态、错误和网关提示 |
| Raw item | 未识别协议 item 的可见兜底 |

消息只渲染到匹配当前 instance/thread 的视图。切换 thread 后，页面通过原生历史或 runtime buffer 构建对应内容。

## 输入区

输入区包含：

- `+`：选择附件；
- 权限入口：请求批准、风险批准、完全访问或自定义；
- 模型/reasoning/speed 入口；
- 文本框：普通内容和 `/` 命令；
- `↑`：发送；
- `■`：有活跃 turn 时精确中断。

附件先显示为可删除 chip。Skills 面板选择的 skill 也会作为下一条消息的结构化 chip。发送成功前，消息已进入 IndexedDB outbox；清空输入框不等于服务端已经执行。

## 左侧抽屉

抽屉包含：

- 新会话和原生 thread 列表；
- thread 的打开、重命名、Archive/Unarchive 和删除操作；
- Threads、Compact、Rollback、Models、Files、Account、MCP、Skills、Import；
- 浮动新建按钮；
- 配置多个工作区时的工作区切换。

只读控制面返回 app-server 原生数据。Files 只允许读取目标 workspace 范围；Import 先检测迁移项，再由用户选择导入。

## 条件入口

以下入口不会默认出现：

- Push：需要 HTTPS、VAPID、有效 session、已批准设备和浏览器权限；
- Labs：需要 `CODEX_P3_EXPERIMENTAL=1`；
- Admin：需要 `CODEX_ADMIN_ENABLED=1`，随后还需限时 unlock 和逐动作确认；
- 远程 image URL：需要 `CODEX_ALLOW_REMOTE_IMAGES=1`，并通过公网 DNS/SSRF 校验。

入口不可见通常表示服务端没有启用对应 feature，不是页面加载失败。完整能力与条件见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)。
