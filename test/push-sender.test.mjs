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

// endpoint 校验是 SSRF 的第一道闸：Push 订阅的 endpoint 由浏览器提供，而浏览器
// 是我们信任边界之外的东西。一个被诱导的订阅可以让服务端去连内网地址、或者把
// 凭证塞进 URL 带出去。下面每一条都要在**开 socket 之前**拒绝。
function neverRequests() {
  return () => { throw new Error('request() 不该被调用 —— endpoint 校验应当先拒绝'); };
}

test('endpoint 不是合法 URL 时在开 socket 前拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'not a url', keys: {} }, 'p'), /endpoint is invalid/);
});

test('非 HTTPS 的 endpoint 一律拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  for (const endpoint of ['http://push.example/send', 'ftp://push.example/send']) {
    await assert.rejects(send({ endpoint, keys: {} }, 'p'), /public HTTPS hostname/);
  }
});

test('endpoint 里带用户名或密码时拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  for (const endpoint of [
    'https://user@push.example/send',
    'https://user:secret@push.example/send',
  ]) {
    await assert.rejects(send({ endpoint, keys: {} }, 'p'), /public HTTPS hostname/);
  }
});

test('endpoint 直接写成私网/环回地址时拒绝，且不开 socket', async () => {
  // 拒绝可能来自两处：主机名闸（parsePushEndpoint）或地址闸
  // （resolvePublicAddresses，IP 字面量走这条）。要紧的性质不是文案而是
  // 「没有连出去」，所以断言 request() 一次都没被调用。
  let requestCalls = 0;
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    // localhost 这类名字会真的走一次解析，生产环境解到 127.0.0.1 后被地址闸拒；
    // 这里照实模拟，而不是让桩抛错 —— 抛错会掩盖「解析后仍被正确拦下」这件事。
    resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
    request() { requestCalls += 1; },
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]', '10.0.0.5', '169.254.169.254']) {
    await assert.rejects(
      send({ endpoint: `https://${host}/send`, keys: {} }, 'p'),
      /public HTTPS hostname|non-public address/,
      `${host} 必须被拒`,
    );
  }
  assert.equal(requestCalls, 0, '任何一条都不该走到开连接这一步');
});

test('DNS 返回空结果时拒绝，而不是当作「没有限制」放行', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [],
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'https://push.example/send', keys: {} }, 'p'), /non-public address/);
});

test('DNS 返回字符串数组这种旧形态也要逐个校验', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => ['93.184.216.34', '192.168.1.1'],
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'https://push.example/send', keys: {} }, 'p'), /non-public address/);
});

test('endpoint 本身就是公网 IP 时跳过 DNS 但仍然校验', async () => {
  let resolved = 0;
  const capture = {};
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { resolved += 1; return []; },
    request: successfulRequest(capture),
  });
  const result = await send({ endpoint: 'https://93.184.216.34/send', keys: {} }, 'p');
  assert.equal(resolved, 0, 'IP 字面量不需要再过 DNS');
  assert.equal(result.statusCode, 201);
});
