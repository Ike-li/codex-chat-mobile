#!/usr/bin/env node
// scripts/mock-codex-app-server.js —— Mock codex app-server for E2E testing.
// Simulates JSON-RPC 2.0 over stdio protocol without spawning real codex.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let threadId = 'mock_thread_001';
let turnCount = 0;
let activeTurnId = null;
const pendingApprovals = new Map(); // id → { resolve }
const threadHistory = new Map();

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ method, params }) + '\n');
}

function summarizeInputs(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(input => {
    if (input?.type === 'text') return input.text || '';
    if (input?.type === 'mention') return `@${input.name || input.path || 'file'}`;
    if (input?.type === 'skill') return `$${input.name || 'skill'}`;
    if (input?.type === 'localImage') return '[local image]';
    if (input?.type === 'image') return '[image URL]';
    return '';
  }).filter(Boolean).join(' ');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function simulateSlowTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  await sleep(6000);
  notify('item/agentMessage/delta', {
    threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: 'SLOW_TURN_OK',
  });
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: { type: 'agentMessage', id: `msg_${turnCount}`, text: 'SLOW_TURN_OK' },
  });
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'SLOW_TURN_OK',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', text: 'SLOW_TURN_OK' },
    ],
  });
}

async function simulateTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;

  if (input.includes('PRE_ACK_STREAM')) {
    notify('turn/started', {
      threadId: targetThreadId,
      turn: { id: turnId, status: 'inProgress' }
    });
  }

  // Simulate streaming response
  const responseText = input.includes('SCROLL_STREAM_FIXTURE')
    ? Array.from({ length: 90 }, (_, index) => `line-${String(index + 1).padStart(3, '0')} streaming transcript content`).join('\n')
    : input.includes('REAL_BROWSER_OK')
    ? 'REAL_BROWSER_OK'
    : input.includes('PRE_ACK_STREAM')
      ? 'PRE_ACK_STREAM_OK'
    : input.includes('MARKDOWN_FIXTURE')
      ? 'Here is **bold** and `code`.\n\n- item one\n- item two'
    : input.includes('/status')
      ? '当前没有活跃目标或正在执行的任务。'
      : `Mock response to: ${input}`;
  const streamDelayMs = input.includes('STREAMING_MARKDOWN_FIXTURE')
    ? 40
    : input.includes('SCROLL_STREAM_FIXTURE')
      ? 35
      : 10;
  const streamChunks = input.includes('SCROLL_STREAM_FIXTURE')
    ? responseText.split('\n').map((line, index, lines) => index < lines.length - 1 ? `${line}\n` : line)
    : [...responseText];

  // Stream text delta
  for (const char of streamChunks) {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: char
    });
    await sleep(streamDelayMs);
  }

  // Complete the message
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: { type: 'agentMessage', id: `msg_${turnCount}`, text: responseText }
  });

  // Complete the turn
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
  if (activeTurnId === turnId) activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText,
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', id: `msg_${turnCount}`, text: responseText },
    ],
  });
}

async function simulateTurnGroup(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const itemId = `cmd_group_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  for (const char of 'Before the tool.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_before_${turnCount}`, delta: char,
    });
    await sleep(15);
  }
  notify('item/started', {
    threadId: targetThreadId,
    turnId,
    item: { type: 'commandExecution', id: itemId, command: 'printf grouped', status: 'inProgress' },
  });
  notify('item/commandExecution/outputDelta', {
    threadId: targetThreadId, turnId, itemId, delta: 'grouped\n', stream: 'stdout',
  });
  notify('item/completed', {
    threadId: targetThreadId,
    turnId,
    item: { type: 'commandExecution', id: itemId, command: 'printf grouped', aggregatedOutput: 'grouped\n', exitCode: 0, status: 'completed' },
  });
  for (const char of 'After the tool.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_after_${turnCount}`, delta: char,
    });
    await sleep(15);
  }
  notify('turn/completed', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'Before the tool. After the tool.',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', text: 'Before the tool.' },
      { type: 'commandExecution', id: itemId, command: 'printf grouped', aggregatedOutput: 'grouped\n', exitCode: 0, status: 'completed' },
      { type: 'agentMessage', text: 'After the tool.' },
    ],
  });
}

