import { createHash } from 'node:crypto';

export class NeedsYouRegistry {
  #records = new Map();
  #revision = 0;

  open({ kind, target, payload = {}, createdAt = Date.now() } = {}) {
    const normalizedTarget = normalizeTarget(target);
    const normalizedKind = kind === 'question' ? 'question' : 'approval';
    const needId = needIdFor(normalizedKind, normalizedTarget);
    const fingerprint = fingerprintOf({ kind: normalizedKind, target: normalizedTarget, payload });
    const existing = this.#records.get(needId);
    if (existing) {
      return {
        kind: existing.openFingerprint === fingerprint ? 'duplicate' : 'conflict',
        changed: false,
        revision: this.#revision,
        need: toDto(existing),
      };
    }

    const revision = ++this.#revision;
    const record = {
      needId,
      revision,
      kind: normalizedKind,
      state: 'pending',
      target: normalizedTarget,
      payload: clone(payload),
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      openFingerprint: fingerprint,
      resolutionFingerprint: null,
    };
    this.#records.set(needId, record);
    return { kind: 'opened', changed: true, revision, need: toDto(record) };
  }

  snapshot() {
    return {
      revision: this.#revision,
      needs: [...this.#records.values()]
        .filter(record => record.state === 'pending' || record.state === 'unknown')
        .sort((a, b) => a.createdAt - b.createdAt || a.needId.localeCompare(b.needId))
        .map(toDto),
    };
  }

  async resolve(query, resolution, responder) {
    const record = this.#find(query);
    if (!record || !targetMatches(record.target, query)) {
      return { kind: 'stale', changed: false, revision: this.#revision };
    }
    const resolutionFingerprint = fingerprintOf(resolution || {});
    if (record.state === 'resolved') {
      return {
        kind: record.resolutionFingerprint === resolutionFingerprint ? 'duplicate' : 'conflict',
        changed: false,
        revision: this.#revision,
        need: toDto(record),
      };
    }
    if (record.state === 'resolving') {
      return { kind: 'in_progress', changed: false, revision: this.#revision, need: toDto(record) };
    }
    if (record.state !== 'pending') {
      return { kind: 'stale', changed: false, revision: this.#revision, need: toDto(record) };
    }

    record.state = 'resolving';
    record.updatedAt = Date.now();
    try {
      const accepted = await responder(toDto(record));
      if (accepted !== true) {
        record.state = 'revoked';
        record.updatedAt = Date.now();
        record.revision = ++this.#revision;
        return { kind: 'stale', changed: true, revision: this.#revision, need: toDto(record) };
      }
      record.state = 'resolved';
      record.resolutionFingerprint = resolutionFingerprint;
      record.resolvedAt = Date.now();
      record.updatedAt = record.resolvedAt;
      record.revision = ++this.#revision;
      return { kind: 'resolved', changed: true, revision: this.#revision, need: toDto(record) };
    } catch (error) {
      record.state = 'unknown';
      record.updatedAt = Date.now();
      record.revision = ++this.#revision;
      return {
        kind: 'unknown',
        changed: true,
        revision: this.#revision,
        need: toDto(record),
        error,
      };
    }
  }

  close(query, { state = 'revoked', reason = null } = {}) {
    const closed = [];
    for (const record of this.#records.values()) {
      if (!queryMatches(record.target, query)) continue;
      if (!['pending', 'resolving', 'unknown'].includes(record.state)) continue;
      record.state = state === 'expired' ? 'expired' : 'revoked';
      record.updatedAt = Date.now();
      record.payload = { ...record.payload, ...(reason ? { closeReason: String(reason) } : {}) };
      record.revision = ++this.#revision;
      closed.push(toDto(record));
    }
    return { changed: closed.length > 0, revision: this.#revision, needs: closed };
  }

  clear() {
    this.#records.clear();
    this.#revision = 0;
  }

  #find(query = {}) {
    if (typeof query.needId === 'string' && query.needId) return this.#records.get(query.needId) ?? null;
    const matches = [...this.#records.values()].filter(record => queryMatches(record.target, query));
    return matches.length === 1 ? matches[0] : null;
  }
}

function normalizeTarget(target = {}) {
  return {
    instanceId: requiredId(target.instanceId, 'instanceId'),
    threadId: requiredId(target.threadId, 'threadId'),
    turnId: requiredId(target.turnId, 'turnId'),
    itemId: requiredId(target.itemId, 'itemId'),
    requestId: requiredRequestId(target.requestId),
  };
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

function requiredRequestId(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError('requestId is required');
}

function needIdFor(kind, target) {
  return `need_${createHash('sha256')
    .update(fingerprintOf({ kind, target }))
    .digest('hex')
    .slice(0, 24)}`;
}

function targetMatches(target, query = {}) {
  return queryMatches(target, query, true);
}

function queryMatches(target, query = {}, requireComplete = false) {
  const pairs = [
    ['instanceId', query.instanceId],
    ['threadId', query.threadId],
    ['turnId', query.turnId],
    ['itemId', query.itemId],
    ['requestId', query.requestId ?? query.approvalId],
  ];
  if (requireComplete && pairs.some(([, value]) => value === undefined || value === null || value === '')) {
    return false;
  }
  let compared = 0;
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    compared += 1;
    if (target[key] !== value) return false;
  }
  return compared > 0;
}

function fingerprintOf(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function toDto(record) {
  return {
    needId: record.needId,
    revision: record.revision,
    kind: record.kind,
    state: record.state,
    target: { ...record.target },
    payload: clone(record.payload),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
