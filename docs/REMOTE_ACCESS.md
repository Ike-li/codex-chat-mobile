# 远程访问指南

手机连接开发机同时跨越网络、TLS、浏览器 Origin、网关 session 和设备批准五个边界。当前网关对远程明文访问 fail-closed：正确方案是让 Node 继续监听 loopback，由受控 HTTPS 反代提供手机入口。

## HTTPS 与 PWA/Push 的硬限制

Service Worker、PWA 安装和 Web Push 只在浏览器安全上下文中可用：可信 `https://`，或同机的 `http://localhost` / `127.0.0.1` / `::1`。手机访问 `http://192.168.x.x` 不属于安全上下文；本项目还会默认以 426 拒绝远程 HTTP。

| 能力 | 本机 `http://127.0.0.1` | 远程明文 HTTP（默认） | 受控 `https://…` |
|---|---|---|---|
| 基础聊天 / 审批 / 历史 | ✅ | ❌ `426 https_required` | ✅（通过 session + 设备批准后） |
| Service Worker | ✅ | ❌ | ✅ |
| 安装为 PWA | ✅ | ❌ | ✅ |
| Web Push | 需 VAPID/授权 | ❌ | 需 VAPID、有效 session、已批准设备和浏览器授权 |

`CODEX_ALLOW_INSECURE_REMOTE=1` 只能作为明确的危险开发逃生口；它不取消 Origin、认证或设备检查，也不能让浏览器获得 PWA/Push 安全上下文。正常部署保持 `0`。

## 方案对比

无论选哪种反代，都应让代理覆盖为单一 `X-Forwarded-Proto: https`，并把代理的**直接对端 IP**精确写入 `CODEX_TRUSTED_PROXY_IPS`。不要使用 `trust proxy=true`、CIDR、hostname、`*` Origin，也不要相信客户端传入的 `X-Forwarded-For`。

通用 `.env` 基线：

```dotenv
HOST=127.0.0.1
AUTH_TOKEN=<openssl rand -hex 32 的结果>
CODEX_ALLOWED_ORIGINS=https://codex.example.com
CODEX_TRUSTED_PROXY_IPS=127.0.0.1,::1
CODEX_ALLOW_INSECURE_REMOTE=0
```

### 1. Tailscale Serve（推荐）

手机和开发机加入同一 tailnet，在开发机把 loopback 服务发布为 tailnet 内 HTTPS：

```bash
tailscale serve 3001
```

把 `CODEX_ALLOWED_ORIGINS` 改成 Serve 输出的精确 `https://<机器名>.<tailnet>.ts.net`。同机 Serve 应继续使用 `HOST=127.0.0.1`；确认 Node 看到的直接 peer 是 `127.0.0.1` 或 `::1`，且请求带 `X-Forwarded-Proto: https`。使用 Serve 而不是 Funnel，避免不必要的公网入口。

### 2. Caddy / 局域网可信证书

在同机终止 TLS，证书必须被手机信任。示例只展示关键头部，域名和证书策略按你的网络调整：

```caddyfile
codex.example.com {
  reverse_proxy 127.0.0.1:3001 {
    header_up X-Forwarded-Proto https
  }
}
```

若使用 `tls internal` 或 mkcert，需要把对应 CA 安装到手机。仍保持 Node loopback 监听，并将精确域名写入 allowlist。

### 3. Cloudflare Tunnel / ngrok

同机 tunnel 也反代 `http://127.0.0.1:3001`，但手机入口在公网。除本项目 token/session/device checks 外，还应启用服务商的访问策略；不要使用无访问控制的临时公共 URL。确认 tunnel 覆盖 `X-Forwarded-Proto=https`，把实际直接 peer IP 和精确公开 Origin 写入配置。

如果代理在另一台主机或容器网络，只有这时才把 `HOST` 改为实际可达的非 loopback 地址。非 loopback bind 会在启动时强制 `AUTH_TOKEN` 至少 32 字符；防火墙还应只允许代理 IP 访问 Node 端口。

> Node 网关自身不终止 TLS，而是只在直接 peer 被信任时接受其 `X-Forwarded-Proto`。浏览器也不能直连 Codex app-server 的 experimental `--listen ws://`；所有浏览器流量必须经过本项目网关。

## AUTH_TOKEN 实践

