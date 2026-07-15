import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageOutbox } from '../public/js/message-outbox.js';
import { createMessageRequest } from '../public/js/message-request.js';

test('message outbox persists a request before its first transport attempt', async () => {
  const calls = [];
  let stored = [];
  const store = {
    async put(record) {
      calls.push(`put:${record.state}`);
      stored = [structuredClone(record)];
    },
    async list() {
      calls.push('list');
      return structuredClone(stored);
    },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      calls.push(`send:${payload.clientRequestId}`);
      return { ok: true, receipt: { state: 'submitted' } };
    },
  });
  const request = createMessageRequest({
    text: 'persist first',
    target: { threadId: 'thr-outbox' },
  }, { createId: () => 'req-persist-first', now: () => 1 });

  await outbox.enqueue(request);
  await outbox.drain();

  assert.ok(calls.indexOf('put:pending') < calls.indexOf('send:req-persist-first'));
});

test('message outbox deletes a request after a submitted duplicate receipt', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      return {
        ok: true,
        duplicate: true,
        receipt: { clientRequestId: 'req-accepted', state: 'submitted' },
      };
    },
  });
  const request = createMessageRequest({
    text: 'already accepted',
    target: { threadId: 'thr-outbox' },
  }, { createId: () => 'req-accepted', now: () => 2 });

  await outbox.enqueue(request);
  await outbox.drain();

  assert.deepEqual(await store.list(), []);
});

test('message outbox quarantines an unknown timeout for reconciliation without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      transportCalls += 1;
      const error = new Error('ack timeout');
      error.code = 'ack_timeout';
      error.retryable = true;
      error.resultUnknown = true;
      throw error;
    },
  });
  const request = createMessageRequest({
    text: 'retry exactly this',
    target: { threadId: 'thr-retry' },
  }, { createId: () => 'req-retryable', now: () => 3 });
  const originalPayload = structuredClone(request.payload);

  await outbox.enqueue(request);
  await assert.doesNotReject(outbox.drain());
  await assert.doesNotReject(outbox.drain());

  const [retained] = await store.list();
  assert.equal(retained.state, 'needs_reconcile');
  assert.equal(retained.attempts, 1);
  assert.equal(transportCalls, 1);
  assert.deepEqual(retained.lastError, {
    code: 'ack_timeout',
    message: 'ack timeout',
    resultUnknown: true,
  });
  assert.deepEqual(retained.payload, originalPayload);
});

test('message outbox reconciles an unknown request read-only before removing it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let messageSends = 0;
  const reconcileQueries = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-epoch-a',
    async transport() {
      messageSends += 1;
      const error = new Error('ack lost after dispatch');
      error.code = 'ack_timeout';
      error.retryable = true;
      error.resultUnknown = true;
      throw error;
    },
    async reconcileTransport(query) {
      reconcileQueries.push(structuredClone(query));
      return {
        ok: true,
        resolved: true,
        gatewayEpoch: 'gateway-epoch-b',
        receipt: {
          clientRequestId: query.clientRequestId,
          threadId: query.threadId,
          state: 'submitted',
        },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'reconcile me', target: { threadId: 'thr-reconcile-me' },
  }, { createId: () => 'req-reconcile-me', now: () => 4 }));

  await outbox.drain();
  const [unknown] = await store.list();
  assert.equal(unknown.state, 'needs_reconcile');
  assert.equal(unknown.attemptedGatewayEpoch, 'gateway-epoch-a');

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 1, unresolved: 0 });
  assert.equal(messageSends, 1);
  assert.deepEqual(reconcileQueries, [{
    clientRequestId: 'req-reconcile-me',
    threadId: 'thr-reconcile-me',
    attemptedGatewayEpoch: 'gateway-epoch-a',
  }]);
  assert.deepEqual(await store.list(), []);
});

