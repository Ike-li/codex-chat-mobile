# codex-chat-mobile Playwright Test Plan

Source: Planner draft in `.playwright-mcp/codex-chat-mobile-test-plan-draft.md`, normalized into `specs/` so Generator agents can convert the plan into Playwright tests.

## Constraints

- Use the existing `playwright.config.js` project `mobile-chrome`.
- Use the default `baseURL` `http://localhost:3232` and `webServer` command `node scripts/mock-server.js`.
- Do not call the real Codex CLI or consume real model quota.
- Prefer stable existing selectors from `public/index.html`: IDs, classes, role names, and visible text.
- Tests must tolerate replayed messages from the shared mock server because `reuseExistingServer` may preserve state in local runs.

## Generated Coverage

- `e2e/browser-runtime.spec.js`
  - Opens `/`, captures console/page errors, and rejects browser runtime failures for CSP font loading, Service Worker scope, and missing push button initialization.
  - Confirms core UI input/send/attach controls are interactive.
- `e2e/attachments-and-layout.spec.js`
  - Uploads a small text file through the file chooser.
  - Verifies attachment tray display, remove/re-upload, send, user bubble metadata, and responsive layout at 390x844, 844x390, and 390x520.
- `e2e/rich-event-rendering.spec.js`
  - Exercises approval approve/decline, tool result rendering, slash status rendering, and normal response rendering.
- `e2e/critical-flows.spec.js`
  - Existing critical flows updated to use current-message/current-card selectors instead of global strict locators.

## Remaining Playwright Scenarios

### PWA Manifest And Service Worker

File: `e2e/pwa-sw.spec.js`

Steps:
1. Request `/manifest.webmanifest`.
   - Expect `name`, `short_name`, `display`, `start_url`, `theme_color`, and at least one icon entry.
2. Open `/` and wait for Service Worker registration.
   - Expect registration to succeed without a scope error.
   - Expect the active/waiting/installing script URL to include `/js/sw.js`.
3. Request `/js/sw.js`.
   - Expect JavaScript content containing `push` and `notificationclick` listeners.
   - Expect `Service-Worker-Allowed` response header to be `/`.

### Native Controls Browser Panels

File: `e2e/native-controls.spec.js`

Steps:
1. Open `/` and wait until `#state-label` is not `offline`.
2. Click `#native-thread-refresh`.
   - Expect `#native-panel` to become visible.
   - Expect the panel to show thread/list state or a recoverable empty/error state without closing the chat.
3. Click `#native-models-btn`, `#native-files-btn`, `#native-account-btn`, `#native-mcp-btn`, `#native-skills-btn`, and `#native-import-btn`.
   - Expect each action to keep `#native-panel` visible.
   - Expect no page error and no uncaught TypeError.
4. For the Files panel, click a visible directory/file row or assert an empty/recoverable state if the mock app-server returns no entries.

### Popovers And Slash Suggestions

File: `e2e/popovers-and-shortcuts.spec.js`

Steps:
1. Type `/` into `#msg-input`.
   - Expect `#slash-popup` to show slash items such as `/status`, `/diff`, `/review`, and `/permissions`.
2. Click a slash item.
   - Expect the input value to start with that command.
3. Open `#mode-trigger`, `#perm-trigger`, and `#model-trigger`.
   - Expect their popovers to become visible and remain within the viewport.
   - Expect selecting a permission/model option either updates visible text or sends the corresponding slash command without a browser runtime error.

### Multi Instance Tabs

File: `e2e/instances.spec.js`

Steps:
1. Send a normal message to ensure an initial instance exists.
2. Click `#new-instance-btn`.
   - Expect `#instance-tabs` to show at least two tabs or a new active tab.
3. Send a second message in the new instance.
   - Expect the active tab/status to update and the message to render in the current view.
4. Switch back to the previous `.instance-tab`.
   - Expect no page error and no duplicate strict-locator failure.

### Browser Runtime Regression Rule

Every new Playwright browser spec should collect `pageerror` and console `error` messages during its own flow and fail on uncaught `TypeError`, Service Worker scope errors, or CSP resource errors.
