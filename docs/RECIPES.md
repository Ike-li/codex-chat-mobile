# Web 端任务配方

本文提供可以直接照做的操作配方。每个配方都包含前提、操作、预期结果和失败处理。

## 分析一个项目

前提：当前工作区已进入 `WORK_DIR`/`WORK_DIRS` allowlist。

1. 新建 thread；
2. 权限选择“请求批准”或只读 sandbox；
3. 输入：`只读分析项目结构、主要入口、测试方式和风险，不要修改文件。`；
4. 点击发送。

预期：页面显示 reasoning、可能的只读工具卡片和结构化总结。状态栏显示当前 cwd/thread。

失败处理：如果 cwd 不正确，先从工作区选择器切换；如果 Files/工具返回越界错误，不要扩大 allowlist，先确认目标目录。

## 修改代码并检查 Diff

1. 在独立 thread 中描述一个小而明确的改动；
2. 要求“先写失败测试，再最小实现”；
3. 处理出现的命令或文件审批；
4. 查看命令 exit code、file change 和 diff 卡片；
5. 输入 `/diff` 检查累计变更；
6. 输入 `/review` 要求审查当前修改。

预期：测试先失败再通过，文件修改只发生在目标 workspace，diff 卡片与最终总结一致。

失败处理：命令卡片非零退出时先读 stderr；不要在结果未知状态下直接重新发送同一写操作。

## 处理审批和提问

1. 在 needs-you 聚合区打开待办；
2. 核对 thread、命令/变更和可选决议；
3. 点击批准、拒绝，或填写答案；
4. 等待 ACK 后再关闭页面。

预期：卡片变为已处理；另一设备同步撤销旧入口；命令批准后显示真实输出和 exit code。

失败处理：`duplicate` 表示同一决议已成功；`already_resolved` 表示已由其他设备处理；`stale_target` 表示目标失效，不要绕过它重发审批。

## 在运行中补充要求或中断

补充要求：在 turn 仍 running 时直接发送，例如：`先不要改认证模块，只处理 UI。`。app-server 支持时会 steer，否则进入当前 runtime 队列。

中断：点击 `■`。中断只针对当前 instance/thread/turn，不影响其他标签。

预期：状态从 running 转为 interrupt/result/error；队列状态同步更新。

失败处理：如果返回 `stale_target`，先刷新当前 thread 状态，不要对旧 turn ID 重试。

## 跨 Codex App 与 Web 续接

1. 在 Codex App 或 Web 创建并发送一轮消息；
2. 在 Web 抽屉点击 Threads；
3. 找到目标 thread 并打开；
4. 核对标题、cwd 和历史；
5. 发送下一条消息。

预期：历史来自 `thread/read`，首次继续时通过 `thread/resume`；双方看到同一原生 thread。

失败处理：确认两端使用同一 Codex home/account 和 workspace；不要查找 `sessions.json` 或 JSONL fallback，它们不是当前事实源。

## 上传文件、使用 Mention 和 Skill

上传文件：

1. 点击 `+`；
2. 选择最多 10 个、单个不超过 10 MiB、合计不超过 20 MiB 的文件；
3. 检查附件 chip；
4. 输入任务并发送。

PNG 经内容验证后发送为 `localImage`，其他文件发送为 `mention`。

使用 skill：打开 Skills，选择服务端返回的 enabled skill，然后发送任务。服务端会在发送前再次校验 skill。

使用 workspace mention：只选择当前 runtime cwd 内的真实路径。越界路径会被拒绝。

失败处理：附件类型错误、base64 错误、大小超限和路径越界都会返回明确 ACK，不应进入未知执行状态。

## 安全恢复结果未知的消息

当消息显示“结果未知，正在核对；不会自动重发”时：

1. 保持页面在线，等待 `message:reconcile`；
2. 有稳定 thread 时，系统会通过 `thread/read` 查找原 `clientRequestId`；
3. 如果找到，outbox 清除并恢复正常气泡；
4. 如果仍无法确认，判断重复副作用是否可接受；
5. 只有确认后才点击“确认后重试”。

预期：确认重试会生成新 ID，并保存旧 ID 为 retry provenance。旧请求不会复活。

不要刷新后手工复制消息立即发送。gateway receipt ledger 不跨进程持久化，写操作可能已经执行。

更多协议细节见 [WEB_CAPABILITIES.md](WEB_CAPABILITIES.md) 和 [CONCEPTS.md](CONCEPTS.md)。
