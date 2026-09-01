import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageReceiptLedger } from '../message-receipt-ledger.js';
import { NeedsYouRegistry } from '../needs-you-registry.js';

// 「不丢不重」与「需要人时叫得到人」的行为契约。
//
// 这一组测试刻意只断言**外部可观察行为**：同一请求发两次会怎样、断线重连后能查到什么、
// 处理过的审批再处理一次会怎样。不碰 phase / revision / handles 这些内部结构，因为它们
// 是实现细节——现有测试大量断言内部形态，重构时会一起被改掉，那就失去了安全网的意义。
//
// 目的：为后续拆解这两个模块提供一张与实现无关的网。任何改动如果让这里变红，就是真的
// 改变了用户可见的行为，而不只是换了个写法。

function makeLedger() {
  return new MessageReceiptLedger({ now: () => 1000 });
}

const IDENTITY = 'device-a';

test('契约：同一请求重复到达只执行一次，结果对两次调用一致', async () => {
  const ledger = makeLedger();
  const first = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(first.kind, 'owner', '第一次是所有者，应当真正执行');

  const second = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(second.kind, 'duplicate', '第二次不得再执行一遍');

  ledger.settle(first.handle, { ok: true, status: 'done' });
  assert.deepEqual(await ledger.replay(second.handle), { ok: true, status: 'done' },
    '重复请求必须拿到与首次相同的结果，而不是自己再跑一次');
});

test('契约：同一 id 携带不同内容会被拒绝，不能悄悄覆盖', async () => {
  const ledger = makeLedger();
  ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp-a' });
  const conflicting = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp-b' });
  assert.equal(conflicting.kind, 'conflict');
});

test('契约：不同设备的相同 requestId 互不影响', async () => {
  const ledger = makeLedger();
  const a = ledger.claim({ identity: 'device-a', requestId: 'req-1', fingerprint: 'fp' });
  const b = ledger.claim({ identity: 'device-b', requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(a.kind, 'owner');
  assert.equal(b.kind, 'owner', '另一台设备的同名请求是独立的一次发送');
});

test('契约：重连后按请求 id 能查到已完成的结果，无需重发', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: true, status: 'done' });

  // 断线重连走的是这条路：客户端只有 requestId，没有 handle。
  assert.deepEqual(await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' }),
    { ok: true, status: 'done' });
  assert.equal(await ledger.replayByRequest({ identity: IDENTITY, requestId: 'never-sent' }), null,
    '没发过的请求查不到东西，客户端据此判断需要重发');
});

test('契约：结果尚未产生时查询会等待，不会得到「不存在」', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  const pending = ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  let settledFirst = false;
  pending.then(() => { settledFirst = true; });
  await Promise.resolve();
  assert.equal(settledFirst, false, '结果没出来之前不能提前返回 null——那会让客户端重发');

  ledger.settle(claim.handle, { ok: true, status: 'done' });
  assert.deepEqual(await pending, { ok: true, status: 'done' });
});

test('契约：可重试的失败不留痕，用户重试时是干净的一次新发送', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: false, retryable: true, error: 'network' });

  const retry = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(retry.kind, 'owner', '失败且可重试时，同一 id 应能重新发起');
});

test('契约：结果未知的失败必须留痕，不能当成没发生过', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: false, retryable: true, resultUnknown: true, error: 'timeout' });

  const retry = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(retry.kind, 'duplicate',
    '结果未知时不能默默重发——可能已经执行过了，重发就是执行两次');
});

test('契约：runtime 回执把「排队中」推进到「已提交」，并对查询可见', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });

  ledger.advanceRuntime({ instanceId: 'inst-1', clientRequestId: 'req-1', receipt: { state: 'submitted' } });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.receipt.state, 'submitted', '回执推进要能被后续查询看到');
});

test('契约：runtime 拒收会把结果翻成失败，不能显示为成功', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });

  ledger.advanceRuntime({
    instanceId: 'inst-1',
    clientRequestId: 'req-1',
    receipt: { state: 'rejected', errorCode: 'queue_full' },
  });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.ok, false);
  assert.equal(seen.errorCode, 'queue_full');
});

test('契约：回执不能倒退，已提交不会被迟到的「排队中」覆盖', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'submitted' } });

  ledger.advanceRuntime({ instanceId: 'inst-1', clientRequestId: 'req-1', receipt: { state: 'queued' } });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.receipt.state, 'submitted', '乱序到达的旧回执必须被忽略');
});

// —— 审批待办的行为契约 ——

const TARGET = { instanceId: 'inst-1', threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1', requestId: 'rq-1' };

test('契约：待办出现在快照里，处理后消失', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: { command: 'rm -rf /' } });
  assert.equal(registry.snapshot().needs.length, 1, '重连的手机要能看到待办');
  assert.equal(registry.snapshot().needs[0].payload.command, 'rm -rf /',
    '卡片内容必须能重建——协议侧的 server request 是一次性的，重连后取不回来');

  await registry.resolve(TARGET, { decision: 'approved' }, async () => ({ ok: true }));
  assert.equal(registry.snapshot().needs.length, 0, '处理完不该继续出现在待办里');
});

test('契约：同一审批被处理两次，只执行一次决定', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });
  let responderCalls = 0;
  const responder = async () => { responderCalls += 1; return { ok: true }; };

  await registry.resolve(TARGET, { decision: 'approved' }, responder);
  await registry.resolve(TARGET, { decision: 'approved' }, responder);
  assert.equal(responderCalls, 1, '第二次不得再次下发决定');
});

test('契约：处理一个不存在的审批是 stale，不是崩溃', async () => {
  const registry = new NeedsYouRegistry();
  const outcome = await registry.resolve(TARGET, { decision: 'approved' }, async () => ({ ok: true }));
  assert.equal(outcome.kind, 'stale');
});

test('契约：撤销后的待办不再可处理', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });
  registry.close(TARGET, { state: 'revoked' });
  assert.equal(registry.snapshot().needs.length, 0);

  let called = false;
  await registry.resolve(TARGET, { decision: 'approved' }, async () => { called = true; return { ok: true }; });
  assert.equal(called, false, '已撤销的审批不得再下发决定');
});
