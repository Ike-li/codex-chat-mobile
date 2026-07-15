import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferRecoveryEvent,
  completeRecovery,
  createRecoveryState,
} from '../public/js/recovery-state.js';

test('recovery accepts only its exact target and flushes live events above the snapshot watermark', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 9, epoch: 'epoch-a', instanceId: 'inst-b', sessionId: 'thr-b', type: 'text_delta',
  }), false);
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 10, epoch: 'epoch-a', instanceId: 'inst-a', sessionId: 'thr-a', type: 'text_delta',
  }), true);
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 12, epoch: 'epoch-a', instanceId: 'inst-a', sessionId: 'thr-a', type: 'result',
  }), true);

  const completed = completeRecovery(recovery, {
    gap: true,
    rebuilt: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    epoch: 'epoch-a',
    throughSeq: 10,
    snapshot: { source: 'thread/read', messages: [] },
  });
  assert.equal(completed.accepted, true);
  assert.deepEqual(completed.events.map(event => event.seq), [12]);

  const switched = completeRecovery(recovery, {
    gap: true,
    rebuilt: true,
    instanceId: 'inst-b',
    threadId: 'thr-a',
    epoch: 'epoch-a',
    throughSeq: 10,
    snapshot: { source: 'thread/read', messages: [] },
  });
  assert.equal(switched.accepted, false);
});
