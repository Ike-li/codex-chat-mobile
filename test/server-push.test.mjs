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
