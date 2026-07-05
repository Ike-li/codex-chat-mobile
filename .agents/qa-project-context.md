# QA Project Context — codex-chat-mobile

> Source of truth for all QA skills. Last updated: 2026-07-02.

---

## Product

**Name:** codex-chat-mobile

**One-liner:** Mobile web UI that bridges your local Codex CLI to your phone — terminal-equivalent agent access from anywhere.

**Type:** Open-source developer tool / library (MIT license)

**Production URL:** N/A — local-only bridge service, no hosted deployment

**Staging URL:** N/A

**Development URL:** `http://localhost:3001` (default PORT)

### Key User Journeys (Critical Flows)

If any of these break, the product is unusable:

1. **创建任务 + 流式输出** — User sends prompt from mobile UI → Codex processes → streaming text_delta/tool_use/tool_result events rendered in real-time → task completes with visible result
2. **审批流程** — Codex requests permission (file write, shell exec) → mobile UI shows approval card → user approves/declines → Codex proceeds or stops; includes timeout auto-decline
3. **断线重连 + 会话恢复** — Network drops → socket reconnects → catch-up replays missed events → history restored without duplicates; session resume via resumeId
4. **设备认证 + 安全** — AUTH_TOKEN authentication → device whitelist with pending approval → loopback-only binding when no token → CSP headers → timing-safe comparison
5. **斜杠命令** — /status, /diff, /review, /permissions, /resume, /compact, /model, /reasoning — all must route correctly and return meaningful output
6. **文件上传 + 附件** — User attaches files → validated (size, count) → saved with 0600 permissions → paths injected into Codex prompt → attachments metadata in user_message event
7. **多设备同步** — Same session viewed on multiple devices → events broadcast via io.emit → all devices see same output
8. **会话历史浏览** — listSessions filters by workspace CWD → getSessionHistory parses JSONL → deduplication of adjacent identical messages

---

## Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Runtime | Node.js | ≥20 | ESM (`"type": "module"`) |
| Backend Framework | Express | 5.0.0 | Static hosting + REST endpoints |
| Real-time | Socket.IO | 4.8.0 | WebSocket with fallback, event broadcasting |
| Protocol Bridge | codex app-server | JSON-RPC 2.0 over stdio | Long-lived subprocess, NDJSON |
| Frontend | Single-file SPA | `public/index.html` (~1400 lines) | Vanilla JS, no framework, PWA-ready |
| Push Notifications | web-push | 3.6.7 | VAPID keys, Service Worker |
| File Upload | Custom | `uploads.js` | Safe-attachment pattern, 0600 perms |
| Encryption | Custom E2EE | `e2ee.js` | Identity commitment, key exchange |
| Config | dotenv | 17.0.0 | `.env` file for AUTH_TOKEN, WORK_DIR, etc. |

**Monorepo:** No — single package.

---

## Test Stack

| Type | Framework | Config | Directory | Status |
|------|-----------|--------|-----------|--------|
| Unit / Integration | `node:test` (native) | None needed | `test/` | 7 files, ~931 lines; 6 files pass, 1 file (`new-modules.test.mjs`) hangs on `session.send()` test |
| E2E | None selected yet | — | — | No E2E framework; manual testing via `docs/manual-test-cases.md` and `scripts/scenario-server.js` |
| Visual | None | — | — | — |
| Performance | None | — | — | — |

**Test runner command:** `npm test` → `node --test test/*.test.mjs`

**Known test issue:** `new-modules.test.mjs` contains a test (`CodexAppServerSession.send queues and drains with attachments`) that calls `session.send()` which attempts to connect to a real codex app-server process. This test hangs when no codex binary is available. Needs mocking or skip annotation.

### Test File Mapping (Current → Target)

Current naming: `<module>.test.mjs` in `test/` directory.
Target naming: Co-located with source files, e.g., `server.test.mjs` next to `server.js`.

| Current | Target |
|---------|--------|
| `test/agent-appserver.test.mjs` | `agent-appserver.test.mjs` |
| `test/e2ee.test.mjs` | `e2ee.test.mjs` |
| `test/new-modules.test.mjs` | Split into `uploads.test.mjs`, `statusline.test.mjs`, `history.test.mjs` |
| `test/public-ui.test.mjs` | `public/index.test.mjs` |
| `test/server-security.test.mjs` | `server-security.test.mjs` |
| `test/smoke-scripts.test.mjs` | `scripts/smoke.test.mjs` |
| `test/acceptance-doc.test.mjs` | `docs/acceptance.test.mjs` |

---

## CI/CD

**Platform:** GitHub Actions (planned, not yet configured)

**When tests run:** Manual only (`npm test`); no automated CI triggers.

**Planned pipeline:**
- Trigger: PR to `dev` or `master`, push to `dev`
- Steps: `npm install` → `npm test` → report results
- Blockers: Test failures block merge
- Artifacts: None currently; consider test output logs

**Branching strategy:**
- `dev` — development branch, primary integration target
- `master` — production/stable branch
- Both have branch protection enabled
- Admin can push directly to both branches
- Feature branches → PR to `dev` → merge → PR to `master`

