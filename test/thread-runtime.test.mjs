import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadRuntime } from '../thread-runtime.js';
import { CodexAppServerSession } from '../agent-appserver.js';

test('ThreadRuntime is the production runtime with a legacy session compatibility export', () => {
  assert.equal(ThreadRuntime, CodexAppServerSession);
  const runtime = new ThreadRuntime({
    instanceId: 'inst-runtime',
    cwd: '/tmp/work',
    onEvent() {},
    onSessionId() {},
    onExit() {},
  });

  assert.equal(runtime.instanceId, 'inst-runtime');
  assert.equal(typeof runtime.send, 'function');
  assert.equal(typeof runtime.eventsSince, 'function');
  assert.equal(typeof runtime.statusPayload, 'function');
  runtime.dispose();
});
