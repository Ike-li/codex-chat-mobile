import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRequest, messageWirePayload } from '../public/js/message-request.js';

test('message requests get unique ids while retries preserve the original logical-thread payload', () => {
  const ids = ['req-one', 'req-two'];
  const options = {
    createId: () => ids.shift(),
    now: () => 1234,
  };
  const input = {
    text: 'same message',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    target: { instanceId: 'inst-volatile', threadId: 'thr-durable' },
  };

  const first = createMessageRequest(input, options);
  const second = createMessageRequest(input, options);

  assert.notEqual(first.clientRequestId, second.clientRequestId);
  assert.deepEqual(messageWirePayload(first), {
    clientRequestId: 'req-one',
    text: 'same message',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    threadId: 'thr-durable',
  });
  assert.deepEqual(messageWirePayload(first), messageWirePayload(first));
  assert.equal(first.createdAt, 1234);
  assert.equal(first.state, 'pending');
});

test('message requests persist structured input parts in the retry payload', () => {
  const request = createMessageRequest({
    text: 'use selected references',
    parts: [
      { kind: 'mention', name: 'server.js', path: '/tmp/work/server.js' },
      { kind: 'skill', name: 'release', path: '/tmp/work/.agents/skills/release/SKILL.md' },
    ],
    target: { threadId: 'thr-structured-input' },
  }, { createId: () => 'req-structured-input', now: () => 5678 });

  assert.deepEqual(messageWirePayload(request).parts, [
    { kind: 'mention', name: 'server.js', path: '/tmp/work/server.js' },
    { kind: 'skill', name: 'release', path: '/tmp/work/.agents/skills/release/SKILL.md' },
  ]);
});

test('message requests persist CLI turn overrides in the retry payload', () => {
  const request = createMessageRequest({
    text: 'use selected model',
    target: { threadId: 'thr-turn' },
    turn: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      serviceTier: 'fast',
    },
  }, { createId: () => 'req-turn', now: () => 9 });

  assert.deepEqual(messageWirePayload(request).turn, {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    serviceTier: 'fast',
  });
});
