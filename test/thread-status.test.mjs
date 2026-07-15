import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyThreadStatus,
  mergeThreadList,
  threadStatusPresentation,
} from '../public/js/thread-status.js';

test('thread status ignores a host update older than the status already rendered', () => {
  const threads = [{
    id: 'thr-revision',
    title: 'Revision protected',
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    statusRevision: 9,
  }];

  const updated = applyThreadStatus(threads, {
    threadId: 'thr-revision',
    status: { type: 'idle' },
    revision: 8,
  });

  assert.deepEqual(updated, threads);
});

test('thread list refresh preserves a newer host status revision', () => {
  const current = [{
    id: 'thr-refresh-race',
    title: 'Old title',
    status: { type: 'active', activeFlags: [] },
    statusRevision: 12,
  }];
  const refreshed = [{
    id: 'thr-refresh-race',
    title: 'Fresh title',
    status: { type: 'idle' },
    statusRevision: 11,
  }];

  assert.deepEqual(mergeThreadList(current, refreshed), [{
    id: 'thr-refresh-race',
    title: 'Fresh title',
    status: { type: 'active', activeFlags: [] },
    statusRevision: 12,
  }]);
});

test('thread status presentation distinguishes running, needs-you, error, and not-loaded', () => {
  assert.deepEqual(
    threadStatusPresentation({ type: 'active', activeFlags: [] }),
    { kind: 'running', label: 'running', active: true },
  );
  assert.deepEqual(
    threadStatusPresentation({ type: 'active', activeFlags: ['waitingOnUserInput'] }),
    { kind: 'needs-you', label: 'needs you', active: true },
  );
  assert.deepEqual(
    threadStatusPresentation({ type: 'systemError' }),
    { kind: 'error', label: 'error', active: false },
  );
  assert.deepEqual(
    threadStatusPresentation({ type: 'notLoaded' }),
    { kind: 'not-loaded', label: 'not loaded', active: false },
  );
});
