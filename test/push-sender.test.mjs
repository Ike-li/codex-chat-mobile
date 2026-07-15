import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushSender } from '../push-sender.js';

function requestDetails(subscription, payload) {
  return {
    endpoint: subscription.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(payload),
  };
}

function successfulRequest(capture, chunks = []) {
  return (options, onResponse) => {
    capture.options = options;
    const request = new EventEmitter();
    request.write = body => { capture.body = body; };
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 201;
      response.headers = { location: 'accepted' };
      response.destroy = error => response.emit('error', error);
      onResponse(response);
      for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
      response.emit('end');
    });
    return request;
  };
}

test('push sender rejects mixed public and private DNS answers before opening a socket', async () => {
  let requestCalls = 0;
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    request() { requestCalls += 1; },
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /non-public address/,
  );
  assert.equal(requestCalls, 0);
});

test('push sender pins the validated address while preserving TLS server identity', async () => {
  const capture = {};
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async hostname => {
      assert.equal(hostname, 'push.example');
      return [{ address: '93.184.216.34', family: 4 }];
    },
    request: successfulRequest(capture, ['ok']),
  });

  const result = await send({ endpoint: 'https://push.example/send?topic=one', keys: {} }, 'payload');
  assert.equal(result.statusCode, 201);
  assert.equal(result.body, 'ok');
  assert.equal(capture.options.hostname, 'push.example');
  assert.equal(capture.options.servername, 'push.example');
  assert.equal(capture.options.path, '/send?topic=one');
  assert.deepEqual(capture.body, Buffer.from('payload'));
  const pinned = await new Promise((resolve, reject) => {
    capture.options.lookup('push.example', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('push sender enforces one total timeout including DNS resolution', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => new Promise(() => {}),
    request: successfulRequest({}),
    timeoutMs: 10,
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /timed out/,
  );
});

test('push sender rejects an oversized response body', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    request: successfulRequest({}, ['12345']),
    maxResponseBytes: 4,
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /response exceeded/,
  );
});
