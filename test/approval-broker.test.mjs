import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../approval-broker.js';

function makeBroker(options = {}) {
  const events = [];
  const responses = [];
  const pendingApprovals = new Set();
  const broker = new ApprovalBroker({
    emit: (type, payload) => events.push({ type, payload }),
    respond: (approvalId, result) => responses.push({ approvalId, result }),
    pendingApprovals,
    ...options,
  });
  return { broker, events, responses, pendingApprovals };
}

const byType = (events, type) => events.filter(e => e.type === type);

test('commandExecution approval tolerates missing command cwd and reason', () => {
  const { broker, events, responses, pendingApprovals } = makeBroker();

  assert.equal(broker.handleRequest(11, 'item/commandExecution/requestApproval'), true);

  assert.deepEqual(responses, []);
  assert.equal(pendingApprovals.has(11), true);
  const approval = byType(events, 'approval_request').at(-1);
  assert.ok(approval);
  assert.equal(approval.payload.approvalId, 11);
  assert.equal(approval.payload.kind, 'item/commandExecution/requestApproval');
  assert.equal(approval.payload.command, null);
  assert.equal(approval.payload.cwd, null);
  assert.equal(approval.payload.reason, null);
  assert.deepEqual(approval.payload.availableDecisions, ['accept', 'decline']);
});

test('fileChange approval joins changes from the in-progress item cache and degrades on miss', () => {
  const { broker, events } = makeBroker();
  broker.registerItem({
    type: 'fileChange',
    id: 'item_file_1',
    changes: [
      { path: '/work/a.txt', kind: { type: 'add' }, diff: '+hello\n' },
      { path: '/work/b.txt', kind: 'modify', diff: '-old\n+new\n' },
    ],
  });

  assert.equal(broker.handleRequest(21, 'item/fileChange/requestApproval', {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'item_file_1',
    reason: 'review diff',
    grantRoot: '/work',
  }), true);

  let approval = byType(events, 'approval_request').at(-1);
  assert.equal(approval.payload.kind, 'item/fileChange/requestApproval');
  assert.equal(approval.payload.command, null);
  assert.equal(approval.payload.reason, 'review diff');
  assert.equal(approval.payload.grantRoot, '/work');
  assert.deepEqual(approval.payload.changes, [
    { path: '/work/a.txt', kind: 'add', diff: '+hello\n' },
    { path: '/work/b.txt', kind: 'modify', diff: '-old\n+new\n' },
  ]);

  assert.equal(broker.handleRequest(22, 'item/fileChange/requestApproval', {
    itemId: 'missing_item',
    reason: 'no cache',
    grantRoot: '/work',
  }), true);

  approval = byType(events, 'approval_request').at(-1);
  assert.equal(approval.payload.reason, 'no cache');
  assert.equal(approval.payload.grantRoot, '/work');
  assert.equal(approval.payload.changes, undefined);
});

test('permissions approval describes requested permissions and maps decisions to the permissions response model', () => {
  for (const [decision, expected] of [
    ['accept', { permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } }, scope: 'turn' }],
    ['acceptForSession', { permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } }, scope: 'session' }],
    ['decline', { permissions: {}, scope: 'turn' }],
  ]) {
    const { broker, events, responses } = makeBroker();
    assert.equal(broker.handleRequest(30, 'item/permissions/requestApproval', {
      threadId: 'thr',
      turnId: 'turn',
      itemId: 'perm_1',
      environmentId: 'env_1',
      cwd: '/work',
      reason: 'needs broader access',
      permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } },
    }), true);

    const approval = byType(events, 'approval_request').at(-1);
    assert.equal(approval.payload.kind, 'item/permissions/requestApproval');
    assert.equal(approval.payload.cwd, '/work');
    assert.equal(approval.payload.reason, 'needs broader access');
    assert.deepEqual(approval.payload.permissions, { network: { allow: true }, fileSystem: { write: ['/work'] } });

    assert.equal(broker.respondApproval(30, decision), true);
    assert.deepEqual(responses.at(-1), { approvalId: 30, result: expected });
  }
});

test('requestUserInput emits user_input_request and returns answers by question id', () => {
  const { broker, events, responses } = makeBroker();
  assert.equal(broker.handleRequest(40, 'item/tool/requestUserInput', {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'tool_input_1',
    questions: [{
      id: 'q1',
      header: 'Choice',
      question: 'Which branch?',
      isOther: false,
      isSecret: false,
      options: [{ label: 'main', description: 'Use main branch' }],
    }],
    autoResolutionMs: 1500,
  }), true);

  const request = byType(events, 'user_input_request').at(-1);
  assert.ok(request);
  assert.equal(request.payload.approvalId, 40);
  assert.equal(request.payload.kind, 'item/tool/requestUserInput');
  assert.equal(request.payload.autoResolutionMs, 1500);
  assert.deepEqual(request.payload.questions, [{
    id: 'q1',
    header: 'Choice',
    question: 'Which branch?',
    isOther: false,
    isSecret: false,
    options: [{ label: 'main', description: 'Use main branch' }],
  }]);

  assert.equal(broker.respondApproval(40, null, { answers: { q1: ['main'] } }), true);
  assert.deepEqual(responses.at(-1), {
    approvalId: 40,
    result: { answers: { q1: { answers: ['main'] } } },
  });
});

