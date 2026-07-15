import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile shell exposes session state and quick terminal controls', () => {
  assert.match(html, /id="session-meta"/);
  assert.match(html, /id="send-btn"/);
  assert.match(html, /id="interrupt-btn"/);
  assert.match(html, /id="attach-btn"/);
  assert.match(html, /id="model-trigger"/);
  assert.match(html, /id="perm-trigger"/);
});

test('client handles queued input, reconnect catch-up, status, and ANSI output', () => {
  assert.match(html, /case 'status'/);
  assert.match(html, /case 'queued_message'/);
  assert.match(html, /case 'dequeued_message'/);
  assert.match(html, /case 'tool_output_delta'/);
  assert.match(html, /socket\.emit\('catch-up'/);
  assert.match(html, /function renderAnsi/);
  assert.match(html, /function retryLastFailed/);
  assert.match(html, /function copyLatestOutput/);
  assert.match(html, /aria-live="polite"/);
});

test('client applies app-server thread status to thread and instance activity', () => {
  assert.match(html, /case 'thread_status'/);
  assert.match(html, /function handleThreadStatus\(payload\)/);
  assert.match(html, /from '\/js\/thread-status\.js'/);
  assert.match(html, /applyThreadStatus\(appThreads, payload\)/);
  assert.match(html, /mergeThreadList\(appThreads, ack\.threads/);
  assert.match(html, /threadStatusPresentation\(/);
  assert.match(html, /instance\.sessionId === payload\.threadId/);
  assert.match(html, /statusRevision/);
  assert.match(html, /thread-status-dot/);
  assert.match(html, /scheduleThreadListRefresh\(\)/);
});

test('client applies runtime message receipt transitions to the persistent outbox', () => {
  assert.match(html, /case 'message_receipt'/);
  assert.match(html, /messageOutbox\.acceptReceipt\(ev\.payload\)/);
});

test('client reconciles optimistic and queued message bubbles by clientRequestId', () => {
  assert.match(html, /dataset\.clientRequestId/);
  assert.match(html, /promoteOfflineBubble\(clientRequestId\)/);
  assert.match(html, /promoteQueuedBubble\(clientRequestId/);
  assert.match(html, /appendUserBubble\(ev\.payload\.text, ev\.payload\.attachments, ev\.payload\.parts, ev\.payload\.clientRequestId\)/);
  assert.doesNotMatch(html, /offlineUserBubbles\.findIndex\(q => q\.text === text\)/);
});

test('copy buffer is restored from replayed Codex output events', () => {
  assert.match(html, /let latestOutputText = '';/);
  assert.match(html, /function rememberOutput\(text\)/);
  assert.match(html, /rememberOutput\(streamText\)/);
  assert.match(html, /rememberOutput\(msg\)/);
  assert.match(html, /const text = latestOutputText\.trim\(\)/);
  assert.match(html, /function fallbackCopyText\(text\)/);
  assert.match(html, /fallbackCopyText\(text\)/);
  assert.match(html, /function showCopyFallback\(text\)/);
  assert.match(html, /copy-fallback/);
});

test('mobile keyboard uses visual viewport safe area instead of fixed screen height', () => {
  assert.match(html, /--app-height/);
  assert.match(html, /--keyboard-inset/);
  assert.match(html, /visualViewport/);
  assert.match(html, /function syncVisualViewport\(\)/);
  assert.match(html, /resize', syncVisualViewport/);
  assert.match(html, /scroll', syncVisualViewport/);
});

test('client checks auth requirement before opening the socket', () => {
  assert.match(html, /id="auth-gate"/);
  assert.match(html, /id="auth-token-input"/);
  assert.match(html, /autoConnect: false/);
  assert.match(html, /function bootstrapAuth\(\)/);
  assert.match(html, /fetch\('\/health'/);
  assert.match(html, /connectSocket\(\{ allowEmpty: true \}\)/);
  assert.match(html, /function connectSocket\(/);
  assert.match(html, /bootstrapAuth\(\);/);
  assert.match(html, /authForm\.addEventListener\('submit'/);
  assert.match(html, /socket\.connect\(\)/);
  assert.match(html, /socket\.on\('connect_error'/);
});

test('browser exchanges the host token for an HttpOnly session without persisting it', () => {
  assert.match(html, /fetch\('\/auth\/session'/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.doesNotMatch(html, /localStorage\.setItem\('codex_auth_token'/);
  assert.doesNotMatch(html, /localStorage\.getItem\('codex_auth_token'/);
  assert.doesNotMatch(html, /socket\.auth = \{ token: authToken/);
});

test('client creates device credentials with Web Crypto instead of Math.random', () => {
  assert.match(html, /crypto\.randomUUID\(\)/);
  assert.match(html, /crypto\.getRandomValues\(/);
  assert.doesNotMatch(html, /deviceToken = 'dev_' \+ Math\.random/);
});

test('client binds push subscriptions with the current auth and device credentials', () => {
  assert.match(html, /'x-device-token': deviceToken/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.doesNotMatch(html, /fetch\('\/push\/subscribe'[\s\S]{0,300}'x-auth-token'/);
  assert.match(html, /if \(!subscribeResponse\.ok\)/);
});

test('client renders rich approval, user input, and raw item cards', () => {
  assert.match(html, /case 'user_input_request'/);
  assert.match(html, /case 'raw_item'/);
  assert.match(html, /function renderApprovalDetails/);
  assert.match(html, /function handleUserInputRequest/);
  assert.match(html, /function handleRawItem/);
  assert.match(html, /payload\.changes/);
  assert.match(html, /payload\.permissions/);
  assert.match(html, /JSON\.stringify\(payload\.item/);
});

test('client marks user-input cards complete only after a successful server ACK', () => {
  const start = html.indexOf('function handleUserInputRequest');
  const end = html.indexOf('function renderQuestion', start);
  const handler = html.slice(start, end);
  assert.match(handler, /socket\.emit\('user:approval',[\s\S]*ack =>/);
  assert.match(handler, /if \(!ack\?\.ok\)/);
  assert.ok(handler.indexOf('if (!ack?.ok)') < handler.indexOf('markInputCardDone'));
});

test('client keeps unknown needs visible but never renders them as actionable', () => {
  const start = html.indexOf('function renderNeedsYouPanel');
  const end = html.indexOf('function openNeed', start);
  const handler = html.slice(start, end);
  assert.match(handler, /need\.state === 'unknown'/);
  assert.match(handler, /结果未知，等待上游终态/);
  assert.match(html, /need\.state !== 'pending'/);
});

test('client renders ChatGPT device-code login envelopes', () => {
  assert.match(html, /id="account-login-btn"/);
  assert.match(html, /id="account-login-panel"/);
  assert.match(html, /case 'account_login'/);
  assert.match(html, /case 'account_updated'/);
  assert.match(html, /function startChatgptDeviceLogin/);
  assert.match(html, /function handleAccountLogin/);
  assert.match(html, /function handleAccountUpdated/);
  assert.match(html, /socket\.emit\('account:loginStart'/);
  assert.match(html, /socket\.emit\('account:loginCancel'/);
});

test('client renders summary and full reasoning streams separately', () => {
  assert.match(html, /case 'reasoning'/);
  assert.match(html, /function appendReasoning/);
  assert.match(html, /summary_part_added/);
  assert.match(html, /reasoning-summary/);
  assert.match(html, /reasoning-full/);
  assert.match(html, /payload\.channel/);
});

test('client exposes session fork control', () => {
  assert.match(html, /fork-instance-btn/);
  assert.match(html, /function forkCurrentSession/);
  assert.match(html, /socket\.emit\('session:fork'/);
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
    assert.match(html, new RegExp(`id="${id}"`));
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
    assert.match(html, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(html, /function refreshNativeThreads/);
  assert.match(html, /function renderNativeThreadList/);
  assert.match(html, /function startCompact/);
  assert.match(html, /function rollbackThread/);
  assert.match(html, /function loadNativeModels/);
  assert.match(html, /function openFileBrowser/);
  assert.match(html, /function readNativeFile/);
  assert.match(html, /function loadAccountPanel/);
  assert.match(html, /function loadMcpPanel/);
  assert.match(html, /function loadSkillsPanel/);
  assert.match(html, /function detectExternalAgentConfig/);

  for (const [id, handler] of [
    ['native-compact-btn', 'startCompact'],
    ['native-rollback-btn', 'rollbackThread'],
    ['native-models-btn', 'loadNativeModels'],
    ['native-account-btn', 'loadAccountPanel'],
    ['native-mcp-btn', 'loadMcpPanel'],
    ['native-skills-btn', 'loadSkillsPanel'],
    ['native-import-btn', 'detectExternalAgentConfig'],
  ]) {
    assert.match(html, new RegExp(`\\$\\('${id}'\\)\\.onclick = ${handler}`));
  }
  assert.match(html, /\$\('native-thread-refresh'\)\.onclick = \(\) => refreshNativeThreads\(true\)/);
  assert.match(html, /\$\('native-files-btn'\)\.onclick = \(\) => openFileBrowser\(serverCwd\)/);
});

test('client uses app-server threads as the only session drawer and history source', () => {
  assert.match(html, /socket\.emit\('thread:history'/);
  assert.match(html, /function loadNativeThreadHistory/);
  assert.match(html, /renderHistoryMessages/);
  assert.match(html, /thread:select', \{ threadId: s\.id, cwd: s\.cwd, title: s\.title \}/);
  assert.match(html, /loadNativeThreadHistory\(s\)/);
  assert.match(html, /const allItems = appThreads\.filter/);
  assert.match(html, /if \(socket\.connected\) refreshNativeThreads\(\)/);
  assert.doesNotMatch(html, /\bcodexSessions\b/);
  assert.doesNotMatch(html, /socket\.emit\('session:history'/);
  assert.doesNotMatch(html, /socket\.emit\('session:list'/);
  assert.doesNotMatch(html, /case 'session_list'/);
  assert.doesNotMatch(html, /function handleSessionList/);
  assert.doesNotMatch(html, /function loadHistory/);
  assert.doesNotMatch(html, /source === 'codex'/);
});

test('client stores the current thread as a browser preference partitioned by cwd', () => {
  assert.match(html, /from '\/js\/thread-preferences\.js'/);
  assert.match(html, /getCurrentThread\(localStorage, serverCwd\)/);
  assert.match(html, /setCurrentThread\(localStorage, serverCwd, currentSessionId\)/);
  assert.match(html, /clearCurrentThread\(localStorage, serverCwd/);
  assert.doesNotMatch(html, /codex_current_session_id/);
});

test('client buffers live events while applying an epoch-aware thread/read recovery snapshot', () => {
  assert.match(html, /from '\/js\/recovery-state\.js'/);
  assert.match(html, /function requestCatchUp/);
  assert.match(html, /lastEpoch[,}]/);
  assert.match(html, /bufferRecoveryEvent\(activeRecovery, ev\)/);
  assert.match(html, /completeRecovery\(state, ack\)/);
  assert.match(html, /recovery\.snapshot\.messages/);
  assert.match(html, /codex_last_epoch:/);
});

test('client persists one stable message request before clearing input or draining it', () => {
  assert.match(html, /from '\/js\/message-request\.js'/);
  assert.match(html, /from '\/js\/message-outbox\.js'/);
  assert.match(html, /from '\/js\/indexeddb-outbox\.js'/);
  assert.match(html, /from '\/js\/socket-ack\.js'/);
  assert.match(html, /createMessageRequest\(/);
  assert.match(html, /await messageOutbox\.enqueue\(request\)/);
  assert.match(html, /emitWithAck\(socket, 'user:message', payload/);
  assert.match(html, /messageOutbox\.drain\(options\)/);
  assert.doesNotMatch(html, /\bofflineQueue\b/);

  const sendBody = html.slice(html.indexOf('async function sendMessage()'));
  assert.ok(sendBody.indexOf('await messageOutbox.enqueue(request)') < sendBody.indexOf("inputEl.value = '';"));
});

test('new messages drain the complete active view lane instead of bypassing its FIFO head', () => {
  const sendBody = html.slice(html.indexOf('async function sendMessage()'));
  assert.match(sendBody, /shouldSend: outboxRequestMatchesView/);
  assert.doesNotMatch(sendBody, /shouldSend: stored => stored\.clientRequestId === request\.clientRequestId/);
});

test('client reconciles unknown outbox results through the read-only gateway path before draining', () => {
  assert.match(html, /let gatewayEpoch = null;/);
  assert.match(html, /getGatewayEpoch: \(\) => gatewayEpoch/);
  assert.match(html, /reconcileTransport: async payload/);
  assert.match(html, /emitWithAck\(socket, 'message:reconcile'/);
  assert.match(html, /gatewayEpoch = payload\.gatewayEpoch/);
  assert.match(html, /await messageOutbox\.reconcile\(/);
  assert.match(html, /request\.state === 'needs_reconcile'/);
  assert.match(html, /结果未知/);
  assert.match(html, /messageOutbox\.retryAfterConfirmation\(/);
  assert.match(html, /再次发送可能重复执行/);
});

test('confirmed unknown retries bind a fresh request to the current view lane', () => {
  const start = html.indexOf('retryButton.onclick = async () =>');
  const end = html.indexOf("el.querySelector('.bubble')?.appendChild(retryButton);", start);
  const handler = html.slice(start, end);

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
  assert.match(html, /from '\/js\/outbox-recovery\.js'/);
  assert.match(html, /let instanceSnapshotReceived = false/);
  assert.match(html, /isProvisionalInstanceOrphan\(/);

  const start = html.indexOf('async function syncOutboxView()');
  const end = html.indexOf('syncVisualViewport();', start);
  const syncBody = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(syncBody, /orphanedAttemptIds/);
  assert.match(syncBody, /shouldReconcile:[\s\S]*orphanedAttemptIds\.has/);
  assert.match(syncBody, /await ensureViewTarget\(\)/);
  assert.match(syncBody, /messageOutbox\.rebindUnattempted\(/);
  assert.match(syncBody, /restoreProvisionalOutboxTarget\(/);
  assert.match(syncBody, /unboundRecovery[,}]/);
  assert.match(syncBody, /shouldSend: outboxRequestMatchesView/);

  const instancesStart = html.indexOf('function handleInstances(payload)');
  const instancesEnd = html.indexOf('function renderInstanceTabs()', instancesStart);
  const instancesHandler = html.slice(instancesStart, instancesEnd);
  assert.match(instancesHandler, /instanceSnapshotReceived = true/);
  assert.match(instancesHandler, /syncOutboxView\(\)/);
});

test('client sends selected files and skills as durable structured input parts', () => {
  assert.match(html, /let currentInputParts = \[\]/);
  assert.match(html, /function addInputPart\(part\)/);
  assert.match(html, /addInputPart\(\{ kind: 'mention'/);
  assert.match(html, /addInputPart\(\{ kind: 'skill'/);
  assert.match(html, /createMessageRequest\(\{ text, attachments, parts, target \}\)/);
  assert.doesNotMatch(html, /const mention = `@\$\{path\}`/);
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
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /function openAdminPanel/);
  assert.match(html, /function unlockAdminMode/);
  assert.match(html, /function lockAdminMode/);
  assert.match(html, /function runAdminAction/);
  assert.match(html, /promptRequired\('Unlock phrase', 'ENABLE ADMIN'\)/);
  assert.match(html, /promptRequired\('Confirm action', eventName\)/);
  assert.match(html, /adminConfirm: confirmation/);

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
    assert.match(html, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(html, /\$\('native-admin-btn'\)\.onclick = openAdminPanel/);
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
    assert.match(html, new RegExp(`id="${id}"`));
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
    assert.match(html, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  for (const type of ['term_output', 'term_exit', 'realtime', 'remote_control']) {
    assert.match(html, new RegExp(`case '${type}'`));
  }

  assert.match(html, /function openP3Panel/);
  assert.match(html, /function spawnP3Terminal/);
  assert.match(html, /function handleP3TerminalOutput/);
  assert.match(html, /function handleP3Realtime/);
  assert.match(html, /function handleP3RemoteControl/);
  assert.match(html, /\$\('native-p3-btn'\)\.onclick = openP3Panel/);
});