async function simulateReasoningTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const reasoningItemId = `reasoning_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  for (const delta of ['Inspecting ', 'the current ', 'streaming ', 'layout.']) {
    notify('item/reasoning/summaryTextDelta', {
      threadId: targetThreadId, turnId, itemId: reasoningItemId, delta,
    });
    await sleep(140);
  }
  for (const char of 'Reasoning fixture complete.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: char,
    });
    await sleep(20);
  }
  notify('turn/completed', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'Reasoning fixture complete.',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'reasoning', summary: ['Inspecting the current streaming layout.'] },
      { type: 'agentMessage', text: 'Reasoning fixture complete.' },
    ],
  });
}

async function simulateApproval(command, targetThreadId = threadId) {
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
      threadId: targetThreadId, turnId, itemId: `cmd_${turnId}`,
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
      threadId: targetThreadId, turn: { id: turnId, error: { message: 'Approval declined by user' } }
    });
    return;
  }

  // Simulate command execution
  notify('item/started', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: '', exitCode: null, status: 'in_progress'
    }
  });

  await sleep(200);

  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: 'command approved and executed\n', exitCode: 0, status: 'completed'
    }
  });

  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
}

async function simulateFileChange(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'fileChange',
      id: `file_${turnId}`,
      status: 'completed',
      changes: [
        { path: 'src/example.js', kind: { type: 'add' }, diff: '+export const ok = true\n' },
        { path: 'src/readme.md', kind: { type: 'modify' }, diff: '-old\n+new\n' },
      ],
    },
  });
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
  threadHistory.set(targetThreadId, {
    input,
    responseText: '',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      {
        type: 'fileChange',
        id: `file_${turnId}`,
        status: 'completed',
        changes: [
          { path: 'src/example.js', kind: { type: 'add' }, diff: '+export const ok = true\n' },
          { path: 'src/readme.md', kind: { type: 'modify' }, diff: '-old\n+new\n' },
        ],
      },
    ],
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

      case 'thread/settings/update': {
        const mode = msg.params?.collaborationMode?.mode || 'default';
        respond(msg.id, {});
        notify('thread/settings/updated', {
          threadId: msg.params?.threadId || threadId,
          threadSettings: {
            collaborationMode: msg.params?.collaborationMode || { mode, settings: { developer_instructions: null } },
          },
        });
        break;
      }

      case 'thread/resume':
        threadId = msg.params?.threadId || threadId;
        respond(msg.id, {
          thread: { id: threadId, status: { type: 'idle' } }
        });
        break;

      case 'thread/read': {
        const requestedThreadId = msg.params?.threadId || threadId;
        const saved = threadHistory.get(requestedThreadId);
        respond(msg.id, {
          thread: {
            id: requestedThreadId,
            name: 'Mock thread',
            preview: saved?.input || '',
            cwd: process.cwd(),
            status: { type: 'idle' },
            turns: saved ? [{
              id: saved.turnId,
              items: saved.items || [
                { type: 'userMessage', content: [{ type: 'text', text: saved.input, text_elements: [] }] },
                { type: 'agentMessage', text: saved.responseText }
              ]
            }] : []
          }
        });
        break;
      }

      case 'thread/list':
        respond(msg.id, {
          data: [...threadHistory.keys()].map(id => ({
            id,
            name: 'Mock thread',
            preview: threadHistory.get(id)?.input || '',
            cwd: process.cwd(),
            createdAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
            status: { type: 'idle' }
          })),
          nextCursor: null
        });
        break;

      case 'turn/start': {
        const inputs = Array.isArray(msg.params?.input) ? msg.params.input : [];
        if (inputs.some(input => input?.type === 'text' && !Array.isArray(input.text_elements))) {
          process.stdout.write(JSON.stringify({
            id: msg.id,
            error: { code: -32602, message: 'text input requires text_elements' }
          }) + '\n');
          break;
        }
        const input = summarizeInputs(inputs);
        const targetThreadId = msg.params?.threadId || threadId;
        if (input.includes('PRE_ACK_STREAM')) {
          await simulateTurn(input, targetThreadId);
        }
        respond(msg.id, {
          turn: {
            id: `turn_${input.includes('PRE_ACK_STREAM') ? turnCount : turnCount + 1}`,
            status: 'inProgress'
          }
        });

        // Simulate async turn processing
        if (input.includes('PRE_ACK_STREAM')) {
          break;
        } else if (input.includes('REASONING_STREAM_FIXTURE')) {
          simulateReasoningTurn(input, targetThreadId).catch(() => {});
        } else if (input.includes('TURN_GROUP_FIXTURE')) {
          simulateTurnGroup(input, targetThreadId).catch(() => {});
        } else if (input.includes('SLOW_TURN')) {
          simulateSlowTurn(input, targetThreadId).catch(() => {});
        } else if (input.includes('FILE_CHANGE_FIXTURE')) {
          simulateFileChange(input, targetThreadId).catch(() => {});
        } else if (input.includes('approve') || input.includes('echo')) {
          simulateApproval(input, targetThreadId).catch(() => {});
        } else {
          simulateTurn(input, targetThreadId).catch(() => {});
        }
        break;
      }

      case 'turn/steer': {
        const inputs = Array.isArray(msg.params?.input) ? msg.params.input : [];
        const input = summarizeInputs(inputs);
        const turnId = msg.params?.expectedTurnId || activeTurnId || `turn_${turnCount}`;
        respond(msg.id, {
          turn: { id: turnId, status: 'inProgress' },
        });
        notify('item/agentMessage/delta', {
          threadId: msg.params?.threadId || threadId,
          turnId,
          itemId: `steer_${turnCount}`,
          delta: ` [steer:${input}]`,
        });
        break;
      }

      case 'turn/interrupt':
        activeTurnId = null;
        respond(msg.id, { ok: true });
        notify('turn/completed', {
          threadId, turn: { id: `turn_${turnCount}`, status: 'interrupted' }
        });
        break;

      case 'model/list':
        respond(msg.id, {
          data: [
            {
              id: 'gpt-5.6-sol',
              model: 'gpt-5.6-sol',
              displayName: 'GPT-5.6',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
                { reasoningEffort: 'xhigh', description: 'Extra high' },
                { reasoningEffort: 'max', description: 'Maximum' },
              ],
              serviceTiers: [
                { id: 'standard', name: 'Standard', description: 'Default speed' },
                { id: 'fast', name: 'Fast', description: 'Higher usage' },
              ],
              defaultServiceTier: 'standard',
              inputModalities: ['text'],
            },
            {
              id: 'gpt-5.5',
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
                { reasoningEffort: 'xhigh', description: 'Extra high' },
              ],
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text'],
            },
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
              ],
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text'],
            },
            {
              id: 'gpt-5.4-mini',
              model: 'gpt-5.4-mini',
              displayName: 'GPT-5.4-Mini',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'low',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
              ],
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text'],
            },
          ],
          nextCursor: null,
        });
        break;

      case 'modelProvider/capabilities/read':
        respond(msg.id, {
          namespaceTools: true,
          imageGeneration: false,
          webSearch: true,
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
