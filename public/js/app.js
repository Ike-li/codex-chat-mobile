import { bindThreadFromEvent, eventMatchesTarget, withTarget } from '/js/view-routing.js';
import { clearCurrentThread, getCurrentThread, setCurrentThread } from '/js/thread-preferences.js';
import { bufferRecoveryEvent, completeRecovery, createRecoveryState } from '/js/recovery-state.js';
import { createMessageRequest, messageWirePayload } from '/js/message-request.js';
import { createMessageOutbox } from '/js/message-outbox.js';
import { createIndexedDbMessageStore } from '/js/indexeddb-outbox.js';
import { isDefinitelyUnattempted, isProvisionalInstanceOrphan } from '/js/outbox-recovery.js';
import { emitWithAck } from '/js/socket-ack.js';
import {
  applyThreadStatus,
  mergeThreadList,
  threadStatusPresentation,
} from '/js/thread-status.js';
import { resolveComposerPrimaryMode } from '/js/composer-mode.js';
import { projectLabel } from '/js/project-label.js';
import { loadExpandedDirs, persistExpandedDirs, toggleExpandedDir } from '/js/drawer-dirs.js';
import { renderMarkdown } from '/js/markdown.js';
import { createTranscriptStream } from '/js/transcript-stream.js';
import { commandCard, fileChangeCard } from '/js/tool-cards.js';
import { resolveConnectionBanner } from '/js/connection-banner.js';
import { formatRttChip, formatWorkspaceChangeBadge } from '/js/header-chrome.js';
import { createConfirmController } from '/js/confirm-dialog.js';
import { detectAtMentionQuery, applyAtMentionPick, mentionPartFromSearchHit } from '/js/at-mention.js';
import { pickPastedImage, attachmentPreview } from '/js/attachments-ui.js';
import { createWorkspacePanel } from '/js/workspace-panel.js';
import {
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  clampEffortForModel,
  clampServiceTierForModel,
  formatModelBadge,
  formatPermissionBadge,
  formatComposerPermission,
  formatComposerModel,
  formatComposerEffort,
  formatComposerMode,
  normalizeCollaborationMode,
  parseCollaborationModeSlash,
  loadCliSettings,
  reasoningOptionsForModel,
  resolveSelectedModel,
  saveCliSettings,
  sanitizeTurnOverrides,
  serviceTiersForModel,
  visibleModels,
} from '/js/cli-settings.js';

