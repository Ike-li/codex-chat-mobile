# 远程访问指南

本项目的核心场景是「手机连开发机」。本机 `http://127.0.0.1:3001` 开箱即用，但从手机访问要先跨过两道坎：**网络可达** 和 **安全上下文**。第二道坎最容易踩——不解决的话，PWA 装不上、Web Push 收不到，产品核心卖点直接哑火。

## HTTPS 与 PWA/Push 的硬限制

浏览器把 Service Worker、PWA 安装、Web Push 都限定在 **安全上下文（secure context）**。安全上下文只有两种：

- `https://`（任意主机）
- `http://` 且主机是 `localhost` / `127.0.0.1` / `::1`

**`http://192.168.x.x:3001` 或 `http://<主机名>:3001` 不是安全上下文。** 后果：

| 能力 | 本机 `http://127.0.0.1` | 局域网 `http://192.168.x.x` | 隧道 `https://…` |
|---|---|---|---|
| 基础聊天 / 审批 / 历史 | ✅ | ✅ | ✅ |
| Service Worker | ✅ | ❌ | ✅ |
| 安装为 PWA | ✅ | ❌ | ✅ |
| Web Push（锁屏收审批） | ✅ | ❌ | ✅ |

结论：**只要想在手机上装 PWA 或收推送，就必须让手机通过 HTTPS 访问**，即使在自己的局域网里。纯 `http://` 局域网只够临时试聊天。

## 方案对比

从「够用且省心」到「更灵活」排序：

### 1. Tailscale（推荐）

私有 WireGuard 网络，手机和开发机加入同一 tailnet 后用稳定的 `100.x.y.z` 互访；配合 **Tailscale Serve/Funnel** 一条命令拿到可信 HTTPS 证书，安全上下文直接满足。

```bash
# 开发机：把本地 3001 以 HTTPS 暴露到 tailnet（仅自己的设备可见）
tailscale serve 3001
# 手机装 Tailscale App、登录同账号后，用 serve 给出的 https://<机器名>.<tailnet>.ts.net 访问
```

- 优点：零公网暴露、自动 HTTPS、设备级鉴权已在网络层；`serve`（非 `funnel`）不对公网开放。
- 仍需在本项目设 `HOST=0.0.0.0` + 非空 `AUTH_TOKEN`（见下节），双层防护。

### 2. Cloudflare Tunnel / ngrok 等反代隧道

把本地端口经服务商反代成公网 `https://` 域名。

- 优点：手机在任意网络都能连，自动 HTTPS。
- 代价：**这是把控制真实开发机的面板暴露到公网**——务必配非空 `AUTH_TOKEN`，优先选带访问策略（如 Cloudflare Access）的方案，别用无鉴权的临时公网 URL。属高风险，非必要不用。

### 3. 局域网自签 HTTPS

自己在开发机前面架一层 TLS 反代（Caddy `tls internal`、mkcert 本地 CA 等），手机导入 CA 后用 `https://<局域网IP>` 访问。

- 优点：不依赖外部服务，纯本地网络。
- 代价：证书信任要在手机上手动配一次，最琐碎。

> 本项目自身只讲 HTTP + Socket.IO；TLS 由上面任一方案在其外层承担。浏览器 **不能** 直连 Codex app-server 的 `--listen ws://`（experimental/unsupported + `Origin` 一律 403），远程通道必须经本项目 Node 网关。

## AUTH_TOKEN 实践

无论用哪种方案，一旦 `HOST` 不再是 loopback，鉴权就是命门：

- **空 `AUTH_TOKEN` 时服务只接受 loopback**，并拒绝非 loopback host——这是防误配的安全默认值。
- 远程访问必须：`HOST=0.0.0.0` **且** 设一个强随机 `AUTH_TOKEN`（如 `openssl rand -hex 32`）。token 用 timing-safe 方式比较。
- 手机端首次在登录页输入 token，之后保存在该浏览器 `localStorage`；也可用带 `?token=` 的一次性链接首连。
- token 只是「谁能连网关」这一层；破坏性/Admin 操作另有 `ENABLE ADMIN` unlock + 逐操作确认，见 [../SECURITY.md](../SECURITY.md)。

## 排错清单

- **手机能聊天但装不了 PWA / 收不到推送** → 十有八九在用 `http://` 局域网地址。换成 HTTPS（Tailscale Serve / 隧道 / 自签）。
- **连不上、一直转圈** → 检查 `HOST=0.0.0.0`（默认 `127.0.0.1` 只监听本机）、开发机防火墙放行端口、手机与开发机在同一网络或同一 tailnet。
- **提示未授权 / 反复要 token** → `AUTH_TOKEN` 两端不一致，或链接里的 `?token=` 与服务端不符；重新从登录页输入。
- **Web Push 订阅按钮不可用** → 需同时满足安全上下文 **和** 服务端配齐 `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 三项。
- **Codex app-server ws 直连报 403** → 预期行为，浏览器不该直连 app-server；一切走本项目网关。
