# Project: codex-chat-mobile

Goal: Terminal-equivalent Codex CLI access from mobile phone.

## Architecture
- Backend: Node.js ESM, Express 5 + Socket.IO 4, zero third-party AI SDKs
- Frontend: single-file SPA in public/index.html (~1400 lines), PWA-ready
- Core bridge: codex app-server JSON-RPC 2.0 over stdio
- Session model: agents Map (multi-instance parallel) with instanceId routing
- Test framework: node:test (native), 178 tests; Playwright E2E (10 flows)

## Key files
- server.js — HTTP + Socket.IO + agents Map routing (~700 lines)
- agent-appserver.js — CodexAppServerSession: JSON-RPC bridge (~500 lines)
- public/index.html — SPA frontend (~1400 lines)
- docs/technical-plan.md — architecture rationale + Codex protocol reference
- docs/scenario-acceptance.md — 10-case acceptance matrix (四维度判定)

## New modules (2026-06-29)
- uploads.js — file upload with safe-attachment pattern
- statusline.js — git status + context usage for status bar
- history.js — Codex session JSONL parser
- public/js/sw.js — Service Worker for Web Push
- public/manifest.webmanifest + icons/icon.svg — PWA

## Reference
- claude-chat-mobile: /Users/raylee/code/claude-chat-mobile (sister project, Claude Code SDK bridge)
- Codex app-server docs: `codex app-server --help`, `codex app-server generate-ts`
