import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDefinitelyUnattempted,
  isProvisionalInstanceOrphan,
  requiresManualDisposal,
  shouldSurfaceInOutboxView,
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

// 真实场景复现：离线时在 thread A 发一条消息 → 服务器重启（thread A 随之消失）→
// 重连后这条消息被拒。此时它既不匹配当前视图（threadId 对不上），也不是
// provisional 孤儿（isProvisionalInstanceOrphan 见到 threadId 就直接 false），
// 于是两个渲染条件都不满足——气泡根本不画出来。用户不知道消息没发出去，
// 也没有任何办法清掉它，而它还留在 outbox 里占位。
test('a failed record stays visible even when it belongs to another thread', () => {
  const rejected = { state: 'rejected', attempts: 1, payload: { threadId: 'thr-gone', text: 'x' } };
  const unknown = { state: 'needs_reconcile', attempts: 1, payload: { threadId: 'thr-gone', text: 'x' } };
  const waiting = { state: 'pending', payload: { threadId: 'thr-gone', text: 'x' } };

  // 不匹配当前视图、也不是 provisional 孤儿，但已经失败——必须浮出来给用户处置。
  assert.equal(shouldSurfaceInOutboxView(rejected, { matchesView: false, orphaned: false }), true);
  assert.equal(shouldSurfaceInOutboxView(unknown, { matchesView: false, orphaned: false }), true);

  // 还在正常排队的记录不属于当前视图就不打扰用户，它会自己发出去。
  assert.equal(shouldSurfaceInOutboxView(waiting, { matchesView: false, orphaned: false }), false);

  // 属于当前视图的一律显示，不管什么状态。
  assert.equal(shouldSurfaceInOutboxView(waiting, { matchesView: true, orphaned: false }), true);
  assert.equal(shouldSurfaceInOutboxView(rejected, { matchesView: true, orphaned: false }), true);

  // 既有的 provisional 孤儿路径不能退化。
  assert.equal(shouldSurfaceInOutboxView(waiting, { matchesView: false, orphaned: true }), true);

  assert.equal(shouldSurfaceInOutboxView(null, { matchesView: false, orphaned: false }), false);

  // provisional 记录（只有 instanceId、没有 threadId）不能靠这条规则抢先渲染：
  // 它的归属要等实例快照到达后才判得出来，提前画会被误标成「来自其他会话」，
  // 而正确的文案应该是「原会话目标已失效」。这类记录交给孤儿判定负责。
  const provisional = { state: 'needs_reconcile', attempts: 1, payload: { instanceId: 'inst-old', text: 'x' } };
  assert.equal(shouldSurfaceInOutboxView(provisional, { matchesView: false, orphaned: false }), false);
  assert.equal(shouldSurfaceInOutboxView(provisional, { matchesView: false, orphaned: true }), true);
});