(function() {
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages');
  const turnAnnouncer = $('turn-announcer');
  const inputEl = $('msg-input');
  const sendBtn = $('send-btn');
  const jumpToLatestBtn = $('jump-to-latest');
  const attachBtn = $('attach-btn');
  const fileInput = $('file-input');
  const attachTray = $('attach-tray');
  const copyLatestBtn = $('copy-latest-btn');
  const retryLastBtn = $('retry-last-btn');
  const statusDot = $('status-dot');
  const stateLabel = $('state-label');
  const sessionMetaEl = $('session-meta');
  const statusDetail = $('status-detail');
  const drawerOverlay = $('drawer-overlay');
  const drawer = $('drawer');

  const pendingPanel = $('pending-panel');
  const needsYouPanel = $('needs-you-panel');
  const nativePanel = $('native-panel');
  const authGate = $('auth-gate');
  const authForm = $('auth-form');
  const authTokenInput = $('auth-token-input');
  const authError = $('auth-error');
  const deviceAuth = $('device-auth');
  const confirmDialog = createConfirmController({
    modal: $('confirm-modal'),
    titleEl: $('confirm-title'),
    bodyEl: $('confirm-body'),
    inputWrap: $('confirm-input-wrap'),
    inputEl: $('confirm-input'),
    okBtn: $('confirm-ok'),
    cancelBtn: $('confirm-cancel'),
  });
  const connBanner = $('conn-banner');
  const connBannerText = $('conn-banner-text');
  const connBannerDetail = $('conn-banner-detail');
  const connBannerSpinner = $('conn-banner-spinner');
  const connBannerRetry = $('conn-banner-retry');
  const atMentionPopup = $('at-mention-popup');
  let connPhase = 'connecting';
  let connSince = Date.now();
  let connBannerWasVisible = false;
  let connBannerTimer = null;
  let atMentionReqId = 0;
  const deviceIdDisplay = $('device-id-display');

  // Device token
  let deviceToken = localStorage.getItem('codex_device_token');
  if (!deviceToken) {
    deviceToken = createDeviceToken();
    localStorage.setItem('codex_device_token', deviceToken);
  }
  deviceIdDisplay.textContent = deviceToken;

  function createDeviceToken() {
    if (!globalThis.crypto?.getRandomValues) throw new Error('Web Crypto is required for device credentials');
    if (typeof crypto.randomUUID === 'function') return `dev_${crypto.randomUUID()}`;
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return `dev_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  const searchParams = new URLSearchParams(location.search);
  const urlToken = searchParams.get('token') || '';
  let pendingNeedsYouDeepLink = searchParams.get('thread') && searchParams.get('need')
    ? { threadId: searchParams.get('thread'), needId: searchParams.get('need') }
    : null;
  let authToken = urlToken;
  if (urlToken) {
    searchParams.delete('token');
    const nextSearch = searchParams.toString();
    history.replaceState(null, '', `${location.pathname}${nextSearch ? '?' + nextSearch : ''}${location.hash}`);
  }

  // State
  let busy = false;
  let interruptPending = false;
  let streamingEl = null;
  const TRANSCRIPT_FOLLOW_DISTANCE_PX = 80;
  let followTranscript = true;
  let activeAssistantTurnEl = null;
  const transcriptStream = createTranscriptStream({
    onStart() {
      setBusy(true);
      hideTyping();
      const bubble = document.createElement('div');
      bubble.className = 'bubble md';
      bubble.dataset.streaming = 'true';
      streamingEl = bubble;
      appendRaw(bubble, 'codex');
      scrollBottom();
    },
    onText(text) {
      if (!streamingEl) return;
      streamingEl.textContent = text;
      scrollBottom();
    },
    onFinish(text) {
      if (!streamingEl) return;
      streamingEl.innerHTML = renderMarkdown(text);
      delete streamingEl.dataset.streaming;
      streamingEl = null;
      scrollBottom();
    },
  });
  let currentSessionId = null;
  let appThreads = [];
  let sessionsByCwd = new Map();
  let expandedDirs = new Set();
  let showArchivedThreads = false;
  let features = { admin: false, labs: false };
  let adminUnlocked = false;
  let pendingToolCards = {}; // toolUseId -> element
  let pendingApprovalCards = {}; // approvalId -> element
  let needsYouRevision = 0;
  let needsYou = new Map();
  let queuedUserBubbles = [];
  let seenEvents = new Set();
  let sessionStatus = null;
  let serverCwd = '';
  let gatewayEpoch = null;
  let workDirs = [];
  let versions = {};
  let activeTurnText = '';
  let lastFailedText = '';
  let latestOutputText = '';
  let currentAttachments = []; // [{name, mimeType, data: base64}]
  let currentInputParts = []; // server-validated mention / skill / imageUrl descriptors
  let instanceList = [];
  let instanceSnapshotReceived = false;
  let currentViewingId = null;
  let offlineUserBubbles = []; // [{text, el}]
  let renderedOutboxIds = new Set();
  let restoringThreadId = null;
  let activeRecovery = null;
  let targetSetupPromise = null;
  let outboxSyncPromise = null;
  let outboxSyncRequested = false;
  let threadRefreshTimer = null;

  function viewTarget() {
    return { instanceId: currentViewingId, threadId: currentSessionId };
  }

  function rememberCurrentThread(threadId) {
    currentSessionId = typeof threadId === 'string' && threadId ? threadId : null;
    if (currentSessionId) setCurrentThread(localStorage, serverCwd, currentSessionId);
    else clearCurrentThread(localStorage, serverCwd);
  }

  function applyTargetAck(ack) {
    if (!ack?.ok) return false;
    restoringThreadId = null;
    activeRecovery = null;
    if (ack.cwd) {
      serverCwd = ack.cwd;
      expandedDirs.add(ack.cwd);
      persistExpandedDirs(localStorage, expandedDirs);
      if (sessionsByCwd.has(ack.cwd)) appThreads = sessionsByCwd.get(ack.cwd);
      const sel = $('workdir-select');
      if (sel) sel.value = ack.cwd;
      renderDrawerProject();
    }
    if (Object.prototype.hasOwnProperty.call(ack, 'instanceId')) currentViewingId = ack.instanceId || null;
    if (Object.prototype.hasOwnProperty.call(ack, 'threadId')) rememberCurrentThread(ack.threadId);
    renderInstanceTabs();
    renderSessionMeta();
    return true;
  }

  function ensureViewTarget() {
    if (currentViewingId) return Promise.resolve(viewTarget());
    if (targetSetupPromise) return targetSetupPromise;
    const event = currentSessionId ? 'thread:select' : 'session:new';
    const payload = currentSessionId
      ? { threadId: currentSessionId, cwd: serverCwd, title: currentSessionId.slice(0, 8) }
      : { cwd: serverCwd };
    targetSetupPromise = new Promise((resolve, reject) => {
      socket.emit(event, payload, ack => {
        if (!applyTargetAck(ack)) return reject(new Error(ack?.error || '无法建立会话目标'));
        resolve(viewTarget());
      });
    }).finally(() => {
      targetSetupPromise = null;
    });
    return targetSetupPromise;
  }

  function restoreProvisionalOutboxTarget(instanceId) {
    return new Promise((resolve, reject) => {
      socket.emit('session:switch', { instanceId }, ack => {
        if (!applyTargetAck(ack)) return reject(new Error(ack?.error || '无法恢复消息会话目标'));
        resolve(viewTarget());
      });
    });
  }

  function restoreCurrentThreadFromPreference() {
    if (!socket.connected || currentViewingId || restoringThreadId) return false;
    const threadId = getCurrentThread(localStorage, serverCwd);
    if (!threadId) return false;
    const restoreCwd = serverCwd;
    restoringThreadId = threadId;
    socket.emit('thread:history', { threadId, cwd: restoreCwd }, history => {
      if (restoringThreadId !== threadId || serverCwd !== restoreCwd) return;
      if (!history?.ok || history.thread?.id !== threadId) {
        clearCurrentThread(localStorage, restoreCwd, threadId);
        currentSessionId = null;
        restoringThreadId = null;
        renderSessionMeta();
        syncOutboxView();
        return;
      }
      socket.emit('thread:select', {
        threadId,
        cwd: restoreCwd,
        title: history.thread?.name || history.thread?.preview || threadId.slice(0, 8),
      }, ack => {
        if (restoringThreadId !== threadId || serverCwd !== restoreCwd) return;
        restoringThreadId = null;
        if (!applyTargetAck(ack)) {
          clearCurrentThread(localStorage, restoreCwd, threadId);
          currentSessionId = null;
          appendSystem(ack?.error || 'Thread restore failed', true);
          syncOutboxView();
          return;
        }
        clearMessages();
        renderHistoryMessages(
          history.messages || [],
          history.thread?.name || history.thread?.preview || 'Native thread',
        );
        requestCatchUp();
        syncOutboxView();
      });
    });
    return true;
  }

  function requestCatchUp() {
    const target = viewTarget();
    if (!socket.connected || !target.instanceId || !target.threadId) return;
    const lastSeq = Number(localStorage.getItem(`codex_last_seq:${target.threadId}`) || 0);
    const lastEpoch = localStorage.getItem(`codex_last_epoch:${target.threadId}`) || '';
    if (lastSeq <= 0 && !lastEpoch) return;

    const state = createRecoveryState(target);
    activeRecovery = state;
    socket.emit('catch-up', {
      instanceId: target.instanceId,
      sessionId: target.threadId,
      lastSeq,
      lastEpoch,
    }, ack => {
      if (activeRecovery !== state) return;
      activeRecovery = null;
      const recovery = completeRecovery(state, ack);
      if (!recovery.accepted) return;
      if (recovery.gap && !recovery.rebuilt) {
        appendSystem(`重连恢复失败：${ack?.recoveryError || 'thread/read unavailable'}`, true);
      }
      if (recovery.rebuilt) {
        clearMessages();
        renderHistoryMessages(recovery.snapshot.messages || [], recovery.snapshot.title || 'Recovered thread');
        if (recovery.snapshot.threadStatus) {
          handleThreadStatus({ threadId: target.threadId, status: recovery.snapshot.threadStatus });
        }
        localStorage.setItem(`codex_last_seq:${target.threadId}`, String(recovery.throughSeq));
      }
      if (recovery.epoch) {
        localStorage.setItem(`codex_last_epoch:${target.threadId}`, recovery.epoch);
      }
      for (const event of recovery.events) processAgentEvent(event);
    });
  }

  // Socket
  const socket = io({ autoConnect: false, auth: { deviceToken } });
  const isTransportConnected = () => socket.connected && navigator.onLine !== false;

  function overlayBlocksBanner() {
    return authGate?.classList.contains('show') || deviceAuth?.classList.contains('show');
  }

  function paintConnectionBanner() {
    const view = resolveConnectionBanner({
      phase: connPhase,
      elapsedMs: Date.now() - connSince,
      suppressed: overlayBlocksBanner(),
      wasVisible: connBannerWasVisible,
    });
    if (!connBanner) return;
    if (!view) {
      connBanner.hidden = true;
      return;
    }
    connBannerWasVisible = true;
    connBanner.hidden = false;
    connBanner.dataset.tone = view.tone;
    if (connBannerText) connBannerText.textContent = view.label;
    if (connBannerDetail) {
      connBannerDetail.textContent = view.detail || '';
      connBannerDetail.hidden = !view.detail;
    }
    if (connBannerSpinner) connBannerSpinner.hidden = !view.spinner;
    if (connBannerRetry) connBannerRetry.hidden = !view.retry;
  }

  function setConnectionPhase(phase) {
    if (phase !== connPhase) {
      if (phase === 'online') connBannerWasVisible = !connBanner?.hidden;
      else connBannerWasVisible = false;
      connPhase = phase;
      connSince = Date.now();
    }
    paintConnectionBanner();
    if (connBannerTimer) clearInterval(connBannerTimer);
    connBannerTimer = setInterval(paintConnectionBanner, 500);
  }

  const workspacePanel = createWorkspacePanel({
    modal: $('workspace-modal'),
    filesTab: $('workspace-tab-files'),
    changesTab: $('workspace-tab-changes'),
    filesTools: $('workspace-files-tools'),
    gitTools: $('workspace-git-tools'),
    filesBody: $('file-browse-body'),
    changesBody: $('git-changes-body'),
    pathEl: $('file-browse-path'),
    backBtn: $('file-browse-back'),
    gitBranchEl: $('git-changes-branch'),
    socket,
    getCwd: () => serverCwd,
    escHtml,
    onMention(path) {
      addInputPart({ kind: 'mention', name: path.split('/').pop() || path, path });
      workspacePanel.close();
      inputEl.focus();
    },
  });
  $('workspace-close')?.addEventListener('click', () => workspacePanel.close());
  $('git-changes-refresh')?.addEventListener('click', () => workspacePanel.refreshGit());
  $('workspace-modal')?.addEventListener('click', event => {
    if (event.target === $('workspace-modal')) workspacePanel.close();
  });
  connBannerRetry?.addEventListener('click', () => {
    if (!socket.connected) socket.connect();
  });
  const outboxStore = createIndexedDbMessageStore();
  const messageOutbox = createMessageOutbox({
    store: outboxStore,
    isConnected: isTransportConnected,
    getGatewayEpoch: () => gatewayEpoch,
    transport: async payload => {
      const ack = await emitWithAck(socket, 'user:message', payload, { timeoutMs: 10000 });
      const target = viewTarget();
      const payloadThreadId = payload?.threadId || null;
      const payloadInstanceId = payload?.instanceId || null;
      const isCurrentTarget = (
        (!target.threadId && !target.instanceId && !payloadThreadId && !payloadInstanceId)
        || (target.threadId && (payloadThreadId === target.threadId || ack?.threadId === target.threadId))
        || (!target.threadId && target.instanceId
          && (payloadInstanceId === target.instanceId || ack?.instanceId === target.instanceId))
      );
      if (ack?.ok && isCurrentTarget) applyTargetAck(ack);
      return ack;
    },
    reconcileTransport: async payload => emitWithAck(socket, 'message:reconcile', {
      ...payload,
      cwd: serverCwd,
    }, { timeoutMs: 10000 }),
  });
  const outboxReady = outboxStore.recoverInterrupted().then(() => true).catch(error => {
    appendSystem(`消息存储不可用：${error.message}`, true);
    return false;
  });

  async function drainMessageOutbox(options = {}) {
    if (!await outboxReady) return;
    try {
      await messageOutbox.drain(options);
    } catch (error) {
      appendSystem(`消息队列处理失败：${error.message}`, true);
    }
  }

  function outboxRequestMatchesView(request) {
    const payload = request?.payload || {};
    if (payload.threadId) return payload.threadId === currentSessionId;
    if (payload.instanceId) return payload.instanceId === currentViewingId;
    return !currentSessionId && !currentViewingId;
  }

  function outboxRequestIsOrphaned(request) {
    return isProvisionalInstanceOrphan(request, {
      currentInstanceId: currentViewingId,
      instanceSnapshotReceived,
      activeInstanceIds: instanceList.map(instance => instance.instanceId),
    });
  }

  async function syncOutboxView() {
    outboxSyncRequested = true;
    if (outboxSyncPromise) return outboxSyncPromise;
    outboxSyncPromise = (async () => {
      while (outboxSyncRequested) {
        outboxSyncRequested = false;
        await syncOutboxViewOnce();
      }
    })().finally(() => {
      outboxSyncPromise = null;
    });
    return outboxSyncPromise;
  }

  async function syncOutboxViewOnce() {
    if (!await outboxReady) return;
    try {
      let requests = await outboxStore.list();
      let visibleRequests = requests.filter(outboxRequestMatchesView);
      let orphanedRequests = requests.filter(outboxRequestIsOrphaned);
      const visibleRequestIds = new Set(visibleRequests.map(request => request.clientRequestId));
      const orphanedAttemptIds = new Set(orphanedRequests
        .filter(request => !isDefinitelyUnattempted(request))
        .map(request => request.clientRequestId));
      if (isTransportConnected()) {
        await messageOutbox.reconcile({
          shouldReconcile: request => visibleRequestIds.has(request.clientRequestId)
            || orphanedAttemptIds.has(request.clientRequestId),
        });
        requests = await outboxStore.list();
        const remainingIds = new Set(requests.map(request => request.clientRequestId));
        for (const clientRequestId of [...visibleRequestIds, ...orphanedAttemptIds]) {
          if (!remainingIds.has(clientRequestId)) {
            if (!promoteOfflineBubble(clientRequestId)) promoteQueuedBubble(clientRequestId, '');
          }
        }

        if (!currentViewingId && !currentSessionId && !restoringThreadId) {
          const activeInstanceIds = new Set(instanceList.map(instance => instance.instanceId));
          const restorable = requests.find(request => (
            isDefinitelyUnattempted(request)
            && request.payload?.instanceId
            && !request.payload?.threadId
            && activeInstanceIds.has(request.payload.instanceId)
          ));
          if (restorable) {
            await restoreProvisionalOutboxTarget(restorable.payload.instanceId);
            requests = await outboxStore.list();
          }
        }

        orphanedRequests = requests.filter(outboxRequestIsOrphaned);
        const unattemptedOrphans = orphanedRequests.filter(isDefinitelyUnattempted);
        if (unattemptedOrphans.length) {
          try {
            const target = await ensureViewTarget();
            for (const request of unattemptedOrphans) {
              await messageOutbox.rebindUnattempted(request.clientRequestId, target);
            }
            requests = await outboxStore.list();
          } catch (error) {
            appendSystem(`消息目标恢复失败：${error.message}`, true);
          }
        }
      }

      visibleRequests = requests.filter(outboxRequestMatchesView);
      orphanedRequests = requests.filter(outboxRequestIsOrphaned);
      const untargetedRequests = visibleRequests.filter(request => (
        isDefinitelyUnattempted(request)
        && !request.payload?.threadId
        && !request.payload?.instanceId
      ));
      if (isTransportConnected() && untargetedRequests.length && !currentSessionId && !currentViewingId) {
        try {
          const target = await ensureViewTarget();
          for (const request of untargetedRequests) {
            await messageOutbox.rebindUnattempted(request.clientRequestId, target);
          }
          requests = await outboxStore.list();
          visibleRequests = requests.filter(outboxRequestMatchesView);
          orphanedRequests = requests.filter(outboxRequestIsOrphaned);
        } catch (error) {
          appendSystem(`消息目标恢复失败：${error.message}`, true);
        }
      }
      const orphanedRequestIds = new Set(orphanedRequests.map(request => request.clientRequestId));
      const displayRequests = requests.filter(request => (
        outboxRequestMatchesView(request) || orphanedRequestIds.has(request.clientRequestId)
      ));
      for (const request of displayRequests) {
        if (renderedOutboxIds.has(request.clientRequestId)) continue;
        const payload = messageWirePayload(request);
        const unboundRecovery = orphanedRequestIds.has(request.clientRequestId);
        if (request.state === 'queued' && !unboundRecovery) {
          appendQueuedBubble({ ...payload, ...(request.receipt || {}) });
        } else {
          appendOfflineBubble(payload, {
            needsReconcile: request.state === 'needs_reconcile',
            unboundRecovery,
          });
        }
      }

      await drainMessageOutbox({
        shouldSend: outboxRequestMatchesView,
      });
    } catch (error) {
      appendSystem(`消息队列恢复失败：${error.message}`, true);
    }
  }

  syncVisualViewport();
  window.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);

  socket.on('connect', () => {
    setConnectionPhase('online');
    renderConnectionState();
    requestCatchUp();
    startRttMonitor();
  });

  socket.on('disconnect', () => {
    adminUnlocked = false;
    setConnectionPhase('offline');
    renderConnectionState();
    clearRtt();
    appendSystem('已断开连接，尝试重连中...', false);
  });

  socket.on('connect_error', err => {
    setConnectionPhase(socket.connected ? 'online' : 'offline');
    renderConnectionState();
    if (err?.message === 'unauthorized') {
      socket.disconnect();
      authToken = '';
      showAuthPrompt('会话已失效，请重新输入访问口令。');
      return;
    }
    appendSystem(`连接失败：${err?.message || 'unknown'}`, true);
  });

  window.addEventListener('offline', () => {
    setConnectionPhase('offline');
    renderConnectionState();
  });
  window.addEventListener('online', () => {
    setConnectionPhase(socket.connected ? 'online' : 'connecting');
    renderConnectionState();
    if (socket.connected) syncOutboxView();
    else socket.connect();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    paintConnectionBanner();
    if (!socket.connected) socket.connect();
  });

  socket.on('agent:event', processAgentEvent);

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const nextToken = authTokenInput.value.trim();
    if (!nextToken) {
      showAuthPrompt('请输入访问口令。');
      return;
    }
    try {
      await establishAuthSession(nextToken);
      authToken = '';
      authTokenInput.value = '';
      connectSocket({ allowEmpty: true });
    } catch (error) {
      showAuthPrompt(error.message || '访问口令不正确，请重试。');
    }
  });

  bootstrapAuth();

  // Redesign - Empty state check helper
  function checkEmptyState() {
    const isEmpty = messagesEl.children.length === 0;
    $('empty-state').style.display = isEmpty ? 'flex' : 'none';
    messagesEl.style.display = isEmpty ? 'none' : 'flex';
    if (isEmpty) {
      followTranscript = true;
      jumpToLatestBtn.hidden = true;
    }
  }

  const storedCliSettings = loadCliSettings(localStorage);
  let selectedModel = storedCliSettings.model || '';
  let selectedReasoning = storedCliSettings.effort || '';
  let selectedServiceTier = storedCliSettings.serviceTier || '';
  let selectedApproval = storedCliSettings.approvalPolicy || '';
  let selectedSandbox = storedCliSettings.sandbox || '';
  let selectedMode = storedCliSettings.collaborationMode || '';
  let availableModels = [];

  const miInput = $('model-input');
  if (miInput && selectedModel) miInput.value = selectedModel;
  const permSelect = $('perm-select');
  if (permSelect) permSelect.value = selectedApproval;

  function displayModelId() {
    return selectedModel || resolveSelectedModel('', availableModels);
  }

  function currentModelRecord() {
    const id = displayModelId();
    return availableModels.find(model => (model.model || model.id) === id)
      || { model: id, displayName: id };
  }

  function modelsForPicker() {
    const visible = visibleModels(availableModels);
    if (selectedModel && !visible.some(model => (model.model || model.id) === selectedModel)) {
      return [{ model: selectedModel, displayName: selectedModel }, ...visible];
    }
    return visible;
  }

  function currentTurnSettings() {
    return sanitizeTurnOverrides({
      model: selectedModel,
      effort: selectedReasoning,
      approvalPolicy: selectedApproval,
      sandbox: selectedSandbox,
      serviceTier: selectedServiceTier,
      collaborationMode: selectedMode,
    });
  }

  function persistComposerSettings() {
    saveCliSettings(localStorage, currentTurnSettings());
    if (miInput) miInput.value = selectedModel;
    if (permSelect) permSelect.value = selectedApproval;
  }

  function applyCollaborationMode(mode) {
    const next = normalizeCollaborationMode(mode);
    if (!next) return;
    selectedMode = next;
    persistComposerSettings();
    renderCliSettingsPopovers();
    if (!isTransportConnected()) return;
    socket.emit('thread:collaborationMode', withTarget({
      mode: next,
      cwd: serverCwd,
    }, viewTarget()), ack => {
      if (!ack?.ok) {
        appendSystem(ack?.error || '切换会话模式失败', true);
        return;
      }
      if (ack.mode) selectedMode = ack.mode;
      persistComposerSettings();
      renderCliSettingsPopovers();
    });
  }

  function renderPopoverItems(container, items, dataAttr, selectedId) {
    if (!container) return;
    container.innerHTML = items.map(item => `
      <div class="popover-item${item.id && item.id === selectedId ? ' selected' : ''}" data-${dataAttr}="${escHtml(item.id)}">
        <span class="popover-item-icon">${item.icon || ''}</span>
        <div class="popover-item-details">
          <span class="popover-item-title">${escHtml(item.title)}</span>
          ${item.desc ? `<span class="popover-item-desc">${escHtml(item.desc)}</span>` : ''}
        </div>
        <span class="popover-item-check">✓</span>
      </div>
    `).join('');
  }

  function renderCliSettingsPopovers() {
    const modelRecord = currentModelRecord();
    renderPopoverItems($('approval-list'), APPROVAL_OPTIONS, 'approval', selectedApproval);
    renderPopoverItems($('sandbox-list'), SANDBOX_OPTIONS, 'sandbox', selectedSandbox);
    renderPopoverItems(
      $('model-list'),
      modelsForPicker().map(model => ({
        id: model.model || model.id,
        title: model.displayName || model.model || model.id,
        desc: model.model || model.id,
        icon: model.isDefault ? '⭐' : '🤖',
      })),
      'model',
      displayModelId(),
    );
    renderPopoverItems(
      $('reasoning-list'),
      reasoningOptionsForModel(modelRecord).map(option => ({
        ...option,
        icon: option.id === selectedReasoning ? '●' : '○',
      })),
      'reasoning',
      selectedReasoning,
    );
    const tiers = serviceTiersForModel(modelRecord);
    const speedLabel = $('speed-section-label');
    const speedList = $('speed-list');
    if (speedLabel) speedLabel.hidden = tiers.length === 0;
    if (speedList) {
      speedList.hidden = tiers.length === 0;
      renderPopoverItems(
        speedList,
        tiers.map(tier => ({
          id: tier.id,
          title: tier.name || tier.id,
          desc: tier.description || '',
          icon: /fast|priority/i.test(`${tier.id} ${tier.name}`) ? '⚡' : '⚪',
        })),
        'speed',
        selectedServiceTier,
      );
    }
    const bypassList = $('bypass-list');
    if (bypassList) {
      const active = selectedApproval === 'never' && selectedSandbox === 'danger-full-access';
      bypassList.innerHTML = `
        <div class="popover-item${active ? ' selected' : ''}" data-bypass="1">
          <span class="popover-item-icon">☠️</span>
          <div class="popover-item-details">
            <span class="popover-item-title">绕过批准和沙箱</span>
            <span class="popover-item-desc">对应 --dangerously-bypass-approvals-and-sandbox</span>
          </div>
          <span class="popover-item-check">✓</span>
        </div>`;
    }
    updateFloatingBadges();
  }

  function applyComposerModel(modelId) {
    selectedModel = modelId;
    const record = currentModelRecord();
    selectedReasoning = clampEffortForModel(selectedReasoning, record);
    selectedServiceTier = clampServiceTierForModel(selectedServiceTier, record);
    persistComposerSettings();
    renderCliSettingsPopovers();
  }

  function loadComposerModels() {
    renderCliSettingsPopovers();
    if (!socket.connected) return;
    socket.emit('models:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return;
      availableModels = ack.models || [];
      if (selectedModel) {
        selectedModel = resolveSelectedModel(selectedModel, availableModels);
        const record = currentModelRecord();
        if (selectedReasoning) selectedReasoning = clampEffortForModel(selectedReasoning, record);
        if (selectedServiceTier) selectedServiceTier = clampServiceTierForModel(selectedServiceTier, record);
        persistComposerSettings();
      }
      renderCliSettingsPopovers();
    });
  }

  function updateFloatingBadges() {
    const permTextEl = $('perm-trigger-text');
    if (permTextEl) {
      permTextEl.textContent = formatComposerPermission({
        approvalPolicy: selectedApproval || sessionStatus?.approvalPolicy || '',
        sandbox: selectedSandbox || sessionStatus?.sandbox || '',
      });
    }

    const modelTextEl = $('model-trigger-text');
    const record = currentModelRecord();
    if (modelTextEl) {
      modelTextEl.textContent = formatComposerModel({
        model: displayModelId(),
        displayName: record.displayName,
      }) || '模型';
    }

    const effortText = formatComposerEffort(selectedReasoning);
    const effortWrap = $('effort-trigger');
    const effortTextEl = $('effort-trigger-text');
    if (effortTextEl) effortTextEl.textContent = effortText;
    if (effortWrap) effortWrap.hidden = !effortText;

    const modeWrap = $('mode-trigger');
    const modeTextEl = $('mode-trigger-text');
    const modeId = normalizeCollaborationMode(selectedMode);
    if (modeTextEl) modeTextEl.textContent = formatComposerMode(modeId);
    if (modeWrap) modeWrap.hidden = modeId !== 'plan';

    const defaults = $('composer-defaults');
    if (defaults) {
      defaults.title = [
        formatComposerModel({ model: displayModelId(), displayName: record.displayName }) || '模型',
        formatPermissionBadge({
          approvalPolicy: selectedApproval || sessionStatus?.approvalPolicy || '',
          sandbox: selectedSandbox || sessionStatus?.sandbox || '',
        }),
        formatModelBadge({
          model: displayModelId(),
          effort: selectedReasoning,
          serviceTier: selectedServiceTier,
          displayName: record.displayName,
        }),
      ].filter(Boolean).join('\n');
    }

    const visibleMode = normalizeCollaborationMode(selectedMode) || 'default';
    document.querySelectorAll('#mode-list .popover-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.mode === visibleMode);
    });
  }

  const sessionSettings = $('session-settings');
  function openSessionSettings() {
    if (sessionSettings) sessionSettings.hidden = false;
  }
  function closeSessionSettings() {
    if (sessionSettings) sessionSettings.hidden = true;
  }
  $('composer-defaults')?.addEventListener('click', event => {
    event.stopPropagation();
    if (sessionSettings?.hidden === false) closeSessionSettings();
    else openSessionSettings();
  });
  $('session-settings-close')?.addEventListener('click', closeSessionSettings);
  sessionSettings?.addEventListener('click', event => {
    if (event.target === sessionSettings) closeSessionSettings();
  });

  $('approval-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-approval]');
    if (!item) return;
    selectedApproval = item.dataset.approval;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('sandbox-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-sandbox]');
    if (!item) return;
    selectedSandbox = item.dataset.sandbox;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('bypass-list')?.addEventListener('click', event => {
    if (!event.target.closest('[data-bypass]')) return;
    selectedApproval = 'never';
    selectedSandbox = 'danger-full-access';
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('model-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-model]');
    if (!item) return;
    applyComposerModel(item.dataset.model);
  });
  $('reasoning-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-reasoning]');
    if (!item) return;
    selectedReasoning = item.dataset.reasoning;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('speed-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-speed]');
    if (!item) return;
    const next = item.dataset.speed || '';
    selectedServiceTier = selectedServiceTier === next ? '' : next;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });

  $('mode-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-mode]');
    if (!item) return;
    applyCollaborationMode(item.dataset.mode);
  });

  renderCliSettingsPopovers();

  // Redesign - Slash Autocomplete trigger & control
  const slashPopup = $('slash-popup');
  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val === '/') {
      showSlashPopup();
    } else if (val.startsWith('/') && !val.includes(' ')) {
      const query = val.slice(1).toLowerCase();
      let hasMatch = false;
      document.querySelectorAll('.slash-item').forEach(item => {
        const cmd = item.dataset.cmd.slice(1).toLowerCase();
        if (cmd.includes(query)) {
          item.style.display = 'flex';
          hasMatch = true;
        } else {
          item.style.display = 'none';
        }
      });
      if (hasMatch) showSlashPopup();
      else hideSlashPopup();
    } else {
      hideSlashPopup();
    }
    scheduleAtMention(val);
  });

  function showSlashPopup() { slashPopup.classList.add('show'); }
  function hideSlashPopup() { slashPopup.classList.remove('show'); }

  function hideAtMentionPopup() {
    atMentionReqId += 1;
    if (atMentionPopup) {
      atMentionPopup.classList.remove('show');
      atMentionPopup.hidden = true;
      atMentionPopup.innerHTML = '';
    }
  }

  function scheduleAtMention(value) {
    const cursor = inputEl.selectionStart ?? value.length;
    const hit = detectAtMentionQuery(value.slice(0, cursor));
    if (!hit) {
      hideAtMentionPopup();
      return;
    }
    hideSlashPopup();
    const reqId = ++atMentionReqId;
    if (atMentionPopup) {
      atMentionPopup.hidden = false;
      atMentionPopup.classList.add('show');
      atMentionPopup.innerHTML = '<div class="at-mention-item">查找文件…</div>';
    }
    socket.emit('files:search', { cwd: serverCwd, query: hit.query }, ack => {
      if (reqId !== atMentionReqId) return;
      const paths = ack?.ok ? (ack.paths || []) : [];
      if (!atMentionPopup) return;
      if (!paths.length) {
        atMentionPopup.innerHTML = `<div class="at-mention-item">${escHtml(ack?.ok ? '没有匹配的文件' : (ack?.error || '无法搜索文件'))}</div>`;
        return;
      }
      atMentionPopup.innerHTML = paths.map(path => (
        `<button type="button" class="at-mention-item" data-path="${escHtml(path)}">${escHtml(path)}</button>`
      )).join('');
    });
  }

  atMentionPopup?.addEventListener('mousedown', event => event.preventDefault());
  atMentionPopup?.addEventListener('click', event => {
    const item = event.target.closest('[data-path]');
    if (!item) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const hit = detectAtMentionQuery(inputEl.value.slice(0, cursor));
    if (!hit) return;
    const next = applyAtMentionPick(inputEl.value, {
      matchStart: hit.matchStart,
      cursorPos: cursor,
      path: item.dataset.path,
    });
    inputEl.value = next.text;
    inputEl.setSelectionRange(next.cursorPos, next.cursorPos);
    addInputPart(mentionPartFromSearchHit(item.dataset.path, serverCwd));
    hideAtMentionPopup();
    applyComposerMode();
  });

  document.querySelectorAll('.slash-item').forEach(item => {
    item.onclick = () => {
      const cmd = item.dataset.cmd;
      hideSlashPopup();
      const modeSlash = parseCollaborationModeSlash(cmd);
      if (modeSlash) {
        applyCollaborationMode(modeSlash.mode);
        inputEl.value = '';
        applyComposerMode();
        return;
      }
      inputEl.value = cmd + ' ';
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    };
  });

  // Hide popup on click outside
  document.addEventListener('click', e => {
    if (!slashPopup.contains(e.target) && e.target !== inputEl) {
      hideSlashPopup();
    }
    if (atMentionPopup && !atMentionPopup.contains(e.target) && e.target !== inputEl) {
      hideAtMentionPopup();
    }
  });

  // Empty state Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach(card => {
    card.onclick = () => {
      inputEl.value = card.dataset.prompt || card.dataset.cmd || '';
      sendMessage();
    };
  });

  function processAgentEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    if (activeRecovery && bufferRecoveryEvent(activeRecovery, ev)) return;
    if (!eventMatchesTarget(ev, viewTarget())) return;
    const boundTarget = bindThreadFromEvent(viewTarget(), ev);
    if (boundTarget.threadId !== currentSessionId) {
      rememberCurrentThread(boundTarget.threadId);
    }
    if (ev.seq > 0 && ev.epoch && ev.epoch !== 'server') {
      const key = `${ev.instanceId || 'global'}:${ev.epoch}:${ev.seq}`;
      if (seenEvents.has(key)) return;
      seenEvents.add(key);
      if (seenEvents.size > 1200) seenEvents = new Set([...seenEvents].slice(-600));
      if (ev.sessionId) {
        rememberCurrentThread(ev.sessionId);
        localStorage.setItem(`codex_last_seq:${ev.sessionId}`, String(ev.seq));
        localStorage.setItem(`codex_last_epoch:${ev.sessionId}`, ev.epoch);
      }
    }

    if (ev.type === 'text_delta' || ev.type === 'tool_use' || ev.type === 'tool_output_delta') hideTyping();
    if (ev.type === 'result' || ev.type === 'error') hideTyping();

    switch (ev.type) {
      case 'device_status':
        handleDeviceStatus(ev.payload);
        break;
      case 'init':
        handleInit(ev.payload, ev);
        break;
      case 'status':
        handleStatus(ev.payload);
        break;
      case 'status_line':
        handleStatusLine(ev.payload);
        break;
      case 'instances':
        handleInstances(ev.payload);
        break;
      case 'thread_event':
        handleThreadEvent(ev.payload);
        break;
      case 'thread_status':
        handleThreadStatus(ev.payload);
        break;
      case 'collaboration_mode':
        if (ev.payload?.mode) {
          selectedMode = ev.payload.mode;
          persistComposerSettings();
          renderCliSettingsPopovers();
        }
        break;
      case 'user_message':
        finalizeStream();
        finishAssistantTurn();
        appendUserBubble(ev.payload.text, ev.payload.attachments, ev.payload.parts, ev.payload.clientRequestId);
        break;
      case 'message_receipt':
        messageOutbox.acceptReceipt(ev.payload).catch(error => {
          appendSystem(`消息确认保存失败：${error.message}`, true);
        });
        break;
      case 'queued_message':
        appendQueuedBubble(ev.payload);
        break;
      case 'dequeued_message':
        markQueuedBubble(ev.payload.clientRequestId, ev.payload.text, '发送中');
        break;
      case 'queue_cleared':
        handleQueueCleared(ev.payload);
        break;
      case 'text_delta':
        appendTextDelta(ev.payload.text);
        break;
      case 'tool_use':
        handleToolUse(ev.payload);
        break;
      case 'tool_output_delta':
        handleToolOutputDelta(ev.payload);
        break;
      case 'term_output':
        handleP3TerminalOutput(ev.payload);
        break;
      case 'term_exit':
        handleP3TerminalExit(ev.payload);
        break;
      case 'tool_result':
        handleToolResult(ev.payload);
        break;
      case 'approval_request':
        handleApprovalRequest(ev.payload, ev);
        break;
      case 'user_input_request':
        handleUserInputRequest(ev.payload, ev);
        break;
      case 'approval_revoked':
        handleApprovalRevoked(ev.payload);
        break;
      case 'needs_you_changed':
        handleNeedsYouChanged(ev.payload);
        break;
      case 'file_change':
        handleFileChange(ev.payload);
        break;
      case 'plan':
        handlePlan(ev.payload);
        break;
      case 'reasoning':
        appendReasoning(ev.payload);
        break;
      case 'account_login':
      case 'account_updated':
        break;
      case 'compact':
        handleCompact(ev.payload);
        break;
      case 'rollback':
        handleRollback(ev.payload);
        break;
      case 'rate_limits':
        handleRateLimits(ev.payload);
        break;
      case 'mcp_status':
        handleMcpStatus(ev.payload);
        break;
      case 'skills_changed':
        handleSkillsChanged(ev.payload);
        break;
      case 'external_agent_config_import':
        handleExternalAgentConfigImport(ev.payload);
        break;
      case 'realtime':
        handleP3Realtime(ev.payload);
        break;
      case 'remote_control':
        handleP3RemoteControl(ev.payload);
        break;
      case 'mcp_use':
        handleMcpUse(ev.payload);
        break;
      case 'mcp_result':
        handleMcpResult(ev.payload);
        break;
      case 'search':
        handleSearch(ev.payload);
        break;
      case 'diff':
        handleDiff(ev.payload);
        break;
      case 'result':
        handleResult(ev.payload);
        break;
      case 'error':
        finalizeStream();
        finishAssistantTurn();
        announceTurnComplete('回复失败');
        appendError(ev.payload.message);
        if (activeTurnText) rememberFailure(activeTurnText);
        setBusy(false);
        break;
      case 'system':
        appendSystem(ev.payload.message, ev.payload.isError);
        break;
      case 'pending_devices':
        handlePendingDevices(ev.payload);
        break;
      case 'usage':
        handleUsage(ev.payload);
        break;
      case 'raw_item':
        handleRawItem(ev.payload);
        break;
      default:
        handleRawItem({ envelopeType: ev.type, item: ev.payload });
        break;
    }
  }

  async function bootstrapAuth() {
    if (authToken) {
      try {
        await establishAuthSession(authToken);
        authToken = '';
        connectSocket({ allowEmpty: true });
      } catch (error) {
        authToken = '';
        showAuthPrompt(error.message || '访问口令不正确，请重新输入。');
      }
      return;
    }
    sessionMetaEl.textContent = 'checking auth...';
    try {
      const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) {
        connectSocket({ allowEmpty: true });
        return;
      }
      if (response.status === 401) {
        showAuthPrompt();
        return;
      }
      showAuthPrompt('无法确认认证状态，请输入访问口令。');
    } catch {
      showAuthPrompt('无法确认认证状态，请输入访问口令。');
    }
  }

  async function establishAuthSession(token) {
    const response = await fetch('/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'x-auth-token': token,
        'x-device-token': deviceToken,
      },
    });
    if (!response.ok) throw new Error('访问口令不正确，请重试。');
    return response.json();
  }

  function showAuthPrompt(message = '') {
    authGate.classList.add('show');
    authError.textContent = message;
    stateLabel.textContent = 'auth';
    sessionMetaEl.textContent = '需要访问口令';
    setTimeout(() => authTokenInput.focus(), 0);
  }

  function hideAuthPrompt() {
    authGate.classList.remove('show');
    authError.textContent = '';
  }

  function connectSocket({ allowEmpty = false } = {}) {
    void allowEmpty;
    socket.auth = { deviceToken };
    hideAuthPrompt();
    sessionMetaEl.textContent = 'connecting...';
    renderConnectionState();
    socket.connect();
  }

  function handleDeviceStatus(payload) {
    if (payload.status === 'pending') {
      deviceAuth.classList.add('show');
    } else if (payload.status === 'approved') {
      deviceAuth.classList.remove('show');
    } else if (payload.status === 'denied') {
      deviceAuth.classList.add('show');
      deviceIdDisplay.textContent = '已被拒绝';
    }
  }

  function handleInit(payload, event) {
    applyFeatureManifest(payload.features);
    gatewayEpoch = payload.gatewayEpoch || gatewayEpoch;
    serverCwd = payload.cwd || serverCwd;
    const incomingInstanceId = event?.instanceId || payload.instanceId || null;
    const savedThreadId = getCurrentThread(localStorage, serverCwd);
    const acceptsIncomingTarget = Boolean(incomingInstanceId)
      && (incomingInstanceId === currentViewingId || (savedThreadId && savedThreadId === payload.sessionId));
    if (acceptsIncomingTarget) {
      currentViewingId = incomingInstanceId;
      rememberCurrentThread(payload.sessionId);
    } else if (!currentViewingId) {
      currentViewingId = null;
      currentSessionId = savedThreadId;
    }
    versions = payload.versions || versions || {};
    if (payload.workDirs?.length) {
      workDirs = payload.workDirs;
      renderWorkdirSelect();
    }

    loadComposerModels();

    renderSessionMeta();
    expandedDirs = loadExpandedDirs(localStorage, serverCwd);
    renderDrawerProject();
    renderDrawerProjects();
    renderInstanceTabs();
    updateFloatingBadges();
    if (socket.connected) refreshNativeThreads();
    if (!restoreCurrentThreadFromPreference()) syncOutboxView();
    requestNeedsYouSnapshot();
    checkEmptyState();
  }

  function requestNeedsYouSnapshot() {
    if (!socket.connected) return;
    socket.emit('needs-you:snapshot', {}, ack => {
      if (!ack?.ok || !Number.isFinite(ack.revision) || ack.revision < needsYouRevision) return;
      needsYouRevision = ack.revision;
      needsYou = new Map((ack.needs || []).map(need => [need.needId, need]));
      renderNeedsYouPanel();
      openPendingNeedsYouDeepLink();
    });
  }

  function handleNeedsYouChanged(payload) {
    const need = payload?.need;
    if (!need?.needId || !Number.isFinite(payload?.revision) || payload.revision < needsYouRevision) return;
    needsYouRevision = payload.revision;
    if (need.state === 'pending' || need.state === 'unknown') needsYou.set(need.needId, need);
    else needsYou.delete(need.needId);
    if (need.state === 'unknown') {
      markNeedCardUnknown(need.needId);
    } else if (need.state !== 'pending') {
      const card = pendingApprovalCards[need.needId];
      if (card) {
        delete pendingApprovalCards[need.needId];
        const actions = card.querySelector('.approval-btns:last-child');
        if (actions) actions.innerHTML = '<span class="tool-output tool-ok" style="background:transparent;padding:0;">已在其他设备处理</span>';
      }
    }
    renderNeedsYouPanel();
    openPendingNeedsYouDeepLink();
  }

  function openPendingNeedsYouDeepLink() {
    if (!pendingNeedsYouDeepLink) return;
    const need = needsYou.get(pendingNeedsYouDeepLink.needId);
    if (!need || need.state !== 'pending' || need.target?.threadId !== pendingNeedsYouDeepLink.threadId) return;
    pendingNeedsYouDeepLink = null;
    searchParams.delete('thread');
    searchParams.delete('need');
    const nextSearch = searchParams.toString();
    history.replaceState(null, '', `${location.pathname}${nextSearch ? '?' + nextSearch : ''}${location.hash}`);
    openNeed(need);
  }

  function renderNeedsYouPanel() {
    if (!needsYouPanel) return;
    const active = [...needsYou.values()].filter(need => need.state === 'pending' || need.state === 'unknown');
    if (!active.length) {
      needsYouPanel.hidden = true;
      needsYouPanel.innerHTML = '';
      return;
    }
    needsYouPanel.hidden = false;
    needsYouPanel.innerHTML = `<div class="needs-you-heading"><span>需要你</span><span>${active.length}</span></div>`
      + active.map(need => {
        const summary = need.kind === 'question'
          ? (need.payload?.questions?.[0]?.question || 'Codex 有问题等待回答')
          : (Array.isArray(need.payload?.command) ? need.payload.command.join(' ') : (need.payload?.command || need.payload?.reason || '有操作等待审批'));
        const action = need.state === 'unknown'
          ? '<span class="tool-output tool-err" style="background:transparent;padding:0;">结果未知，等待上游终态</span>'
          : '<button class="native-mini-btn" type="button" data-need-action="open">处理</button>';
        return `<div class="needs-you-row" data-need-id="${escHtml(need.needId)}">
          <div class="needs-you-copy">
            <div class="needs-you-summary">${escHtml(summary)}</div>
            <div class="needs-you-thread">${escHtml(need.target?.threadId || '')}</div>
          </div>
          ${action}
        </div>`;
      }).join('');
    needsYouPanel.querySelectorAll('[data-need-action="open"]').forEach(button => {
      button.onclick = () => openNeed(needsYou.get(button.closest('[data-need-id]')?.dataset.needId));
    });
  }

  function openNeed(need) {
    if (!need?.target?.threadId || need.state !== 'pending') return;
    const thread = appThreads.find(item => item.id === need.target.threadId);
    socket.emit('thread:select', {
      threadId: need.target.threadId,
      cwd: thread?.cwd || serverCwd,
      title: thread?.title || need.target.threadId.slice(0, 8),
    }, ack => {
      if (!applyTargetAck(ack)) {
        appendSystem(ack?.error || '需要你目标已失效', true);
        return;
      }
      clearMessages();
      const payload = { ...need.payload, needId: need.needId };
      const event = { instanceId: need.target.instanceId, sessionId: need.target.threadId };
      if (need.kind === 'question') handleUserInputRequest(payload, event);
      else handleApprovalRequest(payload, event);
    });
  }

  function markNeedCardUnknown(needId) {
    const card = pendingApprovalCards[needId];
    if (!card) return;
    delete pendingApprovalCards[needId];
    const actions = card.querySelector('.approval-btns:last-child');
    if (actions) {
      actions.innerHTML = '<span class="tool-output tool-err" style="background:transparent;padding:0;">结果未知，等待上游终态</span>';
    }
  }

  function applyFeatureManifest(manifest) {
    features = {
      admin: manifest?.admin === true,
      labs: manifest?.labs === true,
    };
    if (!features.admin) adminUnlocked = false;
    const adminButton = $('native-admin-btn');
    const labsButton = $('native-p3-btn');
    if (adminButton) adminButton.hidden = !features.admin;
    if (labsButton) labsButton.hidden = !features.labs;
  }

  function renderWorkdirSelect() {
    const sel = document.getElementById('workdir-select');
    const container = document.getElementById('workdir-container');
    if (container) container.hidden = true;
    if (sel && workDirs.length) {
      sel.innerHTML = workDirs.map(d => {
        const name = d.split('/').pop() || d;
        return `<option value="${escHtml(d)}"${d === serverCwd ? ' selected' : ''}>${escHtml(name)}</option>`;
      }).join('');
      sel.onchange = () => handleWorkdirChange(sel.value);
    }
    renderDrawerProject();
    renderDrawerProjects();
  }

  function renderDrawerProject() {
    const name = projectLabel(serverCwd) || '项目';
    const el = $('drawer-project');
    if (el) {
      el.textContent = name;
      el.title = serverCwd || '';
    }
    const headerProject = $('header-project');
    if (headerProject) {
      headerProject.textContent = name;
      headerProject.title = serverCwd || '';
    }
    const emptyProject = $('empty-project');
    if (emptyProject) {
      emptyProject.textContent = name ? `在 ${name}` : '';
      emptyProject.hidden = !name;
    }
    const headerContext = $('header-context');
    if (headerContext) {
      headerContext.title = serverCwd ? `工作区：${serverCwd}` : '浏览工作区文件和改动';
    }
  }

  function rememberExpandedDirs() {
    persistExpandedDirs(localStorage, expandedDirs);
  }

  function applyWorkspace(cwd, { clearChat = true } = {}) {
    if (!cwd) return;
    const changed = cwd !== serverCwd;
    if (changed) {
      serverCwd = cwd;
      restoringThreadId = null;
      activeRecovery = null;
      currentViewingId = null;
      currentSessionId = getCurrentThread(localStorage, serverCwd);
      sessionStatus = null;
      appThreads = sessionsByCwd.get(cwd) || [];
      const sel = $('workdir-select');
      if (sel) sel.value = cwd;
      if (clearChat) clearMessages();
    }
    expandedDirs.add(cwd);
    rememberExpandedDirs();
    renderDrawerProject();
  }

  function toggleDirExpand(cwd) {
    const result = toggleExpandedDir(expandedDirs, cwd);
    expandedDirs = result.set;
    rememberExpandedDirs();
    renderDrawerProjects();
    if (result.expanded) refreshThreadsForCwd(cwd);
  }

  function renderDrawerProjects() {
    const root = $('drawer-projects');
    if (!root) return;
    const dirs = workDirs.length ? workDirs : (serverCwd ? [serverCwd] : []);
    if (!dirs.length) {
      root.innerHTML = '';
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.innerHTML = `<div class="drawer-section-label">项目</div>`;
    for (const dir of dirs) {
      const name = projectLabel(dir) || dir;
      const expanded = expandedDirs.has(dir);
      const current = dir === serverCwd;
      const block = document.createElement('div');
      block.className = 'drawer-project-block' + (current ? ' current' : '') + (expanded ? ' expanded' : '');
      block.innerHTML = `<div class="drawer-project-item${current ? ' active' : ''}" title="${escHtml(dir)}">`
        + `<button type="button" class="dir-toggle" data-cwd="${escHtml(dir)}">`
        + `<span class="project-icon">${expanded ? '📂' : '📁'}</span>`
        + `<span class="dir-arrow${expanded ? ' rotated' : ''}">▶</span>`
        + `<span class="dir-name">${escHtml(name)}</span>`
        + `</button>`
        + `<button type="button" class="dir-new" data-new-cwd="${escHtml(dir)}" title="在此工作区新建会话">＋</button>`
        + `</div>`
        + `<div class="dir-subtree${expanded ? ' expanded' : ''}"></div>`;
      root.appendChild(block);
      if (expanded) fillDirSubtree(block.querySelector('.dir-subtree'), dir);
    }
    root.querySelectorAll('.dir-toggle').forEach(btn => {
      btn.onclick = () => toggleDirExpand(btn.dataset.cwd);
    });
    root.querySelectorAll('.dir-new').forEach(btn => {
      btn.onclick = event => {
        event.stopPropagation();
        createNewSession(btn.dataset.newCwd);
        closeDrawer();
      };
    });
  }

  function fillDirSubtree(container, cwd) {
    if (!container) return;
    const threads = (sessionsByCwd.get(cwd) || (cwd === serverCwd ? appThreads : [])).filter(item => item.id);
    if (!threads.length) {
      container.innerHTML = '<div class="session-empty">暂无会话</div>';
      return;
    }
    container.innerHTML = '';
    for (const thread of threads) container.appendChild(createSessionRow(thread));
  }

  function handleWorkdirChange(cwd) {
    if (!cwd || cwd === serverCwd) return;
    applyWorkspace(cwd, { clearChat: true });
    renderDrawerProjects();
    refreshThreadsForCwd(cwd);
  }

  function handleStatus(payload) {
    sessionStatus = payload || null;
    if (payload?.sessionId) {
      rememberCurrentThread(payload.sessionId);
    }
    setBusy(Boolean(payload?.busy));
    renderSessionMeta();
    renderInstanceTabs();
    updateFloatingBadges();
    checkEmptyState();
  }

  function handleStatusLine(payload) {
    updateStatusDetail(payload);
  }

  function handleInstances(payload) {
    instanceList = payload.instances || [];
    instanceSnapshotReceived = true;
    currentViewingId = payload.viewingInstanceId || null;
    renderInstanceTabs();
    syncOutboxView();
  }

  function renderInstanceTabs() {}

  function renderThreadTitle() {
    const titleEl = $('thread-title');
    if (!titleEl) return;
    const thread = currentSessionId
      ? appThreads.find(item => item.id === currentSessionId)
      : null;
    const name = String(thread?.title || thread?.preview || '').trim();
    titleEl.textContent = name || '新会话';
  }

  function goHome() {
    closeDrawer();
    currentViewingId = null;
    rememberCurrentThread(null);
    sessionStatus = null;
    restoringThreadId = null;
    activeRecovery = null;
    clearMessages();
    renderSessionMeta();
    renderDrawerProjects();
    applyComposerMode();
  }

  function createNewSession(cwd = serverCwd) {
    if (cwd) applyWorkspace(cwd, { clearChat: false });
    socket.emit('session:new', { cwd: cwd || serverCwd }, ack => {
      if (!applyTargetAck(ack)) {
        appendSystem(ack?.error || '新建会话失败', true);
        return;
      }
      clearMessages();
      renderDrawerProjects();
    });
  }

  // eslint-disable-next-line no-unused-vars -- drawer fork trigger is not in main chrome yet
  function forkCurrentSession() {
    socket.emit('session:fork', { instanceId: currentViewingId }, ack => {
      if (!ack?.ok) {
        appendSystem(ack?.error || '会话分叉失败', true);
        return;
      }
      applyTargetAck(ack);
      clearMessages();
      appendSystem('已分叉当前会话', false);
      refreshNativeThreads();
    });
  }

  function paintHeaderChanges(git) {
    const el = $('header-changes');
    if (!el) return;
    const label = formatWorkspaceChangeBadge(git);
    el.textContent = label;
    el.hidden = !label;
  }

  function updateStatusDetail(payload) {
    if (!payload) {
      statusDetail.textContent = '';
      paintHeaderChanges(null);
      return;
    }
    const parts = [];
    if (payload.project) parts.push(`📁 ${escHtml(payload.project)}`);
    if (payload.sandbox) parts.push(`🛡 ${escHtml(payload.sandbox)}`);
    if (payload.approvalPolicy) parts.push(`✓ ${escHtml(payload.approvalPolicy)}`);
    if (payload.git) {
      const g = payload.git;
      let gitStr = `⎇ ${escHtml(g.branch || '?')}`;
      if (g.changed) gitStr += ` Δ${g.changed}`;
      if (g.ahead) gitStr += ` ↑${g.ahead}`;
      if (g.behind) gitStr += ` ↓${g.behind}`;
      if (g.insertions || g.deletions) gitStr += ` +${g.insertions}/-${g.deletions}`;
      parts.push(gitStr);
    }
    if (payload.ctx) {
      parts.push(`📐 ${(payload.ctx.totalInputTokens / 1000).toFixed(1)}k`);
    }
    if (payload.sessionId) {
      parts.push(`${(payload.sessionId || '').slice(0, 8)}`);
    }
    if (payload.state) {
      parts.push(payload.busy ? '⚡' : '○');
    }
    if (payload.queueLength > 0) {
      parts.push(`q:${payload.queueLength}`);
    }
    statusDetail.textContent = parts.join(' · ');
    paintHeaderChanges(payload.git);
  }

  function handleThreadEvent(payload) {
    if (!payload?.event) return;
    const labels = { archived: '已归档', unarchived: '已取消归档', deleted: '已删除', name_updated: '已重命名' };
    appendSystem(`Thread ${labels[payload.event] || payload.event}: ${(payload.threadId || '').slice(0, 8)}`, false);
    refreshNativeThreads();
  }

  function handleThreadStatus(payload) {
    if (!payload?.threadId || !payload.status) return;
    const presentation = threadStatusPresentation(payload.status);
    const incomingRevision = Number.isInteger(payload.revision) ? payload.revision : 0;
    const currentRevision = appThreads.find(thread => thread.id === payload.threadId)?.statusRevision || 0;
    const stale = incomingRevision > 0 && currentRevision > incomingRevision;
    appThreads = applyThreadStatus(appThreads, payload);
    for (const [cwd, threads] of sessionsByCwd) {
      sessionsByCwd.set(cwd, applyThreadStatus(threads, payload));
    }
    if (serverCwd && sessionsByCwd.has(serverCwd)) appThreads = sessionsByCwd.get(serverCwd);
    instanceList = instanceList.map(instance => instance.sessionId === payload.threadId
      ? { ...instance, busy: presentation.active, state: presentation.kind }
      : instance);
    if (currentSessionId === payload.threadId && !stale) {
      sessionStatus = {
        ...(sessionStatus || {}),
        threadStatus: payload.status,
        threadStatusRevision: incomingRevision || sessionStatus?.threadStatusRevision || 0,
        busy: presentation.active,
        state: presentation.kind,
      };
      setBusy(presentation.active);
      renderSessionMeta();
    }
    renderInstanceTabs();
    renderSessionList();
    if (payload.scope === 'host') scheduleThreadListRefresh();
  }

  function handleCompact(payload) {
    appendSystem(`上下文压缩完成: ${(payload?.threadId || currentSessionId || '').slice(0, 8)}`, false);
  }

  function handleRollback(payload) {
    appendSystem(`已回退 ${payload?.numTurns || 1} 轮: ${(payload?.threadId || currentSessionId || '').slice(0, 8)}`, false);
  }

  function handleRateLimits(payload) {
    const limit = payload?.rateLimits?.limitName || payload?.rateLimits?.limitId || 'rate limit';
    appendSystem(`Rate limits updated: ${limit}`, false);
  }

  function handleMcpStatus(payload) {
    appendSystem(`MCP ${payload?.name || 'server'}: ${payload?.status || 'updated'}`, Boolean(payload?.error));
  }

  function handleSkillsChanged() {
    appendSystem('Skills changed', false);
  }

  function handleExternalAgentConfigImport(payload) {
    appendSystem(`External config import ${payload?.status || 'updated'}: ${payload?.importId || ''}`, false);
  }

  function handleUsage(payload) {
    const usage = payload?.usage || {};
    const total = usage.totalTokens || usage.total_tokens || usage.total || null;
    if (total) appendSystem(`Token usage: ${total}`, false);
  }

  function renderSessionMeta() {
    const cwd = sessionStatus?.cwd || serverCwd || '';
    const policy = sessionStatus?.approvalPolicy || 'on-request';
    const sandbox = sessionStatus?.sandbox || 'workspace-write';
    const queue = sessionStatus?.queueLength || 0;
    const sid = currentSessionId ? currentSessionId.slice(0, 8) : 'new';
    const codex = versions.codex ? versions.codex.replace(/^codex-cli\s*/, '') : 'codex';
    const path = compactPath(cwd);
    sessionMetaEl.textContent = `${path || 'no workspace'} · ${sandbox} · ${policy} · q:${queue} · ${sid} · ${codex}`;
    const state = sessionStatus?.state || (socket.connected ? 'idle' : 'offline');
    stateLabel.textContent = state.replace('_', ' ');
    renderThreadTitle();
    renderConnectionState();
  }

  function compactPath(path) {
    if (!path) return '';
    const parts = String(path).split('/').filter(Boolean);
    if (parts.length <= 2) return path;
    return '…/' + parts.slice(-2).join('/');
  }

  function syncVisualViewport() {
    const vv = window.visualViewport;
    const height = vv?.height || window.innerHeight;
    const width = vv?.width || window.innerWidth;
    const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    document.documentElement.style.setProperty('--app-width', `${Math.round(width)}px`);
    scrollBottom();
  }

  function createSessionRow(s) {
    const el = document.createElement('div');
    el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    const date = new Date(s.lastUsedAt || s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tag = s.model ? ` · ${escHtml(s.model)}` : '';
    const status = threadStatusPresentation(s.status);
    const actions = `<div class="native-row-actions">
          <button class="native-mini-btn" data-action="rename">Rename</button>
          <button class="native-mini-btn" data-action="${s.archived ? 'unarchive' : 'archive'}">${s.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="native-mini-btn native-danger" data-action="delete">Delete</button>
        </div>`;
    el.innerHTML = `<div class="session-title"><span class="thread-status-dot ${status.kind}" title="${escHtml(status.label)}"></span><span class="session-title-copy">${escHtml(s.title || '未命名')}</span></div><div class="session-date">${date}${tag} · ${escHtml(status.label)}</div>${actions}`;
    el.onclick = () => {
      socket.emit('thread:select', { threadId: s.id, cwd: s.cwd, title: s.title }, ack => {
        if (!ack?.ok) {
          appendSystem(ack?.error || 'Thread select failed', true);
          return;
        }
        applyTargetAck(ack);
        clearMessages();
        loadNativeThreadHistory(s);
        renderDrawerProjects();
      });
      closeDrawer();
    };
    for (const btn of el.querySelectorAll('[data-action]')) {
      btn.onclick = event => {
        event.stopPropagation();
        handleNativeThreadAction(s, btn.dataset.action);
      };
    }
    return el;
  }

  function renderSessionList() {
    renderDrawerProjects();
    if (Date.now() - drawerOpenedAt < 1500) resetDrawerScroll();
  }

  async function handleNativeThreadAction(thread, action) {
    if (action === 'rename') {
      const name = await confirmDialog.prompt({ title: '重命名会话', body: '输入新的会话名称', initial: thread.title || '' });
      if (!name) return;
      socket.emit('thread:rename', { threadId: thread.id, name, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(ack?.error || 'Rename failed', true);
        refreshNativeThreads();
      });
      return;
    }
    if (action === 'delete' && !await confirmDialog.confirm({
      title: '删除会话',
      body: '删除后可从 Codex 历史中消失，且不能从本页撤销。',
      danger: true,
    })) return;
    if (action === 'unarchive') {
      socket.emit('thread:unarchive', { threadId: thread.id, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(ack?.error || 'Unarchive failed', true);
        refreshNativeThreads();
      });
      return;
    }
    if (action === 'delete') {
      socket.emit('thread:delete', { threadId: thread.id, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(ack?.error || 'Delete failed', true);
        clearCurrentThread(localStorage, thread.cwd || serverCwd, thread.id);
        if (currentSessionId === thread.id) {
          currentSessionId = null;
          currentViewingId = null;
          clearMessages();
        }
        refreshNativeThreads();
      });
      return;
    }
    socket.emit('thread:archive', { threadId: thread.id, cwd: thread.cwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Archive failed', true);
      refreshNativeThreads();
    });
  }

  function renderNativePanel(title, bodyHtml) {
    nativePanel.hidden = false;
    nativePanel.innerHTML = `<div class="native-panel-header"><span>${escHtml(title)}</span><button class="native-mini-btn" type="button" data-close-native>Close</button></div>${bodyHtml}`;
    const close = nativePanel.querySelector('[data-close-native]');
    if (close) close.onclick = () => { nativePanel.hidden = true; };
  }

  function scheduleThreadListRefresh() {
    if (threadRefreshTimer) clearTimeout(threadRefreshTimer);
    const requestedCwd = serverCwd;
    threadRefreshTimer = setTimeout(() => {
      threadRefreshTimer = null;
      if (socket.connected && requestedCwd === serverCwd) refreshNativeThreads();
    }, 250);
  }

  function refreshThreadsForCwd(cwd, { showPanel = false } = {}) {
    if (!cwd) return;
    socket.emit('thread:list', { cwd, archived: showArchivedThreads }, ack => {
      if (!ack?.ok) {
        if (cwd === serverCwd) appendSystem(ack?.error || 'Thread list failed', true);
        return;
      }
      const next = mergeThreadList(sessionsByCwd.get(cwd) || [], ack.threads || []);
      sessionsByCwd.set(cwd, next);
      if (cwd === serverCwd) appThreads = next;
      renderSessionList();
      if (cwd === serverCwd) {
        if (showPanel) renderNativeThreadList();
        renderThreadTitle();
      }
    });
  }

  function refreshNativeThreads(showPanel = false) {
    if (serverCwd) expandedDirs.add(serverCwd);
    const targets = expandedDirs.size ? [...expandedDirs] : (serverCwd ? [serverCwd] : []);
    for (const cwd of targets) {
      refreshThreadsForCwd(cwd, { showPanel: showPanel && cwd === serverCwd });
    }
  }

  function renderNativeThreadList() {
    const rows = appThreads.length
      ? appThreads.map(t => `<div class="native-list-row">
          <div class="native-row-title">${escHtml(t.title || t.id)}</div>
          <div class="native-row-meta">${escHtml((t.id || '').slice(0, 8))} · ${escHtml(t.cwd || '')}</div>
        </div>`).join('')
      : '<div class="native-list-row">No native threads</div>';
    renderNativePanel(showArchivedThreads ? 'Archived Threads' : 'Native Threads', rows);
  }

  function startCompact() {
    if (!currentSessionId) {
      appendSystem('No active thread to compact', true);
      return;
    }
    socket.emit('thread:compact', { threadId: currentSessionId, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Compact failed', true);
      appendSystem('Compact requested', false);
    });
  }

  async function rollbackThread() {
    if (!currentSessionId) {
      appendSystem('No active thread to rollback', true);
      return;
    }
    const raw = await confirmDialog.prompt({ title: '回退会话', body: '回退多少轮？', initial: '1' });
    if (raw === null) return;
    const numTurns = Math.max(1, Number.parseInt(raw, 10) || 1);
    socket.emit('thread:rollback', { threadId: currentSessionId, numTurns, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Rollback failed', true);
      appendSystem(`Rollback requested: ${numTurns}`, false);
    });
  }

  function loadNativeModels() {
    socket.emit('models:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Model list failed', true);
      const caps = ack.capabilities || {};
      const modelRows = (ack.models || []).map(model => {
        const id = model.model || model.id || '';
        const name = model.displayName || id;
        return `<div class="native-list-row">
          <div class="native-row-title">${escHtml(name)}</div>
          <div class="native-row-meta">${escHtml(id)}${model.isDefault ? ' · default' : ''}</div>
          <div class="native-row-actions"><button class="native-mini-btn" data-model-id="${escHtml(id)}">Use</button></div>
        </div>`;
      }).join('') || '<div class="native-list-row">No models</div>';
      renderNativePanel('Models', `<div class="native-list-row"><div class="native-row-meta">namespaceTools:${Boolean(caps.namespaceTools)} · image:${Boolean(caps.imageGeneration)} · web:${Boolean(caps.webSearch)}</div></div>${modelRows}`);
      nativePanel.querySelectorAll('[data-model-id]').forEach(btn => {
        btn.onclick = () => {
          applyComposerModel(btn.dataset.modelId);
        };
      });
    });
  }

  function openFileBrowser(path = serverCwd) {
    const targetPath = path || serverCwd || '/';
    socket.emit('fs:readDirectory', { path: targetPath, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Read directory failed', true);
      const parent = parentPath(targetPath);
      const rows = [
        parent ? `<button class="native-mini-btn" data-dir="${escHtml(parent)}">..</button>` : '',
        ...(ack.entries || []).map(entry => {
          const child = joinPath(targetPath, entry.fileName);
          const action = entry.isDirectory ? `data-dir="${escHtml(child)}"` : `data-file="${escHtml(child)}"`;
          return `<div class="native-list-row">
            <div class="native-row-title">${entry.isDirectory ? 'Folder' : 'File'} ${escHtml(entry.fileName)}</div>
            <div class="native-row-actions"><button class="native-mini-btn" ${action}>${entry.isDirectory ? 'Open' : '@ Mention'}</button></div>
          </div>`;
        })
      ].join('');
      renderNativePanel('Files', `<input class="native-input" value="${escHtml(targetPath)}" data-file-path>${rows || '<div class="native-list-row">Empty directory</div>'}`);
      const pathInput = nativePanel.querySelector('[data-file-path]');
      pathInput.onkeydown = event => {
        if (event.key === 'Enter') openFileBrowser(pathInput.value.trim());
      };
      nativePanel.querySelectorAll('[data-dir]').forEach(btn => {
        btn.onclick = () => openFileBrowser(btn.dataset.dir);
      });
      nativePanel.querySelectorAll('[data-file]').forEach(btn => {
        btn.onclick = () => readNativeFile(btn.dataset.file);
      });
    });
  }

  function readNativeFile(path) {
    socket.emit('fs:readFile', { path, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Read file failed', true);
      const text = decodeBase64Text(ack.dataBase64 || '');
      addInputPart({ kind: 'mention', name: path.split('/').pop() || path, path });
      inputEl.focus();
      renderNativePanel('File Preview', `<div class="native-list-row"><div class="native-row-title">${escHtml(path)}</div><pre class="tool-output" style="max-height:180px;">${escHtml(text.slice(0, 2000))}</pre></div>`);
    });
  }

  function loadAccountPanel() {
    socket.emit('account:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Account read failed', true);
      renderNativePanel('Account', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify({ account: ack.account, usage: ack.usage, rateLimits: ack.rateLimits }, null, 2))}</pre>`);
    });
  }

  function loadMcpPanel() {
    socket.emit('mcp:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'MCP read failed', true);
      const rows = (ack.servers || []).map(server => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(server.name)}</div>
        <div class="native-row-meta">${escHtml(server.authStatus || '')} · tools:${Object.keys(server.tools || {}).length}</div>
      </div>`).join('') || '<div class="native-list-row">No MCP servers</div>';
      renderNativePanel('MCP', rows);
    });
  }

  function loadSkillsPanel() {
    socket.emit('skills:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Skills read failed', true);
      const skills = (ack.entries || []).flatMap(entry => (entry.skills || []).map(skill => ({
        ...skill,
        cwd: entry.cwd,
      }))).filter(skill => skill.enabled === true);
      const rows = skills.map((skill, index) => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(skill.name)}</div>
        <div class="native-row-meta">${escHtml(skill.description || skill.path || skill.cwd || '')}</div>
        <div class="native-row-actions"><button class="native-mini-btn" data-skill-index="${index}">Use</button></div>
      </div>`).join('') || '<div class="native-list-row">No enabled skills</div>';
      renderNativePanel('Skills', rows);
      nativePanel.querySelectorAll('[data-skill-index]').forEach(btn => {
        btn.onclick = () => {
          const skill = skills[Number(btn.dataset.skillIndex)];
          if (!skill) return;
          addInputPart({ kind: 'skill', name: skill.name, path: skill.path });
          inputEl.focus();
        };
      });
    });
  }

  function detectExternalAgentConfig() {
    socket.emit('externalAgentConfig:detect', { cwd: serverCwd, includeHome: false }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Detect failed', true);
      const items = ack.items || [];
      const rows = items.map((item, index) => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(item.description || 'Migration item')}</div>
        <div class="native-row-meta">${escHtml(item.cwd || 'home')}</div>
        <div class="native-row-actions"><button class="native-mini-btn" data-import-index="${index}">Import</button></div>
      </div>`).join('') || '<div class="native-list-row">No importable config</div>';
      renderNativePanel('Import', rows);
      nativePanel.querySelectorAll('[data-import-index]').forEach(btn => {
        btn.onclick = async () => {
          const item = items[Number(btn.dataset.importIndex)];
          if (!item) return;
          const accepted = await confirmDialog.confirm({ title: '导入配置', body: item.description || 'Import this config?' });
          if (!accepted) return;
          socket.emit('externalAgentConfig:import', { migrationItems: [item], cwd: serverCwd }, importAck => {
            if (!importAck?.ok) return appendSystem(importAck?.error || 'Import failed', true);
            appendSystem(`Import started: ${importAck.importId || ''}`, false);
          });
        };
      });
    });
  }

  function openP3Panel() {
    if (!features.labs) return;
    renderNativePanel('Labs', `
      <div class="native-list-row">
        <div class="native-row-title">Capabilities</div>
        <div class="native-row-actions"><button id="p3-capabilities-btn" class="native-mini-btn" type="button">Read</button></div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Terminal</div>
        <div class="native-row-actions">
          <button id="p3-terminal-spawn-btn" class="native-mini-btn" type="button">Spawn</button>
          <button id="p3-terminal-write-btn" class="native-mini-btn" type="button">Write</button>
          <button id="p3-terminal-resize-btn" class="native-mini-btn" type="button">Resize</button>
          <button id="p3-terminal-terminate-btn" class="native-mini-btn native-danger" type="button">Stop</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Threads</div>
        <div class="native-row-actions">
          <button id="p3-thread-turns-btn" class="native-mini-btn" type="button">Turns</button>
          <button id="p3-thread-search-btn" class="native-mini-btn" type="button">Search</button>
        </div>
      </div>
    `);
    $('p3-capabilities-btn').onclick = loadP3Capabilities;
    $('p3-terminal-spawn-btn').onclick = spawnP3Terminal;
    $('p3-terminal-write-btn').onclick = writeP3Terminal;
    $('p3-terminal-resize-btn').onclick = resizeP3Terminal;
    $('p3-terminal-terminate-btn').onclick = terminateP3Terminal;
    $('p3-thread-turns-btn').onclick = loadP3ThreadTurns;
    $('p3-thread-search-btn').onclick = searchP3Threads;
  }

  function loadP3Capabilities() {
    socket.emit('p3:capabilities', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 capabilities failed', true);
      renderNativePanel('Labs', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify(ack.capabilities || {}, null, 2))}</pre>`);
    });
  }

  function spawnP3Terminal() {
    const command = promptRequired('Command', 'bash -lc "pwd"');
    if (command === null) return;
    const processId = promptRequired('Process id', `term_${Date.now()}`);
    if (processId === null) return;
    socket.emit('p3:terminalSpawn', {
      cwd: serverCwd,
      processId,
      command: ['bash', '-lc', command],
      cols: 100,
      rows: 30,
    }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal spawn failed', true);
      appendSystem(`Terminal spawned: ${ack.processId || processId}`, false);
    });
  }

  function writeP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    const text = prompt('Input', '');
    if (text === null) return;
    socket.emit('p3:terminalWrite', { cwd: serverCwd, processId, text }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal write failed', true);
      appendSystem(`Terminal write: ${processId}`, false);
    });
  }

  function resizeP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    socket.emit('p3:terminalResize', { cwd: serverCwd, processId, cols: 100, rows: 30 }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal resize failed', true);
      appendSystem(`Terminal resized: ${processId}`, false);
    });
  }

  function terminateP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    socket.emit('p3:terminalTerminate', { cwd: serverCwd, processId }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal terminate failed', true);
      appendSystem(`Terminal stopped: ${processId}`, false);
    });
  }

  function loadP3ThreadTurns() {
    const threadId = promptRequired('Thread id', currentSessionId || '');
    if (threadId === null) return;
    socket.emit('p3:threadTurns', { cwd: serverCwd, threadId }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 thread turns failed', true);
      renderNativePanel('Turns', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify(ack.turns || [], null, 2))}</pre>`);
    });
  }

  function searchP3Threads() {
    const query = promptRequired('Search query');
    if (query === null) return;
    socket.emit('p3:threadSearch', { cwd: serverCwd, query, limit: 20 }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 thread search failed', true);
      const rows = (ack.results || []).map(thread => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(thread.name || thread.title || thread.preview || thread.id || 'Thread')}</div>
        <div class="native-row-meta">${escHtml(thread.id || thread.sessionId || '')}</div>
      </div>`).join('') || '<div class="native-list-row">No results</div>';
      renderNativePanel('Search', rows);
    });
  }

  function handleP3TerminalOutput(payload) {
    const text = String(payload?.text || '');
    if (!text) return;
    rememberOutput(text);
    appendSystem(`Terminal ${payload?.stream || 'stdout'} ${payload?.processId || ''}: ${text.slice(0, 600)}`, payload?.stream === 'stderr');
  }

  function handleP3TerminalExit(payload) {
    appendSystem(`Terminal exited ${payload?.processId || ''}: ${payload?.exitCode ?? 'unknown'}`, Number(payload?.exitCode) !== 0);
  }

  function handleP3Realtime(payload) {
    appendSystem(`Realtime ${payload?.event || 'event'}: ${payload?.threadId || currentSessionId || ''}`, payload?.event === 'error');
  }

  function handleP3RemoteControl(payload) {
    const status = typeof payload?.status === 'string' ? payload.status : (payload?.status?.type || 'updated');
    appendSystem(`Remote control ${status}: ${payload?.serverName || ''}`, false);
  }

  function openAdminPanel() {
    if (!features.admin) return;
    renderNativePanel('Admin', `
      <div class="native-list-row">
        <div class="native-row-title">${adminUnlocked ? 'Unlocked' : 'Locked'}</div>
        <div class="native-row-actions">
          <button id="admin-unlock-btn" class="native-mini-btn" type="button"${adminUnlocked ? ' hidden' : ''}>Unlock</button>
          <button id="admin-lock-btn" class="native-mini-btn" type="button"${adminUnlocked ? '' : ' hidden'}>Lock</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Config</div>
        <div class="native-row-actions">
          <button id="admin-config-write-btn" class="native-mini-btn" type="button">Write</button>
          <button id="admin-config-batch-btn" class="native-mini-btn" type="button">Batch</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Plugins</div>
        <div class="native-row-actions">
          <button id="admin-plugin-install-btn" class="native-mini-btn" type="button">Install</button>
          <button id="admin-plugin-uninstall-btn" class="native-mini-btn" type="button">Uninstall</button>
          <button id="admin-marketplace-add-btn" class="native-mini-btn" type="button">Add Market</button>
          <button id="admin-marketplace-remove-btn" class="native-mini-btn" type="button">Remove Market</button>
          <button id="admin-marketplace-upgrade-btn" class="native-mini-btn" type="button">Upgrade Market</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Files</div>
        <div class="native-row-actions">
          <button id="admin-fs-write-btn" class="native-mini-btn native-danger" type="button">Write</button>
          <button id="admin-fs-remove-btn" class="native-mini-btn native-danger" type="button">Remove</button>
          <button id="admin-fs-copy-btn" class="native-mini-btn" type="button">Copy</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">MCP / Account</div>
        <div class="native-row-actions">
          <button id="admin-mcp-call-btn" class="native-mini-btn native-danger" type="button">Tool Call</button>
          <button id="admin-logout-btn" class="native-mini-btn native-danger" type="button">Logout</button>
        </div>
      </div>
    `);
    $('admin-unlock-btn').onclick = unlockAdminMode;
    $('admin-lock-btn').onclick = lockAdminMode;
    $('admin-config-write-btn').onclick = adminConfigWrite;
    $('admin-config-batch-btn').onclick = adminConfigBatchWrite;
    $('admin-plugin-install-btn').onclick = adminPluginInstall;
    $('admin-plugin-uninstall-btn').onclick = adminPluginUninstall;
    $('admin-marketplace-add-btn').onclick = adminMarketplaceAdd;
    $('admin-marketplace-remove-btn').onclick = adminMarketplaceRemove;
    $('admin-marketplace-upgrade-btn').onclick = adminMarketplaceUpgrade;
    $('admin-fs-write-btn').onclick = adminFsWrite;
    $('admin-fs-remove-btn').onclick = adminFsRemove;
    $('admin-fs-copy-btn').onclick = adminFsCopy;
    $('admin-mcp-call-btn').onclick = adminMcpCall;
    $('admin-logout-btn').onclick = adminAccountLogout;
  }

  function unlockAdminMode() {
    let confirmText;
    try {
      confirmText = promptRequired('Unlock phrase', 'ENABLE ADMIN');
    } catch (err) {
      appendSystem(err.message, true);
      return;
    }
    if (confirmText === null) return;
    if (confirmText !== 'ENABLE ADMIN') return appendSystem('Admin unlock phrase mismatch', true);
    socket.emit('admin:unlock', { confirmText }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Admin unlock failed', true);
      adminUnlocked = true;
      appendSystem('Admin mode enabled', false);
      openAdminPanel();
    });
  }

  function lockAdminMode() {
    socket.emit('admin:lock', {}, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Admin lock failed', true);
      adminUnlocked = false;
      appendSystem('Admin mode locked', false);
      openAdminPanel();
    });
  }

  const adminEmitters = {
    'admin:configWrite': (payload, ack) => socket.emit('admin:configWrite', payload, ack),
    'admin:configBatchWrite': (payload, ack) => socket.emit('admin:configBatchWrite', payload, ack),
    'admin:pluginInstall': (payload, ack) => socket.emit('admin:pluginInstall', payload, ack),
    'admin:pluginUninstall': (payload, ack) => socket.emit('admin:pluginUninstall', payload, ack),
    'admin:marketplaceAdd': (payload, ack) => socket.emit('admin:marketplaceAdd', payload, ack),
    'admin:marketplaceRemove': (payload, ack) => socket.emit('admin:marketplaceRemove', payload, ack),
    'admin:marketplaceUpgrade': (payload, ack) => socket.emit('admin:marketplaceUpgrade', payload, ack),
    'admin:fsWriteFile': (payload, ack) => socket.emit('admin:fsWriteFile', payload, ack),
    'admin:fsRemove': (payload, ack) => socket.emit('admin:fsRemove', payload, ack),
    'admin:fsCopy': (payload, ack) => socket.emit('admin:fsCopy', payload, ack),
    'admin:mcpToolCall': (payload, ack) => socket.emit('admin:mcpToolCall', payload, ack),
    'admin:accountLogout': (payload, ack) => socket.emit('admin:accountLogout', payload, ack),
  };

  function runAdminAction(eventName, buildPayload) {
    if (!adminUnlocked) return appendSystem('Admin mode is locked', true);
    let confirmation;
    try {
      confirmation = promptRequired('Confirm action', eventName);
    } catch (err) {
      appendSystem(err.message, true);
      return;
    }
    if (confirmation === null) return;
    if (confirmation !== eventName) return appendSystem(`${eventName} confirmation mismatch`, true);
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      appendSystem(err.message, true);
      return;
    }
    if (!payload) return;
    adminEmitters[eventName]({ ...payload, cwd: serverCwd, adminConfirm: confirmation }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || `${eventName} failed`, true);
      appendSystem(`${eventName} completed`, false);
    });
  }

  function promptRequired(label, initial = '') {
    const value = prompt(label, initial);
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} required`);
    return trimmed;
  }

  function adminConfigWrite() {
    runAdminAction('admin:configWrite', () => ({
      keyPath: promptRequired('Config keyPath', 'model'),
      value: promptRequired('Config value', 'gpt-5.5'),
      mergeStrategy: 'replace',
    }));
  }

  function adminConfigBatchWrite() {
    runAdminAction('admin:configBatchWrite', () => ({
      edits: [{
        keyPath: promptRequired('Config keyPath', 'approval_policy'),
        value: promptRequired('Config value', 'on-request'),
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    }));
  }

  function adminPluginInstall() {
    runAdminAction('admin:pluginInstall', () => ({ pluginName: promptRequired('Plugin name') }));
  }

  function adminPluginUninstall() {
    runAdminAction('admin:pluginUninstall', () => ({ pluginId: promptRequired('Plugin id') }));
  }

  function adminMarketplaceAdd() {
    runAdminAction('admin:marketplaceAdd', () => ({ source: promptRequired('Marketplace source') }));
  }

  function adminMarketplaceRemove() {
    runAdminAction('admin:marketplaceRemove', () => ({ marketplaceName: promptRequired('Marketplace name') }));
  }

  function adminMarketplaceUpgrade() {
    runAdminAction('admin:marketplaceUpgrade', () => ({ marketplaceName: promptRequired('Marketplace name') }));
  }

  function adminFsWrite() {
    runAdminAction('admin:fsWriteFile', () => ({
      path: promptRequired('File path', serverCwd ? `${serverCwd}/admin.txt` : ''),
      dataBase64: btoa(unescape(encodeURIComponent(promptRequired('File text')))),
    }));
  }

  function adminFsRemove() {
    runAdminAction('admin:fsRemove', () => ({ path: promptRequired('Path'), recursive: true, force: false }));
  }

  function adminFsCopy() {
    runAdminAction('admin:fsCopy', () => ({
      sourcePath: promptRequired('Source path'),
      destinationPath: promptRequired('Destination path'),
      recursive: true,
    }));
  }

  function adminMcpCall() {
    runAdminAction('admin:mcpToolCall', () => ({
      threadId: promptRequired('Thread id', currentSessionId || ''),
      server: promptRequired('MCP server'),
      tool: promptRequired('MCP tool'),
      arguments: JSON.parse(prompt('Arguments JSON', '{}') || '{}'),
    }));
  }

  function adminAccountLogout() {
    runAdminAction('admin:accountLogout', () => ({}));
  }

  function joinPath(base, name) {
    return `${String(base || '/').replace(/\/+$/, '')}/${name}`.replace(/^\/\//, '/');
  }

  function parentPath(path) {
    const clean = String(path || '').replace(/\/+$/, '');
    if (!clean || clean === '/') return null;
    const idx = clean.lastIndexOf('/');
    return idx <= 0 ? '/' : clean.slice(0, idx);
  }

  function decodeBase64Text(dataBase64) {
    try {
      const bytes = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  }

  function loadNativeThreadHistory(s) {
    socket.emit('thread:history', { threadId: s.id, cwd: s.cwd }, data => {
      if (!data?.ok) {
        appendSystem(data?.error || 'Thread history failed', true);
        return;
      }
      renderHistoryMessages(data.messages || [], s.title || data.thread?.name || data.thread?.preview || 'Native thread');
    });
  }

  function renderHistoryMessages(msgs, title) {
    finishAssistantTurn();
    if (msgs.length === 0) {
      appendSystem('该会话无历史消息', false);
      return;
    }
    appendSystem(`📋 ${title || '历史会话'}（${msgs.length} 条消息）`, false);
    for (const m of msgs.slice(-30)) {
      if (m.kind === 'command') {
        appendRaw(renderCommandCard(commandCard(m)), 'codex');
        continue;
      }
      if (m.kind === 'file_change') {
        handleFileChange({ files: m.files || [] });
        continue;
      }
      if (m.kind === 'mcp') {
        const toolUseId = `history-mcp-${messagesEl.children.length}`;
        handleMcpUse({ ...m, toolUseId });
        handleMcpResult({ ...m, toolUseId });
        continue;
      }
      if (m.kind === 'search') {
        handleSearch(m);
        continue;
      }
      if (m.kind === 'plan') {
        handlePlan({ plan: m.plan || [] });
        continue;
      }
      if (m.kind === 'reasoning') {
        appendReasoning({ text: m.text, channel: m.channel || 'summary' });
        sealReasoning();
        continue;
      }
      if (m.kind === 'raw') {
        handleRawItem({ item: m.item });
        continue;
      }
      if (m.role === 'user') {
        appendHistoryUserBubble(m.content);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'bubble md';
        bubble.innerHTML = renderMarkdown(m.content || '');
        appendRaw(bubble, 'codex');
      }
    }
    finishAssistantTurn();
    scrollBottom();
    checkEmptyState();
  }

  function appendHistoryUserBubble(text) {
    finishAssistantTurn();
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="bubble">${escHtml(text || '')}</div>`;
    messagesEl.appendChild(el);
  }

  function appendQueuedBubble(payload) {
    const text = payload.text || '';
    const clientRequestId = payload.clientRequestId || '';
    const offlineIndex = clientRequestId
      ? offlineUserBubbles.findIndex(item => item.clientRequestId === clientRequestId)
      : -1;
    if (offlineIndex >= 0) {
      const [{ el }] = offlineUserBubbles.splice(offlineIndex, 1);
      el.classList.remove('offline');
      el.classList.add('queued');
      const labelEl = el.querySelector('.offline-label');
      if (labelEl) {
        labelEl.className = 'queued-label';
        labelEl.textContent = `Queued #${payload.position || payload.queueLength || 1}`;
      }
      queuedUserBubbles.push({ clientRequestId, text, el });
      return;
    }
    const el = document.createElement('div');
    el.className = 'msg user queued';
    el.dataset.text = text;
    if (clientRequestId) el.dataset.clientRequestId = clientRequestId;
    el.innerHTML = `<div class="bubble">${escHtml(text)}<span class="queued-label">Queued #${payload.position || payload.queueLength || 1}</span></div>`;
    messagesEl.appendChild(el);
    if (clientRequestId) renderedOutboxIds.add(clientRequestId);
    queuedUserBubbles.push({ clientRequestId, text, el });
    scrollBottom();
    checkEmptyState();
  }

  function markQueuedBubble(clientRequestId, text, label) {
    const item = clientRequestId
      ? queuedUserBubbles.find(q => q.clientRequestId === clientRequestId)
      : queuedUserBubbles.find(q => q.text === text);
    if (!item) return false;
    const labelEl = item.el.querySelector('.queued-label');
    if (labelEl) labelEl.textContent = label;
    return true;
  }

  function promoteQueuedBubble(clientRequestId, text) {
    const idx = clientRequestId
      ? queuedUserBubbles.findIndex(q => q.clientRequestId === clientRequestId)
      : queuedUserBubbles.findIndex(q => q.text === text);
    if (idx === -1) return false;
    const [{ el }] = queuedUserBubbles.splice(idx, 1);
    el.classList.remove('queued');
    const labelEl = el.querySelector('.queued-label');
    if (labelEl) labelEl.remove();
    return true;
  }

  function handleQueueCleared(payload) {
    queuedUserBubbles.forEach(q => q.el.remove());
    queuedUserBubbles = [];
    appendSystem(`已清空 ${payload.dropped || 0} 条队列输入`, false);
    checkEmptyState();
  }

  function appendOfflineBubble(payload, { needsReconcile = false, unboundRecovery = false } = {}) {
    const text = payload.text || '';
    const clientRequestId = payload.clientRequestId || '';
    if (clientRequestId && renderedOutboxIds.has(clientRequestId)) return;
    const el = document.createElement('div');
    el.className = 'msg user offline';
    el.dataset.text = text;
    if (clientRequestId) el.dataset.clientRequestId = clientRequestId;
    let html = `<div class="bubble">`;
    if (payload.attachments?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">📎 ${payload.attachments.map(a => escHtml(a.name)).join(', ')}</div>`;
    }
    if (payload.parts?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">📌 ${payload.parts.map(partDisplayName).map(escHtml).join(', ')}</div>`;
    }
    const deliveryLabel = unboundRecovery
      ? (needsReconcile
        ? '⚠️ 原会话目标已失效，正在按请求 ID 核对；不会自动重发'
        : '⏳ 原会话目标已失效，连接后将恢复到当前会话')
      : (needsReconcile
        ? '⚠️ 结果未知，正在核对；不会自动重发'
        : '⏳ 弱网等待同步 (Offline Queue)');
    html += `${escHtml(text || (payload.parts?.length ? '(结构化引用)' : '(附件)'))}<span class="offline-label">${deliveryLabel}</span></div>`;
    el.innerHTML = html;
    if (needsReconcile && clientRequestId) {
      const retryButton = document.createElement('button');
      retryButton.className = 'unknown-retry-btn';
      retryButton.type = 'button';
      retryButton.textContent = '确认后重试';
      retryButton.onclick = async () => {
        const accepted = await confirmDialog.confirm({
          title: '确认后重试',
          body: '无法确认上一请求是否已执行；再次发送可能重复执行工具或修改。',
          danger: true,
        });
        if (!accepted) return;
        try {
          const target = await ensureViewTarget();
          const replacement = await messageOutbox.retryAfterConfirmation(clientRequestId, { target });
          if (!replacement) return;
          const bubbleIndex = offlineUserBubbles.findIndex(item => item.clientRequestId === clientRequestId);
          if (bubbleIndex >= 0) offlineUserBubbles.splice(bubbleIndex, 1);
          renderedOutboxIds.delete(clientRequestId);
          el.dataset.clientRequestId = replacement.clientRequestId;
          renderedOutboxIds.add(replacement.clientRequestId);
          offlineUserBubbles.push({ clientRequestId: replacement.clientRequestId, text, el });
          const label = el.querySelector('.offline-label');
          if (label) label.textContent = '⏳ 已确认重试，等待发送';
          retryButton.remove();
          await drainMessageOutbox({
            shouldSend: outboxRequestMatchesView,
          });
        } catch (error) {
          appendSystem(`消息重试失败：${error.message}`, true);
        }
      };
      el.querySelector('.bubble')?.appendChild(retryButton);
    }
    messagesEl.appendChild(el);
    if (clientRequestId) renderedOutboxIds.add(clientRequestId);
    offlineUserBubbles.push({ clientRequestId, text, el });
    scrollBottom();
    checkEmptyState();
  }

  function promoteOfflineBubble(clientRequestId) {
    if (!clientRequestId) return false;
    const idx = offlineUserBubbles.findIndex(q => q.clientRequestId === clientRequestId);
    if (idx === -1) return false;
    const [{ el }] = offlineUserBubbles.splice(idx, 1);
    el.classList.remove('offline');
    const labelEl = el.querySelector('.offline-label');
    if (labelEl) labelEl.remove();
    return true;
  }

  function renderCommandCard(model) {
    const card = document.createElement('div');
    card.className = 'tool-card command-card';
    if (model.ok === true) card.dataset.ok = 'true';
    else if (model.ok === false) card.dataset.ok = 'false';
    const command = model.command || 'streaming output';
    const exit = model.exitCode == null
      ? ''
      : `<div class="tool-exit ${model.ok ? 'tool-ok' : 'tool-err'}">exit: ${escHtml(String(model.exitCode))}</div>`;
    card.innerHTML = `<div class="tool-name">${escHtml(model.title)}</div>`
      + `<details${model.running ? ' open' : ''}><summary class="tool-cmd">${escHtml(command)}</summary></details>`
      + `<div class="tool-output live-output${model.ok === false ? ' tool-err' : model.ok === true ? ' tool-ok' : ''}">${model.output ? renderAnsi(model.output) : ''}</div>`
      + exit;
    return card;
  }

  function handleToolUse(payload) {
    finalizeStream();
    const model = commandCard({ command: payload.inputSummary || '', running: true });
    const card = renderCommandCard(model);
    appendRaw(card, 'codex');
    pendingToolCards[payload.toolUseId] = card;
    scrollBottom();
  }

  function ensureToolOutputCard(toolUseId) {
    let card = pendingToolCards[toolUseId];
    if (!card) {
      const model = commandCard({ command: 'streaming output', running: true });
      card = renderCommandCard(model);
      appendRaw(card, 'codex');
      pendingToolCards[toolUseId] = card;
    }
    let out = card.querySelector('.live-output');
    if (!out) {
      out = document.createElement('div');
      out.className = 'tool-output live-output';
      card.appendChild(out);
    }
    return out;
  }

  function handleToolOutputDelta(payload) {
    if (!payload.text) return;
    const out = ensureToolOutputCard(payload.toolUseId || 'unknown');
    out.innerHTML += renderAnsi(payload.text);
    out.scrollTop = out.scrollHeight;
    scrollBottom();
  }

  function handleToolResult(payload) {
    const card = pendingToolCards[payload.toolUseId];
    const existingCommand = card?.querySelector('.tool-cmd')?.textContent || '';
    const model = commandCard({
      command: existingCommand,
      output: payload.outputSummary || (payload.ok ? '(完成)' : '(出错)'),
      exitCode: payload.exitCode ?? (payload.ok ? 0 : null),
      status: payload.status || 'completed',
    });
    const statusLine = `status: ${model.status} · exit: ${model.exitCode ?? 'unknown'}\n`;
    const resultText = statusLine + model.output;
    if (card) {
      card.classList.add('command-card');
      if (model.ok === true) card.dataset.ok = 'true';
      else if (model.ok === false) card.dataset.ok = 'false';
      let out = card.querySelector('.live-output');
      if (!out) {
        out = document.createElement('div');
        card.appendChild(out);
      }
      out.className = 'tool-output live-output ' + (model.ok ? 'tool-ok' : 'tool-err');
      const resultHtml = renderAnsi(model.output);
      if (out.innerText.trim()) out.innerHTML += '<br>' + resultHtml;
      else out.innerHTML = resultHtml;
      let exit = card.querySelector('.tool-exit');
      if (!exit && model.exitCode != null) {
        exit = document.createElement('div');
        exit.className = 'tool-exit ' + (model.ok ? 'tool-ok' : 'tool-err');
        exit.textContent = `exit: ${model.exitCode}`;
        card.appendChild(exit);
      } else if (exit && model.exitCode != null) {
        exit.className = 'tool-exit ' + (model.ok ? 'tool-ok' : 'tool-err');
        exit.textContent = `exit: ${model.exitCode}`;
      }
      delete pendingToolCards[payload.toolUseId];
    }
    rememberOutput(resultText);
    scrollBottom();
  }

  function handleResult(payload) {
    finalizeStream();
    finishAssistantTurn();
    announceTurnComplete(payload?.ok === false ? '回复失败' : '回复完成');
    setBusy(false);
    if (payload && payload.ok === false && activeTurnText) rememberFailure(activeTurnText);
    if (payload && payload.ok !== false) activeTurnText = '';
    refreshNativeThreads();
    checkEmptyState();
  }

  function handleApprovalRequest(payload, event) {
    finalizeStream();
    const requestTarget = {
      instanceId: event?.instanceId || null,
      threadId: event?.sessionId || payload.threadId || null,
    };
    const decisions = payload.availableDecisions || [];
    const deny = decisions.includes('decline') ? 'decline' : (decisions.includes('cancel') ? 'cancel' : 'decline');
    const sessionDecision = decisions.includes('acceptForSession') ? `<button class="approve-btn" data-d="acceptForSession">本会话批准</button>` : '';
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">⚠️ 需要审批</div>`
      + `<div class="tool-cmd">${escHtml(payload.command || payload.kind || '需要确认的操作')}</div>`
      + renderApprovalDetails(payload)
      + `<div class="approval-btns">`
      + `<button class="approve-btn" data-d="accept">批准</button>`
      + sessionDecision
      + `<button class="deny-btn" data-d="${deny}">拒绝</button></div>`;
    appendRaw(card, 'codex');
    const cardKey = payload.needId || String(payload.approvalId);
    pendingApprovalCards[cardKey] = card;
    const btns = card.querySelector('.approval-btns');
    btns.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        btns.querySelectorAll('button').forEach(button => { button.disabled = true; });
        socket.emit('user:approval', withTarget({
          needId: payload.needId,
          approvalId: payload.approvalId,
          decision: b.dataset.d,
          turnId: payload.turnId,
          itemId: payload.itemId,
        }, requestTarget), ack => {
          if (!ack?.ok) {
            if (ack?.resultUnknown) {
              markNeedCardUnknown(cardKey);
              appendSystem('审批结果未知，等待上游终态；不会自动重试', true);
              return;
            }
            btns.querySelectorAll('button').forEach(button => { button.disabled = false; });
            appendSystem(ack?.error || '审批失败，请刷新后重试', true);
            return;
          }
          delete pendingApprovalCards[cardKey];
          needsYou.delete(payload.needId);
          renderNeedsYouPanel();
          btns.innerHTML = `<span class="tool-output tool-ok" style="background:transparent;padding:0;">已${b.dataset.d === 'accept' ? '批准' : '拒绝'}</span>`;
        });
      };
    });
    scrollBottom();
  }

  function renderApprovalDetails(payload) {
    let html = '';
    if (payload.reason) {
      html += `<div class="tool-output" style="opacity:.8;background:transparent;color:var(--text-muted);">${escHtml(payload.reason)}</div>`;
    }
    if (payload.permissions && (payload.permissions.network !== undefined || payload.permissions.fileSystem !== undefined)) {
      const lines = [];
      if (payload.permissions.network !== undefined) lines.push(`network: ${JSON.stringify(payload.permissions.network)}`);
      if (payload.permissions.fileSystem !== undefined) lines.push(`fileSystem: ${JSON.stringify(payload.permissions.fileSystem)}`);
      html += `<div class="tool-cmd">${escHtml(lines.join('\n'))}</div>`;
    }
    if (Array.isArray(payload.changes) && payload.changes.length) {
      html += payload.changes.map(change => {
        const title = `${kindLabel(change.kind)}: ${change.path || ''}`;
        const diff = change.diff ? `<pre class="tool-output" style="max-height:220px;">${escHtml(change.diff)}</pre>` : '';
        return `<details open><summary class="tool-cmd">${escHtml(title)}</summary>${diff}</details>`;
      }).join('');
    }
    if (payload.grantRoot) {
      html += `<div class="tool-cmd">grantRoot: ${escHtml(payload.grantRoot)}</div>`;
    }
    return html;
  }

  function kindLabel(k) {
    return ({ add: '新增', modify: '修改', update: '修改', delete: '删除', rename: '重命名' }[k] || k || 'modify');
  }

  function handleUserInputRequest(payload, event) {
    finalizeStream();
    const requestTarget = {
      instanceId: event?.instanceId || null,
      threadId: event?.sessionId || payload.threadId || null,
    };
    const questions = payload.questions || [];
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">❔ 需要回答</div>`
      + questions.map(q => renderQuestion(q)).join('')
      + (payload.autoResolutionMs ? `<div class="tool-output" style="opacity:.7;background:transparent;color:var(--text-muted);">autoResolutionMs: ${escHtml(String(payload.autoResolutionMs))}</div>` : '')
      + `<div class="approval-btns"><button class="approve-btn answer-submit" type="button">提交</button><button class="deny-btn answer-cancel" type="button">跳过</button></div>`;
    appendRaw(card, 'codex');
    const cardKey = payload.needId || String(payload.approvalId);
    pendingApprovalCards[cardKey] = card;

    card.querySelectorAll('.answer-option').forEach(btn => {
      btn.onclick = () => btn.classList.toggle('selected');
    });
    const submitAnswers = (answers, successLabel) => {
      const actionButtons = card.querySelectorAll('.approval-btns:last-child button');
      actionButtons.forEach(button => { button.disabled = true; });
      socket.emit('user:approval', withTarget({
        needId: payload.needId,
        approvalId: payload.approvalId,
        answers,
        turnId: payload.turnId,
        itemId: payload.itemId,
      }, requestTarget), ack => {
        if (!ack?.ok) {
          if (ack?.resultUnknown) {
            markNeedCardUnknown(cardKey);
            appendSystem('回答结果未知，等待上游终态；不会自动重试', true);
            return;
          }
          actionButtons.forEach(button => { button.disabled = false; });
          appendSystem(ack?.error || '回答提交失败，请刷新后重试', true);
          return;
        }
        needsYou.delete(payload.needId);
        renderNeedsYouPanel();
        markInputCardDone(card, cardKey, successLabel);
      });
    };
    card.querySelector('.answer-submit').onclick = () => {
      submitAnswers(collectAnswers(card, questions), '已提交');
    };
    card.querySelector('.answer-cancel').onclick = () => {
      submitAnswers({}, '已跳过');
    };
    scrollBottom();
  }

  function renderQuestion(q) {
    const options = Array.isArray(q.options) ? q.options : [];
    const header = q.header || q.id || 'Question';
    const optionHtml = options.length
      ? `<div class="approval-btns">${options.map(o => `<button type="button" class="approve-btn answer-option" data-q="${escHtml(q.id)}" data-value="${escHtml(o.label)}">${escHtml(o.label)}</button>`).join('')}</div>`
      : `<input class="tool-cmd answer-input" data-q="${escHtml(q.id)}" type="${q.isSecret ? 'password' : 'text'}" placeholder="Answer">`;
    return `<div class="tool-cmd" style="white-space:normal;"><strong>${escHtml(header)}</strong><br>${escHtml(q.question || '')}</div>${optionHtml}`;
  }

  function collectAnswers(card, questions) {
    const answers = {};
    questions.forEach(q => {
      const qid = String(q.id || '');
      const selected = [...card.querySelectorAll(`.answer-option[data-q="${cssEscape(qid)}"].selected`)].map(btn => btn.dataset.value);
      const input = card.querySelector(`.answer-input[data-q="${cssEscape(qid)}"]`);
      const typed = input?.value?.trim();
      const values = selected.length ? selected : (typed ? [typed] : []);
      answers[qid] = values;
    });
    return answers;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return value.replace(/"/g, '\\"');
  }

  function markInputCardDone(card, cardKey, label) {
    delete pendingApprovalCards[cardKey];
    const btns = card.querySelector('.approval-btns:last-child');
    if (btns) btns.innerHTML = `<span class="tool-output tool-ok" style="background:transparent;padding:0;">${escHtml(label)}</span>`;
  }

  function handleApprovalRevoked(payload) {
    const key = String(payload?.approvalId ?? payload?.requestId ?? '');
    const card = pendingApprovalCards[key];
    if (!card) return;
    delete pendingApprovalCards[key];
    card.remove();
    scrollBottom();
  }

  function handleFileChange(payload) {
    finalizeStream();
    const model = fileChangeCard({ files: payload.files || [] });
    if (!model.files.length) return;
    const card = document.createElement('div');
    card.className = 'tool-card file-change-card';
    card.innerHTML = `<div class="tool-name">${escHtml(model.title)}</div>`
      + model.files.map(file => {
        const line = `${file.kindLabel}: ${file.path}`;
        if (!file.expandable) return `<div class="tool-cmd">${escHtml(line)}</div>`;
        return `<details><summary class="tool-cmd">${escHtml(line)}</summary><pre class="tool-output">${escHtml(file.diff)}</pre></details>`;
      }).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handleRawItem(payload) {
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    const label = payload?.item?.type || payload?.envelopeType || 'raw';
    card.innerHTML = `<div class="tool-name">🧾 Raw</div>`
      + `<details><summary class="tool-cmd">${escHtml(label)}</summary><pre class="tool-output">${escHtml(JSON.stringify(payload.item || payload, null, 2))}</pre></details>`;
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handlePlan(payload) {
    finalizeStream();
    const plan = payload.plan || [];
    if (!plan.length) return;
    const icon = s => ({ completed: '✅', inProgress: '⏳', in_progress: '⏳', pending: '⬜' }[s] || '•');
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">📋 计划</div>`
      + plan.map(p => `<div class="tool-cmd">${icon(p.status)} ${escHtml(p.step || '')}</div>`).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function appendReasoning(payload) {
    const data = typeof payload === 'string' ? { text: payload, channel: 'summary' } : (payload || {});
    const channel = payload && payload.channel === 'full' ? 'full' : 'summary';
    if (!data.text && data.kind !== 'summary_part_added') return;
    if (!appendReasoning.card) {
      const card = document.createElement('div');
      card.className = 'tool-card reasoning-card';
      card.dataset.streaming = 'true';
      card.innerHTML = '<details class="reasoning-fold"><summary class="reasoning-toggle"><span class="reasoning-label">思考中</span></summary><div class="reasoning-stack"></div></details>';
      appendRaw(card, 'codex');
      appendReasoning.card = card;
      appendReasoning.sections = {};
    }
    const section = ensureReasoningSection(channel);
    if (data.kind === 'summary_part_added' && section.textContent.trim()) {
      section.textContent += '\n\n';
    }
    if (data.text) section.textContent += data.text;
    scrollBottom();
  }

  function ensureReasoningSection(channel) {
    const key = channel === 'full' ? 'full' : 'summary';
    if (appendReasoning.sections?.[key]) return appendReasoning.sections[key];
    const wrap = document.createElement('div');
    wrap.className = key === 'full'
      ? 'reasoning-section reasoning-full'
      : 'reasoning-section reasoning-summary';
    wrap.innerHTML = `${key === 'full' ? '<div class="reasoning-channel">完整推理</div>' : ''}<pre class="reasoning-body"></pre>`;
    appendReasoning.card.querySelector('.reasoning-stack')?.appendChild(wrap);
    const out = wrap.querySelector('.reasoning-body');
    appendReasoning.sections[key] = out;
    return out;
  }

  // MCP tool cards
  const pendingMcpCards = {};
  function handleMcpUse(payload) {
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">🔧 ${escHtml(payload.serverName)}/${escHtml(payload.toolName)}</div><div class="tool-cmd">${escHtml(payload.inputSummary || '')}</div>`;
    appendRaw(card, 'codex');
    pendingMcpCards[payload.toolUseId] = card;
    scrollBottom();
  }

  function handleMcpResult(payload) {
    const card = pendingMcpCards[payload.toolUseId];
    if (card) {
      const out = document.createElement('div');
      out.className = 'tool-output ' + (payload.ok ? 'tool-ok' : 'tool-err');
      out.textContent = payload.outputSummary || (payload.ok ? '(完成)' : '(出错)');
      card.appendChild(out);
      delete pendingMcpCards[payload.toolUseId];
    }
    scrollBottom();
  }

  // Search results card
  function handleSearch(payload) {
    finalizeStream();
    const results = payload.results || [];
    if (!payload.query && !results.length) return;
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">🔍 搜索: ${escHtml(payload.query || '')}</div>`
      + results.map(r => `<div class="tool-cmd" style="margin-bottom:4px;"><a href="${escHtml(r.url)}" target="_blank" style="color:var(--accent-light);text-decoration:none;font-weight:600;">${escHtml(r.title)}</a><br><span class="tool-output" style="background:transparent;color:var(--text-muted);padding:4px 0 0;">${escHtml(r.snippet || '')}</span></div>`).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  // Cumulative diff card
  function handleDiff(payload) {
    if (!payload.diff) return;
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">📊 变更摘要</div><pre class="tool-cmd" style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto;">${escHtml(payload.diff)}</pre>`;
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handlePendingDevices(payload) {
    const devices = payload.devices || [];
    if (devices.length === 0) {
      pendingPanel.classList.remove('show');
      pendingPanel.innerHTML = '';
      return;
    }
    pendingPanel.classList.add('show');
    pendingPanel.innerHTML = devices.map(d =>
      `<div class="pending-device">
        <div class="pending-device-info">设备 ${d.deviceId.slice(0, 12)}… 来自 ${d.ip}</div>
        <div class="pending-btns">
          <button class="approve-btn" data-id="${escHtml(d.deviceId)}">批准</button>
          <button class="deny-btn" data-id="${escHtml(d.deviceId)}">拒绝</button>
        </div>
      </div>`
    ).join('');
    pendingPanel.querySelectorAll('.approve-btn').forEach(btn => {
      btn.onclick = () => socket.emit('user:approveDevice', { deviceId: btn.dataset.id });
    });
    pendingPanel.querySelectorAll('.deny-btn').forEach(btn => {
      btn.onclick = () => socket.emit('user:denyDevice', { deviceId: btn.dataset.id });
    });
  }

  // Streaming text
  function appendTextDelta(text) {
    if (appendReasoning.card) sealReasoning();
    rememberOutput(transcriptStream.append(text));
  }

  function finalizeStream() {
    transcriptStream.finish();
    sealReasoning();
  }

  function sealReasoning() {
    const label = appendReasoning.card?.querySelector('.reasoning-label');
    if (label) label.textContent = '思考过程';
    if (appendReasoning.card) delete appendReasoning.card.dataset.streaming;
    appendReasoning.card = null;
    appendReasoning.sections = null;
  }

  function partDisplayName(part) {
    if (part?.kind === 'skill') return `$${part.name || 'skill'}`;
    if (part?.kind === 'mention') return `@${part.name || 'file'}`;
    return '[Image]';
  }

  function appendUserBubble(text, attachments, parts, clientRequestId) {
    activeTurnText = text;
    latestOutputText = '';
    if (promoteOfflineBubble(clientRequestId)) {
      scrollBottom();
      setBusy(true);
      showTyping();
      return;
    }
    if (promoteQueuedBubble(clientRequestId, text)) {
      scrollBottom();
      setBusy(true);
      showTyping();
      return;
    }
    const el = document.createElement('div');
    el.className = 'msg user';
    let html = `<div class="bubble">`;
    if (attachments?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">📎 ${attachments.map(a => escHtml(a.name)).join(', ')}</div>`;
    }
    if (parts?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">📌 ${parts.map(partDisplayName).map(escHtml).join(', ')}</div>`;
    }
    html += `${escHtml(text || (parts?.length ? '(结构化引用)' : '(附件)'))}</div>`;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    scrollBottom();
    setBusy(true);
    showTyping();
    checkEmptyState();
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    const el = document.createElement('div');
    el.className = 'msg codex';
    el.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    typingEl = el;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function ensureAssistantTurn() {
    if (activeAssistantTurnEl) return activeAssistantTurnEl;
    const turn = document.createElement('div');
    turn.className = 'msg codex assistant-turn';
    turn.dataset.active = 'true';
    turn.setAttribute('aria-busy', 'true');
    messagesEl.appendChild(turn);
    activeAssistantTurnEl = turn;
    checkEmptyState();
    return turn;
  }

  function finishAssistantTurn() {
    if (!activeAssistantTurnEl) return;
    delete activeAssistantTurnEl.dataset.active;
    activeAssistantTurnEl.removeAttribute('aria-busy');
    activeAssistantTurnEl = null;
  }

  function announceTurnComplete(message) {
    turnAnnouncer.textContent = '';
    requestAnimationFrame(() => {
      turnAnnouncer.textContent = message;
    });
  }

  function appendRaw(el, role) {
    if (role === 'codex') {
      const turn = ensureAssistantTurn();
      turn.appendChild(el);
      return turn;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'msg ' + role;
    wrapper.appendChild(el);
    messagesEl.appendChild(wrapper);
    checkEmptyState();
    return wrapper;
  }

  function appendSystem(msg, isError) {
    const el = document.createElement('div');
    el.className = 'msg system-msg' + (isError ? ' error-msg' : '');
    el.innerHTML = `<div class="bubble">${escHtml(msg)}</div>`;
    messagesEl.appendChild(el);
    scrollBottom();
    checkEmptyState();
  }

  function appendError(msg) {
    const el = document.createElement('div');
    el.className = 'msg system-msg error-msg';
    el.innerHTML = `<div class="bubble">❌ ${escHtml(msg)}</div>`;
    messagesEl.appendChild(el);
    rememberOutput(msg);
    scrollBottom();
    checkEmptyState();
  }

  function rememberOutput(text) {
    const clean = String(text || '').trim();
    if (clean) latestOutputText = clean;
  }

  function rememberFailure(text) {
    lastFailedText = text || lastFailedText;
    if (retryLastBtn) {
      retryLastBtn.disabled = !lastFailedText;
      retryLastBtn.classList.toggle('has-failure', Boolean(lastFailedText));
    }
  }

  function clearMessages() {
    finalizeStream();
    finishAssistantTurn();
    messagesEl.innerHTML = '';
    pendingToolCards = {};
    pendingApprovalCards = {};
    queuedUserBubbles = [];
    offlineUserBubbles = [];
    renderedOutboxIds = new Set();
    latestOutputText = '';
    followTranscript = true;
    jumpToLatestBtn.hidden = true;
    setBusy(false);
    checkEmptyState();
  }

  // Connection UI states
  function composerHasContent() {
    return Boolean(inputEl.value.trim() || currentAttachments.length || currentInputParts.length);
  }

  function applyComposerMode() {
    if (!sendBtn) return;
    const state = resolveComposerPrimaryMode({
      turnRunning: busy,
      hasContent: composerHasContent(),
      interruptPending,
    });
    sendBtn.dataset.mode = state.mode;
    sendBtn.disabled = !state.enabled;
    sendBtn.hidden = !state.visible;
    const sendWrap = $('send-btn-container');
    if (sendWrap) sendWrap.hidden = !state.visible;
    sendBtn.title = state.mode === 'stop'
      ? (state.enabled ? '中断' : '正在停止')
      : '发送';
    sendBtn.setAttribute('aria-label', sendBtn.title);
    const followUpBtn = $('followup-btn');
    if (followUpBtn) followUpBtn.hidden = !state.followUpVisible;
  }

  function interruptCurrentTurn() {
    if (interruptPending) return;
    interruptPending = true;
    applyComposerMode();
    socket.emit('user:interrupt', withTarget({
      turnId: sessionStatus?.turnId || undefined,
    }, viewTarget()), ack => {
      if (ack?.ok) return;
      interruptPending = false;
      applyComposerMode();
      appendSystem(ack?.error || '中断失败', true);
    });
  }

  function setBusy(b) {
    busy = b;
    if (!b) interruptPending = false;
    renderConnectionState();
    const spinner = $('mini-status-spinner');
    if (spinner) spinner.style.display = b ? 'inline-block' : 'none';
    if (!b) hideTyping();
    applyComposerMode();
  }

  function renderConnectionState() {
    const state = sessionStatus?.state || (busy ? 'running' : 'idle');
    const dotState = state === 'awaiting_approval' ? 'awaiting' : (state === 'running' ? 'busy' : state);
    const connected = isTransportConnected();
    statusDot.className = connected ? `connected ${dotState}` : '';
    if (stateLabel) stateLabel.textContent = connected ? state.replace('_', ' ') : 'offline';
    paintConnectionBanner();
  }

  let rttTimer = null;
  let rttInFlight = false;

  function paintRtt(ms) {
    const el = $('conn-rtt');
    if (!el) return;
    const view = formatRttChip(ms);
    if (!view.visible) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('data-tone');
      return;
    }
    el.hidden = false;
    el.textContent = view.label;
    el.dataset.tone = view.tone;
  }

  function measureRtt() {
    if (!socket.connected || rttInFlight) return;
    rttInFlight = true;
    const startedAt = performance.now();
    socket.timeout(3000).emit('conn:ping', {}, error => {
      rttInFlight = false;
      if (error || !socket.connected) return;
      paintRtt(performance.now() - startedAt);
    });
  }

  function stopRttMonitor() {
    if (rttTimer) clearInterval(rttTimer);
    rttTimer = null;
    rttInFlight = false;
  }

  function startRttMonitor() {
    stopRttMonitor();
    measureRtt();
    rttTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      measureRtt();
    }, 5000);
  }

  function clearRtt() {
    stopRttMonitor();
    paintRtt(NaN);
  }

  function transcriptDistanceFromBottom() {
    return Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop);
  }

  function paintJumpToLatest() {
    const hasOverflow = messagesEl.scrollHeight > messagesEl.clientHeight + 1;
    jumpToLatestBtn.hidden = followTranscript || !hasOverflow;
  }

  function scrollBottom(force = false) {
    if (!force && !followTranscript) {
      paintJumpToLatest();
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    followTranscript = true;
    paintJumpToLatest();
  }

  messagesEl.addEventListener('scroll', () => {
    followTranscript = transcriptDistanceFromBottom() <= TRANSCRIPT_FOLLOW_DISTANCE_PX;
    paintJumpToLatest();
  });

  jumpToLatestBtn.addEventListener('click', () => {
    followTranscript = true;
    scrollBottom(true);
  });

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderAnsi(s) {
    const input = String(s || '');
    // ANSI SGR sequences start with the ESC control byte by definition.
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;
    let html = '';
    let last = 0;
    let open = false;
    const classFor = code => ({
      1: 'ansi-bold',
      2: 'ansi-dim',
      31: 'ansi-red',
      32: 'ansi-green',
      33: 'ansi-yellow',
      34: 'ansi-blue',
      35: 'ansi-magenta',
      36: 'ansi-cyan',
      90: 'ansi-muted'
    }[code]);
    for (const match of input.matchAll(re)) {
      html += escHtml(input.slice(last, match.index));
      if (open) { html += '</span>'; open = false; }
      const codes = (match[1] || '0').split(';').map(n => Number(n || 0));
      const classes = codes.map(classFor).filter(Boolean);
      if (classes.length) {
        html += `<span class="${classes.join(' ')}">`;
        open = true;
      }
      last = match.index + match[0].length;
    }
    html += escHtml(input.slice(last));
    if (open) html += '</span>';
    return html;
  }

  sendBtn.onclick = () => {
    if (sendBtn.dataset.mode === 'stop') interruptCurrentTurn();
    else sendMessage();
  };
  $('followup-btn').onclick = sendMessage;
  $('native-thread-refresh').onclick = () => refreshNativeThreads(true);
  $('native-compact-btn').onclick = startCompact;
  $('native-rollback-btn').onclick = rollbackThread;
  $('native-models-btn').onclick = loadNativeModels;
  $('native-files-btn').onclick = () => openFileBrowser(serverCwd);
  $('native-account-btn').onclick = loadAccountPanel;
  $('native-mcp-btn').onclick = loadMcpPanel;
  $('native-skills-btn').onclick = loadSkillsPanel;
  $('native-import-btn').onclick = detectExternalAgentConfig;
  $('native-p3-btn').onclick = openP3Panel;
  $('native-admin-btn').onclick = openAdminPanel;
  // 工具按钮在抽屉里:点任一按钮后关闭抽屉,让主区的数据面板可见
  const nativeControlsRegion = $('native-controls');
  if (nativeControlsRegion) {
    nativeControlsRegion.addEventListener('click', (e) => {
      if (e.target.closest('.native-control-btn')) closeDrawer();
    });
  }
  document.querySelectorAll('#quick-actions [data-command]').forEach(btn => {
    btn.onclick = () => {
      inputEl.value = btn.dataset.command;
      sendMessage();
    };
  });
  if (copyLatestBtn) copyLatestBtn.onclick = copyLatestOutput;
  if (retryLastBtn) retryLastBtn.onclick = retryLastFailed;
  inputEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (composerHasContent()) sendMessage();
    else if (sendBtn.dataset.mode === 'stop') interruptCurrentTurn();
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    applyComposerMode();
  });

  async function sendMessage() {
    if (interruptPending) return;
    const modeSlash = parseCollaborationModeSlash(inputEl.value);
    if (modeSlash) {
      applyCollaborationMode(modeSlash.mode);
      inputEl.value = modeSlash.rest;
      applyComposerMode();
      if (!modeSlash.rest && !currentAttachments.length && !currentInputParts.length) return;
    }
    const text = inputEl.value.trim();
    const hasAttachments = currentAttachments.length > 0;
    const hasParts = currentInputParts.length > 0;
    if (!text && !hasAttachments && !hasParts) return;

    let target = viewTarget();
    if (isTransportConnected()) {
      try {
        target = await ensureViewTarget();
      } catch (error) {
        appendSystem(error.message || '无法建立会话目标', true);
        return;
      }
    }

    const attachments = hasAttachments
      ? currentAttachments.map(attachment => ({ ...attachment }))
      : undefined;
    const parts = hasParts
      ? currentInputParts.map(part => ({ ...part }))
      : undefined;
    const turn = currentTurnSettings();
    const request = createMessageRequest({ text, attachments, parts, target, turn });
    try {
      if (!await outboxReady) throw new Error('IndexedDB outbox unavailable');
      await messageOutbox.enqueue(request);
    } catch (error) {
      appendSystem(`消息未保存，未发送：${error.message}`, true);
      return;
    }

    inputEl.value = '';
    inputEl.style.height = 'auto';
    hideSlashPopup();
    if (hasAttachments) {
      currentAttachments = [];
    }
    if (hasParts) currentInputParts = [];
    renderAttachTray();
    applyComposerMode();
    appendOfflineBubble(messageWirePayload(request));
    drainMessageOutbox({
      shouldSend: outboxRequestMatchesView,
    });
  }

  async function copyLatestOutput() {
    const text = latestOutputText.trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!fallbackCopyText(text)) throw new Error('clipboard unavailable');
      appendSystem('已复制最近输出', false);
    } catch {
      if (fallbackCopyText(text)) appendSystem('已复制最近输出', false);
      else showCopyFallback(text);
    }
  }

  function showCopyFallback(text) {
    const card = document.createElement('div');
    card.className = 'copy-fallback';
    const label = document.createElement('div');
    label.textContent = '剪贴板受限，已选中最近输出，请用系统复制菜单。';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    card.appendChild(label);
    card.appendChild(ta);
    appendRaw(card, 'system-msg');
    scrollBottom();
    setTimeout(() => {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
    }, 0);
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    inputEl.focus();
    return ok;
  }

  function retryLastFailed() {
    if (!lastFailedText || !socket.connected) return;
    inputEl.value = lastFailedText;
    sendMessage();
  }

  // ---- Web Push ----
  const pushBtn = document.getElementById('push-subscribe-btn');
  async function initPush() {
    if (!pushBtn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/js/sw.js', { scope: '/' });
      const sub = await reg.pushManager.getSubscription();
      if (sub) pushBtn.style.display = 'none'; // already subscribed
      else pushBtn.style.display = '';
    } catch { /* SW registration failed */ }
    pushBtn.onclick = async () => {
      try {
        const resp = await fetch('/push/vapid-public-key');
        if (!resp.ok) { alert('推送未配置'); return; }
        const { key } = await resp.json();
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
        const subscribeResponse = await fetch('/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'x-device-token': deviceToken,
          },
          body: JSON.stringify(sub)
        });
        if (!subscribeResponse.ok) {
          await sub.unsubscribe().catch(() => {});
          const failure = await subscribeResponse.json().catch(() => ({}));
          throw new Error(failure.error || `Push subscription failed (${subscribeResponse.status})`);
        }
        pushBtn.textContent = '🔕';
        pushBtn.title = '已订阅推送';
        pushBtn.onclick = null;
      } catch (e) {
        console.warn('[push] subscribe failed:', e.message);
      }
    };
  }
  initPush();

  // ---- 附件 ----
  attachBtn.onclick = () => fileInput.click();

  inputEl.addEventListener('paste', async event => {
    const item = pickPastedImage(event.clipboardData);
    if (!item?.getAsFile) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    currentAttachments = currentAttachments.concat(await readFileAsAttachment(file));
    renderAttachTray();
  });

  $('attach-preview-modal')?.addEventListener('click', () => {
    $('attach-preview-modal').hidden = true;
  });

  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    fileInput.value = '';
    const newAttachments = await Promise.all(files.map(readFileAsAttachment));
    currentAttachments = currentAttachments.concat(newAttachments);
    renderAttachTray();
  };

  function readFileAsAttachment(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result.split(',')[1];
        resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', data });
      };
      reader.readAsDataURL(file);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1048576).toFixed(1) + 'MB';
  }

  function addInputPart(part) {
    const key = `${part?.kind || ''}:${part?.path || part?.url || ''}`;
    const exists = currentInputParts.some(candidate => (
      `${candidate?.kind || ''}:${candidate?.path || candidate?.url || ''}` === key
    ));
    if (!exists) currentInputParts.push({ ...part });
    renderAttachTray();
  }

  function renderAttachTray() {
    if (currentAttachments.length === 0 && currentInputParts.length === 0) {
      attachTray.hidden = true;
      applyComposerMode();
      return;
    }
    attachTray.hidden = false;
    attachTray.innerHTML = '';
    const approxBytes = a => Math.round(a.data.length * 0.75);
    for (let i = 0; i < currentAttachments.length; i++) {
      const a = currentAttachments[i];
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="attach-chip-name">${escHtml(a.name)}</span>`
        + `<span class="attach-chip-size">${formatBytes(approxBytes(a))}</span>`
        + `<button class="attach-chip-remove" data-idx="${i}">✕</button>`;
      chip.querySelector('.attach-chip-remove').onclick = event => {
        event.stopPropagation();
        currentAttachments.splice(i, 1);
        renderAttachTray();
      };
      chip.onclick = () => {
        const preview = attachmentPreview(a);
        if (preview.kind !== 'image') return;
        const modal = $('attach-preview-modal');
        const img = $('attach-preview-img');
        if (img) img.src = preview.src;
        if (modal) modal.hidden = false;
      };
      attachTray.appendChild(chip);
    }
    for (let i = 0; i < currentInputParts.length; i++) {
      const part = currentInputParts[i];
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const prefix = part.kind === 'skill' ? '$' : (part.kind === 'imageUrl' ? '🖼 ' : '@');
      chip.innerHTML = `<span class="attach-chip-name">${prefix}${escHtml(part.name || part.url || part.path || '')}</span>`
        + `<button class="attach-chip-remove" data-part-idx="${i}">✕</button>`;
      chip.querySelector('.attach-chip-remove').onclick = () => {
        currentInputParts.splice(i, 1);
        renderAttachTray();
      };
      attachTray.appendChild(chip);
    }
    applyComposerMode();
  }

  // Session drawer
  function resetDrawerScroll() {
    const body = $('drawer-body');
    if (body) body.scrollTop = 0;
    const active = document.querySelector('#drawer-projects .drawer-project-block.active');
    if (active && body && active.offsetTop > 48) body.scrollTop = active.offsetTop - 8;
  }

  let drawerOpenedAt = 0;
  $('menu-btn').onclick = () => {
    drawerOpenedAt = Date.now();
    expandedDirs = loadExpandedDirs(localStorage, serverCwd);
    refreshNativeThreads();
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    resetDrawerScroll();
  };

  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
  }
  drawerOverlay.onclick = closeDrawer;

  $('header-context').onclick = () => {
    workspacePanel.open();
  };
  $('header-home').onclick = goHome;
  $('header-new').onclick = () => {
    createNewSession();
    closeDrawer();
  };
  $('confirm-modal')?.addEventListener('click', event => {
    if (event.target === $('confirm-modal')) confirmDialog.close();
  });
  messagesEl.addEventListener('click', event => {
    const copyBtn = event.target.closest('.code-copy-btn');
    if (!copyBtn) return;
    const code = copyBtn.closest('.code-block-wrap')?.querySelector('code')?.textContent || '';
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code);
    else fallbackCopyText(code);
  });

  $('new-session-btn').onclick = () => {
    createNewSession();
    closeDrawer();
  };

  // Drawer FAB
  $('drawer-fab-new').onclick = () => {
    createNewSession();
    closeDrawer();
  };

  applyComposerMode();
  renderDrawerProject();
  renderDrawerProjects();
  setConnectionPhase('connecting');

  // Helper for push VAPID key
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

})();
