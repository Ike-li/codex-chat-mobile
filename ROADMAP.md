# Roadmap

This roadmap separates what is shipped and maintained from what is still open. It reflects the state of `master`; day-to-day tasks live in [GitHub issues](https://github.com/Ike-li/codex-chat-mobile/issues), not here.

「已完成」依据 git 历史与当前测试门禁；「进行中 / 候选」中标注 *(待确认)* 的条目需要维护者确认后再排期。中文说明见每节。

## Shipped

Delivered and covered by the test gates (`npm run test:ci`):

- **App-server bridge** — long-lived `codex app-server` over stdio, JSON-RPC 2.0 lifecycle (initialize → thread → turn), queue, interrupt, steer, fork.
- **Approval model** — command / file-change / permission / user-input approvals via `ApprovalBroker`, plus legacy `applyPatchApproval` / `execCommandApproval` fallback and `serverRequest/resolved` revocation.
- **Streaming UI** — text deltas, reasoning (channel/kind partitioned), command/tool cards with exit codes, file-change and diff panels, plan panel, raw-envelope fallback for unknown items.
- **Mobile shell** — single-file SPA/PWA, multi-workspace routing (`WORK_DIR` + `WORK_DIRS`), multi-instance tabs, catch-up on reconnect, status line (git + context usage).
- **Native controls** — thread list/resume/archive/rename/delete, compact, rollback, model list, read-only fs, account/usage/rate-limits, MCP status, skills, external-agent-config import.
- **Admin (P2)** — config write, plugin/marketplace, fs write/remove/copy, MCP tool call, logout — behind `ENABLE ADMIN` unlock + per-action confirm + owner-only audit log.
- **Labs (P3, experimental)** — web terminal via `command/exec`, thread turns/search with graceful degradation, realtime/remote-control notification tracking; gated behind `CODEX_P3_EXPERIMENTAL`.
- **Security baseline** — loopback-only without `AUTH_TOKEN`, timing-safe token compare, device trust, upload validation + owner-only writes, symlink defense, CSP, log redaction.
- **Attachments & push** — validated uploads injected as safe local paths, VAPID Web Push, installable PWA.
- **CI & protocol gate** — GitHub Actions on Node 20/22, coverage thresholds + delta, and app-server protocol drift/coverage check against `.protocol/stable/`.

## In Progress

- **Open-source documentation pass** — bilingual README, LICENSE (AGPL-3.0), CONTRIBUTING, SECURITY, and the `docs/` set (ARCHITECTURE, TESTING, PROTOCOL, API, SHOWCASE, REMOTE_ACCESS, GUIDE, PROTOCOL_UPGRADE).

## Candidates

Not scheduled; listed for direction. Promote to an issue before starting.

- **Real ChatGPT device-code login smoke** — automation covers the mock; real-account `chatgptDeviceCode` flow still needs a manual/CI path. *(待确认)*
- **Native pagination/search** — switch history from JSONL parsing to `thread/turns/list` / `thread/items/list` / `thread/search` once those requests are exported by the pinned CLI. *(待确认)*
- **Official remote-control pairing** — track `remoteControl/*` maturing upstream; evaluate replacing self-managed device auth when the official pairing lands. *(待确认)*
- **Realtime voice** — `thread/realtime/*` currently notification-only; real audio input is out of scope until prioritized. *(待确认)*
- **Delta coalescing** — bridge→frontend high-frequency delta batching for very long logs (performance, not correctness). *(待确认)*
- **Screenshots / demo GIF** — capture portrait chat + approval card for the READMEs.

## Non-Goals

- `codex cloud` cloud tasks (go through the ChatGPT backend, not app-server).
- A hosted/multi-tenant backend — this stays a single-user local control plane.
- Reimplementing TUI-local rendering details (transcript scrolling, keybindings, onboarding).
