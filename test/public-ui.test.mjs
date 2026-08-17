import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const allContent = html + '\n' + appJs;

test('HTML loads the application from an external module and contains no inline scripts', () => {
  assert.match(html, /<script\s+type="module"\s+src="\/js\/app\.js"><\/script>/);
  assert.match(html, /<script\s+src="\/vendor\/marked\.min\.js"><\/script>/);
  assert.match(html, /<script\s+src="\/vendor\/purify\.min\.js"><\/script>/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=/i);
    assert.equal(body.trim(), '');
  }
});

test('mobile shell exposes session state and quick terminal controls', () => {
  assert.match(allContent, /id="session-meta"/);
  assert.match(allContent, /id="send-btn"/);
  assert.match(allContent, /id="send-btn"/);
  assert.match(allContent, /id="followup-btn"/);
  assert.match(allContent, /resolveComposerPrimaryMode/);
  assert.match(allContent, /data-mode/);
  assert.doesNotMatch(html, /id="interrupt-btn"/);
  assert.match(allContent, /id="attach-btn"/);
  assert.match(allContent, /id="composer-defaults"/);
  assert.match(allContent, /id="session-settings"/);
  assert.match(appJs, /followUpVisible/);
  assert.match(appJs, /\$\('followup-btn'\)\.onclick = sendMessage/);
  assert.doesNotMatch(appJs, /async function sendMessage\(\) \{\s*if \(busy\) return;/);
});

test('client handles queued input, reconnect catch-up, status, and ANSI output', () => {
  assert.match(allContent, /case 'status'/);
  assert.match(allContent, /case 'queued_message'/);
  assert.match(allContent, /case 'dequeued_message'/);
  assert.match(allContent, /case 'tool_output_delta'/);
  assert.match(allContent, /socket\.emit\('catch-up'/);
  assert.match(allContent, /function renderAnsi/);
  assert.match(allContent, /function retryLastFailed/);
  assert.match(allContent, /function copyLatestOutput/);
  assert.match(allContent, /function setBusy\(b\)/);
  assert.match(allContent, /if \(!b\) hideTyping\(\)/);
  assert.match(allContent, /aria-live="polite"/);
});

test('client applies app-server thread status to thread and instance activity', () => {
  assert.match(allContent, /case 'thread_status'/);
  assert.match(allContent, /function handleThreadStatus\(payload\)/);
  assert.match(allContent, /from '\/js\/thread-status\.js'/);
  assert.match(allContent, /applyThreadStatus\(appThreads, payload\)/);
  assert.match(allContent, /mergeThreadList\(sessionsByCwd\.get\(cwd\) \|\| \[\], ack\.threads/);
  assert.match(allContent, /threadStatusPresentation\(/);
  assert.match(allContent, /instance\.sessionId === payload\.threadId/);
  assert.match(allContent, /statusRevision/);
  assert.match(allContent, /thread-status-dot/);
  assert.match(allContent, /scheduleThreadListRefresh\(\)/);
});

test('client applies runtime message receipt transitions to the persistent outbox', () => {
  assert.match(allContent, /case 'message_receipt'/);
  assert.match(allContent, /messageOutbox\.acceptReceipt\(ev\.payload\)/);
});

test('client reconciles optimistic and queued message bubbles by clientRequestId', () => {
  assert.match(allContent, /dataset\.clientRequestId/);
  assert.match(allContent, /promoteOfflineBubble\(clientRequestId\)/);
  assert.match(allContent, /promoteQueuedBubble\(clientRequestId/);
  assert.match(allContent, /appendUserBubble\(ev\.payload\.text, ev\.payload\.attachments, ev\.payload\.parts, ev\.payload\.clientRequestId\)/);
  assert.doesNotMatch(allContent, /offlineUserBubbles\.findIndex\(q => q\.text === text\)/);
});

test('copy buffer is restored from replayed Codex output events', () => {
  assert.match(allContent, /let latestOutputText = '';/);
  assert.match(allContent, /function rememberOutput\(text\)/);
  assert.match(allContent, /rememberOutput\(streamText\)/);
  assert.match(allContent, /rememberOutput\(msg\)/);
  assert.match(allContent, /const text = latestOutputText\.trim\(\)/);
  assert.match(allContent, /function fallbackCopyText\(text\)/);
  assert.match(allContent, /fallbackCopyText\(text\)/);
  assert.match(allContent, /function showCopyFallback\(text\)/);
  assert.match(allContent, /copy-fallback/);
});

test('mobile keyboard uses visual viewport safe area instead of fixed screen height', () => {
  assert.match(allContent, /--app-height/);
  assert.match(allContent, /--keyboard-inset/);
  assert.match(allContent, /visualViewport/);
  assert.match(allContent, /function syncVisualViewport\(\)/);
  assert.match(allContent, /resize', syncVisualViewport/);
  assert.match(allContent, /scroll', syncVisualViewport/);
});

test('client checks auth requirement before opening the socket', () => {
  assert.match(allContent, /id="auth-gate"/);
  assert.match(allContent, /id="auth-token-input"/);
  assert.match(allContent, /autoConnect: false/);
  assert.match(allContent, /function bootstrapAuth\(\)/);
  assert.match(allContent, /fetch\('\/health'/);
  assert.match(allContent, /connectSocket\(\{ allowEmpty: true \}\)/);
  assert.match(allContent, /function connectSocket\(/);
  assert.match(allContent, /bootstrapAuth\(\);/);
  assert.match(allContent, /authForm\.addEventListener\('submit'/);
  assert.match(allContent, /socket\.connect\(\)/);
  assert.match(allContent, /socket\.on\('connect_error'/);
});

test('browser exchanges the host token for an HttpOnly session without persisting it', () => {
  assert.match(allContent, /fetch\('\/auth\/session'/);
  assert.match(allContent, /credentials: 'same-origin'/);
  assert.doesNotMatch(allContent, /localStorage\.setItem\('codex_auth_token'/);
  assert.doesNotMatch(allContent, /localStorage\.getItem\('codex_auth_token'/);
  assert.doesNotMatch(allContent, /socket\.auth = \{ token: authToken/);
});

test('client creates device credentials with Web Crypto instead of Math.random', () => {
  assert.match(allContent, /crypto\.randomUUID\(\)/);
  assert.match(allContent, /crypto\.getRandomValues\(/);
  assert.doesNotMatch(allContent, /deviceToken = 'dev_' \+ Math\.random/);
});

test('client binds push subscriptions with the current auth and device credentials', () => {
  assert.match(allContent, /'x-device-token': deviceToken/);
  assert.match(allContent, /credentials: 'same-origin'/);
  assert.doesNotMatch(allContent, /fetch\('\/push\/subscribe'[\s\S]{0,300}'x-auth-token'/);
  assert.match(allContent, /if \(!subscribeResponse\.ok\)/);
});

test('command and file-change cards use structured card models', () => {
  assert.match(appJs, /from '\/js\/tool-cards\.js'/);
  assert.match(appJs, /commandCard\(/);
  assert.match(appJs, /fileChangeCard\(/);
  assert.match(appJs, /tool-card command-card/);
  assert.match(appJs, /file-change-card/);
  assert.match(appJs, /tool-exit/);
});

test('client renders rich approval, user input, and raw item cards', () => {
  assert.match(allContent, /case 'user_input_request'/);
  assert.match(allContent, /case 'raw_item'/);
  assert.match(allContent, /function renderApprovalDetails/);
  assert.match(allContent, /function handleUserInputRequest/);
  assert.match(allContent, /function handleRawItem/);
  assert.match(allContent, /payload\.changes/);
  assert.match(allContent, /payload\.permissions/);
  assert.match(allContent, /JSON\.stringify\(payload\.item/);
});

test('client marks user-input cards complete only after a successful server ACK', () => {
  const start = allContent.indexOf('function handleUserInputRequest');
  const end = allContent.indexOf('function renderQuestion', start);
  const handler = allContent.slice(start, end);
  assert.match(handler, /socket\.emit\('user:approval',[\s\S]*ack =>/);
  assert.match(handler, /if \(!ack\?\.ok\)/);
  assert.ok(handler.indexOf('if (!ack?.ok)') < handler.indexOf('markInputCardDone'));
});

test('client keeps unknown needs visible but never renders them as actionable', () => {
  const start = allContent.indexOf('function renderNeedsYouPanel');
  const end = allContent.indexOf('function openNeed', start);
  const handler = allContent.slice(start, end);
  assert.match(handler, /need\.state === 'unknown'/);
  assert.match(handler, /结果未知，等待上游终态/);
  assert.match(allContent, /need\.state !== 'pending'/);
});

test('web UI does not expose ChatGPT account login', () => {
  assert.doesNotMatch(html, /id="account-login-btn"/);
  assert.doesNotMatch(html, /id="account-login-panel"/);
  assert.doesNotMatch(html, />登录</);
  assert.doesNotMatch(allContent, /function startChatgptDeviceLogin/);
  assert.doesNotMatch(allContent, /socket\.emit\('account:loginStart'/);
  assert.doesNotMatch(allContent, /socket\.emit\('account:loginCancel'/);
  assert.match(allContent, /case 'account_login'/);
  assert.match(allContent, /case 'account_updated'/);
});

test('client renders summary and full reasoning streams separately', () => {
  assert.match(allContent, /case 'reasoning'/);
  assert.match(allContent, /function appendReasoning/);
  assert.match(allContent, /summary_part_added/);
  assert.match(allContent, /reasoning-summary/);
  assert.match(allContent, /reasoning-full/);
  assert.match(allContent, /payload\.channel/);
});

test('main chrome hides live instance tabs and keeps new session in the drawer', () => {
  assert.match(html, /id="new-session-btn"/);
  assert.match(html, /id="drawer-fab-new"/);
  assert.match(allContent, /function createNewSession/);
  assert.doesNotMatch(html, /id="instance-tabs"/);
  assert.doesNotMatch(allContent, /id="new-instance-btn"/);
  assert.doesNotMatch(allContent, /id="fork-instance-btn"/);
});

test('drawer hides the tools panel and labels conversations by project', () => {
  assert.match(html, /id="drawer-tools"[^>]*\bhidden\b/);
  assert.match(html, /id="drawer-project"/);
  assert.match(appJs, /from '\/js\/project-label\.js'/);
  assert.match(appJs, /function renderDrawerProject/);
  assert.doesNotMatch(appJs, / · native/);
});

test('opening the drawer pins projects at the top and does not start at the bottom', () => {
  assert.match(html, /#drawer \{[^}]*overflow:\s*hidden/);
  assert.match(html, /#drawer-body \{[^}]*min-height:\s*0/);
  assert.match(appJs, /function resetDrawerScroll/);
  const start = appJs.indexOf("$('menu-btn').onclick");
  const end = appJs.indexOf('function closeDrawer', start);
  assert.match(appJs.slice(start, end), /resetDrawerScroll\(\)/);
});

test('drawer lists every allowlisted workspace so the user can switch projects', () => {
  assert.match(html, /id="drawer-projects"/);
  assert.match(html, /id="drawer-body"/);
  assert.match(appJs, /function renderDrawerProjects/);
  assert.match(appJs, /function toggleDirExpand/);
  assert.match(appJs, /from '\/js\/drawer-dirs\.js'/);
  assert.match(appJs, /dir-toggle/);
  assert.match(appJs, /dir-new/);
  assert.match(appJs, /dir-subtree/);
  assert.match(appJs, /createNewSession\(btn\.dataset\.newCwd\)/);
  assert.match(appJs, /toggleDirExpand\(btn\.dataset\.cwd\)/);
});

test('header chrome uses a workspace pill, RTT chip and home/new actions', () => {
  assert.match(html, /id="thread-title"/);
  assert.match(html, /id="header-project"/);
  assert.match(html, /id="header-context"/);
  assert.match(html, /id="header-changes"/);
  assert.match(html, /id="conn-rtt"/);
  assert.match(html, /id="header-home"/);
  assert.match(html, /id="header-new"/);
  assert.match(html, /id="status-dot"/);
  assert.match(html, /id="menu-btn"/);
  assert.doesNotMatch(html, /id="header-copy"/);
  assert.doesNotMatch(html, /id="btnConsole"/);
  assert.match(allContent, /function renderThreadTitle/);
  assert.match(allContent, /新会话/);
  const headerHtml = html.slice(html.indexOf('<div id="header">'), html.indexOf('id="input-area"'));
  const inputHtml = html.slice(html.indexOf('id="input-area"'));
  assert.match(inputHtml, /id="composer-defaults"/);
  assert.doesNotMatch(headerHtml, /id="composer-defaults"/);
  assert.match(html, /id="mode-list"/);
  assert.match(appJs, /from '\/js\/header-chrome\.js'/);
  assert.match(appJs, /conn:ping/);
  assert.match(appJs, /formatRttChip/);
  assert.match(appJs, /formatWorkspaceChangeBadge/);
  assert.match(appJs, /\$\('header-home'\)\.onclick/);
  assert.match(appJs, /\$\('header-new'\)\.onclick/);
  assert.match(appJs, /\$\('header-context'\)\.onclick/);
});

test('client keeps session fork available without a main-chrome tab strip', () => {
  assert.match(allContent, /function forkCurrentSession/);
  assert.match(allContent, /socket\.emit\('session:fork'/);
});

test('client exposes P1 native app-server controls and readonly status panels', () => {
  for (const id of [
    'native-controls',
    'native-thread-refresh',
    'native-compact-btn',
    'native-rollback-btn',
    'native-models-btn',
    'native-files-btn',
    'native-account-btn',
    'native-mcp-btn',
    'native-skills-btn',
    'native-import-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  for (const event of [
    'thread:list',
    'thread:archive',
    'thread:unarchive',
    'thread:delete',
    'thread:rename',
    'thread:compact',
    'thread:rollback',
    'models:read',
    'fs:readDirectory',
    'fs:readFile',
    'account:read',
    'mcp:read',
    'skills:read',
    'externalAgentConfig:detect',
    'externalAgentConfig:import',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(allContent, /function refreshNativeThreads/);
  assert.match(allContent, /function renderNativeThreadList/);
  assert.match(allContent, /function startCompact/);
  assert.match(allContent, /function rollbackThread/);
  assert.match(allContent, /function loadNativeModels/);
  assert.match(allContent, /function openFileBrowser/);
  assert.match(allContent, /function readNativeFile/);
  assert.match(allContent, /function loadAccountPanel/);
  assert.match(allContent, /function loadMcpPanel/);
  assert.match(allContent, /function loadSkillsPanel/);
  assert.match(allContent, /function detectExternalAgentConfig/);

  for (const [id, handler] of [
    ['native-compact-btn', 'startCompact'],
    ['native-rollback-btn', 'rollbackThread'],
    ['native-models-btn', 'loadNativeModels'],
    ['native-account-btn', 'loadAccountPanel'],
    ['native-mcp-btn', 'loadMcpPanel'],
    ['native-skills-btn', 'loadSkillsPanel'],
    ['native-import-btn', 'detectExternalAgentConfig'],
  ]) {
    assert.match(allContent, new RegExp(`\\$\\('${id}'\\)\\.onclick = ${handler}`));
  }
  assert.match(allContent, /\$\('native-thread-refresh'\)\.onclick = \(\) => refreshNativeThreads\(true\)/);
  assert.match(allContent, /\$\('native-files-btn'\)\.onclick = \(\) => openFileBrowser\(serverCwd\)/);
});

test('mobile shell exposes connection banner, workspace sheet, confirm sheet and @ mention search', () => {
  const workspaceJs = readFileSync(new URL('../public/js/workspace-panel.js', import.meta.url), 'utf8');
  assert.match(html, /id="conn-banner"/);
  assert.match(html, /id="workspace-modal"/);
  assert.match(html, /id="confirm-modal"/);
  assert.match(html, /id="at-mention-popup"/);
  assert.match(html, /id="attach-preview-modal"/);
  assert.match(html, /id="push-subscribe-btn"/);
  assert.match(html, /id="header-project"/);
  assert.match(html, /highlight\.min\.js/);
  assert.match(appJs, /from '\/js\/connection-banner\.js'/);
  assert.match(appJs, /from '\/js\/workspace-panel\.js'/);
  assert.match(appJs, /from '\/js\/confirm-dialog\.js'/);
  assert.match(appJs, /files:search/);
  assert.match(workspaceJs, /git:status/);
  assert.match(appJs, /pickPastedImage/);
  assert.match(appJs, /m\.kind === 'command'/);
});

test('assistant bubbles render sanitized markdown instead of escaped plaintext', () => {
  assert.match(appJs, /from '\/js\/markdown\.js'/);
  assert.match(appJs, /function paintStreamMarkdown/);
  assert.match(appJs, /streamingEl\.innerHTML = renderMarkdown\(streamText\)/);
  assert.match(appJs, /renderMarkdown\(m\.content \|\| ''\)/);
  assert.doesNotMatch(appJs, /escHtml\(m\.content\.slice\(0, 500\)\)/);
  assert.doesNotMatch(appJs, /streamingEl\.textContent = streamText/);
});

test('client uses app-server threads as the only session drawer and history source', () => {
  assert.match(allContent, /socket\.emit\('thread:history'/);
  assert.match(allContent, /function loadNativeThreadHistory/);
  assert.match(allContent, /renderHistoryMessages/);
  assert.match(allContent, /thread:select', \{ threadId: s\.id, cwd: s\.cwd, title: s\.title \}/);
  assert.match(allContent, /loadNativeThreadHistory\(s\)/);
  assert.match(allContent, /sessionsByCwd\.get\(cwd\)/);
  assert.match(allContent, /if \(socket\.connected\) refreshNativeThreads\(\)/);
  assert.doesNotMatch(allContent, /\bcodexSessions\b/);
  assert.doesNotMatch(allContent, /socket\.emit\('session:history'/);
  assert.doesNotMatch(allContent, /socket\.emit\('session:list'/);
  assert.doesNotMatch(allContent, /case 'session_list'/);
  assert.doesNotMatch(allContent, /function handleSessionList/);
  assert.doesNotMatch(allContent, /function loadHistory/);
  assert.doesNotMatch(allContent, /source === 'codex'/);
});

test('client stores the current thread as a browser preference partitioned by cwd', () => {
  assert.match(allContent, /from '\/js\/thread-preferences\.js'/);
  assert.match(allContent, /getCurrentThread\(localStorage, serverCwd\)/);
  assert.match(allContent, /setCurrentThread\(localStorage, serverCwd, currentSessionId\)/);
  assert.match(allContent, /clearCurrentThread\(localStorage, serverCwd/);
  assert.doesNotMatch(allContent, /codex_current_session_id/);
});

test('client buffers live events while applying an epoch-aware thread/read recovery snapshot', () => {
  assert.match(allContent, /from '\/js\/recovery-state\.js'/);
  assert.match(allContent, /function requestCatchUp/);
  assert.match(allContent, /lastEpoch[,}]/);
  assert.match(allContent, /bufferRecoveryEvent\(activeRecovery, ev\)/);
  assert.match(allContent, /completeRecovery\(state, ack\)/);
  assert.match(allContent, /recovery\.snapshot\.messages/);
  assert.match(allContent, /codex_last_epoch:/);
});

test('client persists one stable message request before clearing input or draining it', () => {
  assert.match(allContent, /from '\/js\/message-request\.js'/);
  assert.match(allContent, /from '\/js\/message-outbox\.js'/);
  assert.match(allContent, /from '\/js\/indexeddb-outbox\.js'/);
  assert.match(allContent, /from '\/js\/socket-ack\.js'/);
  assert.match(allContent, /createMessageRequest\(/);
  assert.match(allContent, /await messageOutbox\.enqueue\(request\)/);
  assert.match(allContent, /emitWithAck\(socket, 'user:message', payload/);
  assert.match(allContent, /messageOutbox\.drain\(options\)/);
  assert.doesNotMatch(allContent, /\bofflineQueue\b/);

  const sendBody = allContent.slice(allContent.indexOf('async function sendMessage()'));
  assert.ok(sendBody.indexOf('await messageOutbox.enqueue(request)') < sendBody.indexOf("inputEl.value = '';"));
});

test('new messages drain the complete active view lane instead of bypassing its FIFO head', () => {
  const sendBody = allContent.slice(allContent.indexOf('async function sendMessage()'));
  assert.match(sendBody, /shouldSend: outboxRequestMatchesView/);
  assert.doesNotMatch(sendBody, /shouldSend: stored => stored\.clientRequestId === request\.clientRequestId/);
});

test('client reconciles unknown outbox results through the read-only gateway path before draining', () => {
  assert.match(allContent, /let gatewayEpoch = null;/);
  assert.match(allContent, /getGatewayEpoch: \(\) => gatewayEpoch/);
  assert.match(allContent, /reconcileTransport: async payload/);
  assert.match(allContent, /emitWithAck\(socket, 'message:reconcile'/);
  assert.match(allContent, /gatewayEpoch = payload\.gatewayEpoch/);
  assert.match(allContent, /await messageOutbox\.reconcile\(/);
  assert.match(allContent, /request\.state === 'needs_reconcile'/);
  assert.match(allContent, /结果未知/);
  assert.match(allContent, /messageOutbox\.retryAfterConfirmation\(/);
  assert.match(allContent, /再次发送可能重复执行/);
});

test('confirmed unknown retries bind a fresh request to the current view lane', () => {
  const start = allContent.indexOf('retryButton.onclick = async () =>');
  const end = allContent.indexOf("el.querySelector('.bubble')?.appendChild(retryButton);", start);
  const handler = allContent.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /const target = await ensureViewTarget\(\)/);
  assert.match(handler, /retryAfterConfirmation\(clientRequestId, \{ target \}\)/);
  assert.match(handler, /renderedOutboxIds\.delete\(clientRequestId\)/);
  assert.match(handler, /dataset\.clientRequestId = replacement\.clientRequestId/);
  assert.match(handler, /offlineUserBubbles\.splice\(/);
  assert.match(handler, /shouldSend: outboxRequestMatchesView/);
  assert.doesNotMatch(handler, /shouldSend: request => request\.clientRequestId === clientRequestId/);
});

test('client surfaces provisional orphans, reconciles attempted ones, and rebinds only unattempted ones', () => {
  assert.match(allContent, /from '\/js\/outbox-recovery\.js'/);
  assert.match(allContent, /let instanceSnapshotReceived = false/);
  assert.match(allContent, /isProvisionalInstanceOrphan\(/);

  const start = allContent.indexOf('async function syncOutboxView()');
  const end = allContent.indexOf('syncVisualViewport();', start);
  const syncBody = allContent.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(syncBody, /orphanedAttemptIds/);
  assert.match(syncBody, /shouldReconcile:[\s\S]*orphanedAttemptIds\.has/);
  assert.match(syncBody, /await ensureViewTarget\(\)/);
  assert.match(syncBody, /messageOutbox\.rebindUnattempted\(/);
  assert.match(syncBody, /restoreProvisionalOutboxTarget\(/);
  assert.match(syncBody, /unboundRecovery[,}]/);
  assert.match(syncBody, /shouldSend: outboxRequestMatchesView/);

  const instancesStart = allContent.indexOf('function handleInstances(payload)');
  const instancesEnd = allContent.indexOf('function renderInstanceTabs()', instancesStart);
  const instancesHandler = allContent.slice(instancesStart, instancesEnd);
  assert.match(instancesHandler, /instanceSnapshotReceived = true/);
  assert.match(instancesHandler, /syncOutboxView\(\)/);
});

test('client sends selected files and skills as durable structured input parts', () => {
  assert.match(allContent, /let currentInputParts = \[\]/);
  assert.match(allContent, /function addInputPart\(part\)/);
  assert.match(allContent, /addInputPart\(\{ kind: 'mention'/);
  assert.match(allContent, /addInputPart\(\{ kind: 'skill'/);
  assert.match(allContent, /createMessageRequest\(\{ text, attachments, parts, target, turn \}\)/);
  assert.doesNotMatch(allContent, /const mention = `@\$\{path\}`/);
});

test('composer settings expose CLI model, reasoning, approval and sandbox without slash messages', () => {
  assert.match(appJs, /from '\/js\/cli-settings\.js'/);
  assert.match(html, /data-testid="composer-defaults"/);
  assert.match(html, /id="session-settings"/);
  assert.match(appJs, /formatComposerPermission/);
  assert.match(appJs, /openSessionSettings/);
  assert.match(html, /id="approval-list"/);
  assert.match(html, /id="sandbox-list"/);
  assert.match(html, /id="model-list"/);
  assert.match(html, /id="reasoning-list"/);
  assert.match(allContent, /function loadComposerModels/);
  assert.match(allContent, /function renderCliSettingsPopovers/);
  assert.match(allContent, /data-approval/);
  assert.match(allContent, /data-sandbox/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/model '/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/reasoning '/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/approval-policy '/);
  assert.doesNotMatch(html, /data-value="unlessTrusted"/);
  assert.doesNotMatch(html, /data-reasoning="超高"/);
});

test('client exposes P2 admin controls behind unlock and per-action confirmation', () => {
  for (const id of [
    'native-admin-btn',
    'admin-unlock-btn',
    'admin-lock-btn',
    'admin-config-write-btn',
    'admin-config-batch-btn',
    'admin-plugin-install-btn',
    'admin-plugin-uninstall-btn',
    'admin-marketplace-add-btn',
    'admin-marketplace-remove-btn',
    'admin-marketplace-upgrade-btn',
    'admin-fs-write-btn',
    'admin-fs-remove-btn',
    'admin-fs-copy-btn',
    'admin-mcp-call-btn',
    'admin-logout-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  assert.match(allContent, /function openAdminPanel/);
  assert.match(allContent, /function unlockAdminMode/);
  assert.match(allContent, /function lockAdminMode/);
  assert.match(allContent, /function runAdminAction/);
  assert.match(allContent, /promptRequired\('Unlock phrase', 'ENABLE ADMIN'\)/);
  assert.match(allContent, /promptRequired\('Confirm action', eventName\)/);
  assert.match(allContent, /adminConfirm: confirmation/);

  for (const event of [
    'admin:unlock',
    'admin:lock',
    'admin:configWrite',
    'admin:configBatchWrite',
    'admin:pluginInstall',
    'admin:pluginUninstall',
    'admin:marketplaceAdd',
    'admin:marketplaceRemove',
    'admin:marketplaceUpgrade',
    'admin:fsWriteFile',
    'admin:fsRemove',
    'admin:fsCopy',
    'admin:mcpToolCall',
    'admin:accountLogout',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(allContent, /\$\('native-admin-btn'\)\.onclick = openAdminPanel/);
});

test('client exposes P3 experimental labs controls and isolated event renderers', () => {
  for (const id of [
    'native-p3-btn',
    'p3-capabilities-btn',
    'p3-terminal-spawn-btn',
    'p3-terminal-write-btn',
    'p3-terminal-resize-btn',
    'p3-terminal-terminate-btn',
    'p3-thread-turns-btn',
    'p3-thread-search-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  for (const event of [
    'p3:capabilities',
    'p3:terminalSpawn',
    'p3:terminalWrite',
    'p3:terminalResize',
    'p3:terminalTerminate',
    'p3:threadTurns',
    'p3:threadSearch',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  for (const type of ['term_output', 'term_exit', 'realtime', 'remote_control']) {
    assert.match(allContent, new RegExp(`case '${type}'`));
  }

  assert.match(allContent, /function openP3Panel/);
  assert.match(allContent, /function spawnP3Terminal/);
  assert.match(allContent, /function handleP3TerminalOutput/);
  assert.match(allContent, /function handleP3Realtime/);
  assert.match(allContent, /function handleP3RemoteControl/);
  assert.match(allContent, /\$\('native-p3-btn'\)\.onclick = openP3Panel/);
});