---

## Environments

| Environment | URL | Notes |
|-------------|-----|-------|
| Local Development | `http://localhost:3001` | Developer's machine, real codex CLI binary required |
| Staging | N/A | — |
| Production | N/A | Local-only service, no hosted deployment |

**Environment parity:** All testing happens locally with real codex CLI. No mock services or sandboxed environments for CI.

**Third-party dependencies:**
- `codex` CLI binary must be installed and accessible in PATH
- Web Push requires VAPID keys (generated once, stored in .env)
- No external APIs or databases — pure local bridge

---

## Quality Goals

| Metric | Target | Measurement |
|--------|--------|-------------|
| Unit test coverage | 80%+ line coverage on business logic | To be measured (Istanbul/c8 not yet configured) |
| E2E coverage | All 8 critical user journeys | Playwright (not yet set up) |
| Flake rate | <2% over rolling 30-day window | CI failure analysis |
| Suite duration | Unit <3 min, E2E <15 min | CI timing |
| Test pass rate | 100% on `dev` and `master` | PR gate |

**Current state:** 6/7 test files pass. Coverage not measured. No CI gates.

---

## Risk Areas

| Area | Risk Level | Business Impact | Notes |
|------|-----------|----------------|-------|
| **安全边界** | Critical | Direct — affects user's local machine | AUTH_TOKEN timingSafeEqual, device whitelist, loopback binding, CSP headers. Security vulnerability = arbitrary code execution on developer's machine. |
| **协议兼容性** | Critical | High — product unusable if protocol breaks | codex app-server JSON-RPC protocol, event mapping (item/agentMessage/delta → text_delta), streaming. Protocol changes in codex CLI break the bridge silently. |
| **实时通信可靠性** | Important | Medium — user loses work or sees duplicates | Socket.IO disconnect/reconnect, catch-up replay, multi-device sync. Message loss or duplication affects trust. |
| **文件操作安全** | Important | High — file corruption or permission issues | uploads.js file validation, 0600 permissions, WORK_DIR boundary enforcement. Malicious upload = local file overwrite. |
| **辅助功能完整性** | Monitor | Low — feature degradation, not data loss | Web Push notifications, E2EE key exchange, history parsing. Breaks are visible but not catastrophic. |

### Risk Scoring

- **Critical:** High impact + High likelihood (security boundary — known attack surface, protocol changes from upstream)
- **Important:** High impact + Low likelihood (file operations — well-tested but edge cases exist)
- **Monitor:** Low impact + High likelihood (notification formatting — breaks often, low severity)

---

## Team

| Role | Count | Notes |
|------|-------|-------|
| Lead Developer / Maintainer | 1 | Ike-li — primary author, all architecture decisions |
| Contributors | Occasional | Open-source contributions, PRs reviewed by maintainer |

**Dev:QA ratio:** Effectively infinite (solo developer with no dedicated QA)

**Ownership model:** Developer owns all tests. No manual regression suite; lean on low-barrier automation (node:test + planned Playwright). QA "role" = strategy + critical-path E2E, done by the developer.

**Methodology:** Trunk-based with dev/master branches. Feature branches for significant changes.

**QA engagement:** Post-development — tests written alongside or after implementation. No shift-left spec review.

---

## Conventions

### Test File Naming
- **Current:** `<module>.test.mjs` in `test/` directory
- **Target:** Co-located with source files (e.g., `server.test.mjs` next to `server.js`)
- **Extension:** `.test.mjs` (ESM modules)

### Test Framework Patterns
- `import { test } from 'node:test'`
- `import assert from 'node:assert/strict'`
- Helper functions at top of file (e.g., `makeSession()`, `byType()`)
- Test descriptions in Chinese (matching codebase language)

### Branching Strategy
- `dev` — active development, integration target
- `master` — stable releases
- Feature branches: `<type>/<description>` (e.g., `fix/security-loopback`)
- PRs required to both `dev` and `master`
- Branch protection enabled, admin override allowed

### Selector Strategy (Frontend)
- `data-testid` attributes for testable elements (preferred for stability)
- Semantic HTML with ARIA roles where appropriate
- ID-based selectors for critical elements (`#session-meta`, `#quick-actions`)

### Test Data Strategy
- Temporary directories via `mkdtempSync(join(tmpdir(), 'ccm-test-'))`
- Inline fixtures (JSON strings, mock objects)
- No test factories or seeded databases
- Cleanup in test teardown (rmdirSync with recursive option)

### Code Style
- Chinese comments and test descriptions
- JSDoc-style documentation
- MIT license
- ESM imports throughout

---

## Notes

- **No E2E framework yet** — manual testing via `docs/manual-test-cases.md` and browser-based scenario runner (`scripts/scenario-server.js`). Playwright recommended as default E2E framework.
- **No coverage tool** — c8 or Istanbul needed to measure the 80% target.
- **Hanging test** — `new-modules.test.mjs` line 279 needs mocking for `session.send()` or skip annotation.
- **codex CLI dependency** — integration tests require real `codex` binary; unit tests should mock this dependency.