test('message outbox reconciles a queued receipt when the gateway epoch changes', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const queries = [];
  let messageSends = 0;
  await store.put({
    ...createMessageRequest({
      text: 'queued on the old gateway', target: { threadId: 'thr-old-queue' },
    }, { createId: () => 'req-old-queue', now: () => 5 }),
    state: 'queued',
    attemptedGatewayEpoch: 'gateway-old',
    receipt: {
      clientRequestId: 'req-old-queue',
      threadId: 'thr-old-queue',
      state: 'queued',
    },
  });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-new',
    async transport() { messageSends += 1; },
    async reconcileTransport(query) {
      queries.push(structuredClone(query));
      return {
        ok: true,
        resolved: false,
        gatewayEpoch: 'gateway-new',
        resultUnknown: true,
        errorCode: 'client_request_not_found',
      };
    },
  });

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 0, unresolved: 1 });
  assert.equal(messageSends, 0);
  assert.deepEqual(queries, [{
    clientRequestId: 'req-old-queue',
    threadId: 'thr-old-queue',
    attemptedGatewayEpoch: 'gateway-old',
  }]);
  const [record] = await store.list();
  assert.equal(record.state, 'needs_reconcile');
  assert.equal(record.reconciledGatewayEpoch, 'gateway-new');
});

test('message outbox reconciles a queued receipt after a same-epoch view switch', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    clientRequestId: 'req-queued-same-epoch',
    createdAt: 1,
    state: 'queued',
    attemptedGatewayEpoch: 'gateway-stable',
    payload: {
      clientRequestId: 'req-queued-same-epoch',
      text: 'queued while another view opens',
      threadId: 'thr-queued-same-epoch',
    },
  });
  const queries = [];
  const outbox = createMessageOutbox({
    store,
    transport: async () => assert.fail('queued reconciliation must stay read-only'),
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-stable',
    async reconcileTransport(query) {
      queries.push(query);
      return {
        ok: true,
        resolved: true,
        receipt: {
          clientRequestId: query.clientRequestId,
          state: 'submitted',
          threadId: query.threadId,
        },
      };
    },
  });

  const summary = await outbox.reconcile();

  assert.deepEqual(summary, { checked: 1, resolved: 1, unresolved: 0 });
  assert.deepEqual(queries, [{
    clientRequestId: 'req-queued-same-epoch',
    threadId: 'thr-queued-same-epoch',
    attemptedGatewayEpoch: 'gateway-stable',
  }]);
  assert.deepEqual(await store.list(), []);
});

test('message outbox records a definitive reconciled rejection without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'rejected upstream', target: { threadId: 'thr-rejected-upstream' },
    }, { createId: () => 'req-rejected-upstream', now: () => 6 }),
    state: 'needs_reconcile',
  });
  let messageSends = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { messageSends += 1; },
    async reconcileTransport() {
      return {
        ok: true,
        resolved: true,
        gatewayEpoch: 'gateway-current',
        outcome: {
          ok: false,
          errorCode: 'dispatch_rejected',
          error: 'runtime rejected the message',
          retryable: false,
          resultUnknown: false,
        },
      };
    },
  });

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 1, unresolved: 0 });
  assert.equal(messageSends, 0);
  const [record] = await store.list();
  assert.equal(record.state, 'rejected');
  assert.deepEqual(record.lastError, {
    code: 'dispatch_rejected',
    message: 'runtime rejected the message',
    resultUnknown: false,
  });
});

