# Security Policy

codex-chat-mobile is a local control plane for a real development machine. A connected client can drive the Codex CLI — read files, propose patches, and request command execution — inside the configured workspace, sandbox, and approval policy. Treat any remote exposure as high risk.

## Threat Model

- The Node server bridges browsers to a local `codex app-server` process; whoever reaches the HTTP/Socket.IO endpoint with a valid token effectively operates Codex on your machine.
- Approval policies, sandbox modes, and workspace allowlists bound what a turn may do, but they are guardrails, not isolation — the server itself must stay unreachable to strangers.
- Device trust, pending approvals, uploads, and audit logs live on the host as owner-only files.

## Deployment Rules

- With an empty `AUTH_TOKEN`, the server only accepts loopback connections and refuses to serve non-loopback hosts.
- Any LAN or tunnel deployment requires `HOST=0.0.0.0` plus a strong, non-empty `AUTH_TOKEN` (compared timing-safe).
- Prefer private tunnels (Tailscale, WireGuard, SSH) over public exposure; never place the server directly on the public internet.
- Keep `CODEX_SANDBOX` and `CODEX_APPROVAL_POLICY` at the most restrictive settings your workflow allows; destructive/Admin operations stay behind an unlock plus per-action confirmation.

## Supported Versions

Pre-1.0: only the latest `master` receives security fixes.

## Reporting a Vulnerability

- Report privately via GitHub: [Security → Report a vulnerability](https://github.com/Ike-li/codex-chat-mobile/security/advisories/new).
- Please do not open public issues for security reports.
- Include reproduction steps, impact, and the affected configuration (`HOST`, `AUTH_TOKEN` set or not, sandbox/approval policy). You should normally hear back within a week.
