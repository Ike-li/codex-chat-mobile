import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDefinitelyUnattempted,
  isProvisionalInstanceOrphan,
  requiresManualDisposal,
} from '../public/js/outbox-recovery.js';

test('provisional outbox targets become orphans only after an authoritative instance snapshot', () => {
  const request = {
    clientRequestId: 'req-provisional',
    state: 'pending',
    payload: {
      clientRequestId: 'req-provisional',
      text: 'recover me',
      instanceId: 'inst-old',
    },
  };

  assert.equal(isProvisionalInstanceOrphan(request, {
    currentInstanceId: null,
    instanceSnapshotReceived: false,
    activeInstanceIds: [],
  }), false);
  assert.equal(isProvisionalInstanceOrphan(request, {
    currentInstanceId: null,
    instanceSnapshotReceived: true,
    activeInstanceIds: ['inst-old'],
  }), false);
  assert.equal(isProvisionalInstanceOrphan(request, {
    currentInstanceId: null,
    instanceSnapshotReceived: true,
    activeInstanceIds: ['inst-new'],
  }), true);
  assert.equal(isProvisionalInstanceOrphan({
    ...request,
    payload: { ...request.payload, threadId: 'thr-durable' },
  }, {
    currentInstanceId: null,
    instanceSnapshotReceived: true,
    activeInstanceIds: [],
  }), false);
});

test('only never-attempted pending records are safe to rebind in place', () => {
  assert.equal(isDefinitelyUnattempted({ state: 'pending' }), true);
  assert.equal(isDefinitelyUnattempted({ state: 'pending', attempts: 0 }), true);
  assert.equal(isDefinitelyUnattempted({ state: 'pending', attempts: 1 }), false);
  assert.equal(isDefinitelyUnattempted({ state: 'needs_reconcile', attempts: 1 }), false);
  assert.equal(isDefinitelyUnattempted({ state: 'pending', attemptedGatewayEpoch: 'gateway-old' }), false);
});

test('a record that no automatic path can advance is flagged for manual disposal', () => {
  // 弱网里正常排队等待：drain 会自己发出去，不该催用户动手。
  assert.equal(requiresManualDisposal({ state: 'pending' }, { orphaned: false }), false);
  assert.equal(requiresManualDisposal({ state: 'sending', attempts: 1 }, { orphaned: false }), false);
  assert.equal(requiresManualDisposal({ state: 'queued', attempts: 1 }, { orphaned: false }), false);
  // 网关明确拒绝：终态，且 drain 会停在它这里挡住同视图后面的消息。
  assert.equal(requiresManualDisposal({ state: 'rejected', attempts: 1 }, { orphaned: false }), true);
  // 结果未知：只能由用户决定重试还是丢弃。
  assert.equal(requiresManualDisposal({ state: 'needs_reconcile', attempts: 1 }, { orphaned: false }), true);
  // 目标失效但从未发出：连上后会被 rebindUnattempted 自动接回当前会话。
  assert.equal(requiresManualDisposal({ state: 'pending', attempts: 0 }, { orphaned: true }), false);
  // 目标失效且已尝试：不能重绑、不能重发、reconcile 也不覆盖 retryable —— 三条自动出路全断。
  assert.equal(requiresManualDisposal({ state: 'retryable', attempts: 1 }, { orphaned: true }), true);
  assert.equal(requiresManualDisposal({
    state: 'pending', attempts: 1, attemptedGatewayEpoch: 'epoch-old',
  }, { orphaned: true }), true);
  assert.equal(requiresManualDisposal(null, { orphaned: true }), false);
});

test('an unattempted orphan is the only unbound record whose recovery promise is honest', () => {
  const unattempted = { state: 'pending', attempts: 0 };
  const attempted = { state: 'retryable', attempts: 1 };
  // UI 只有对前者才能承诺"连接后将恢复到当前会话"。
  assert.equal(isDefinitelyUnattempted(unattempted) && !requiresManualDisposal(unattempted, { orphaned: true }), true);
  assert.equal(isDefinitelyUnattempted(attempted), false);
  assert.equal(requiresManualDisposal(attempted, { orphaned: true }), true);
});
