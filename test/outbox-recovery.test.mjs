import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDefinitelyUnattempted,
  isProvisionalInstanceOrphan,
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
