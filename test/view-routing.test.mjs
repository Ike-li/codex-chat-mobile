import test from 'node:test';
import assert from 'node:assert/strict';

import { bindThreadFromEvent, eventMatchesTarget, withTarget } from '../public/js/view-routing.js';

test('eventMatchesTarget rejects a foreign thread event before rendering', () => {
  const target = { instanceId: 'inst_a', threadId: 'thr_a' };

  assert.equal(eventMatchesTarget({
    type: 'text_delta',
    instanceId: 'inst_b',
    sessionId: 'thr_b',
    payload: { text: 'foreign' },
  }, target), false);

  assert.equal(eventMatchesTarget({
    type: 'text_delta',
    instanceId: 'inst_a',
    sessionId: 'thr_a',
    payload: { text: 'current' },
  }, target), true);
});

test('eventMatchesTarget allows host-level control events for every view', () => {
  const target = { instanceId: 'inst_a', threadId: 'thr_a' };

  for (const type of [
    'device_status',
    'instances',
    'pending_devices',
    'status_line',
    'account_login',
    'account_updated',
    'rate_limits',
    'mcp_status',
    'skills_changed',
    'external_agent_config_import',
    'remote_control',
  ]) {
    assert.equal(eventMatchesTarget({ type, epoch: 'server', seq: 0, payload: {} }, target), true, type);
  }
});

test('eventMatchesTarget exposes host-scoped thread status to every view while isolating runtime status', () => {
  const targetA = { instanceId: 'inst_a', threadId: 'thr_a' };
  const targetB = { instanceId: 'inst_b', threadId: 'thr_b' };
  const hostStatus = {
    type: 'thread_status',
    instanceId: null,
    sessionId: null,
    payload: { scope: 'host', threadId: 'thr_external', status: 'active' },
  };

  assert.equal(eventMatchesTarget(hostStatus, targetA), true);
  assert.equal(eventMatchesTarget(hostStatus, targetB), true);

  const runtimeStatus = {
    type: 'thread_status',
    instanceId: 'inst_a',
    sessionId: 'thr_a',
    payload: { threadId: 'thr_a', status: 'active' },
  };
  assert.equal(eventMatchesTarget(runtimeStatus, targetA), true);
  assert.equal(eventMatchesTarget(runtimeStatus, targetB), false);
});

test('eventMatchesTarget rejects the retired session_list event', () => {
  assert.equal(eventMatchesTarget({
    type: 'session_list',
    epoch: 'server',
    seq: 0,
    payload: {},
  }, { instanceId: 'inst_a', threadId: 'thr_a' }), false);
});

test('eventMatchesTarget accepts a control-agent event addressed to the current thread', () => {
  const target = { instanceId: 'inst_live', threadId: 'thr_a' };

  assert.equal(eventMatchesTarget({
    type: 'compact',
    instanceId: 'inst_control',
    sessionId: null,
    payload: { threadId: 'thr_a' },
  }, target), true);
  assert.equal(eventMatchesTarget({
    type: 'compact',
    instanceId: 'inst_control',
    sessionId: null,
    payload: { threadId: 'thr_b' },
  }, target), false);
});

test('withTarget freezes the current instance and thread onto an outgoing command', () => {
  assert.deepEqual(withTarget(
    { text: 'hello' },
    { instanceId: 'inst_a', threadId: 'thr_a' },
  ), {
    text: 'hello',
    instanceId: 'inst_a',
    threadId: 'thr_a',
  });
});

test('bindThreadFromEvent binds only the matching provisional instance', () => {
  const provisional = { instanceId: 'inst_new', threadId: null };

  assert.deepEqual(bindThreadFromEvent(provisional, {
    instanceId: 'inst_foreign', sessionId: 'thr_foreign',
  }), provisional);
  assert.deepEqual(bindThreadFromEvent(provisional, {
    instanceId: 'inst_new', sessionId: 'thr_new',
  }), { instanceId: 'inst_new', threadId: 'thr_new' });
});

test('eventMatchesTarget allows the initial scoped init before a target is restored', () => {
  assert.equal(eventMatchesTarget({
    type: 'init',
    instanceId: 'inst_restored',
    sessionId: 'thr_restored',
    payload: { sessionId: 'thr_restored' },
  }, { instanceId: null, threadId: null }), true);
});