- `AUTH_TOKEN` 是高熵 bootstrap secret，不是浏览器长期 bearer token。远程登录页把它发送到 `POST /auth/session`；成功后变量被清空，服务器返回绑定 `deviceToken` 的 HttpOnly/SameSite=Strict cookie，确认 HTTPS 时还带 `Secure`。
- session 默认七天（`CODEX_SESSION_TTL_MS=604800000`），只保存在服务端内存；服务重启会全部失效。浏览器 localStorage 只保存随机 device token 和 UI 偏好，不保存 host token。
- 远程 Socket 只接受 cookie + 同一 device token，不接受 handshake `auth.token`。HTTP query 参数也不参与 API 鉴权。
- 页面目前可把 `?token=` 当作一次 bootstrap 输入并立即从地址栏删除，但它不是密码学上的一次性 token，仍可能进入历史、代理或诊断日志；默认不要生成或分享这种 URL。
- 新 device token 进入 pending，达到 `CODEX_PENDING_DEVICE_LIMIT`（默认 32）后返回 `pairing_capacity`。可从已批准设备操作，或在开发机运行：

```bash
node scripts/device.js list
node scripts/device.js approve <device-id>
node scripts/device.js deny <device-id>
```

这些命令与服务端一样遵循 `CODEX_DATA_DIR`。设备 deny 会撤销该设备全部 session、删除 Push 绑定并断开在线 socket。外部以原子替换方式从 `trusted-devices.json` 删除 token 也会立即 reconcile：即使该设备当前离线，已有 auth session 和 Push 绑定仍会撤销；远程 socket 会断开，但已经连接的 loopback socket 会保留。`DELETE /auth/session` 只注销当前 session 并断开其 socket。

认证失败默认每直接 peer IP 5 次/60 秒（`CODEX_AUTH_MAX_FAILURES` / `CODEX_AUTH_WINDOW_MS`）。阈值前拒绝和该窗口第一次 429 会进入 security audit，后续 429 聚合抑制；audit 使用 O_APPEND，并在 `CODEX_SECURITY_AUDIT_MAX_BYTES`（默认 1 MiB）保留一份轮转。反代下多个用户可能共享一个 bucket；这是单用户控制面，不应把它当成多租户限流。

Web Push 还要求 VAPID 三项、公网 HTTPS endpoint、有效 `p256dh/auth` keys、有效 session 和已批准设备。每次投递都会重新解析全部 DNS：任一私网/loopback/link-local/site-local/保留地址或公私混合结果都会拒绝；实际 TLS 请求保持原 hostname/SNI，但 lookup pin 到已验证 IP，并受 10 秒总超时和 64 KiB 响应上限约束。每个设备只保留最新 endpoint，总数默认 64；deny/失信设备不会继续投递。approval/question 的 needs-you 通知使用泛化正文和 `thread + need` 深链，不放命令、问题或回答正文。`result` / `error` 也会触发通知，但目前不带 needs-you 深链；正文取 payload 的 status/message 并截断到 180 字符，因此实际错误文本可能出现在操作系统通知预览中。

## 排错清单

- **HTTP 426 `forwarded_proto_required`**：直接 peer 已列为 trusted proxy，但代理没有覆盖 `X-Forwarded-Proto`。
- **HTTP 426 `https_required`**：请求仍被判定为远程 HTTP，或代理明确转发了 `http`；不要用 insecure override 掩盖生产配置错误。
- **Socket `origin_required` / `origin_not_allowed`**：手机的完整 Origin 未精确列入 `CODEX_ALLOWED_ORIGINS`，或 scheme/host/port 不一致。
- **启动时报 token 长度错误**：`HOST` 是非 loopback，而 `AUTH_TOKEN` 少于 32 字符；重新生成，或让同机代理访问 loopback。
- **`unauthorized` / 反复登录**：session 不存在、过期、服务器重启、cookie 与 device token 不匹配，或设备已被撤销；从登录页重新 exchange，不要把 token 塞进 Socket/query。
- **`pairing_capacity`**：pending 已达默认 32；在受信任设备或开发机清理/拒绝旧请求。
- **`rate_limited`**：认证或 Admin unlock 失败窗口触发；先修正凭据/配置，等待窗口结束。
- **批准后仍 pending，返回 `device_persist_failed`**：`CODEX_DATA_DIR` 不可写、原子临时文件冲突或磁盘错误；目标会保持锁定，修复存储后重试。
- **deny 返回 `device_persist_failed`**：在线 socket/session 已 fail-closed 撤销，但 durable trust file 未成功更新；修复存储并再次 deny。
- **Web Push 按钮不可用**：依次检查可信 HTTPS、VAPID 三项、有效 session、设备已批准、浏览器权限和订阅容量；订阅持久化失败不会假报成功。
- **PWA 装不上**：先检查证书是否被手机信任，再检查 manifest/Service Worker；远程 HTTP 即使打开 insecure override 也不是安全上下文。
- **app-server ws 直连 403**：预期行为；浏览器不直连 app-server。
