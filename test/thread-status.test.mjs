import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyThreadStatus,
  mergeThreadList,
  threadStatusPresentation,
  needResolutionLabel,
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

// 一张挂着的审批卡失去 pending 状态的原因有三种，此前界面一律写「已在其他设备处理」。
// 超时和被撤销时这句话是假的——用户会跑去另一台设备找根本不存在的操作记录。
// need.state 的取值见 needs-you-registry.js：pending / resolved / revoked / expired。
test('a stale approval card explains why it went away, instead of always blaming another device', () => {
  assert.equal(needResolutionLabel('resolved'), '已在其他设备处理');
  assert.equal(needResolutionLabel('expired'), '已超时失效');
  assert.equal(needResolutionLabel('revoked'), '已被撤销');
  // 未知状态不编造原因，只陈述结果。
  assert.equal(needResolutionLabel('something-new'), '已失效');
  assert.equal(needResolutionLabel(''), '已失效');
  assert.equal(needResolutionLabel(undefined), '已失效');
  // pending 还挂着，不该有结束文案。
  assert.equal(needResolutionLabel('pending'), '');
});
