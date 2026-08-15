import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageReceiptLedger } from '../message-receipt-ledger.js';

test('receipt ledger shares one pending result and rejects a conflicting fingerprint', async () => {
  const ledger = new MessageReceiptLedger();

  const owner = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'same',
  });
  const duplicate = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'same',
  });
  const conflict = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'different',
  });

  assert.equal(owner.kind, 'owner');
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(conflict.kind, 'conflict');

  let replaySettled = false;
  const replay = ledger.replay(duplicate.handle).then(result => {
    replaySettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(replaySettled, false);

  ledger.settle(owner.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-1', state: 'submitted' },
  });

  assert.deepEqual(await replay, {
    ok: true,
    receipt: { clientRequestId: 'req-1', state: 'submitted' },
  });
});

test('receipt ledger keeps pending ownership past the ready timeout until the owner settles', async () => {
  const ledger = new MessageReceiptLedger({ readyTtlMs: 5 });
  const owner = ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  });
  const waiting = ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  });
  const replay = ledger.replay(waiting.handle);

  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(ledger.stats().size, 1);
  assert.equal(ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  }).kind, 'duplicate');
  assert.equal(ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'different-payload',
  }).kind, 'conflict');

  ledger.settle(owner.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-slow', state: 'submitted' },
  });
  assert.deepEqual(await replay, {
    ok: true,
    receipt: { clientRequestId: 'req-slow', state: 'submitted' },
  });
});

test('receipt ledger keeps runtime receipt transitions monotonic across settle races', async () => {
  const ledger = new MessageReceiptLedger();

  const beforeSettle = ledger.claim({
    identity: 'device:a', requestId: 'req-before', fingerprint: 'before',
  });
  assert.equal(ledger.bindRuntime(beforeSettle.handle, {
    instanceId: 'inst-a', clientRequestId: 'req-before',
  }), true);
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-before',
    receipt: { clientRequestId: 'req-before', state: 'submitted', turnId: 'turn-before' },
  }), true);
  ledger.settle(beforeSettle.handle, {
    ok: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    receipt: { clientRequestId: 'req-before', state: 'queued' },
  });
  assert.equal((await ledger.replay(beforeSettle.handle)).receipt.state, 'submitted');

  const afterSettle = ledger.claim({
    identity: 'device:a', requestId: 'req-after', fingerprint: 'after',
  });
  ledger.bindRuntime(afterSettle.handle, {
    instanceId: 'inst-a', clientRequestId: 'req-after',
  });
  ledger.settle(afterSettle.handle, {
    ok: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    receipt: { clientRequestId: 'req-after', state: 'queued' },
  });
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-after',
    receipt: { clientRequestId: 'req-after', state: 'submitted', turnId: 'turn-after' },
  }), true);
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-after',
    receipt: { clientRequestId: 'req-after', state: 'queued' },
  }), false);

  assert.deepEqual((await ledger.replay(afterSettle.handle)).receipt, {
    clientRequestId: 'req-after',
    state: 'submitted',
    turnId: 'turn-after',
  });
});

test('receipt ledger expires only terminal entries and fails closed at its hard cap', () => {
  let now = 0;
  const ledger = new MessageReceiptLedger({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now,
  });

  const waiting = ledger.claim({
    identity: 'device:a', requestId: 'req-waiting', fingerprint: 'waiting',
  });
  ledger.settle(waiting.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-waiting', state: 'queued' },
  });
  const terminal = ledger.claim({
    identity: 'device:a', requestId: 'req-terminal', fingerprint: 'terminal',
  });
  ledger.settle(terminal.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-terminal', state: 'submitted' },
  });
  assert.equal(ledger.stats().size, 2);

  now = 101;
  const replacement = ledger.claim({
    identity: 'device:a', requestId: 'req-replacement', fingerprint: 'replacement',
  });
  assert.equal(replacement.kind, 'owner');
  assert.equal(ledger.stats().size, 2);
  ledger.settle(replacement.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-replacement', state: 'submitted' },
  });

  const full = ledger.claim({
    identity: 'device:a', requestId: 'req-full', fingerprint: 'full',
  });
  assert.equal(full.kind, 'full');
  assert.equal(ledger.stats().size, 2);

  now = 202;
  const afterExpiry = ledger.claim({
    identity: 'device:a', requestId: 'req-after-expiry', fingerprint: 'after-expiry',
  });
  assert.equal(afterExpiry.kind, 'owner');
  assert.equal(ledger.stats().size, 2);
});

test('receipt ledger expires a settled non-retryable failure without a receipt', () => {
  let now = 0;
  const ledger = new MessageReceiptLedger({
    maxEntries: 1,
    ttlMs: 100,
    now: () => now,
  });
  const failed = ledger.claim({
    identity: 'device:a', requestId: 'req-failed', fingerprint: 'failed',
  });
  ledger.settle(failed.handle, {
    ok: false,
    retryable: false,
    errorCode: 'invalid_message',
    error: 'message rejected',
  });

  now = 101;
  const replacement = ledger.claim({
    identity: 'device:a', requestId: 'req-after-failure', fingerprint: 'replacement',
  });

  assert.equal(replacement.kind, 'owner');
  assert.equal(ledger.stats().size, 1);
});

test('receipt ledger releases a definitely unaccepted retryable request for the same-id retry', async () => {
  const ledger = new MessageReceiptLedger();
  const first = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  const concurrentDuplicate = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  const replay = ledger.replay(concurrentDuplicate.handle);

  ledger.settle(first.handle, {
    ok: false,
    retryable: true,
    resultUnknown: false,
    errorCode: 'queue_full',
    error: 'runtime queue is full',
  });

  assert.equal((await replay).errorCode, 'queue_full');
  const retry = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  assert.equal(retry.kind, 'owner');
});