test('v1 applyPatchApproval and execCommandApproval map mobile decisions to ReviewDecision strings', () => {
  for (const method of ['applyPatchApproval', 'execCommandApproval']) {
    for (const [mobileDecision, reviewDecision] of [
      ['accept', 'approved'],
      ['acceptForSession', 'approved_for_session'],
      ['decline', 'denied'],
      ['cancel', 'abort'],
    ]) {
      const { broker, events, responses } = makeBroker();
      const params = method === 'applyPatchApproval'
        ? {
            conversationId: 'thr',
            callId: 'patch_call',
            fileChanges: { '/work/a.txt': { type: 'add', diff: '+a\n' } },
            reason: 'apply patch',
            grantRoot: '/work',
          }
        : {
            conversationId: 'thr',
            callId: 'exec_call',
            approvalId: 'legacy_exec',
            command: ['npm', 'test'],
            cwd: '/work',
            reason: 'run tests',
            parsedCmd: { name: 'npm' },
          };

      assert.equal(broker.handleRequest(50, method, params), true);
      const approval = byType(events, 'approval_request').at(-1);
      assert.equal(approval.payload.kind, method);
      if (method === 'applyPatchApproval') {
        assert.deepEqual(approval.payload.changes, [{ path: '/work/a.txt', kind: 'add', diff: '+a\n' }]);
      } else {
        assert.equal(approval.payload.command, 'npm test');
      }

      assert.equal(broker.respondApproval(50, mobileDecision), true);
      assert.deepEqual(responses.at(-1), {
        approvalId: 50,
        result: { decision: reviewDecision },
      });
    }
  }
});

test('v2 command and fileChange approvals pass through decision strings exactly', () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) {
      const { broker, responses } = makeBroker();
      assert.equal(broker.handleRequest(60, method, { command: 'npm test', itemId: 'missing' }), true);
      assert.equal(broker.respondApproval(60, decision), true);
      assert.deepEqual(responses.at(-1), {
        approvalId: 60,
        result: { decision },
      });
    }
  }
});

test('resolved and repeated approval decisions are idempotent', () => {
  const { broker, events, responses, pendingApprovals } = makeBroker();
  assert.equal(broker.handleRequest(70, 'item/commandExecution/requestApproval', { command: 'npm test' }), true);
  assert.equal(broker.respondApproval(70, 'accept'), true);
  assert.equal(broker.respondApproval(70, 'decline'), false);
  assert.equal(responses.length, 1);
  assert.equal(pendingApprovals.has(70), false);

  assert.equal(broker.handleRequest(71, 'item/commandExecution/requestApproval', { command: 'npm test' }), true);
  assert.equal(broker.handleResolved({ requestId: '71', threadId: 'thr' }), 71);
  assert.equal(broker.respondApproval(71, 'accept'), false);
  assert.equal(responses.length, 1);

  const revoked = byType(events, 'approval_revoked').at(-1);
  assert.equal(revoked.payload.approvalId, 71);
  assert.equal(revoked.payload.requestId, '71');
  assert.equal(revoked.payload.threadId, 'thr');
  assert.equal(broker.handleResolved({ requestId: '71', threadId: 'thr' }), null);
});

test('approval audit is owner-only and records metadata without commands, questions, or answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-broker-'));
  const auditPath = join(dir, 'approval-audit.jsonl');
  try {
    const { broker } = makeBroker({ auditPath });
    assert.equal(broker.handleRequest(80, 'item/commandExecution/requestApproval', {
      command: 'printf command-secret',
      cwd: '/private/work-secret',
      reason: 'reason-secret',
    }), true);
    assert.equal(broker.respondApproval(80, 'decline'), true);
    assert.equal(broker.handleRequest(81, 'item/tool/requestUserInput', {
      questions: [{ id: 'secret-q', question: 'question-secret', isSecret: true }],
    }), true);
    assert.equal(broker.respondApproval(81, null, {
      answers: { 'secret-q': ['answer-secret'] },
    }), true);

    const mode = statSync(auditPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].event, 'request');
    assert.equal(lines[0].approvalId, 80);
    assert.equal(lines[0].method, 'item/commandExecution/requestApproval');
    assert.equal(lines[1].event, 'decision');
    assert.equal(lines[1].decision, 'decline');
    assert.equal(lines[2].questionCount, 1);
    assert.equal(lines[3].answerCount, 1);
    const audit = readFileSync(auditPath, 'utf8');
    for (const secret of [
      'command-secret',
      '/private/work-secret',
      'reason-secret',
      'question-secret',
      'answer-secret',
    ]) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declinePending emits a revocation so the gateway can close the need', () => {
  // clearPending 的其它调用点（abort、turn 完成、进程退出）都会顺带发一个能让
  // server.js 的 trackNeedsYou 关单的事件。declinePending 原本只回包不发事件，
  // 于是那条 needs-you 记录永远停在 pending：不参与 prune，还会推给每台重连的手机。
  const emitted = [];
  const responded = [];
  const broker = new ApprovalBroker({
    emit: (type, payload) => emitted.push({ type, payload }),
    respond: (id, result) => responded.push({ id, result }),
    pendingApprovals: new Set(),
  });

  broker.handleRequest(7, 'item/commandExecution/requestApproval', {
    threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', command: ['rm', '-rf', '/tmp/x'],
  });
  emitted.length = 0;

  broker.declinePending();
  assert.deepEqual(responded.map(entry => entry.result), [{ decision: 'decline' }]);
  assert.deepEqual(emitted.map(entry => entry.type), ['approval_revoked']);
  assert.equal(emitted[0].payload.approvalId, 7);
  assert.equal(broker.pendingApprovals.size, 0);
});
