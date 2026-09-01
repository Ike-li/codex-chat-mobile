import { test } from 'node:test';
import assert from 'node:assert/strict';

async function importServerWithoutStarting() {
  const prev = process.env.CODEX_SERVER_NO_START;
  process.env.CODEX_SERVER_NO_START = '1';
  try {
    return await import(`../server.js?test=${Date.now()}-${Math.random()}`);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SERVER_NO_START;
    else process.env.CODEX_SERVER_NO_START = prev;
  }
}

test('pushDecision sends approval and user input notifications but not revoked notifications', async () => {
  const { pushDecision } = await importServerWithoutStarting();

  assert.match(pushDecision({
    type: 'approval_request',
    payload: { kind: 'item/commandExecution/requestApproval', command: 'npm test', reason: 'run tests' },
  }).title, /待审批/);

  assert.match(pushDecision({
    type: 'user_input_request',
    payload: { questions: [{ question: 'Continue?' }] },
  }).title, /需要人到场/);

  assert.equal(pushDecision({ type: 'approval_revoked', payload: { approvalId: 1 } }), null);
});

test('approval push uses a stable needs-you deep link without exposing command text by default', async () => {
  const { pushDecision } = await importServerWithoutStarting();
  const notification = pushDecision({
    type: 'approval_request',
    sessionId: 'thr mobile/one',
    payload: {
      needId: 'need_abc123',
      approvalId: 42,
      command: 'rm -rf private-project',
    },
  });

  assert.equal(notification.tag, 'need:need_abc123');
  assert.deepEqual(notification.data, {
    needId: 'need_abc123',
    threadId: 'thr mobile/one',
    url: '/?thread=thr%20mobile%2Fone&need=need_abc123',
  });
  assert.doesNotMatch(notification.body, /private-project/);
});

// R-7 的缺口：此前只在待审批/需人到场/完成/出错时推送。codex 进程死掉是最需要人知道的
// 情形之一——任务停了，而手机上看到的还是「运行中」，不推的话用户会一直等一个不会来的
// 结果。只推真正的失败原因，status 事件本身很频繁，全推就是骚扰。
test('codex 进程退出要推送，普通状态变化不推', async () => {
  const { pushDecision } = await importServerWithoutStarting();

  for (const reason of ['process_exit', 'process_error']) {
    const decision = pushDecision({ type: 'status', payload: { reason, state: 'idle' } });
    assert.ok(decision, `${reason} 应当推送`);
    assert.match(decision.title, /Codex/);
    assert.match(decision.body, /退出|中断/);
  }

  for (const reason of ['turn_started', 'turn_completed', 'idle']) {
    assert.equal(pushDecision({ type: 'status', payload: { reason, state: 'running' } }), null, `${reason} 不该推送`);
  }
});
