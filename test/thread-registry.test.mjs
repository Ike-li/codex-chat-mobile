import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadRegistry } from '../thread-registry.js';

function assertStale(action) {
  assert.throws(action, error => {
    assert.equal(error?.code, 'stale_target');
    return true;
  });
}

test('registers a provisional instance and atomically binds its thread', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  assert.equal(registry.register(runtime, { instanceId: 'inst-a' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a' }), runtime);
  assertStale(() => registry.resolve({ threadId: 'thr-a' }));

  assert.equal(registry.bind(runtime, { threadId: 'thr-a' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
  assert.deepEqual(registry.snapshot(), [{
    runtime,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    turnId: null,
    requestIds: [],
  }]);
});

test('register can bind an initial thread and repeated identical bindings are idempotent', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { threadId: 'thr-a', turnId: 'turn-a', requestId: 'req-a' });
  registry.bind(runtime, { threadId: 'thr-a', turnId: 'turn-a', requestId: 'req-a' });

  assert.equal(registry.resolve({
    instanceId: 'inst-a',
    threadId: 'thr-a',
    turnId: 'turn-a',
    requestId: 'req-a',
  }), runtime);
});

test('all provided identifiers must resolve to the same runtime', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtimeA, { turnId: 'turn-a', requestId: 'req-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b', requestId: 'req-b' });

  assertStale(() => registry.resolve({ instanceId: 'inst-a', threadId: 'thr-b' }));
  assertStale(() => registry.resolve({ threadId: 'thr-a', turnId: 'turn-b' }));
  assertStale(() => registry.resolve({ turnId: 'turn-a', requestId: 'req-b' }));
  assertStale(() => registry.resolve({ instanceId: 'missing' }));
  assertStale(() => registry.resolve({}));
});

test('thread ids have one owner while local turn and request ids require context', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-owned' });
  registry.bind(runtimeA, { turnId: 'turn-owned', requestId: 'req-owned' });
  registry.register(runtimeB, { instanceId: 'inst-b' });

  assertStale(() => registry.bind(runtimeB, { threadId: 'thr-owned' }));
  registry.bind(runtimeB, { turnId: 'turn-owned' });
  registry.bind(runtimeB, { requestId: 'req-owned' });

  assert.equal(registry.resolve({ threadId: 'thr-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-a', turnId: 'turn-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', turnId: 'turn-owned' }), runtimeB);
  assertStale(() => registry.resolve({ turnId: 'turn-owned' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 'req-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', requestId: 'req-owned' }), runtimeB);
  assertStale(() => registry.resolve({ requestId: 'req-owned' }));
});

test('bind is atomic when any requested identifier conflicts', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });

  assertStale(() => registry.bind(runtimeA, {
    threadId: 'thr-b',
    turnId: 'turn-a',
    requestId: 'req-a',
  }));

  assertStale(() => registry.resolve({ turnId: 'turn-a' }));
  assertStale(() => registry.resolve({ requestId: 'req-a' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a' }), runtimeA);
  assert.deepEqual(registry.snapshot().find(entry => entry.runtime === runtimeA), {
    runtime: runtimeA,
    instanceId: 'inst-a',
    threadId: null,
    turnId: null,
    requestIds: [],
  });
});

test('a runtime can own multiple request identifiers including numeric RPC ids', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { requestId: 'client-request-a' });
  registry.bind(runtime, { requestId: 0 });
  registry.bind(runtime, { requestId: 42 });

  assert.equal(registry.resolve({ requestId: 'client-request-a' }), runtime);
  assert.equal(registry.resolve({ requestId: 0 }), runtime);
  assert.equal(registry.resolve({ requestId: 42, threadId: 'thr-a' }), runtime);
  assert.deepEqual(registry.snapshot()[0].requestIds, ['client-request-a', 0, 42]);
});

test('releaseRequest removes one completed request without releasing its runtime', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { requestId: 'request-a' });
  registry.bind(runtime, { requestId: 'request-b' });

  assert.equal(registry.releaseRequest(runtime, 'request-a'), true);
  assert.equal(registry.releaseRequest(runtime, 'request-a'), false);
  assertStale(() => registry.resolve({ instanceId: 'inst-a', requestId: 'request-a' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 'request-b' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
});

test('transport-local request ids can repeat but require an owner identifier to resolve', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeA, { requestId: 1 });
  registry.bind(runtimeB, { requestId: 1 });

  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 1 }), runtimeA);
  assert.equal(registry.resolve({ threadId: 'thr-b', requestId: 1 }), runtimeB);
  assertStale(() => registry.resolve({ requestId: 1 }));
});

test('binding a new active turn replaces the previous turn index', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-1' });
  registry.bind(runtime, { turnId: 'turn-2' });

  assertStale(() => registry.resolve({ turnId: 'turn-1' }));
  assert.equal(registry.resolve({ turnId: 'turn-2' }), runtime);
  assert.equal(registry.snapshot()[0].turnId, 'turn-2');
});

test('clearTurn removes only the expected active turn ownership', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-current' });

  assert.equal(registry.clearTurn(runtime, 'turn-stale'), false);
  assert.equal(registry.resolve({ instanceId: 'inst-a', turnId: 'turn-current' }), runtime);
  assert.equal(registry.clearTurn(runtime, 'turn-current'), true);
  assertStale(() => registry.resolve({ turnId: 'turn-current' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
});

test('transport-local turn ids can repeat but require a thread or instance to resolve', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeA, { turnId: 'turn-local-1' });
  registry.bind(runtimeB, { turnId: 'turn-local-1' });

  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-local-1' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', turnId: 'turn-local-1' }), runtimeB);
  assertStale(() => registry.resolve({ turnId: 'turn-local-1' }));
});

test('a runtime cannot be rebound to a different instance or thread', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });

  assertStale(() => registry.register(runtime, { instanceId: 'inst-b' }));
  assertStale(() => registry.bind(runtime, { threadId: 'thr-b' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
  assertStale(() => registry.resolve({ instanceId: 'inst-b' }));
  assertStale(() => registry.resolve({ threadId: 'thr-b' }));
});

test('release removes every index owned by a runtime', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-a', requestId: 'req-a' });
  registry.bind(runtime, { requestId: 'req-b' });

  assert.equal(registry.release(runtime), true);
  assert.equal(registry.release(runtime), false);
  assert.deepEqual(registry.snapshot(), []);
  for (const target of [
    { instanceId: 'inst-a' },
    { threadId: 'thr-a' },
    { turnId: 'turn-a' },
    { requestId: 'req-a' },
    { requestId: 'req-b' },
  ]) {
    assertStale(() => registry.resolve(target));
  }
});