test('message outbox retries an unknown result only after explicit confirmation', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'confirm before retry', target: { threadId: 'thr-confirm-retry' },
    }, { createId: () => 'req-confirm-retry', now: () => 7 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-after-confirmation',
    createId: () => 'req-confirm-retry-replacement',
    now: () => 1234,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: {
          clientRequestId: payload.clientRequestId,
          threadId: payload.threadId,
          state: 'submitted',
        },
      };
    },
  });

  await outbox.drain();
  assert.deepEqual(sent, []);
  const replacement = await outbox.retryAfterConfirmation('req-confirm-retry', {
    confirmedAt: 1234,
    target: { threadId: 'thr-confirm-retry' },
  });
  assert.equal(replacement.clientRequestId, 'req-confirm-retry-replacement');
  assert.equal(replacement.retryOfClientRequestId, 'req-confirm-retry');
  await outbox.drain();

  assert.deepEqual(sent, ['req-confirm-retry-replacement']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox rebinds only a never-attempted provisional request without changing its id', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put(createMessageRequest({
    text: 'recover provisional target',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    target: { instanceId: 'inst-dead' },
  }, { createId: () => 'req-rebind-same-id', now: () => 77 }));
  await store.put({
    ...createMessageRequest({
      text: 'attempted target stays quarantined', target: { instanceId: 'inst-dead' },
    }, { createId: () => 'req-attempted-orphan', now: () => 78 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { assert.fail('rebinding must not dispatch'); },
  });

  const rebound = await outbox.rebindUnattempted('req-rebind-same-id', {
    threadId: 'thr-current',
    instanceId: 'inst-current',
  });
  const refused = await outbox.rebindUnattempted('req-attempted-orphan', {
    threadId: 'thr-current',
  });

  assert.equal(rebound.clientRequestId, 'req-rebind-same-id');
  assert.equal(rebound.createdAt, 77);
  assert.deepEqual(rebound.payload, {
    clientRequestId: 'req-rebind-same-id',
    text: 'recover provisional target',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    threadId: 'thr-current',
  });
  assert.equal(refused, null);
  const attempted = (await store.list()).find(record => record.clientRequestId === 'req-attempted-orphan');
  assert.equal(attempted.state, 'needs_reconcile');
  assert.equal(attempted.payload.instanceId, 'inst-dead');
});

test('confirmed retry cannot race with reconciliation and resurrect the quarantined id', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'serialize retry and reconcile', target: { instanceId: 'inst-dead' },
    }, { createId: () => 'req-race-old', now: () => 79 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  let releaseReconcile;
  let reconciliationStarted;
  const started = new Promise(resolve => { reconciliationStarted = resolve; });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    createId: () => 'req-race-replacement',
    async transport() { assert.fail('the race test must stay read-only'); },
    async reconcileTransport() {
      reconciliationStarted();
      await new Promise(resolve => { releaseReconcile = resolve; });
      return { ok: true, resolved: false, resultUnknown: true };
    },
  });

  const reconciling = outbox.reconcile();
  await started;
  const retrying = outbox.retryAfterConfirmation('req-race-old', {
    target: { threadId: 'thr-current' },
  });
  releaseReconcile();
  const [, replacement] = await Promise.all([reconciling, retrying]);

  assert.equal(replacement.clientRequestId, 'req-race-replacement');
  assert.deepEqual((await store.list()).map(record => record.clientRequestId), [
    'req-race-replacement',
  ]);
});

