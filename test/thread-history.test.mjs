import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThreadHistoryMessages } from '../thread-history.js';

test('user and assistant items keep the existing text-only shape', () => {
  const messages = normalizeThreadHistoryMessages({
    turns: [{
      items: [
        {
          type: 'userMessage',
          content: [
            { type: 'text', text: 'hello from native thread' },
            { type: 'mention', name: 'README.md' },
            { type: 'skill', name: 'release' },
            { type: 'localImage' },
          ],
        },
        { type: 'agentMessage', text: 'hello from Codex app-server' },
      ],
    }],
  });
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello from native thread\n@README.md\n$release\n[Image]' },
    { role: 'assistant', content: 'hello from Codex app-server' },
  ]);
});

test('completed command, file-change, mcp, search and plan items become history cards', () => {
  const messages = normalizeThreadHistoryMessages({
    turns: [{
      items: [
        {
          type: 'commandExecution',
          command: 'ls',
          aggregatedOutput: 'ok\n',
          exitCode: 0,
          status: 'completed',
        },
        {
          type: 'fileChange',
          changes: [{ path: 'src/a.js', kind: { type: 'add' }, diff: '+a\n' }],
        },
        {
          type: 'mcpToolCall',
          serverName: 'github',
          toolName: 'search',
          arguments: { q: 'x' },
          result: 'found',
        },
        {
          type: 'webSearch',
          query: 'codex',
          results: [{ title: 'Docs', url: 'https://example.com', snippet: 'hi' }],
        },
        {
          type: 'plan',
          plan: [{ step: 'one', status: 'completed' }],
        },
        {
          type: 'reasoning',
          summary: 'thinking',
        },
      ],
    }],
  });
  assert.equal(messages[0].kind, 'command');
  assert.equal(messages[0].command, 'ls');
  assert.equal(messages[0].exitCode, 0);
  assert.equal(messages[1].kind, 'file_change');
  assert.equal(messages[1].files[0].path, 'src/a.js');
  assert.equal(messages[2].kind, 'mcp');
  assert.equal(messages[2].serverName, 'github');
  assert.equal(messages[3].kind, 'search');
  assert.equal(messages[3].query, 'codex');
  assert.equal(messages[4].kind, 'plan');
  assert.equal(messages[5].kind, 'reasoning');
  assert.equal(messages[5].text, 'thinking');
});

test('unknown completed items stay visible as raw cards', () => {
  const messages = normalizeThreadHistoryMessages({
    turns: [{ items: [{ type: 'mysteryBox', id: 'x', payload: { a: 1 } }] }],
  });
  assert.equal(messages[0].kind, 'raw');
  assert.equal(messages[0].item.type, 'mysteryBox');
});
