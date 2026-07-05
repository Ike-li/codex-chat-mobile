# codex-chat-mobile

Phone-friendly web UI for controlling a local Codex CLI session — terminal-equivalent agent access from mobile.

## What it does

- Runs a local Express + Socket.IO server.
- Spawns `codex app-server` over stdio as the Codex process wrapper (JSON-RPC 2.0).
- Streams Codex events to the phone as chat bubbles, tool cards, plans, diffs, search cards, file-change cards, reasoning, and approval prompts.
- Supports slash commands `/status`, `/diff`, `/review`, `/permissions`, `/resume`, `/compact`, `/model`.
- Queues phone input while a turn is running, drains FIFO.
- **File uploads** — select files from phone, injected as Read-able paths in prompts.
- **Status bar** — real-time git branch/changes, context token usage, session state.
- **History browsing** — browse past Codex sessions including terminal-created ones.
- **Multi-workspace** — switch between projects via `WORK_DIRS` env var.
- **Multi-session parallel** — multiple concurrent agent instances with tab switching.
- **Web Push** — turn-completion notifications via VAPID (optional).
- **PWA** — installable to home screen with standalone display.
- Interrupt, reconnect catch-up, device approval, token auth, E2EE, owner-only state files.
- 178 unit + integration + acceptance tests, plus 10 Playwright E2E tests.

## Setup

```bash
npm install
cp .env.example .env
npm test
npm start
```

Set `.env` with placeholders appropriate for your machine:

```bash
PORT=3001
HOST=127.0.0.1
AUTH_TOKEN=replace-with-a-local-secret
WORK_DIR=/absolute/path/to/workspace
WORK_DIRS=/other/project,/third/project   # optional: multi-workspace
CODEX_BIN=/absolute/path/to/codex
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
CODEX_INPUT_QUEUE_LIMIT=20
# Web Push (optional):
VAPID_SUBJECT=mailto:you@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Open `http://localhost:3001` locally. For LAN/tunnel access, set `HOST=0.0.0.0` with a non-empty `AUTH_TOKEN`. Without `AUTH_TOKEN`, the server enforces loopback-only binding.

## Architecture

```
public/index.html (SPA + PWA)
     ↕ Socket.IO
server.js (agents Map + route layer)
     ├── agent-appserver.js    (codex app-server JSON-RPC bridge)
     ├── sessions.js           (session metadata)
     ├── devices.js            (device trust)
     ├── uploads.js            (file uploads)
     ├── statusline.js         (git + ctx status bar)
     ├── history.js            (Codex session history)
     ├── e2ee.js               (end-to-end encryption)
     ├── push.js + sw.js       (Web Push)
     ├── relay.js              (WS relay)
     ├── sanitizer.js          (log redaction)
     ├── file-security.js      (symlink defense + 0600)
     └── server-security.js    (loopback enforcement)
```

## Mobile Controls

- Send text + files: 📎 button to attach, sends as Codex turn with injected paths.
- Slash chips: one-tap `/status`, `/diff`, `/review`, `/model`, `/permissions`, `/resume`, `/compact`.
- Stop button: sends `turn/interrupt` and clears queue.
- Session drawer: new/resume sessions, browse Codex-native history.
- Header: workdir/model/permission selectors, instance tabs, status detail line.
- 🔔 Push subscribe for offline turn-completion notifications.

## Safeguards

Keep `WORK_DIR` explicit, use `AUTH_TOKEN` for non-local access, keep `CODEX_SANDBOX=workspace-write` or stricter, and do not expose the server directly to untrusted networks.