test('message outbox drains in FIFO order through one shared flight', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const firstResolvers = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    transport(payload) {
      sent.push(payload.clientRequestId);
      if (payload.clientRequestId === 'req-first') {
        return new Promise(resolve => firstResolvers.push(resolve));
      }
      return Promise.resolve({
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      });
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'first', target: { threadId: 'thr-fifo' },
  }, { createId: () => 'req-first', now: () => 10 }));
  await outbox.enqueue(createMessageRequest({
    text: 'second', target: { threadId: 'thr-fifo' },
  }, { createId: () => 'req-second', now: () => 20 }));

  const drainA = outbox.drain();
  const drainB = outbox.drain();
  await new Promise(resolve => setImmediate(resolve));
  const sentBeforeFirstAck = [...sent];
  for (const resolve of firstResolvers) {
    resolve({ ok: true, receipt: { clientRequestId: 'req-first', state: 'submitted' } });
  }
  await Promise.all([drainA, drainB]);

  assert.deepEqual(sentBeforeFirstAck, ['req-first']);
  assert.deepEqual(sent, ['req-first', 'req-second']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox schedules a follow-up drain for input enqueued during an active flight', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  let releaseFirst;
  const firstAck = new Promise(resolve => { releaseFirst = resolve; });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      if (payload.clientRequestId === 'req-active-first') await firstAck;
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'first active request', target: { threadId: 'thr-active-flight' },
  }, { createId: () => 'req-active-first', now: () => 21 }));

  const firstDrain = outbox.drain({
    shouldSend: request => request.clientRequestId === 'req-active-first',
  });
  await new Promise(resolve => setImmediate(resolve));
  await outbox.enqueue(createMessageRequest({
    text: 'arrived during active request', target: { threadId: 'thr-active-flight' },
  }, { createId: () => 'req-active-second', now: () => 22 }));
  const secondDrain = outbox.drain({
    shouldSend: request => request.clientRequestId === 'req-active-second',
  });
  releaseFirst();

  await Promise.all([firstDrain, secondDrain]);

  assert.deepEqual(sent, ['req-active-first', 'req-active-second']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox records an explicit rejection and does not skip ahead in FIFO order', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: false,
        errorCode: 'stale_target',
        error: 'message target is stale',
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'blocked first', target: { threadId: 'thr-stale' },
  }, { createId: () => 'req-rejected', now: () => 30 }));
  await outbox.enqueue(createMessageRequest({
    text: 'must wait', target: { threadId: 'thr-stale' },
  }, { createId: () => 'req-waiting', now: () => 40 }));

  await outbox.drain();

  const [rejected, waiting] = await store.list();
  assert.deepEqual(sent, ['req-rejected']);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.lastError, {
    code: 'stale_target',
    message: 'message target is stale',
    resultUnknown: false,
  });
  assert.equal(waiting.state, 'pending');
});

test('message outbox does not automatically replay a rejected FIFO head', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await store.put({
    ...createMessageRequest({
      text: 'rejected head', target: { threadId: 'thr-rejected-head' },
    }, { createId: () => 'req-rejected-head', now: () => 41 }),
    state: 'rejected',
  });
  await outbox.enqueue(createMessageRequest({
    text: 'pending behind rejection', target: { threadId: 'thr-rejected-head' },
  }, { createId: () => 'req-behind-rejection', now: () => 42 }));

  await outbox.drain();

  assert.deepEqual(sent, []);
  assert.deepEqual((await store.list()).map(record => record.state), ['rejected', 'pending']);
});

test('message outbox skips an already queued record while draining later pending input', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await store.put({
    ...createMessageRequest({
      text: 'already queued', target: { threadId: 'thr-runtime-queue' },
    }, { createId: () => 'req-already-queued', now: () => 43 }),
    state: 'queued',
    receipt: { clientRequestId: 'req-already-queued', state: 'queued' },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'pending after queued', target: { threadId: 'thr-runtime-queue' },
  }, { createId: () => 'req-after-queued', now: () => 44 }));

  await outbox.drain();

  assert.deepEqual(sent, ['req-after-queued']);
  const [queued] = await store.list();
  assert.equal(queued.clientRequestId, 'req-already-queued');
  assert.equal(queued.state, 'queued');
});

test('message outbox drains only requests selected for the active view', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'active thread', target: { threadId: 'thr-active' },
  }, { createId: () => 'req-active-view', now: () => 47 }));
  await outbox.enqueue(createMessageRequest({
    text: 'background thread', target: { threadId: 'thr-background' },
  }, { createId: () => 'req-background-view', now: () => 48 }));

  await outbox.drain({
    shouldSend: request => request.payload.threadId === 'thr-active',
  });

  assert.deepEqual(sent, ['req-active-view']);
  const [background] = await store.list();
  assert.equal(background.clientRequestId, 'req-background-view');
  assert.equal(background.state, 'pending');
});

