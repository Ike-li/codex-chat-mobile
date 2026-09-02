# Web 端故障排查

本文按用户看到的症状排查。先确认问题发生在哪一层，再采取最小修复，不要用关闭安全策略来掩盖部署错误。

## 排查顺序

1. 查看浏览器页面上的连接、设备和错误状态；
2. 检查服务端启动日志；
3. 请求 `/health`，确认网关可达；
4. 检查 HTTPS、Origin、可信代理、session 和设备批准；
5. 检查本机 Codex 版本、登录状态和 app-server；
6. 最后再检查具体 thread、outbox 或 feature flag。

基础检查：

```bash
node --version
cat .codex-version
npm run protocol:check
npm test
```

## 页面无法连接

### 一直显示 connecting/offline

检查服务是否运行、URL/端口是否正确，以及反向代理是否能访问 `127.0.0.1:3001`。

### 返回 `secure_transport_required` 或 HTTP 426

远程请求仍被识别为明文 HTTP。使用可信 HTTPS；如果经过反向代理，只有 `CODEX_TRUSTED_PROXY_IPS` 中的直接对端可以提供 `X-Forwarded-Proto`。

### 返回 `origin_required` 或 `origin_not_allowed`

把手机地址的完整 scheme、host 和 port 精确加入 `CODEX_ALLOWED_ORIGINS`。不支持 `*`，也不要只填 hostname。

### 登录反复失败或被限流

确认 `AUTH_TOKEN` 与服务器一致、非 loopback 监听时至少 32 字符。修正后等待失败窗口结束，不要连续尝试。

## 已连接但不能发送

### 页面仍显示 pending/locked

新远程设备尚未批准。必须从已批准设备或开发机批准；仅成功换取 session 不代表设备已受信任。

### 返回 `stale_target`

当前 instance/thread/turn 已失效。刷新 thread 列表并重新选择目标，不要继续使用旧标签中的操作入口。

### 返回 `request_id_conflict`

同一 `clientRequestId` 被用于不同内容或目标。这通常表示客户端状态被错误复制；保留原记录用于核对，为新的逻辑消息生成新 ID。

### 消息停在 queued

runtime 仍 busy 或消息等待后续 receipt。不要删除 outbox；等待 submitted/steered/rejected 更新，必要时检查目标 turn 是否仍运行。

### 文件操作被拒并记为 `workspace_scope`

目标路径不在 `WORK_DIR` / `WORK_DIRS` 之内。路径先做 realpath 归一，再按分隔符锚定比较，所以软链接指向区外、`..` 穿越、以及 `/srv/work` 与 `/srv/work-other` 这类前缀碰撞都会被拒。

macOS 和 Windows 上还有一种容易误判的情况：文件系统大小写不敏感，但 `realpath` **不**做大小写归一。磁盘上叫 `work` 时，`/…/WORK/a.txt` 会被判为区外并拒绝，尽管它指向同一个目录。改用与 `WORK_DIR` 完全一致的大小写即可。这里刻意保持严格匹配——大小写敏感的文件系统上 `/srv/work` 和 `/srv/WORK` 是两个不同目录，放宽比较会变成真正的越权。

## 对话、历史或审批异常

### Codex 没有输出

确认本机 Codex 已登录、版本匹配 `.codex-version`、`WORK_DIR` 有效，并查看是否有未处理审批。真实服务启动才会使用本机 Codex；Playwright E2E 使用 mock。

### 历史 thread 看不到

确认两端使用同一 Codex home/account，且 thread 没有被 archive。Web 只读取 app-server `thread/list/read`，不会读取 `sessions.json` 或旧 JSONL fallback。

### 审批卡一直等待

检查 needs-you 顶部聚合和另一设备。未回答的 server request 会阻塞 turn；系统不会自动批准。上游撤销或 turn 终止后卡片应变为 revoked/expired。

### 显示“结果未知，正在核对”

等待只读 reconciliation。有稳定 thread 时系统会通过 `thread/read` 查找原请求。只有确认重复副作用可接受时才点击“确认后重试”；该操作会生成新 ID。

### 刷新后内容缺失或重复

普通断线应按 seq/epoch catch-up；gap/epoch mismatch 应触发 snapshot。检查 `thread:history`/catch-up 错误和目标 thread 是否正确，不要把另一个 instance 的事件手工合并进当前视图。

## 附件、Push 或 PWA 异常

### 附件发送失败

检查：最多 10 个、单个 10 MiB、合计 20 MiB。mention 必须在 runtime cwd 内；skill 必须仍为 enabled。上传目录必须是普通目录而非 symlink，并能被修正为 0700。

### Push 按钮不可用

依次检查 HTTPS、VAPID 三项、有效 session、设备批准、浏览器通知权限和订阅容量。iOS 需要从主屏幕 PWA 请求通知权限。

### PWA 无法安装

先确认手机信任证书和页面是安全上下文，再检查 manifest 和 Service Worker。`CODEX_ALLOW_INSECURE_REMOTE=1` 不能把 HTTP 变成安全上下文。

### Push 订阅成功但收不到通知

确认设备仍 trusted、订阅没有被替换、endpoint 解析为纯公网地址。投递拒绝私网/混合 DNS，并有 10 秒总超时和 64 KiB 响应上限。

## Labs 或模型不可用

### 看不到 Labs

Labs 默认关闭：设置 `CODEX_P3_EXPERIMENTAL=1` 并重启网关，关闭时服务端返回 `feature_disabled`。宿主配置不受此开关影响，入口常驻在抽屉的工具面板里。

### 宿主配置操作被拒绝

宿主配置没有解锁步骤（旧的 admin 解锁已整套拆除），但每个动作需要独立确认——缺 `confirmAction` 会被拒绝并记入审计。

### 模型列表为空或模型不能使用

以 app-server `models/list`、账号权限和当前 Codex 配置为准。页面标签不代表账号一定有模型权限。查看 Account 的 usage/rate limits，并确认本机 Codex 登录状态。

若问题仍无法定位，记录最小复现、页面错误、服务端脱敏日志、目标 thread/instance 和已运行门禁；不要附带 token、cookie、私钥或完整敏感命令。
