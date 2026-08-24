// test/needs-you-registry.test.mjs —— 跨 thread 待办登记表的生命周期与索引契约。
// 这些性质此前只被 server-integration 间接覆盖（见 FEATURE-BREAKDOWN 附录 C）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeedsYouRegistry } from '../needs-you-registry.js';

const targetFor = (index, instanceId = 'inst_1') => ({
  instanceId,
  threadId: 'thr_1',
  turnId: `turn_${index}`,
  itemId: `item_${index}`,
  requestId: index,
});

// ---- 终态记录的回收 ----

test('终态记录在 TTL 之后被回收，不随 turn 数无限累积', () => {
  // close() 只把 state 改成 expired/revoked，记录本身从不移除；而 server.js 的
  // trackNeedsYou 在每个 result / error / 终态 status 上都调一次 close，
  // 于是「挂着跑几天」的网关会单调累积记录并逐步拖慢每一次扫描。
  let clock = 1_000_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });

  for (let round = 0; round < 200; round += 1) {
    registry.open({ kind: 'approval', target: targetFor(round), payload: {}, createdAt: clock });
    registry.close({ instanceId: 'inst_1' }, { state: 'expired' });
    clock += 1_000;
  }

  const { size } = registry.stats();
  assert.ok(size <= 61, `记录数应稳定在 TTL 窗口内（≈60），实际 ${size}`);
});

test('pending 记录不会被 TTL 回收', () => {
  let clock = 1_000_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  registry.open({ kind: 'approval', target: targetFor(1), payload: {}, createdAt: clock });

  clock += 600_000;
  registry.open({ kind: 'approval', target: targetFor(2), payload: {}, createdAt: clock });

  assert.equal(registry.snapshot().needs.length, 2, '未决的待办不能因为放得久就消失');
});

// ---- 扫描开销 ----

test('close 的开销不随其他 instance 的历史记录数增长', () => {
  const measure = historySize => {
    const registry = new NeedsYouRegistry();
    for (let index = 0; index < historySize; index += 1) {
      registry.open({
        kind: 'approval',
        target: targetFor(index, `inst_other_${index}`),
        payload: {},
      });
    }
    const started = performance.now();
    for (let round = 0; round < 200; round += 1) {
      registry.close({ instanceId: 'inst_absent' }, { state: 'expired' });
    }
    return performance.now() - started;
  };

  measure(500);
  const small = Math.max(measure(500), 0.05);
  const large = measure(4000);
  assert.ok(large / small < 4, `8 倍历史下 close 不应线性放大，实际 ${(large / small).toFixed(1)}×`);
});

test('close 只关闭目标 instance 的待办', () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: targetFor(1, 'inst_a'), payload: {} });
  registry.open({ kind: 'approval', target: targetFor(2, 'inst_b'), payload: {} });

  const closed = registry.close({ instanceId: 'inst_a' }, { state: 'expired' });
  assert.equal(closed.needs.length, 1);
  assert.equal(closed.needs[0].target.instanceId, 'inst_a');
  assert.deepEqual(registry.snapshot().needs.map(need => need.target.instanceId), ['inst_b']);
});

// ---- 重开语义在 TTL 前后的分界 ----

test('TTL 内重开同一 need 仍是 duplicate，异指纹仍是 conflict', () => {
  let clock = 1_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  const target = targetFor(1);
  registry.open({ kind: 'approval', target, payload: { command: 'ls' }, createdAt: clock });
  registry.close({ instanceId: 'inst_1' }, { state: 'expired' });

  clock += 30_000;
  assert.equal(
    registry.open({ kind: 'approval', target, payload: { command: 'ls' }, createdAt: clock }).kind,
    'duplicate',
  );
  assert.equal(
    registry.open({ kind: 'approval', target, payload: { command: 'rm -rf /' }, createdAt: clock }).kind,
    'conflict',
  );
});

test('TTL 过后同一 need 可以重新开单', () => {
  let clock = 1_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  const target = targetFor(1);
  registry.open({ kind: 'approval', target, payload: {}, createdAt: clock });
  registry.close({ instanceId: 'inst_1' }, { state: 'expired' });

  clock += 120_000;
  assert.equal(
    registry.open({ kind: 'approval', target, payload: {}, createdAt: clock }).kind,
    'opened',
  );
});

// ---- 既有行为的护栏 ----

test('snapshot 只含 pending 与 unknown，按 createdAt 排序', () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: targetFor(2), payload: {}, createdAt: 2_000 });
  registry.open({ kind: 'question', target: targetFor(1), payload: {}, createdAt: 1_000 });
  const { needs, revision } = registry.snapshot();
  assert.deepEqual(needs.map(need => need.target.turnId), ['turn_1', 'turn_2']);
  assert.equal(revision, 2);
});

test('resolve 缺任一标识即 stale', async () => {
  const registry = new NeedsYouRegistry();
  const opened = registry.open({ kind: 'approval', target: targetFor(1), payload: {} });
  const outcome = await registry.resolve(
    { needId: opened.need.needId, instanceId: 'inst_1' },
    { decision: 'accept' },
    async () => true,
  );
  assert.equal(outcome.kind, 'stale');
});
