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

(function() {
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('msg-input');
  const sendBtn = $('send-btn');
  const interruptBtn = $('interrupt-btn');
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
  const sessionListEl = $('session-list');
  const pendingPanel = $('pending-panel');
  const needsYouPanel = $('needs-you-panel');
  const accountLoginBtn = $('account-login-btn');
  const accountLoginPanel = $('account-login-panel');
  const nativePanel = $('native-panel');
  const authGate = $('auth-gate');
  const authForm = $('auth-form');
  const authTokenInput = $('auth-token-input');
  const authError = $('auth-error');
  const deviceAuth = $('device-auth');
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
  let streamingEl = null;
  let streamText = '';
  let currentSessionId = null;
  let appThreads = [];
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
  let activeAccountLoginId = null;
  let restoringThreadId = null;
  let activeRecovery = null;
  let targetSetupPromise = null;
  let outboxSyncPromise = null;
  let outboxSyncRequested = false;
  let threadListGeneration = 0;
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
    if (ack.cwd) serverCwd = ack.cwd;
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
    renderConnectionState();
    requestCatchUp();
  });

  socket.on('disconnect', () => {
    adminUnlocked = false;
    renderConnectionState();
    appendSystem('已断开连接，尝试重连中...', false);
  });

  socket.on('connect_error', err => {
    renderConnectionState();
    if (err?.message === 'unauthorized') {
      socket.disconnect();
      authToken = '';
      showAuthPrompt('会话已失效，请重新输入访问口令。');
      return;
    }
    appendSystem(`连接失败：${err?.message || 'unknown'}`, true);
  });

  window.addEventListener('offline', renderConnectionState);
  window.addEventListener('online', () => {
    renderConnectionState();
    if (socket.connected) syncOutboxView();
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
  }

  // Redesign - State for Reasoning and Mode
  let selectedModel = localStorage.getItem('codex_selected_model') || 'gpt-5.5';
  let selectedReasoning = localStorage.getItem('codex_selected_reasoning') || '超高';
  let selectedSpeed = localStorage.getItem('codex_selected_speed') || '标准';
  let selectedMode = '/chat';

  // Ensure model-input element starts with the selected model
  const miInput = $('model-input');
  if (miInput) {
    miInput.value = selectedModel;
  }

  // Redesign - Sync inline triggers and popovers
  function updateFloatingBadges() {
    const currentModel = $('model-input').value || selectedModel || 'gpt-5.5';
    const currentPolicy = $('perm-select').value || 'on-request';

    // Format model name
    let modelDisplay = currentModel;
    if (modelDisplay.toLowerCase().startsWith('gpt-')) {
      modelDisplay = modelDisplay.slice(4);
    }

    // Map policy text & icon
    let policyDisplay = '请求批准';
    let policyIcon = '🖐️';
    if (currentPolicy === 'never') {
      policyDisplay = '完全访问';
      policyIcon = '⚠️';
    } else if (currentPolicy === 'unlessTrusted') {
      policyDisplay = '替我审批';
      policyIcon = '🛡️';
    } else if (currentPolicy === 'custom') {
      policyDisplay = '自定义';
      policyIcon = '⚙️';
    } else {
      policyDisplay = '请求批准';
      policyIcon = '🖐️';
    }

    // Update inline triggers text
    const permTextEl = $('perm-trigger-text');
    if (permTextEl) {
      permTextEl.innerHTML = `${policyIcon} ${policyDisplay}`;
    }

    const modelTextEl = $('model-trigger-text');
    if (modelTextEl) {
      const speedIndicator = selectedSpeed === '快速' ? ' · ⚡' : '';
      modelTextEl.textContent = `${modelDisplay} ${selectedReasoning}${speedIndicator}`;
    }

    // Sync selected class inside Permission Popover
    document.querySelectorAll('#perm-popover .popover-item').forEach(item => {
      const val = item.dataset.value;
      item.classList.toggle('selected', val === currentPolicy);
    });

    // Sync selected class inside Model List Popover
    document.querySelectorAll('#model-popover .model-list .popover-item').forEach(item => {
      const m = item.dataset.model;
      const matchesKnown = currentModel.toLowerCase().includes(m);
      item.classList.toggle('selected', matchesKnown);
    });

    // Sync selected class inside Reasoning List Popover
    document.querySelectorAll('#model-popover .reasoning-list .popover-item').forEach(item => {
      const r = item.dataset.reasoning;
      item.classList.toggle('selected', r === selectedReasoning);
    });

    // Sync selected class inside Speed List Popover
    document.querySelectorAll('#model-popover .speed-list .popover-item').forEach(item => {
      const s = item.dataset.speed;
      item.classList.toggle('selected', s === selectedSpeed);
    });

    // Sync mode header display
    const modeTextEl = $('mode-trigger-text');
    if (modeTextEl) {
      modeTextEl.textContent = selectedMode === '/plan' ? '📋 计划模式' : '💬 对话模式';
    }
    document.querySelectorAll('#mode-popover .popover-item').forEach(item => {
      const val = item.dataset.value;
      item.classList.toggle('selected', val === selectedMode);
    });
  }

  // Redesign - Toggles and Clicks for Popovers
  const permTrigger = $('perm-trigger');
  const permPopover = $('perm-popover');
  const modelTrigger = $('model-trigger');
  const modelPopover = $('model-popover');
  const modeTrigger = $('mode-trigger');
  const modePopover = $('mode-popover');

  // Helper to close all popovers
  function closeAllPopovers() {
    permPopover?.classList.remove('show');
    modelPopover?.classList.remove('show');
    modePopover?.classList.remove('show');
  }

  if (permTrigger) {
    permTrigger.onclick = e => {
      e.stopPropagation();
      const show = !permPopover.classList.contains('show');
      closeAllPopovers();
      if (show) permPopover.classList.add('show');
    };
  }

  if (modelTrigger) {
    modelTrigger.onclick = e => {
      e.stopPropagation();
      const show = !modelPopover.classList.contains('show');
      closeAllPopovers();
      if (show) modelPopover.classList.add('show');
    };
  }

  if (modeTrigger) {
    modeTrigger.onclick = e => {
      e.stopPropagation();
      const show = !modePopover.classList.contains('show');
      closeAllPopovers();
      if (show) modePopover.classList.add('show');
    };
  }

  // Wire Permission Popover options
  document.querySelectorAll('#perm-popover .popover-item').forEach(item => {
    item.onclick = () => {
      const val = item.dataset.value;
      $('perm-select').value = val;
      inputEl.value = '/approval-policy ' + (val || 'on-request');
      sendMessage();
      closeAllPopovers();
    };
  });

  // Wire Model Popover options
  document.querySelectorAll('#model-popover .model-list .popover-item').forEach(item => {
    item.onclick = () => {
      const m = item.dataset.model;
      selectedModel = m;
      localStorage.setItem('codex_selected_model', m);
      $('model-input').value = m;
      inputEl.value = '/model ' + m;
      sendMessage();
      updateFloatingBadges();
      closeAllPopovers();
    };
  });

  // Wire Reasoning Popover options
  document.querySelectorAll('#model-popover .reasoning-list .popover-item').forEach(item => {
    item.onclick = () => {
      const r = item.dataset.reasoning;
      selectedReasoning = r;
      localStorage.setItem('codex_selected_reasoning', r);
      inputEl.value = '/reasoning ' + r;
      sendMessage();
      updateFloatingBadges();
      closeAllPopovers();
    };
  });

  // Wire Speed Popover options
  document.querySelectorAll('#model-popover .speed-list .popover-item').forEach(item => {
    item.onclick = () => {
      const s = item.dataset.speed;
      selectedSpeed = s;
      localStorage.setItem('codex_selected_speed', s);
      inputEl.value = '/speed ' + (s === '快速' ? 'fast' : 'standard');
      sendMessage();
      updateFloatingBadges();
      closeAllPopovers();
    };
  });

  // Wire Mode Popover options
  document.querySelectorAll('#mode-popover .popover-item').forEach(item => {
    item.onclick = () => {
      const val = item.dataset.value;
      selectedMode = val;
      inputEl.value = val;
      sendMessage();
      closeAllPopovers();
    };
  });

  // Close popovers when clicking outside
  document.addEventListener('click', e => {
    if (permPopover && !permPopover.contains(e.target) && e.target !== permTrigger) {
      permPopover.classList.remove('show');
    }
    if (modelPopover && !modelPopover.contains(e.target) && e.target !== modelTrigger) {
      modelPopover.classList.remove('show');
    }
    if (modePopover && !modePopover.contains(e.target) && e.target !== modeTrigger) {
      modePopover.classList.remove('show');
    }
  });

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
  });

  function showSlashPopup() { slashPopup.classList.add('show'); }
  function hideSlashPopup() { slashPopup.classList.remove('show'); }

  document.querySelectorAll('.slash-item').forEach(item => {
    item.onclick = () => {
      const cmd = item.dataset.cmd;
      inputEl.value = cmd + ' ';
      inputEl.focus();
      hideSlashPopup();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    };
  });

  // Hide popup on click outside
  document.addEventListener('click', e => {
    if (!slashPopup.contains(e.target) && e.target !== inputEl) {
      hideSlashPopup();
    }
  });

  // Empty state Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach(card => {
    card.onclick = () => {
      inputEl.value = card.dataset.cmd;
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
      case 'user_message':
        finalizeStream();
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
        handleAccountLogin(ev.payload);
        break;
      case 'account_updated':
        handleAccountUpdated(ev.payload);
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

  function startChatgptDeviceLogin() {
    if (!socket.connected) {
      appendSystem('连接后才能启动 ChatGPT 登录', true);
      return;
    }
    handleAccountLogin({ status: 'starting' });
    socket.emit('account:loginStart', { type: 'chatgptDeviceCode' }, ack => {
      if (!ack?.ok) {
        handleAccountLogin({ status: 'failed', error: ack?.error || '登录启动失败' });
        return;
      }
      handleAccountLogin({
        status: 'pending',
        loginId: ack.loginId,
        verificationUrl: ack.verificationUrl,
        userCode: ack.userCode
      });
    });
  }

  function handleAccountLogin(payload) {
    const status = payload?.status || 'unknown';
    if (payload?.loginId) activeAccountLoginId = payload.loginId;
    if (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'cancel_missing') {
      activeAccountLoginId = null;
    }
    accountLoginPanel.hidden = false;

    if (status === 'starting') {
      accountLoginPanel.innerHTML = '<div class="account-login-row"><div class="account-login-main"><strong>正在启动 ChatGPT 登录...</strong></div></div>';
      return;
    }
    if (status === 'pending') {
      const verificationUrl = payload.verificationUrl || '';
      const userCode = payload.userCode || '';
      accountLoginPanel.innerHTML = `<div class="account-login-row">
        <div class="account-login-main">
          <strong>ChatGPT 设备码登录</strong>
          <span class="account-login-code">${escHtml(userCode)}</span>
          <a class="account-login-url" href="${escHtml(verificationUrl)}" target="_blank" rel="noopener">${escHtml(verificationUrl)}</a>
        </div>
        <button class="deny-btn account-login-cancel" type="button">取消</button>
      </div>`;
      const cancel = accountLoginPanel.querySelector('.account-login-cancel');
      cancel.onclick = () => {
        if (!activeAccountLoginId) return;
        socket.emit('account:loginCancel', { loginId: activeAccountLoginId }, ack => {
          if (!ack?.ok) handleAccountLogin({ status: 'failed', error: ack?.error || '取消登录失败' });
        });
      };
      return;
    }
    if (status === 'completed') {
      accountLoginPanel.innerHTML = '<div class="account-login-row"><div class="account-login-main"><strong>ChatGPT 登录完成</strong><span>账号状态已更新。</span></div></div>';
      appendSystem('ChatGPT 登录完成', false);
      return;
    }
    if (status === 'canceled' || status === 'cancel_missing') {
      accountLoginPanel.innerHTML = '<div class="account-login-row"><div class="account-login-main"><strong>ChatGPT 登录已取消</strong></div></div>';
      return;
    }
    accountLoginPanel.innerHTML = `<div class="account-login-row"><div class="account-login-main"><strong>ChatGPT 登录失败</strong><span>${escHtml(payload?.error || 'unknown error')}</span></div></div>`;
  }

  function handleAccountUpdated(payload) {
    const authMode = payload?.authMode || 'unknown';
    const planType = payload?.planType || 'unknown';
    if (accountLoginPanel.hidden) accountLoginPanel.hidden = false;
    if (authMode === 'chatgpt') {
      accountLoginPanel.innerHTML = `<div class="account-login-row"><div class="account-login-main"><strong>ChatGPT 已登录</strong><span>${escHtml(planType)}</span></div></div>`;
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

    // Sync models
    const mi = document.getElementById('model-input');
    mi.onchange = () => {
      const m = mi.value.trim();
      if (m) { inputEl.value = '/model ' + m; sendMessage(); }
      updateFloatingBadges();
    };

    const ps = document.getElementById('perm-select');
    ps.onchange = () => {
      const p = ps.value;
      if (p) { inputEl.value = '/approval-policy ' + p; sendMessage(); ps.value = ''; }
      updateFloatingBadges();
    };

    renderSessionMeta();
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
    if (workDirs.length <= 1) { container.style.display = 'none'; return; }
    container.style.display = 'flex';
    sel.innerHTML = workDirs.map(d => {
      const name = d.split('/').pop() || d;
      return `<option value="${escHtml(d)}"${d === serverCwd ? ' selected' : ''}>${escHtml(name)}</option>`;
    }).join('');
    sel.onchange = () => handleWorkdirChange(sel.value);
  }

  function handleWorkdirChange(cwd) {
    serverCwd = cwd;
    restoringThreadId = null;
    activeRecovery = null;
    currentViewingId = null;
    currentSessionId = getCurrentThread(localStorage, serverCwd);
    sessionStatus = null;
    document.getElementById('workdir-select').value = cwd;
    clearMessages();
    refreshNativeThreads();
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

  function renderInstanceTabs() {
    const tabs = document.getElementById('instance-tabs');
    if (instanceList.length <= 1 && !currentSessionId) { tabs.style.display = 'none'; return; }
    tabs.style.display = 'flex';
    let html = '';
    for (const inst of instanceList) {
      const active = inst.instanceId === currentViewingId ? ' active' : '';
      const name = (inst.sessionId || 'new').slice(0, 8);
      const dot = inst.busy ? '⚡' : '○';
      html += `<button class="instance-tab${active}" data-iid="${escHtml(inst.instanceId)}" style="padding:6px 12px;font-size:11px;font-weight:600;border:1px solid ${active?'var(--text)':'var(--border)'};border-radius:12px;background:${active?'var(--text)':'var(--surface)'};color:${active?'var(--surface)':'var(--text)'};cursor:pointer;white-space:nowrap;transition:all 0.1s;">${dot} ${name}</button>`;
    }
    html += `<button id="fork-instance-btn" title="分叉当前会话" style="padding:4px 10px;font-size:14px;font-weight:bold;border:1px solid var(--border);border-radius:12px;background:var(--surface);cursor:pointer;color:var(--text-muted);">⎇</button>`;
    html += `<button id="new-instance-btn" style="padding:4px 10px;font-size:16px;font-weight:bold;border:1px solid var(--border);border-radius:12px;background:var(--surface);cursor:pointer;color:var(--text-muted);">+</button>`;
    tabs.innerHTML = html;

    for (const btn of tabs.querySelectorAll('.instance-tab')) {
      btn.onclick = () => {
        socket.emit('session:switch', { instanceId: btn.dataset.iid }, ack => {
          if (!applyTargetAck(ack)) appendSystem(ack?.error || '实例切换失败', true);
        });
      };
    }
    document.getElementById('fork-instance-btn').onclick = forkCurrentSession;
    document.getElementById('new-instance-btn').onclick = createNewSession;
  }

  function createNewSession() {
    socket.emit('session:new', { cwd: serverCwd }, ack => {
      if (!applyTargetAck(ack)) {
        appendSystem(ack?.error || '新建会话失败', true);
        return;
      }
      clearMessages();
    });
  }

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

  function updateStatusDetail(payload) {
    if (!payload) { statusDetail.textContent = ''; return; }
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

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    const allItems = appThreads.filter(s => s.id);

    if (allItems.length === 0) {
      sessionListEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;font-weight:500;text-align:center;">暂无会话</div>';
      return;
    }
    for (const s of allItems) {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      const date = new Date(s.lastUsedAt || s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const tag = s.model ? ` · ${escHtml(s.model)}` : '';
      const srcTag = ' · native';
      const status = threadStatusPresentation(s.status);
      const actions = `<div class="native-row-actions">
          <button class="native-mini-btn" data-action="rename">Rename</button>
          <button class="native-mini-btn" data-action="${s.archived ? 'unarchive' : 'archive'}">${s.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="native-mini-btn native-danger" data-action="delete">Delete</button>
        </div>`;
      el.innerHTML = `<div class="session-title"><span class="thread-status-dot ${status.kind}" title="${escHtml(status.label)}"></span><span class="session-title-copy">${escHtml(s.title || '未命名')}</span></div><div class="session-date">${date}${tag}${srcTag} · ${escHtml(status.label)}</div>${actions}`;
      el.onclick = () => {
        socket.emit('thread:select', { threadId: s.id, cwd: s.cwd, title: s.title }, ack => {
          if (!ack?.ok) {
            appendSystem(ack?.error || 'Thread select failed', true);
            return;
          }
          applyTargetAck(ack);
          clearMessages();
          loadNativeThreadHistory(s);
        });
        closeDrawer();
      };
      for (const btn of el.querySelectorAll('[data-action]')) {
        btn.onclick = event => {
          event.stopPropagation();
          handleNativeThreadAction(s, btn.dataset.action);
        };
      }
      sessionListEl.appendChild(el);
    }
  }

  function handleNativeThreadAction(thread, action) {
    if (action === 'rename') {
      const name = prompt('Thread name', thread.title || '');
      if (!name) return;
      socket.emit('thread:rename', { threadId: thread.id, name, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(ack?.error || 'Rename failed', true);
        refreshNativeThreads();
      });
      return;
    }
    if (action === 'delete' && !confirm('Delete this thread?')) return;
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

  function refreshNativeThreads(showPanel = false) {
    const requestedCwd = serverCwd;
    const requestGeneration = ++threadListGeneration;
    socket.emit('thread:list', { cwd: requestedCwd, archived: showArchivedThreads }, ack => {
      if (requestGeneration !== threadListGeneration || requestedCwd !== serverCwd) return;
      if (!ack?.ok) {
        appendSystem(ack?.error || 'Thread list failed', true);
        return;
      }
      appThreads = mergeThreadList(appThreads, ack.threads || []);
      if (showPanel) renderNativeThreadList();
      renderSessionList();
    });
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

  function rollbackThread() {
    if (!currentSessionId) {
      appendSystem('No active thread to rollback', true);
      return;
    }
    const raw = prompt('Rollback turns', '1');
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
          selectedModel = btn.dataset.modelId;
          localStorage.setItem('codex_selected_model', selectedModel);
          $('model-input').value = selectedModel;
          inputEl.value = `/model ${selectedModel}`;
          updateFloatingBadges();
          sendMessage();
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
        btn.onclick = () => {
          const item = items[Number(btn.dataset.importIndex)];
          if (!item || !confirm('Import this config?')) return;
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
    if (msgs.length === 0) {
      appendSystem('该会话无历史消息', false);
      return;
    }
    appendSystem(`📋 ${title || '历史会话'}（${msgs.length} 条消息）`, false);
    for (const m of msgs.slice(-30)) {
      if (m.role === 'user') {
        appendHistoryUserBubble(m.content);
      } else {
        const el = document.createElement('div');
        el.className = 'msg codex';
        el.innerHTML = `<div class="bubble" style="white-space:pre-wrap;font-size:13px;">${escHtml(m.content.slice(0, 500))}${m.content.length > 500 ? ' ...' : ''}</div>`;
        messagesEl.appendChild(el);
      }
    }
    scrollBottom();
    checkEmptyState();
  }

  function appendHistoryUserBubble(text) {
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
        if (!confirm('无法确认上一请求是否已执行；再次发送可能重复执行工具或修改。确定重试吗？')) return;
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

  function handleToolUse(payload) {
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">⚙️ ShellCall</div><div class="tool-cmd">${escHtml(payload.inputSummary || '')}</div>`;
    appendRaw(card, 'codex');
    pendingToolCards[payload.toolUseId] = card;
    scrollBottom();
  }

  function ensureToolOutputCard(toolUseId) {
    let card = pendingToolCards[toolUseId];
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card';
      card.innerHTML = `<div class="tool-name">⚙️ ShellCall</div><div class="tool-cmd">streaming output</div>`;
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
    const statusLine = `status: ${payload.status || 'completed'} · exit: ${payload.exitCode ?? (payload.ok ? 0 : 'unknown')}\n`;
    const resultText = statusLine + (payload.outputSummary || (payload.ok ? '(完成)' : '(出错)'));
    if (card) {
      let out = card.querySelector('.live-output');
      if (!out) {
        out = document.createElement('div');
        card.appendChild(out);
      }
      out.className = 'tool-output live-output ' + (payload.ok ? 'tool-ok' : 'tool-err');
      const resultHtml = renderAnsi(resultText);
      if (out.innerText.trim()) out.innerHTML += '<br>' + resultHtml;
      else out.innerHTML = resultHtml;
      card.appendChild(out);
      delete pendingToolCards[payload.toolUseId];
    }
    rememberOutput(resultText);
    scrollBottom();
  }

  function handleResult(payload) {
    finalizeStream();
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
    const files = payload.files || [];
    if (!files.length) return;
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">📝 文件变更</div>`
      + files.map(f => `<div class="tool-cmd">${escHtml(kindLabel(f.kind))}: ${escHtml(f.path)}</div>`).join('');
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
      card.innerHTML = '<div class="tool-name">思考过程</div>';
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
    wrap.innerHTML = `<div class="tool-name" style="font-size:11px;opacity:.7;">${key === 'full' ? 'Full reasoning' : 'Summary'}</div><pre class="tool-output" style="white-space:pre-wrap;opacity:.72;background:transparent;color:var(--text-muted);"></pre>`;
    appendReasoning.card.appendChild(wrap);
    const out = wrap.querySelector('pre');
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
    if (!streamingEl) {
      setBusy(true);
      streamText = '';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      streamingEl = bubble;
      appendRaw(bubble, 'codex');
    }
    streamText += text;
    streamingEl.textContent = streamText;
    rememberOutput(streamText);
    scrollBottom();
  }

  function finalizeStream() {
    streamingEl = null;
    streamText = '';
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

  function appendRaw(el, role) {
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
    messagesEl.innerHTML = '';
    finalizeStream();
    pendingToolCards = {};
    pendingApprovalCards = {};
    queuedUserBubbles = [];
    offlineUserBubbles = [];
    renderedOutboxIds = new Set();
    latestOutputText = '';
    setBusy(false);
    checkEmptyState();
  }

  // Connection UI states
  function setBusy(b) {
    busy = b;
    renderConnectionState();
    const spinner = $('mini-status-spinner');
    if (spinner) spinner.style.display = b ? 'inline-block' : 'none';
    if (b) interruptBtn.classList.add('show');
    else interruptBtn.classList.remove('show');
  }

  function renderConnectionState() {
    const state = sessionStatus?.state || (busy ? 'running' : 'idle');
    const dotState = state === 'awaiting_approval' ? 'awaiting' : (state === 'running' ? 'busy' : state);
    const connected = isTransportConnected();
    statusDot.className = connected ? `connected ${dotState}` : '';
    if (stateLabel) stateLabel.textContent = connected ? state.replace('_', ' ') : 'offline';
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

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

  // Send
  sendBtn.onclick = sendMessage;
  if (accountLoginBtn) accountLoginBtn.onclick = startChatgptDeviceLogin;
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  async function sendMessage() {
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
    const request = createMessageRequest({ text, attachments, parts, target });
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

  interruptBtn.onclick = () => {
    socket.emit('user:interrupt', withTarget({
      turnId: sessionStatus?.turnId || undefined,
    }, viewTarget()), ack => {
      if (!ack?.ok) appendSystem(ack?.error || '中断失败', true);
    });
  };

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
      chip.querySelector('.attach-chip-remove').onclick = () => {
        currentAttachments.splice(i, 1);
        renderAttachTray();
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
  }

  // Session drawer
  $('menu-btn').onclick = () => {
    refreshNativeThreads();
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
  };

  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
  }
  drawerOverlay.onclick = closeDrawer;

  // Header copy details toggle (ultra-clean ChatGPT mobile experience)
  $('header-copy').onclick = () => {
    $('header-copy').classList.toggle('show-details');
  };

  $('new-session-btn').onclick = () => {
    createNewSession();
    closeDrawer();
  };

  // Drawer FAB
  $('drawer-fab-new').onclick = () => {
    createNewSession();
    closeDrawer();
  };

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
