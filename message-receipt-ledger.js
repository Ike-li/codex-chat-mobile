export class MessageReceiptLedger {
  constructor(options = {}) {
    this.entries = new Map();
    this.handles = new Map();
    this.runtimeIndex = new Map();
    this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 10000;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
      ? options.ttlMs
      : 24 * 60 * 60 * 1000;
    this.now = options.now || (() => Date.now());
  }

  claim({ identity, requestId, fingerprint }) {
    this.prune();
    const key = `${identity}\0${requestId}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      return { kind: 'duplicate', handle: existing.handle };
    }
    if (this.entries.size >= this.maxEntries) return { kind: 'full' };

    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const handle = Object.freeze({ key });
    const entry = {
      handle,
      fingerprint,
      phase: 'pending',
      result: null,
      latestReceipt: null,
      runtimeKey: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      terminalAt: null,
      settledAt: null,
      ready,
      resolveReady,
    };
    this.entries.set(key, entry);
    this.handles.set(handle, entry);
    return { kind: 'owner', handle };
  }

  settle(handle, result) {
    const entry = this.handles.get(handle);
    if (!entry || entry.phase !== 'pending') return false;
    const receipt = selectLatestReceipt(result?.receipt, entry.latestReceipt);
    entry.phase = settledPhase(result, receipt);
    entry.result = applyReceipt(result, receipt);
    entry.updatedAt = this.now();
    entry.settledAt = entry.updatedAt;
    if (entry.phase === 'terminal') entry.terminalAt = entry.updatedAt;
    entry.resolveReady();
    if (
      !receipt
      && result?.ok === false
      && result.retryable === true
      && result.resultUnknown !== true
    ) {
      this.removeEntry(entry);
    }
    return true;
  }

  bindRuntime(handle, { instanceId, clientRequestId }) {
    const entry = this.handles.get(handle);
    if (!entry || !instanceId || !clientRequestId) return false;
    const runtimeKey = `${instanceId}\0${clientRequestId}`;
    const existing = this.runtimeIndex.get(runtimeKey);
    if (existing && existing !== entry) return false;
    if (entry.runtimeKey && entry.runtimeKey !== runtimeKey) {
      this.runtimeIndex.delete(entry.runtimeKey);
    }
    entry.runtimeKey = runtimeKey;
    this.runtimeIndex.set(runtimeKey, entry);
    return true;
  }

  advanceRuntime({ instanceId, clientRequestId, receipt }) {
    const entry = this.runtimeIndex.get(`${instanceId}\0${clientRequestId}`);
    if (!entry || !receipt) return false;
    const current = entry.latestReceipt || entry.result?.receipt || null;
    if (!canAdvanceReceipt(current, receipt)) return false;
    entry.latestReceipt = { ...(current || {}), ...receipt };
    if (entry.result) entry.result = applyReceipt(entry.result, entry.latestReceipt);
    entry.updatedAt = this.now();
    if (entry.settledAt !== null) entry.settledAt = entry.updatedAt;
    if (entry.phase !== 'pending') {
      entry.phase = receiptPhase(entry.latestReceipt);
      if (entry.phase === 'terminal' && entry.terminalAt === null) {
        entry.terminalAt = entry.updatedAt;
      }
    }
    return true;
  }

  async replay(handle) {
    const entry = this.handles.get(handle);
    if (!entry) return null;
    await entry.ready;
    return entry.result;
  }

  async replayByRequest({ identity, requestId }) {
    this.prune();
    const entry = this.entries.get(`${identity}\0${requestId}`);
    if (!entry) return null;
    await entry.ready;
    return entry.result;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const entry of this.entries.values()) {
      // 回收依据是「已结算」而不是「已终态」。settledPhase 对 dispatch_failed 的形状
      // （retryable + resultUnknown）返回 'settled'，对停在队列里的返回 'waiting'——
      // 两者的 terminalAt 都是 null，原先永远回收不掉，最终把 maxEntries 占满，
      // 之后所有带 clientRequestId 的消息都会收到 receipt_ledger_full。
      // pending 的 ready promise 还有人等着，删了会挂住 replay；waiting 是还排在
      // 队列里、尚未执行的消息，删掉它的回执会让 reconcile 查不到而重复发送。
      if (entry.phase === 'pending' || entry.phase === 'waiting') continue;
      if (entry.settledAt === null || entry.settledAt > cutoff) continue;
      this.removeEntry(entry);
    }
  }

  clear() {
    this.entries.clear();
    this.handles.clear();
    this.runtimeIndex.clear();
  }

  stats() {
    return { size: this.entries.size };
  }

  removeEntry(entry) {
    this.entries.delete(entry.handle.key);
    this.handles.delete(entry.handle);
    if (entry.runtimeKey) this.runtimeIndex.delete(entry.runtimeKey);
  }
}

function receiptRank(receipt) {
  if (receipt?.state === 'queued') return 1;
  if (receipt?.state === 'submitted' || receipt?.state === 'steered' || receipt?.state === 'rejected') {
    return 2;
  }
  return 0;
}

function canAdvanceReceipt(current, next) {
  const currentRank = receiptRank(current);
  const nextRank = receiptRank(next);
  if (nextRank < currentRank) return false;
  if (currentRank >= 2 && nextRank >= 2 && current?.state !== next?.state) return false;
  return true;
}

function selectLatestReceipt(current, latest) {
  if (!latest) return current || null;
  if (!current) return latest;
  return canAdvanceReceipt(current, latest) ? { ...current, ...latest } : current;
}

function receiptPhase(receipt) {
  if (receipt?.state === 'queued') return 'waiting';
  if (receiptRank(receipt) >= 2) return 'terminal';
  return 'settled';
}

function settledPhase(result, receipt) {
  if (receipt) return receiptPhase(receipt);
  if (result?.ok === false && result.retryable !== true && result.resultUnknown !== true) {
    return 'terminal';
  }
  return 'settled';
}

function applyReceipt(result, receipt) {
  if (!receipt) return result;
  const next = { ...(result || {}), receipt: { ...receipt } };
  if (receipt.state === 'rejected') {
    next.ok = false;
    next.errorCode = receipt.errorCode || 'dispatch_rejected';
    next.error = receipt.error || '消息未被 Codex runtime 接受';
  }
  return next;
}
