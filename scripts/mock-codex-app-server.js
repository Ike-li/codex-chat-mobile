#!/usr/bin/env node
// scripts/mock-codex-app-server.js —— Mock codex app-server for E2E testing.
// Simulates JSON-RPC 2.0 over stdio protocol without spawning real codex.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let threadId = 'mock_thread_001';
let turnCount = 0;
const pendingApprovals = new Map(); // id → { resolve }

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ method, params }) + '\n');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function simulateTurn(input) {
  turnCount++;
  const turnId = `turn_${turnCount}`;

  // Simulate streaming response
  const responseText = input.includes('REAL_BROWSER_OK')
    ? 'REAL_BROWSER_OK'
    : input.includes('/status')
      ? '当前没有活跃目标或正在执行的任务。'
      : `Mock response to: ${input}`;

  // Stream text delta
  for (const char of responseText) {
    notify('item/agentMessage/delta', {
      threadId, turnId, itemId: `msg_${turnCount}`, delta: char
    });
    await sleep(10);
  }

  // Complete the message
  notify('item/completed', {
    threadId, turnId,
    item: { type: 'agentMessage', id: `msg_${turnCount}`, text: responseText }
  });

  // Complete the turn
  notify('turn/completed', {
    threadId, turn: { id: turnId, status: 'completed' }
  });
}

async function simulateApproval(command) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const approvalId = turnCount + 100;

  // Send approval request as a server→client request (has id)
  const requestPromise = new Promise(resolve => {
    pendingApprovals.set(approvalId, { resolve });
  });

  process.stdout.write(JSON.stringify({
    method: 'item/commandExecution/requestApproval',
    id: approvalId,
    params: {
      threadId, turnId, itemId: `cmd_${turnId}`,
      command,
      cwd: '/tmp/mock-workdir',
      reason: 'needs execution',
      availableDecisions: ['accept', 'decline']
    }
  }) + '\n');

  // Wait for client response (with timeout)
  const timeout = setTimeout(() => {
    if (pendingApprovals.has(approvalId)) {
      pendingApprovals.get(approvalId).resolve({ decision: 'decline' });
      pendingApprovals.delete(approvalId);
    }
  }, 10000);

  const { decision } = await requestPromise;
  clearTimeout(timeout);

  if (decision === 'decline') {
    // Turn failed - declined
    notify('turn/failed', {
      threadId, turn: { id: turnId, error: { message: 'Approval declined by user' } }
    });
    return;
  }

  // Simulate command execution
  notify('item/started', {
    threadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: '', exitCode: null, status: 'in_progress'
    }
  });

  await sleep(200);

  notify('item/completed', {
    threadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: 'command approved and executed\n', exitCode: 0, status: 'completed'
    }
  });

  notify('turn/completed', {
    threadId, turn: { id: turnId, status: 'completed' }
  });
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Handle approval responses (id + result, no method)
  if (msg.id !== undefined && msg.result && !msg.method) {
    const pending = pendingApprovals.get(msg.id);
    if (pending) {
      pending.resolve(msg.result);
      pendingApprovals.delete(msg.id);
      return;
    }
  }

  // Handle requests (have id)
  if (msg.id !== undefined && msg.method) {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, {
          serverInfo: { name: 'mock-codex-app-server', version: '0.1.0' },
          capabilities: {}
        });
        break;

      case 'thread/start':
        threadId = `mock_thread_${Date.now()}`;
        respond(msg.id, {
          thread: { id: threadId, status: 'active' }
        });
        break;

      case 'thread/resume':
        respond(msg.id, {
          thread: { id: msg.params?.threadId || threadId, status: 'active' }
        });
        break;

      case 'turn/start': {
        const input = msg.params?.input?.[0]?.text || '';
        respond(msg.id, { status: 'inProgress' });

        // Simulate async turn processing
        if (input.includes('approve') || input.includes('echo')) {
          simulateApproval(input).catch(() => {});
        } else {
          simulateTurn(input).catch(() => {});
        }
        break;
      }

      case 'turn/interrupt':
        respond(msg.id, { ok: true });
        notify('turn/completed', {
          threadId, turn: { id: `turn_${turnCount}`, status: 'interrupted' }
        });
        break;

      default:
        respond(msg.id, {});
    }
  }

  // Handle notifications (no id)
  if (msg.method && msg.id === undefined) {
    // Client notifications like 'initialized' — acknowledge silently
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