test('message outbox marks a successful ack without a receipt as needing reconciliation', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return { ok: true };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'unknown first', target: { threadId: 'thr-invalid-receipt' },
  }, { createId: () => 'req-invalid-receipt', now: () => 45 }));
  await outbox.enqueue(createMessageRequest({
    text: 'must remain pending', target: { threadId: 'thr-invalid-receipt' },
  }, { createId: () => 'req-after-invalid-receipt', now: () => 46 }));

  await outbox.drain();
  await outbox.drain();

  const [unknown, waiting] = await store.list();
  assert.deepEqual(sent, ['req-invalid-receipt']);
  assert.equal(unknown.state, 'needs_reconcile');
  assert.deepEqual(unknown.lastError, {
    code: 'invalid_receipt',
    message: 'Message acknowledgement did not contain a matching receipt',
    resultUnknown: true,
  });
  assert.equal(waiting.state, 'pending');
});

test('message outbox quarantines an explicit unknown server result without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      transportCalls += 1;
      return {
        ok: false,
        retryable: true,
        resultUnknown: true,
        errorCode: 'dispatch_failed',
        error: 'dispatch result is unknown',
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'unknown dispatch', target: { threadId: 'thr-unknown-dispatch' },
  }, { createId: () => 'req-unknown-dispatch', now: () => 49 }));

  await outbox.drain();
  await outbox.drain();

  const [unknown] = await store.list();
  assert.equal(unknown.state, 'needs_reconcile');
  assert.equal(unknown.attempts, 1);
  assert.equal(transportCalls, 1);
  assert.deepEqual(unknown.lastError, {
    code: 'dispatch_failed',
    message: 'dispatch result is unknown',
    resultUnknown: true,
  });
});

test('message outbox automatically retries a definite retryable result', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      transportCalls += 1;
      if (transportCalls === 1) {
        return {
          ok: false,
          retryable: true,
          resultUnknown: false,
          errorCode: 'runtime_busy',
          error: 'runtime can be retried safely',
        };
      }
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'retry known failure', target: { threadId: 'thr-definite-retry' },
  }, { createId: () => 'req-definite-retry', now: () => 49.5 }));

  await outbox.drain();
  const [retryable] = await store.list();
  assert.equal(retryable.state, 'retryable');
  assert.equal(retryable.lastError.resultUnknown, false);

  await outbox.drain();

  assert.equal(transportCalls, 2);
  assert.deepEqual(await store.list(), []);
});

test('message outbox retains a queued receipt until a later durable transition', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'queued' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'wait in runtime queue', target: { threadId: 'thr-queued' },
  }, { createId: () => 'req-queued', now: () => 50 }));

  await outbox.drain();

  const [queued] = await store.list();
  assert.equal(queued.state, 'queued');
  assert.deepEqual(queued.receipt, {
    clientRequestId: 'req-queued',
    state: 'queued',
  });

  await outbox.acceptReceipt({
    clientRequestId: 'req-queued',
    state: 'submitted',
    turnId: 'turn-after-queue',
  });
  assert.deepEqual(await store.list(), []);
});

test('message outbox records a rejected runtime transition for a queued request', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'queued' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'queued then rejected', target: { threadId: 'thr-rejected-transition' },
  }, { createId: () => 'req-rejected-transition', now: () => 60 }));
  await outbox.drain();

  const accepted = await outbox.acceptReceipt({
    clientRequestId: 'req-rejected-transition',
    state: 'rejected',
    errorCode: 'turn_start_failed',
    error: 'turn/start failed after dequeue',
  });

  const [rejected] = await store.list();
  assert.equal(accepted, true);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.receipt, {
    clientRequestId: 'req-rejected-transition',
    state: 'rejected',
    errorCode: 'turn_start_failed',
    error: 'turn/start failed after dequeue',
  });
  assert.deepEqual(rejected.lastError, {
    code: 'turn_start_failed',
    message: 'turn/start failed after dequeue',
    resultUnknown: false,
  });
});
