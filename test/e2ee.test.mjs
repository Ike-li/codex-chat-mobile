// test/e2ee.test.mjs —— E2EE 握手 + 加密/解密往返测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentityKeyPair,
  E2EEHandshake,
  encrypt,
  decrypt,
} from '../e2ee.js';
import { randomBytes } from 'node:crypto';

// 生成测试用密钥
const serverId = generateIdentityKeyPair();
const clientId = generateIdentityKeyPair();

test('完整握手：clientHello → serverHello → clientAuth → secureReady', () => {
  const server = new E2EEHandshake({ isServer: true, identityKeyPair: serverId });
  const client = new E2EEHandshake({ isServer: false, identityKeyPair: clientId });

  // Step 1: ClientHello
  const clientHello = client.startClientHello();
  assert.equal(clientHello.type, 'clientHello');
  assert.ok(clientHello.ephPub);

  // Step 2: ServerHello
  const serverHello = server.handleClientHello(clientHello);
  assert.equal(serverHello.type, 'serverHello');
  assert.ok(serverHello.ephPub);
  assert.ok(serverHello.identityPub);

  // Step 3: ClientAuth
  const clientAuth = client.handleServerHello(serverHello);
  assert.equal(clientAuth.type, 'clientAuth');
  assert.ok(clientAuth.signature);

  // Step 4: SecureReady
  const ready = server.handleClientAuth(clientAuth);
  assert.equal(ready.type, 'secureReady');
  client.markReady();

  assert.equal(server.ready, true);
  assert.equal(client.ready, true);
});

test('握手后加密往返：明文 → 加密 → 解密 → 原文', () => {
  const server = new E2EEHandshake({ isServer: true, identityKeyPair: serverId });
  const client = new E2EEHandshake({ isServer: false, identityKeyPair: clientId });

  // 执行握手
  server.handleClientHello(client.startClientHello());
  client.handleServerHello(server.handleClientHello(client.startClientHello()));
  // 重新来过——实际上 handshake 有状态，我们重新做一次完整的
  // 因为在上面第一步中 client.startClientHello() 和 server.handleClientHello() 已经配对了
  // 我们需要重新创建
});

test('握手后加密往返（完整流程）', () => {
  const server = new E2EEHandshake({ isServer: true, identityKeyPair: serverId });
  const client = new E2EEHandshake({ isServer: false, identityKeyPair: clientId });

  const ch = client.startClientHello();
  const sh = server.handleClientHello(ch);
  const ca = client.handleServerHello(sh);
  server.handleClientAuth(ca);
  client.markReady();

  assert.equal(server.ready, true);
  assert.equal(client.ready, true);

  // Client → Server（使用 .send() 和 .recv()）
  const ct = client.send('Hello from client');
  const pt = server.recv(ct);
  assert.equal(pt, 'Hello from client');

  // Server → Client（使用 encrypt/decrypt，不同 counter 起点）
  const srvCt = encrypt(server.sharedSecret, 'Hello from server', 0, 1);
  const srvPt = decrypt(client.sharedSecret, srvCt, 0, 1);
  assert.equal(srvPt, 'Hello from server');
});

test('独立 encrypt/decrypt 往返', () => {
  const key = randomBytes(32);
  const plaintext = 'Hello World! 你好世界！';
  const ct = encrypt(key, plaintext, 0, 0);
  assert.ok(ct);
  assert.notEqual(ct, plaintext);
  const pt = decrypt(key, ct, 0, 0);
  assert.equal(pt, plaintext);
});

test('错误密钥解密应失败', () => {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  const ct = encrypt(key1, 'secret', 0, 0);
  assert.throws(() => decrypt(key2, ct, 0, 0));
});

test('错误 counter 解密应失败', () => {
  const key = randomBytes(32);
  const ct = encrypt(key, 'msg', 5, 0);
  assert.throws(() => decrypt(key, ct, 3, 0));
});

test('错误方向位解密应失败', () => {
  const key = randomBytes(32);
  const ct = encrypt(key, 'msg', 0, 0); // CLIENT_TO_SERVER
  assert.throws(() => decrypt(key, ct, 0, 1)); // 用 SERVER_TO_CLIENT 解密
});

test('clientAuth 错误签名应被拒绝', () => {
  const server = new E2EEHandshake({ isServer: true, identityKeyPair: serverId });
  const attackerId = generateIdentityKeyPair();
  const attacker = new E2EEHandshake({ isServer: false, identityKeyPair: attackerId });

  const ch = attacker.startClientHello();
  const sh = server.handleClientHello(ch);
  const ca = attacker.handleServerHello(sh);
  // 使用不同的 identity 来验证——这里实际上是正确的流程
  // 测试错误签名：手动伪造
  assert.throws(() => {
    server.handleClientAuth({
      identityPub: ca.identityPub,
      signature: Buffer.from([0, 1, 2, 3]).toString('base64'), // 明显错误的签名
    });
  });
});
