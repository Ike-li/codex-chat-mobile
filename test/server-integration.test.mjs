import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as socketClient } from 'socket.io-client';
import webpush from 'web-push';

const ENV_KEYS = [
  'CODEX_SERVER_NO_START',
  'CODEX_DATA_DIR',
  'WORK_DIR',
  'WORK_DIRS',
  'PORT',
  'HOST',
  'AUTH_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'CODEX_BIN',
  'CODEX_FAKE_RPC_LOG',
  'CODEX_FAKE_SPAWN_LOG',
  'CODEX_ALLOW_REMOTE_IMAGES',
  'CODEX_SESSION_TTL_MS',
  'CODEX_ADMIN_ENABLED',
  'CODEX_ADMIN_UNLOCK_TTL_MS',
  'CODEX_ADMIN_UNLOCK_MAX_FAILURES',
  'CODEX_ADMIN_UNLOCK_WINDOW_MS',
  'CODEX_P3_EXPERIMENTAL',
  'CODEX_PUSH_MAX_SUBSCRIPTIONS',
  'CODEX_EVENT_BUFFER_CAP',
  'CODEX_ALLOWED_ORIGINS',
  'CODEX_TRUSTED_PROXY_IPS',
  'CODEX_ALLOW_INSECURE_REMOTE',
  'CODEX_AUTH_MAX_FAILURES',
  'CODEX_AUTH_WINDOW_MS',
  'CODEX_PENDING_DEVICE_LIMIT',
];

test('server lifecycle exposes HTTP and Socket.IO behavior without starting Codex', async () => {
  const fixture = await startIsolatedServer();
  try {
    const health = await fetch(`${fixture.url}/health`, {
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    const csp = health.headers.get('content-security-policy');
    assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.equal((await health.json()).status, 'ok');

    const vapid = await fetch(`${fixture.url}/push/vapid-public-key`);
    assert.equal(vapid.status, 503);
    assert.deepEqual(await vapid.json(), { error: 'push not configured' });

    const subscribe = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
      },
      body: JSON.stringify({ endpoint: 'https://push.example/sub' }),
    });
    assert.equal(subscribe.status, 503);

    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      const init = await waitForAgentEvent(socket, 'init');
      assert.equal(init.payload.cwd, fixture.workDir);
      assert.deepEqual(init.payload.workDirs, [fixture.workDir, fixture.altWorkDir]);

      const threadList = await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir });
      assert.equal(threadList.ok, true);
      assert.ok(Array.isArray(threadList.threads));

      const pendingDevices = await waitForAgentEvent(socket, 'pending_devices');
      assert.deepEqual(pendingDevices.payload.devices, []);

      socket.emit('user:message', { text: '   ' });
      const emptyMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(emptyMessage.payload.isError, true);
      assert.match(emptyMessage.payload.message, /消息为空/);

      socket.emit('user:message', { text: 'x'.repeat(50001) });
      const longMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(longMessage.payload.isError, true);
      assert.match(longMessage.payload.message, /消息过长/);

      const newAck = await emitWithAck(socket, 'session:new', { cwd: fixture.altWorkDir });
      assert.equal(newAck.ok, true);
      assert.ok(newAck.instanceId);
      assert.equal(newAck.threadId, null);
      assert.equal(newAck.cwd, fixture.altWorkDir);
      const switchedInit = await waitForAgentEvent(socket, 'init');
      assert.equal(switchedInit.payload.cwd, fixture.altWorkDir);

      const invalidFork = await emitWithAck(socket, 'session:fork', {});
      assert.equal(invalidFork.ok, false);
      assert.match(invalidFork.error, /没有可分叉/);

      const invalidCancel = await emitWithAck(socket, 'account:loginCancel', {});
      assert.equal(invalidCancel.ok, false);
      assert.match(invalidCancel.error, /无效登录任务/);

      const catchUp = await emitWithAck(socket, 'catch-up', { sessionId: 'missing-session', lastSeq: 0 });
      assert.equal(catchUp.replayed, 0);
      assert.equal(catchUp.gap, false);
      assert.equal(catchUp.errorCode, 'stale_target');
      assert.equal(catchUp.threadId, 'missing-session');

      socket.emit('user:interrupt');
      socket.emit('user:approval', { approvalId: 1, decision: 'decline' });
      socket.emit('session:switch', { instanceId: 'missing-instance' });
      socket.emit('user:approveDevice', { deviceId: '' });
      socket.emit('user:denyDevice', { deviceId: '' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('stopServer clears every maintenance interval created by startServer', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Map();
  const cleared = new Set();
  let fixture;

  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = originalSetInterval(callback, delay, ...args);
    intervals.set(handle, delay);
    return handle;
  };
  globalThis.clearInterval = handle => {
    if (intervals.has(handle)) cleared.add(handle);
    return originalClearInterval(handle);
  };

  try {
    fixture = await startIsolatedServer();
    await fixture.close();
    fixture = null;

    const maintenanceIntervals = [...intervals]
      .filter(([, delay]) => [4_000, 300_000, 3_600_000].includes(delay))
      .map(([handle]) => handle);
    assert.equal(maintenanceIntervals.length, 4);
    assert.deepEqual(
      maintenanceIntervals.filter(handle => !cleared.has(handle)),
      [],
      'stopServer must clear status, upload, auth-session, and failure-window intervals',
    );
  } finally {
    if (fixture) await fixture.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const handle of intervals.keys()) originalClearInterval(handle);
  }
});

test('push subscription rejects unauthenticated requests without persisting them', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  try {
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example/unauthorized',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    await fixture.close();
  }
});

test('push subscription rejects an authenticated but unapproved device', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  try {
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': 'device-not-approved',
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/unapproved',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'device_not_approved' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    await fixture.close();
  }
});

test('push subscription binds a sanitized subscription to the approved device', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-approved-push';
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const response = await fetch(`${fixture.url}/push/subscribe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': fixture.authToken,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          endpoint: 'https://push.example/approved',
          keys: { p256dh: 'public-key', auth: 'auth-secret' },
          deviceToken: 'attacker-controlled-device',
          privileged: true,
        }),
      });

      assert.equal(response.status, 200);
      const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].deviceToken, deviceToken);
      assert.equal(stored[0].endpoint, 'https://push.example/approved');
      assert.deepEqual(stored[0].keys, { p256dh: 'public-key', auth: 'auth-secret' });
      assert.equal(Object.hasOwn(stored[0], 'privileged'), false);
      assert.equal(Object.hasOwn(stored[0], 'createdAt'), true);
      assert.equal(Object.hasOwn(stored[0], 'updatedAt'), true);
      assert.equal(statSync(join(fixture.dataDir, 'push-subscriptions.json')).mode & 0o777, 0o600);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('push subscription reports a persistence failure instead of acknowledging success', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-persist-failure';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    mkdirSync(join(fixture.dataDir, 'push-subscriptions.json.tmp'));

    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/persist-failure',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'subscription_persist_failed' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('successful push subscription writes a redacted security audit record', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-audit-secret';
  const endpoint = 'https://push.example/audit-secret-endpoint';
  const p256dh = 'audit-public-key-secret';
  const auth = 'audit-auth-secret';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    });
    assert.equal(response.status, 200);

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"push_subscription"/);
    assert.match(audit, /"action":"subscribe"/);
    assert.match(audit, /"outcome":"success"/);
    for (const secret of [deviceToken, endpoint, p256dh, auth]) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('denying a device removes its bound push subscriptions', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const targetDevice = 'device-push-to-revoke';
  const controllerDevice = 'device-push-controller';
  let targetSocket;
  let controllerSocket;
  try {
    targetSocket = await connectSocket(fixture.url, fixture.authToken, targetDevice);
    await waitForAgentEvent(targetSocket, 'init');
    const subscribed = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': targetDevice,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/revoked-device',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });
    assert.equal(subscribed.status, 200);

    controllerSocket = await connectSocket(fixture.url, fixture.authToken, controllerDevice);
    await waitForAgentEvent(controllerSocket, 'init');
    const disconnected = once(targetSocket, 'disconnect');
    controllerSocket.emit('user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.deepEqual(stored, []);
  } finally {
    if (targetSocket?.connected) targetSocket.disconnect();
    if (controllerSocket?.connected) controllerSocket.disconnect();
    await fixture.close();
  }
});

test('a device replacing its push endpoint keeps only the latest subscription', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-endpoint-rotation';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    for (const endpoint of ['https://push.example/old', 'https://push.example/current']) {
      const response = await fetch(`${fixture.url}/push/subscribe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': fixture.authToken,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          endpoint,
          keys: { p256dh: 'public-key', auth: 'auth-secret' },
        }),
      });
      assert.equal(response.status, 200);
    }

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, deviceToken);
    assert.equal(stored[0].endpoint, 'https://push.example/current');
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('push subscription rejects a non-HTTPS endpoint without persisting it', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-invalid-endpoint';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'http://127.0.0.1/internal-service',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_subscription' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('a new bound push subscription drops legacy unbound records', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({
    vapid,
    initialPushSubscriptions: [{
      endpoint: 'https://push.example/legacy-unbound',
      keys: { p256dh: 'legacy-public-key', auth: 'legacy-auth-secret' },
    }],
  });
  const deviceToken = 'device-push-migration';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/current-bound',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });
    assert.equal(response.status, 200);

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, deviceToken);
    assert.equal(stored[0].endpoint, 'https://push.example/current-bound');
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('push subscription capacity rejects a new device without evicting existing bindings', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid, pushMaxSubscriptions: 1 });
  const firstDevice = 'device-push-capacity-first';
  const secondDevice = 'device-push-capacity-second';
  let firstSocket;
  let secondSocket;
  try {
    firstSocket = await connectSocket(fixture.url, fixture.authToken, firstDevice);
    secondSocket = await connectSocket(fixture.url, fixture.authToken, secondDevice);
    await waitForAgentEvent(firstSocket, 'init');
    await waitForAgentEvent(secondSocket, 'init');

    const subscribe = deviceToken => fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: `https://push.example/${deviceToken}`,
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal((await subscribe(firstDevice)).status, 200);
    const rejected = await subscribe(secondDevice);
    assert.equal(rejected.status, 429);
    assert.deepEqual(await rejected.json(), { error: 'subscription_limit' });

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, firstDevice);
  } finally {
    if (firstSocket?.connected) firstSocket.disconnect();
    if (secondSocket?.connected) secondSocket.disconnect();
    await fixture.close();
  }
});

test('push delivery skips a persisted subscription whose device is no longer trusted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-stale-push-delivery-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const vapid = webpush.generateVAPIDKeys();
  const delivered = [];
  const originalSendNotification = webpush.sendNotification;
  webpush.sendNotification = async (subscription, payload) => {
    delivered.push({ subscription, payload });
  };
  const staleDevice = 'device-stale-push-binding';
  let fixture;
  let socket;
  try {
    fixture = await startIsolatedServer({
      codexBin,
      rpcLog,
      vapid,
      initialPushSubscriptions: [{
        deviceToken: staleDevice,
        endpoint: 'https://push.example/stale-binding',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }],
    });
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-current-push-controller');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_stale_push',
      cwd: fixture.workDir,
      title: 'Stale push',
    });
    socket.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_stale_push',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.deepEqual(delivered, []);
    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.deepEqual(stored, []);
  } finally {
    webpush.sendNotification = originalSendNotification;
    socket?.disconnect();
    if (fixture) await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server routes a running user:message through turn/steer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-steer-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'start long run' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      socket.emit('user:message', { text: 'steer while running' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'steer_submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const steer = calls.find(call => call.method === 'turn/steer');
      assert.ok(steer, 'running user:message should call turn/steer');
      assert.deepEqual(steer.params, {
        threadId: 'thr_fake',
        input: [{ type: 'text', text: 'steer while running', text_elements: [] }],
        expectedTurnId: 'turn_fake',
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message requires a stable device identity when clientRequestId is present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-identity-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'must not use socket id for receipts',
        clientRequestId: 'req-without-device',
      });

      assert.equal(ack.ok, false);
      assert.equal(ack.errorCode, 'client_identity_required');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects an oversized clientRequestId before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-id-limit-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-valid-id-1');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'must not dispatch',
        clientRequestId: `req-${'x'.repeat(129)}`,
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_client_request_id',
        error: 'clientRequestId 格式无效',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('socket handshake rejects an oversized deviceToken', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: `device-${'x'.repeat(129)}`,
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'invalid_device_token');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket handshake rejects a trivially short deviceToken', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: 'a',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'invalid_device_token');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket handshake rejects an evil browser Origin even with a valid token', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token: fixture.authToken },
    extraHeaders: { Origin: 'https://evil.example' },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket authentication rate-limits repeated invalid tokens from one IP', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  const attempt = async () => {
    const socket = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: 'wrong-token' },
    });
    try {
      const [error] = await once(socket, 'connect_error');
      return error.message;
    } finally {
      socket.disconnect();
    }
  };
  try {
    assert.equal(await attempt(), 'unauthorized');
    assert.equal(await attempt(), 'unauthorized');
    assert.equal(await attempt(), 'rate_limited');

    const valid = await connectSocket(fixture.url, fixture.authToken);
    valid.disconnect();
  } finally {
    await fixture.close();
  }
});

test('failed socket authentication writes a redacted owner-only security audit record', async () => {
  const fixture = await startIsolatedServer();
  const attemptedToken = 'wrong-secret-must-not-be-logged';
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token: attemptedToken },
  });
  try {
    await once(socket, 'connect_error');
    const auditPath = join(fixture.dataDir, 'security-audit.jsonl');
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
    const audit = readFileSync(auditPath, 'utf8');
    assert.match(audit, /"event":"auth_failure"/);
    assert.match(audit, /"outcome":"denied"/);
    assert.match(audit, /"ip":"127\.0\.0\.1"/);
    assert.doesNotMatch(audit, new RegExp(attemptedToken));
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('authentication rate limiting emits one audit summary per identity window', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  try {
    const statuses = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${fixture.url}/auth/session`, {
        method: 'POST',
        headers: { 'x-auth-token': `wrong-token-${index}` },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 429, 429, 429, 429, 429, 429, 429, 429]);

    const records = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map(record => record.outcome), ['denied', 'denied', 'rate_limited']);
    assert.equal(records[2].attempts, 3);
    assert.equal(Number.isFinite(records[2].resetAt), true);
  } finally {
    await fixture.close();
  }
});

test('an HTTP auth session connects a socket and revocation disconnects and blocks replay', async () => {
  const fixture = await startIsolatedServer();
  const deviceToken = 'device-http-session-revoke';
  let socket;
  let replay;
  try {
    const created = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: {
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get('set-cookie');
    assert.match(cookie, /^codex_session=[^;]+;/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal((await created.json()).ok, true);

    socket = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie.split(';')[0] },
    });
    await once(socket, 'connect');
    const disconnected = once(socket, 'disconnect');

    const revoked = await fetch(`${fixture.url}/auth/session`, {
      method: 'DELETE',
      headers: { Cookie: cookie.split(';')[0] },
    });
    assert.equal(revoked.status, 204);
    await disconnected;

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie.split(';')[0] },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('HTTP APIs do not accept the static host token from a query string', async () => {
  const fixture = await startIsolatedServer();
  try {
    const response = await fetch(`${fixture.url}/health?token=${encodeURIComponent(fixture.authToken)}`);
    assert.equal(response.status, 401);
  } finally {
    await fixture.close();
  }
});

test('auth session issuance rate-limits repeated invalid host tokens', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  const attempt = () => fetch(`${fixture.url}/auth/session`, {
    method: 'POST',
    headers: {
      'x-auth-token': 'wrong-token',
      'x-device-token': 'device-session-rate-limit',
    },
  });
  try {
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 401);
    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { status: 'rate_limited' });
  } finally {
    await fixture.close();
  }
});

test('denying a device revokes all auth sessions bound to that device', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-session-deny-target';
  const cookie = await createAuthSessionCookie(fixture, targetDevice);
  let target;
  let controller;
  let replay;
  try {
    target = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    await once(target, 'connect');
    controller = await connectSocket(fixture.url, fixture.authToken, 'device-session-controller');
    const disconnected = once(target, 'disconnect');
    controller.emit('user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    target?.disconnect();
    controller?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('device denial fails closed and reports trusted-device persistence failure', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-deny-persist-failure-target';
  const cookie = await createAuthSessionCookie(fixture, targetDevice);
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([targetDevice]),
    { mode: 0o600 },
  );
  let target;
  let controller;
  let replay;
  try {
    target = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    await once(target, 'connect');
    controller = await connectSocket(fixture.url, fixture.authToken, 'device-deny-persist-failure-controller');
    mkdirSync(join(fixture.dataDir, 'trusted-devices.json.tmp'));

    const disconnected = once(target, 'disconnect');
    const result = await emitWithAck(controller, 'user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    assert.deepEqual(result, { ok: false, error: 'device_persist_failed' });
    const trusted = JSON.parse(readFileSync(join(fixture.dataDir, 'trusted-devices.json'), 'utf8'));
    assert.equal(trusted.includes(targetDevice), true);

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"action":"deny"/);
    assert.match(audit, /"outcome":"partial"/);
    assert.match(audit, /"reason":"persist_failed"/);
  } finally {
    target?.disconnect();
    controller?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('device denial writes an owner-only redacted security audit record', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-audit-deny-target-secret';
  const controller = await connectSocket(fixture.url, fixture.authToken, 'device-audit-controller');
  try {
    await waitForAgentEvent(controller, 'init');
    await waitForAgentEvent(controller, 'pending_devices');
    controller.emit('user:denyDevice', { deviceId: targetDevice });
    await waitForAgentEvent(controller, 'pending_devices');

    const auditPath = join(fixture.dataDir, 'security-audit.jsonl');
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
    const audit = readFileSync(auditPath, 'utf8');
    assert.match(audit, /"event":"device_access"/);
    assert.match(audit, /"action":"deny"/);
    assert.match(audit, /"outcome":"success"/);
    assert.match(audit, /"source":"socket"/);
    assert.doesNotMatch(audit, new RegExp(targetDevice));
  } finally {
    controller.disconnect();
    await fixture.close();
  }
});

test('device approval writes a redacted security audit record', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const targetDevice = 'device-audit-approve-target-secret';
  const controllerDevice = 'device-audit-approve-controller';
  const cookie = await createAuthSessionCookie(fixture, targetDevice, { forwardedProto: 'https' });
  const controllerCookie = await createAuthSessionCookie(fixture, controllerDevice, { forwardedProto: 'https' });
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([controllerDevice]),
    { mode: 0o600 },
  );
  const target = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken: targetDevice },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  target.__agentEvents = [];
  target.on('agent:event', event => target.__agentEvents.push(event));
  let controller;
  try {
    await once(target, 'connect');
    const pending = await waitForAgentEvent(target, 'device_status');
    assert.equal(pending.payload.status, 'pending');
    controller = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: controllerDevice },
      extraHeaders: {
        Cookie: controllerCookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    controller.__agentEvents = [];
    controller.on('agent:event', event => controller.__agentEvents.push(event));
    await once(controller, 'connect');
    await waitForAgentEvent(controller, 'init');

    controller.emit('user:approveDevice', { deviceId: targetDevice });
    const approved = await waitForAgentEvent(target, 'device_status');
    assert.equal(approved.payload.status, 'approved');

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"device_access"/);
    assert.match(audit, /"action":"approve"/);
    assert.match(audit, /"outcome":"success"/);
    assert.match(audit, /"source":"socket"/);
    assert.doesNotMatch(audit, new RegExp(targetDevice));
  } finally {
    target.disconnect();
    controller?.disconnect();
    await fixture.close();
  }
});

test('device approval stays locked when trusted-device persistence fails', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const targetDevice = 'device-approve-persist-failure-target';
  const controllerDevice = 'device-approve-persist-failure-controller';
  const cookie = await createAuthSessionCookie(fixture, targetDevice, { forwardedProto: 'https' });
  const controllerCookie = await createAuthSessionCookie(fixture, controllerDevice, { forwardedProto: 'https' });
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([controllerDevice]),
    { mode: 0o600 },
  );
  const target = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken: targetDevice },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  target.__agentEvents = [];
  target.on('agent:event', event => target.__agentEvents.push(event));
  let controller;
  try {
    await once(target, 'connect');
    const pending = await waitForAgentEvent(target, 'device_status');
    assert.equal(pending.payload.status, 'pending');

    controller = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: controllerDevice },
      extraHeaders: {
        Cookie: controllerCookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    controller.__agentEvents = [];
    controller.on('agent:event', event => controller.__agentEvents.push(event));
    await once(controller, 'connect');
    await waitForAgentEvent(controller, 'init');

    mkdirSync(join(fixture.dataDir, 'trusted-devices.json.tmp'));
    const result = await emitWithAck(controller, 'user:approveDevice', { deviceId: targetDevice });

    assert.deepEqual(result, { ok: false, error: 'device_persist_failed' });
    assert.equal(target.connected, true);
    assert.equal(
      target.__agentEvents.some(event => event?.type === 'device_status' && event.payload?.status === 'approved'),
      false,
    );
    const trusted = JSON.parse(readFileSync(join(fixture.dataDir, 'trusted-devices.json'), 'utf8'));
    assert.equal(trusted.includes(targetDevice), false);
  } finally {
    target.disconnect();
    controller?.disconnect();
    await fixture.close();
  }
});

test('atomically removing a trusted device externally disconnects it and revokes session replay', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const deviceToken = 'device-external-trust-revoke';
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  writeFileSync(trustedPath, JSON.stringify([deviceToken]), { mode: 0o600 });
  const socketOptions = {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  };
  const socket = socketClient(fixture.url, socketOptions);
  socket.__agentEvents = [];
  socket.on('agent:event', event => socket.__agentEvents.push(event));
  let replay;
  try {
    await once(socket, 'connect');
    await waitForAgentEvent(socket, 'init');
    const disconnected = once(socket, 'disconnect');

    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);

    let revocationTimeout;
    try {
      await Promise.race([
        disconnected,
        new Promise((_, reject) => {
          revocationTimeout = setTimeout(
            () => reject(new Error('trusted device revocation was not observed')),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(revocationTimeout);
    }

    replay = socketClient(fixture.url, socketOptions);
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('atomically removing an offline trusted device revokes its session and Push binding', async () => {
  const deviceToken = 'device-offline-external-revoke';
  const endpoint = 'https://push.example/offline-external-revoke';
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
    initialTrustedDevices: [deviceToken],
    initialPushSubscriptions: [{
      deviceToken,
      endpoint,
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
    }],
  });
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const pushPath = join(fixture.dataDir, 'push-subscriptions.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  let replay;
  try {
    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);

    await waitForCondition(
      () => JSON.parse(readFileSync(pushPath, 'utf8')).length === 0,
      'offline device Push binding was not revoked',
    );

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: {
        Cookie: cookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    replay?.disconnect();
    await fixture.close();
  }
});

test('external trust removal preserves an active loopback socket while revoking its session', async () => {
  const deviceToken = 'device-loopback-trust-file-removal';
  const fixture = await startIsolatedServer({
    initialTrustedDevices: [deviceToken],
    initialPushSubscriptions: [{
      deviceToken,
      endpoint: 'https://push.example/loopback-trust-file-removal',
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
    }],
  });
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const pushPath = join(fixture.dataDir, 'push-subscriptions.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken);
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: { Cookie: cookie },
  });
  let replay;
  try {
    await once(socket, 'connect');
    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);
    await waitForCondition(
      () => JSON.parse(readFileSync(pushPath, 'utf8')).length === 0,
      'loopback device Push binding was not revoked',
    );

    assert.equal(socket.connected, true);
    const catchUp = await emitWithAck(socket, 'catch-up', {
      instanceId: 'missing-instance',
      sessionId: 'missing-thread',
      lastSeq: 0,
    });
    assert.equal(catchUp.errorCode, 'stale_target');

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie },
    });
    const replayOutcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(replayOutcome.kind, 'error');
    assert.equal(replayOutcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('trusted-proxy HTTP requests fail closed unless forwarded as HTTPS', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  try {
    const insecure = await fetch(`${fixture.url}/health`, {
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(insecure.status, 426);
    assert.deepEqual(await insecure.json(), {
      status: 'secure_transport_required',
      errorCode: 'forwarded_proto_required',
    });

    const secure = await fetch(`${fixture.url}/health`, {
      headers: {
        'x-auth-token': fixture.authToken,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(secure.status, 200);
  } finally {
    await fixture.close();
  }
});

test('a device behind a trusted proxy is not auto-approved as loopback', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const deviceToken = 'device-proxied-pending';
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  socket.__agentEvents = [];
  socket.on('agent:event', event => socket.__agentEvents.push(event));
  try {
    await once(socket, 'connect');
    const status = await waitForAgentEvent(socket, 'device_status');
    assert.equal(status.payload.status, 'pending');
    assert.equal(status.payload.deviceId, deviceToken);
    assert.equal(socket.__agentEvents.some(event => event.type === 'init'), false);
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('a remote socket cannot use the static host token without an auth session', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: 'device-static-token-remote',
    },
    extraHeaders: {
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('remote device pairing rejects new devices after the pending capacity is reached', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
    pendingDeviceLimit: 1,
  });
  const firstDevice = 'device-pairing-first';
  const secondDevice = 'device-pairing-second';
  const firstCookie = await createAuthSessionCookie(fixture, firstDevice, { forwardedProto: 'https' });
  const secondCookie = await createAuthSessionCookie(fixture, secondDevice, { forwardedProto: 'https' });
  const optionsFor = (deviceToken, cookie) => ({
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  const first = socketClient(fixture.url, optionsFor(firstDevice, firstCookie));
  let second;
  try {
    await once(first, 'connect');
    second = socketClient(fixture.url, optionsFor(secondDevice, secondCookie));
    const outcome = await Promise.race([
      once(second, 'connect').then(() => ({ kind: 'connected' })),
      once(second, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'pairing_capacity');

    const pending = JSON.parse(readFileSync(join(fixture.dataDir, 'pending-devices.json'), 'utf8'));
    assert.deepEqual(pending.map(device => device.deviceToken), [firstDevice]);
  } finally {
    first.disconnect();
    second?.disconnect();
    await fixture.close();
  }
});

test('a remote auth session cannot be replayed without its bound deviceToken', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const cookie = await createAuthSessionCookie(fixture, 'device-session-bound-remote', { forwardedProto: 'https' });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {},
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('user:message acknowledges an invalid empty request instead of leaving its result unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-invalid-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-invalid-message');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: '   ',
        clientRequestId: 'req-invalid-empty',
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_message',
        error: '消息为空或格式无效',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message acknowledges invalid attachments with a non-retryable error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-invalid-attachment-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-invalid-attachment');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'invalid attachment',
        attachments: [{ name: 'empty.txt', mimeType: 'text/plain', data: '' }],
        clientRequestId: 'req-invalid-attachment',
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_attachments',
        error: '附件缺少数据',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message deterministically rejects a non-array attachments payload before fingerprinting', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-non-array-attachment');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'crafted attachment shape',
        attachments: { data: 'aA==' },
        clientRequestId: 'req-non-array-attachment',
      }, 500);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_attachments',
        error: '附件必须是数组',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('Socket.IO accepts a valid attachment whose wire payload exceeds the default 1 MB limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-large-wire-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-large-wire-message');
    try {
      await waitForAgentEvent(socket, 'init');
      const clientRequestId = 'req-large-wire-attachment';
      const data = Buffer.alloc(1024 * 1024, 0x61).toString('base64');
      assert.ok(data.length > 1_000_000);
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'valid large wire payload',
        attachments: [{ name: 'large.txt', mimeType: 'text/plain', data }],
        clientRequestId,
      }, 5000);

      assert.equal(ack.ok, true);
      assert.equal(ack.receipt.clientRequestId, clientRequestId);
      assert.equal(socket.connected, true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message acknowledges an oversized message with a non-retryable error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-too-long-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-message-too-long');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'x'.repeat(50001),
        clientRequestId: 'req-message-too-long',
      }, 250);

      assert.equal(ack.ok, false);
      assert.equal(ack.errorCode, 'message_too_long');
      assert.equal(ack.retryable, false);
      assert.match(ack.error, /上限 50000/);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message replays the original receipt and dispatches once when clientRequestId is retried after a lost ack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-idempotency-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-replay');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_receipt', cwd: fixture.workDir, title: 'Receipt',
      });
      const payload = {
        text: 'dispatch exactly once',
        clientRequestId: 'req-retry-after-lost-ack',
        instanceId: selected.instanceId,
        threadId: 'thr_receipt',
      };

      socket.emit('user:message', payload);
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      const retry = await emitWithAck(socket, 'user:message', payload);

      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.receipt.clientRequestId, payload.clientRequestId);
      assert.equal(retry.receipt.instanceId, selected.instanceId);
      assert.equal(retry.receipt.threadId, 'thr_receipt');
      assert.equal(retry.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].params.clientUserMessageId, payload.clientRequestId);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('message reconciliation finds a persisted client request after a gateway restart without replaying it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconcile-restart-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createPersistentReceiptCodexBin(root);
  const deviceToken = 'device-reconcile-after-restart';
  const clientRequestId = 'req-reconcile-after-restart';
  let firstGatewayEpoch;
  let firstFixture = null;
  let secondFixture = null;
  try {
    firstFixture = await startIsolatedServer({ codexBin, rpcLog });
    const firstSocket = await connectSocket(firstFixture.url, firstFixture.authToken, deviceToken);
    try {
      const init = await waitForAgentEvent(firstSocket, 'init');
      firstGatewayEpoch = init.payload.gatewayEpoch;
      assert.match(firstGatewayEpoch, /^[a-f0-9]{32}$/);
      const selected = await emitWithAck(firstSocket, 'thread:select', {
        threadId: 'thr_reconcile_restart',
        cwd: firstFixture.workDir,
      });
      firstSocket.emit('user:message', {
        text: 'do not replay after restart',
        clientRequestId,
        instanceId: selected.instanceId,
        threadId: 'thr_reconcile_restart',
      });
      await waitForAgentEventMatching(
        firstSocket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
    } finally {
      firstSocket.disconnect();
    }
    await firstFixture.close();
    firstFixture = null;

    secondFixture = await startIsolatedServer({ codexBin, rpcLog });
    const secondSocket = await connectSocket(secondFixture.url, secondFixture.authToken, deviceToken);
    try {
      const init = await waitForAgentEvent(secondSocket, 'init');
      assert.match(init.payload.gatewayEpoch, /^[a-f0-9]{32}$/);
      assert.notEqual(init.payload.gatewayEpoch, firstGatewayEpoch);

      const reconciliation = await emitWithAck(secondSocket, 'message:reconcile', {
        clientRequestId,
        threadId: 'thr_reconcile_restart',
        attemptedGatewayEpoch: firstGatewayEpoch,
        cwd: secondFixture.workDir,
      });

      assert.equal(reconciliation.ok, true);
      assert.equal(reconciliation.resolved, true);
      assert.equal(reconciliation.source, 'thread/read');
      assert.equal(reconciliation.gatewayEpoch, init.payload.gatewayEpoch);
      assert.deepEqual(reconciliation.receipt, {
        clientRequestId,
        threadId: 'thr_reconcile_restart',
        turnId: 'turn_reconcile_restart',
        itemId: 'user_reconcile_restart',
        state: 'submitted',
      });

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => (
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === clientRequestId
      ));
      assert.equal(dispatches.length, 1);
    } finally {
      secondSocket.disconnect();
    }
  } finally {
    if (firstFixture) await firstFixture.close();
    if (secondFixture) await secondFixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('message reconciliation uses the current gateway receipt before requiring a stable thread id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconcile-current-gateway-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const clientRequestId = 'req-reconcile-current-gateway';
  try {
    const socket = await connectSocket(
      fixture.url,
      fixture.authToken,
      'device-reconcile-current-gateway',
    );
    try {
      const init = await waitForAgentEvent(socket, 'init');
      socket.emit('user:message', {
        text: 'recover the missing acknowledgement',
        clientRequestId,
      });
      await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );

      const reconciliation = await emitWithAck(socket, 'message:reconcile', {
        clientRequestId,
        attemptedGatewayEpoch: init.payload.gatewayEpoch,
        cwd: fixture.workDir,
      });

      assert.equal(reconciliation.ok, true);
      assert.equal(reconciliation.resolved, true);
      assert.equal(reconciliation.source, 'receipt_ledger');
      assert.equal(reconciliation.receipt.clientRequestId, clientRequestId);
      assert.equal(reconciliation.receipt.threadId, 'thr_fake');
      assert.equal(reconciliation.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => (
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === clientRequestId
      ));
      assert.equal(dispatches.length, 1);
      assert.equal(calls.some(call => call.method === 'thread/read'), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message replays a receipt after reconnecting with the same device identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconnect-receipt-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const deviceToken = 'device-reconnect-receipt';
  try {
    const firstSocket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    let payload;
    try {
      await waitForAgentEvent(firstSocket, 'init');
      const selected = await emitWithAck(firstSocket, 'thread:select', {
        threadId: 'thr_reconnect_receipt', cwd: fixture.workDir, title: 'Reconnect receipt',
      });
      payload = {
        text: 'survive socket reconnect',
        clientRequestId: 'req-reconnect-receipt',
        instanceId: selected.instanceId,
        threadId: 'thr_reconnect_receipt',
      };
      firstSocket.emit('user:message', payload);
      await waitForAgentEventMatching(
        firstSocket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
    } finally {
      firstSocket.disconnect();
    }

    const secondSocket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    try {
      await waitForAgentEvent(secondSocket, 'init');
      const { instanceId: _volatileInstanceId, ...logicalRetry } = payload;
      const replay = await emitWithAck(secondSocket, 'user:message', logicalRetry);

      assert.equal(replay.ok, true);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.receipt.clientRequestId, payload.clientRequestId);
      assert.equal(replay.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call =>
        (call.method === 'turn/start' || call.method === 'turn/steer')
        && call.params?.clientUserMessageId === payload.clientRequestId
      );
      assert.equal(dispatches.length, 1);
    } finally {
      secondSocket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects a reused clientRequestId when the message payload changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-id-conflict-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-conflict');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_receipt_conflict', cwd: fixture.workDir, title: 'Receipt conflict',
      });
      const request = {
        text: 'original message',
        clientRequestId: 'req-conflicting-reuse',
        instanceId: selected.instanceId,
        threadId: 'thr_receipt_conflict',
      };

      socket.emit('user:message', request);
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      const conflict = await emitWithAck(socket, 'user:message', {
        ...request,
        text: 'different message with the same id',
      });

      assert.equal(conflict.ok, false);
      assert.equal(conflict.errorCode, 'request_id_conflict');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent identical user:message requests share one pending dispatch and attachment save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-single-flight-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-single-flight');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_single_flight', cwd: fixture.workDir, title: 'Single flight',
      });
      const payload = {
        text: 'send attachment once',
        attachments: [{
          name: 'once.txt',
          mimeType: 'text/plain',
          data: Buffer.from('one durable upload').toString('base64'),
        }],
        clientRequestId: 'req-single-flight',
        instanceId: selected.instanceId,
        threadId: 'thr_single_flight',
      };

      const results = await Promise.all([
        emitWithAck(socket, 'user:message', payload),
        emitWithAck(socket, 'user:message', payload),
      ]);

      assert.equal(results.every(result => result.ok), true);
      assert.equal(results.filter(result => result.duplicate === false).length, 1);
      assert.equal(results.filter(result => result.duplicate === true).length, 1);
      assert.deepEqual(results[0].receipt, results[1].receipt);
      assert.equal(readdirSync(join(fixture.workDir, '.ccm-uploads')).length, 1);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachment fingerprint uses decoded bytes instead of base64 spelling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-attachment-fingerprint-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-attachment-fingerprint');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_attachment_fingerprint', cwd: fixture.workDir, title: 'Attachment fingerprint',
      });
      const padded = Buffer.from('same file byte').toString('base64');
      assert.match(padded, /=+$/);
      const request = {
        text: 'same attachment bytes',
        attachments: [{ name: 'same.txt', mimeType: 'text/plain', data: padded }],
        clientRequestId: 'req-attachment-fingerprint',
        instanceId: selected.instanceId,
        threadId: 'thr_attachment_fingerprint',
      };

      const first = await emitWithAck(socket, 'user:message', request);
      const retry = await emitWithAck(socket, 'user:message', {
        ...request,
        attachments: [{
          ...request.attachments[0],
          data: padded.replace(/=+$/, ''),
        }],
      });

      assert.equal(first.ok, true);
      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(readdirSync(join(fixture.workDir, '.ccm-uploads')).length, 1);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message saves attachments inside the selected thread cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-attachment-target-cwd-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-attachment-cwd');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_attachment_alt_cwd',
        cwd: fixture.altWorkDir,
        title: 'Attachment alt cwd',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'read the attached file',
        attachments: [{
          name: 'target.txt',
          mimeType: 'text/plain',
          data: Buffer.from('target cwd content').toString('base64'),
        }],
        clientRequestId: 'req-attachment-alt-cwd',
        instanceId: selected.instanceId,
        threadId: 'thr_attachment_alt_cwd',
      });

      assert.equal(ack.ok, true);
      assert.equal(readdirSync(join(fixture.altWorkDir, '.ccm-uploads')).length, 1);
      assert.equal(existsSync(join(fixture.workDir, '.ccm-uploads')), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message sends a verified PNG upload as localImage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-local-image-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-local-image-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_local_image_input', cwd: fixture.workDir, title: 'Local image input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'inspect the pixel',
        attachments: [{
          name: 'pixel.png',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        }],
        clientRequestId: 'req-local-image-input',
        instanceId: selected.instanceId,
        threadId: 'thr_local_image_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input[0], {
        type: 'text', text: 'inspect the pixel', text_elements: [],
      });
      assert.equal(dispatch.params.input[1].type, 'localImage');
      assert.match(dispatch.params.input[1].path, /\.ccm-uploads\/.*pixel\.png$/);
      assert.equal(dispatch.params.input[1].path.includes('[附件]'), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message resolves a mention-only part before sending structured UserInput', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-mention-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const mentionedPath = join(fixture.workDir, 'mentioned.txt');
    writeFileSync(mentionedPath, 'mention me');
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-mention-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_mention_input', cwd: fixture.workDir, title: 'Mention input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: '',
        parts: [{ kind: 'mention', name: 'spoofed-name', path: mentionedPath }],
        clientRequestId: 'req-mention-input',
        instanceId: selected.instanceId,
        threadId: 'thr_mention_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input, [{
        type: 'mention',
        name: 'mentioned.txt',
        path: realpathSync(mentionedPath),
      }]);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message revalidates a selected skill against skills/list before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-skill-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const skillPath = join(fixture.workDir, '.agents', 'skills', 'release', 'SKILL.md');
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-skill-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_skill_input', cwd: fixture.workDir, title: 'Skill input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'use release skill',
        parts: [{ kind: 'skill', name: 'release', path: skillPath }],
        clientRequestId: 'req-skill-input',
        instanceId: selected.instanceId,
        threadId: 'thr_skill_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input, [
        { type: 'text', text: 'use release skill', text_elements: [] },
        { type: 'skill', name: 'release', path: skillPath },
      ]);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('queued user:message replays its later submitted receipt without dispatching twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-queued-receipt-transition-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createQueuedTransitionCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-queued-transition');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_queued_transition', cwd: fixture.workDir, title: 'Queued transition',
      });

      socket.emit('user:message', {
        text: 'block while turn id is unknown',
        instanceId: selected.instanceId,
        threadId: 'thr_queued_transition',
      });
      await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_started',
      );

      const payload = {
        text: 'queue and later submit once',
        clientRequestId: 'req-queued-transition',
        instanceId: selected.instanceId,
        threadId: 'thr_queued_transition',
      };
      const queued = await emitWithAck(socket, 'user:message', payload);
      assert.equal(queued.ok, true);
      assert.equal(queued.receipt.state, 'queued');

      await waitForAgentEventMatching(
        socket,
        'message_receipt',
        event => event.payload?.clientRequestId === payload.clientRequestId
          && event.payload?.state === 'submitted',
      );
      const retry = await emitWithAck(socket, 'user:message', payload);

      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.receipt.state, 'submitted');
      assert.equal(retry.receipt.turnId, 'turn_queued_transition');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const queuedDispatches = calls.filter(call =>
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === payload.clientRequestId
      );
      assert.equal(queuedDispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server keeps each socket message bound to its selected thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-thread-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_socket_a',
        cwd: fixture.workDir,
        title: 'Socket A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_socket_b',
        cwd: fixture.workDir,
        title: 'Socket B',
      });
      assert.equal(selectedA.ok, true);
      assert.equal(selectedB.ok, true);

      socketA.emit('user:message', {
        text: 'message from socket A',
        threadId: 'thr_socket_a',
        instanceId: selectedA.instanceId,
      });

      const submitted = await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.instanceId, selectedA.instanceId);
      assert.equal(submitted.sessionId, 'thr_socket_a');
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two sockets selecting the same thread share its single runtime owner', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_shared_owner',
        cwd: fixture.workDir,
        title: 'Shared owner',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_shared_owner',
        cwd: fixture.workDir,
        title: 'Shared owner',
      });

      assert.equal(selectedA.ok, true);
      assert.equal(selectedB.ok, true);
      assert.equal(selectedB.instanceId, selectedA.instanceId);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('two different thread runtimes share one app-server process on the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-shared-host-process-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const spawnLog = join(root, 'spawn.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, spawnLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_shared_host_a', cwd: fixture.workDir, title: 'Shared host A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_shared_host_b', cwd: fixture.workDir, title: 'Shared host B',
      });

      socketA.emit('user:message', {
        text: 'run on shared host A',
        instanceId: selectedA.instanceId,
        threadId: 'thr_shared_host_a',
      });
      socketB.emit('user:message', {
        text: 'run on shared host B',
        instanceId: selectedB.instanceId,
        threadId: 'thr_shared_host_b',
      });
      await waitForAgentEventMatching(socketA, 'status', event => event.payload?.reason === 'turn_submitted');
      await waitForAgentEventMatching(socketB, 'status', event => event.payload?.reason === 'turn_submitted');

      const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(spawns.length, 1);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared host keeps interleaved responses and notifications isolated by thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-shared-host-multiplex-test-'));
  const wireLog = join(root, 'wire.jsonl');
  const codexBin = createMultiplexFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog: wireLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    const seenA = [];
    const seenB = [];
    socketA.on('agent:event', event => seenA.push(event));
    socketB.on('agent:event', event => seenB.push(event));
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_mux_a', cwd: fixture.workDir, title: 'Mux A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_mux_b', cwd: fixture.workDir, title: 'Mux B',
      });
      seenA.length = 0;
      seenB.length = 0;

      const [sentA, sentB] = await Promise.all([
        emitWithAck(socketA, 'user:message', {
          text: 'start mux A', instanceId: selectedA.instanceId, threadId: 'thr_mux_a',
        }),
        emitWithAck(socketB, 'user:message', {
          text: 'start mux B', instanceId: selectedB.instanceId, threadId: 'thr_mux_b',
        }),
      ]);
      assert.equal(sentA.ok, true);
      assert.equal(sentB.ok, true);
      await waitForAgentEvent(socketA, 'result');
      await waitForAgentEvent(socketB, 'result');

      const privateA = seenA.filter(event => event?.seq > 0);
      const privateB = seenB.filter(event => event?.seq > 0);
      assert.equal(privateA.every(event => event.instanceId === selectedA.instanceId), true);
      assert.equal(privateB.every(event => event.instanceId === selectedB.instanceId), true);
      assert.deepEqual(
        privateA.filter(event => event.type === 'text_delta').map(event => event.payload.text),
        ['A-one', 'A-two'],
      );
      assert.deepEqual(
        privateB.filter(event => event.type === 'text_delta').map(event => event.payload.text),
        ['B-one', 'B-two'],
      );
      assert.equal(
        seenB.some(event => event?.type === 'instances'
          && event.payload?.instances?.some(instance =>
            instance.instanceId === selectedA.instanceId && instance.busy === true
          )),
        true,
      );
      assert.equal(
        privateB.some(event => event.type === 'thread_status' && event.instanceId === selectedA.instanceId),
        false,
      );

      const wire = readFileSync(wireLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(wire.filter(entry => entry.kind === 'spawn').length, 1);
      assert.equal(wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'initialize').length, 1);
      assert.equal(wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'initialized').length, 1);
      assert.deepEqual(
        wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'thread/resume')
          .map(entry => entry.frame.params.threadId).sort(),
        ['thr_mux_a', 'thr_mux_b'],
      );
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server sends thread events only to sockets viewing that thread instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-thread-events-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_events_a',
        cwd: fixture.workDir,
        title: 'Events A',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_events_b',
        cwd: fixture.workDir,
        title: 'Events B',
      });
      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;

      socketA.emit('user:message', {
        text: 'private event for socket A',
        threadId: 'thr_events_a',
        instanceId: selectedA.instanceId,
      });
      await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      await new Promise(resolve => setTimeout(resolve, 25));

      const foreignEvents = socketB.__agentEvents.filter(event =>
        event?.seq > 0 && event?.instanceId === selectedA.instanceId
      );
      assert.deepEqual(foreignEvents, []);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects a mismatched instance and thread target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-stale-thread-target-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_stale_a',
        cwd: fixture.workDir,
        title: 'Stale A',
      });
      const selectedB = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_current_b',
        cwd: fixture.workDir,
        title: 'Current B',
      });

      const rejected = await emitWithAck(socket, 'user:message', {
        text: 'must never execute',
        instanceId: selectedB.instanceId,
        threadId: 'thr_stale_a',
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.errorCode, 'stale_target');

      const calls = existsSync(rpcLog)
        ? readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
      const dispatched = calls.some(call =>
        (call.method === 'turn/start' || call.method === 'turn/steer')
        && call.params?.input?.some(item => item.text === 'must never execute')
      );
      assert.equal(dispatched, false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:interrupt stops only the explicitly targeted thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-interrupt-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_interrupt_a', cwd: fixture.workDir, title: 'Interrupt A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_interrupt_b', cwd: fixture.workDir, title: 'Interrupt B',
      });

      socketA.emit('user:message', {
        text: 'run A', instanceId: selectedA.instanceId, threadId: 'thr_interrupt_a',
      });
      socketB.emit('user:message', {
        text: 'run B', instanceId: selectedB.instanceId, threadId: 'thr_interrupt_b',
      });
      await waitForAgentEventMatching(socketA, 'status', event => event.payload?.reason === 'turn_submitted');
      await waitForAgentEventMatching(socketB, 'status', event => event.payload?.reason === 'turn_submitted');

      const interrupted = await emitWithAck(socketA, 'user:interrupt', {
        instanceId: selectedA.instanceId,
        threadId: 'thr_interrupt_a',
        turnId: 'turn_fake',
      });
      assert.equal(interrupted.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const interrupts = calls
        .filter(call => call.method === 'turn/interrupt')
        .map(call => call.params.threadId);
      assert.deepEqual(interrupts, ['thr_interrupt_a']);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:approval resolves only the explicitly targeted thread request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-approval-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_approval_a', cwd: fixture.workDir, title: 'Approval A',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_approval_b', cwd: fixture.workDir, title: 'Approval B',
      });

      socketA.emit('user:message', {
        text: 'request routed approval',
        instanceId: selectedA.instanceId,
        threadId: 'thr_approval_a',
      });
      const request = await waitForAgentEvent(socketA, 'approval_request');
      assert.equal(request.sessionId, 'thr_approval_a');

      const resolved = await emitWithAck(socketA, 'user:approval', {
        instanceId: selectedA.instanceId,
        threadId: 'thr_approval_a',
        turnId: 'turn_fake',
        itemId: 'item_approval',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(resolved.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const decisions = calls.filter(call => call.id === 9001 && call.result?.decision);
      assert.deepEqual(decisions, [{ id: 9001, result: { decision: 'accept' } }]);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy approval requests receive exact routing identities and resolve through needs-you', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-legacy-approval-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-legacy-approval');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_legacy_approval', cwd: fixture.workDir, title: 'Legacy approval',
    });
    socket.emit('user:message', {
      text: 'request legacy approval',
      instanceId: selected.instanceId,
      threadId: 'thr_legacy_approval',
    });
    const request = await waitForAgentEvent(socket, 'approval_request');
    assert.equal(request.payload.threadId, 'thr_legacy_approval');
    assert.equal(request.payload.turnId, 'turn_fake');
    assert.equal(request.payload.itemId, 'legacy_patch_call');

    const snapshot = await emitWithAck(socket, 'needs-you:snapshot', {});
    assert.equal(snapshot.needs.length, 1);
    const [need] = snapshot.needs;
    assert.deepEqual(need.target, {
      instanceId: selected.instanceId,
      threadId: 'thr_legacy_approval',
      turnId: 'turn_fake',
      itemId: 'legacy_patch_call',
      requestId: 9005,
    });

    const resolved = await emitWithAck(socket, 'user:approval', {
      needId: need.needId,
      ...need.target,
      approvalId: need.target.requestId,
      decision: 'accept',
    });
    assert.equal(resolved.ok, true);
    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(calls.find(call => call.id === 9005 && call.result), {
      id: 9005,
      result: { decision: 'approved' },
    });
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('needs-you resolution writes a redacted central security audit record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-audit-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const deviceToken = 'device-needs-audit-secret';
  const threadId = 'thr_needs_audit_secret';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId,
      cwd: fixture.workDir,
      title: 'Needs audit',
    });
    socket.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId,
    });
    const request = await waitForAgentEvent(socket, 'approval_request');
    const resolved = await emitWithAck(socket, 'user:approval', {
      instanceId: selected.instanceId,
      threadId,
      turnId: 'turn_fake',
      itemId: 'item_approval',
      approvalId: request.payload.approvalId,
      decision: 'accept',
    });
    assert.equal(resolved.ok, true);

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"need_resolution"/);
    assert.match(audit, /"outcome":"resolved"/);
    for (const secret of [deviceToken, threadId, 'pwd', 'request routed approval']) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    socket.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh device snapshots and resolves one pending need exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-snapshot-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let socketA;
  let socketB;
  try {
    socketA = await connectSocket(fixture.url, fixture.authToken, 'device-needs-origin');
    await waitForAgentEvent(socketA, 'init');
    const selected = await emitWithAck(socketA, 'thread:select', {
      threadId: 'thr_needs_snapshot', cwd: fixture.workDir, title: 'Needs snapshot',
    });
    socketA.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_snapshot',
    });
    await waitForAgentEvent(socketA, 'approval_request');

    socketB = await connectSocket(fixture.url, fixture.authToken, 'device-needs-fresh');
    await waitForAgentEvent(socketB, 'init');
    const snapshot = await emitWithAck(socketB, 'needs-you:snapshot', {});
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.needs.length, 1);
    const [need] = snapshot.needs;
    assert.equal(typeof need.needId, 'string');
    assert.equal(need.kind, 'approval');
    assert.equal(need.state, 'pending');
    assert.deepEqual(need.target, {
      instanceId: selected.instanceId,
      threadId: 'thr_needs_snapshot',
      turnId: 'turn_fake',
      itemId: 'item_approval',
      requestId: 9001,
    });

    const resolution = {
      needId: need.needId,
      ...need.target,
      approvalId: need.target.requestId,
      decision: 'accept',
    };
    const resolved = await emitWithAck(socketB, 'user:approval', resolution);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.duplicate, false);
    assert.equal(resolved.needId, need.needId);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.revision, 2);

    const changed = await waitForAgentEvent(socketB, 'needs_you_changed');
    assert.equal(changed.payload.need.needId, need.needId);
    assert.equal(changed.payload.need.state, 'resolved');

    const after = await emitWithAck(socketB, 'needs-you:snapshot', {});
    assert.deepEqual(after.needs, []);

    const duplicate = await emitWithAck(socketB, 'user:approval', resolution);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);

    const conflict = await emitWithAck(socketB, 'user:approval', {
      ...resolution,
      decision: 'decline',
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.errorCode, 'already_resolved');

    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const decisions = calls.filter(call => call.id === 9001 && call.result?.decision);
    assert.deepEqual(decisions, [{ id: 9001, result: { decision: 'accept' } }]);
  } finally {
    if (socketA?.connected) socketA.disconnect();
    if (socketB?.connected) socketB.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an upstream resolved request is removed from the needs-you snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-revoked-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-revoked');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_revoked', cwd: fixture.workDir, title: 'Needs revoked',
    });
    socket.emit('user:message', {
      text: 'request revoked approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_revoked',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEvent(socket, 'approval_revoked');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'revoked',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_revoked');

    const snapshot = await emitWithAck(socket, 'needs-you:snapshot', {});
    assert.deepEqual(snapshot.needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a terminal turn failure expires unresolved needs-you entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-expired-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-expired');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_expired', cwd: fixture.workDir, title: 'Needs expired',
    });
    socket.emit('user:message', {
      text: 'request failed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_expired',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_failed');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'expired',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_expired');
    assert.deepEqual((await emitWithAck(socket, 'needs-you:snapshot', {})).needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an app-server exit expires unresolved needs-you entries immediately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-process-exit-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-process-exit');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_process_exit', cwd: fixture.workDir, title: 'Needs process exit',
    });
    socket.emit('user:message', {
      text: 'request exited approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_process_exit',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'process_exit');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'expired',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_process_exit');
    assert.equal(changed.payload.need.payload.closeReason, 'process_exit');
    assert.deepEqual((await emitWithAck(socket, 'needs-you:snapshot', {})).needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:approval rejects a mismatched item without consuming the pending request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-approval-item-target-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_approval_item', cwd: fixture.workDir, title: 'Approval Item',
      });
      socket.emit('user:message', {
        text: 'request routed approval',
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
      });
      const request = await waitForAgentEvent(socket, 'approval_request');

      const mismatched = await emitWithAck(socket, 'user:approval', {
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
        turnId: 'turn_fake',
        itemId: 'wrong_item',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(mismatched.ok, false);
      assert.equal(mismatched.errorCode, 'stale_target');

      const resolved = await emitWithAck(socket, 'user:approval', {
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
        turnId: 'turn_fake',
        itemId: 'item_approval',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(resolved.ok, true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session:switch changes only that socket fallback target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-switch-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const firstA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_switch_a', cwd: fixture.workDir, title: 'Switch A',
      });
      await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_switch_a2', cwd: fixture.workDir, title: 'Switch A2',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_switch_b', cwd: fixture.workDir, title: 'Switch B',
      });

      const switched = await emitWithAck(socketA, 'session:switch', {
        instanceId: firstA.instanceId,
      });
      assert.equal(switched.ok, true);
      assert.equal(switched.instanceId, firstA.instanceId);

      socketA.emit('user:message', { text: 'legacy socket-targeted message' });
      const submitted = await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.sessionId, 'thr_switch_a');
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session:new returns and binds a provisional instance to the requesting socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-new-session-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const created = await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      assert.equal(created.ok, true);
      assert.ok(created.instanceId);
      assert.equal(created.threadId, null);

      socket.emit('user:message', { text: 'first provisional message' });
      const submitted = await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.instanceId, created.instanceId);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisional instance events stay private before thread/start returns an id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-provisional-event-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const created = await emitWithAck(socketA, 'session:new', { cwd: fixture.workDir });
      assert.equal(created.ok, true);
      assert.equal(created.threadId, null);

      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;
      socketA.emit('user:message', {
        text: 'first private provisional message',
        instanceId: created.instanceId,
      });
      await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      await new Promise(resolve => setTimeout(resolve, 25));

      const leaked = socketB.__agentEvents.filter(event =>
        event?.seq > 0 && event?.instanceId === created.instanceId
      );
      assert.deepEqual(leaked, []);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread selection does not overwrite another socket view state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-view-state-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_view_a', cwd: fixture.workDir, title: 'View A',
      });
      await new Promise(resolve => setTimeout(resolve, 25));

      const foreignInit = socketB.__agentEvents.find(event =>
        event?.type === 'init' && event?.payload?.sessionId === 'thr_view_a'
      );
      assert.equal(foreignInit, undefined);
      const latestInstances = socketB.__agentEvents
        .filter(event => event?.type === 'instances')
        .at(-1);
      assert.notEqual(latestInstances?.payload?.viewingInstanceId, selectedA.instanceId);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread selection acknowledges the target before emitting its scoped init', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-select-order-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const order = [];
      const onEvent = event => {
        if (event?.type === 'init' && event?.payload?.sessionId === 'thr_ordered') order.push('init');
      };
      socket.on('agent:event', onEvent);
      await new Promise((resolve, reject) => {
        socket.timeout(5000).emit('thread:select', {
          threadId: 'thr_ordered', cwd: fixture.workDir, title: 'Ordered',
        }, (err, ack) => {
          if (err) return reject(err);
          assert.equal(ack.ok, true);
          order.push('ack');
          resolve();
        });
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      socket.off('agent:event', onEvent);
      assert.deepEqual(order.slice(0, 2), ['ack', 'init']);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('host thread status reaches every approved device without loading that thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-host-thread-status-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createExternalThreadStatusCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let first;
  let second;
  try {
    first = await connectSocket(fixture.url, fixture.authToken, 'device-host-status-first');
    second = await connectSocket(fixture.url, fixture.authToken, 'device-host-status-second');
    await waitForAgentEvent(first, 'init');
    await waitForAgentEvent(second, 'init');

    const firstStatus = waitForAgentEventMatching(first, 'thread_status', event => (
      event.payload?.scope === 'host' && event.payload?.threadId === 'thr_external_status'
    ));
    const secondStatus = waitForAgentEventMatching(second, 'thread_status', event => (
      event.payload?.scope === 'host' && event.payload?.threadId === 'thr_external_status'
    ));
    const list = await emitWithAck(first, 'thread:list', { cwd: fixture.workDir });
    const [eventA, eventB] = await Promise.all([firstStatus, secondStatus]);

    assert.equal(list.ok, true);
    assert.deepEqual(list.threads[0].status, { type: 'active', activeFlags: ['waitingOnApproval'] });
    assert.equal(list.threads[0].statusRevision, 1);
    assert.deepEqual(eventA.payload, eventB.payload);
    assert.deepEqual(eventA.payload, {
      scope: 'host',
      threadId: 'thr_external_status',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      revision: 1,
    });
    assert.equal(eventA.seq, 0);
    assert.equal(eventA.instanceId, null);
    assert.equal(eventA.sessionId, null);

    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.some(call => (
      call.method === 'thread/resume' && call.params?.threadId === 'thr_external_status'
    )), false);
  } finally {
    first?.disconnect();
    second?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up replays only the explicitly targeted thread buffer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_catch_up', cwd: fixture.workDir, title: 'Catch Up',
      });
      socket.emit('user:message', {
        text: 'buffered event',
        instanceId: selected.instanceId,
        threadId: 'thr_catch_up',
      });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      socket.__agentEvents.length = 0;

      const replay = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_catch_up',
        lastSeq: 0,
      });
      assert.ok(replay.replayed > 0);
      assert.equal(replay.instanceId, selected.instanceId);
      assert.equal(replay.threadId, 'thr_catch_up');
      assert.equal(socket.__agentEvents.every(event => event.instanceId === selected.instanceId), true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up rebuilds when the client epoch differs even without a buffer gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-epoch-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_epoch_recovery', cwd: fixture.workDir, title: 'Epoch Recovery',
      });
      socket.emit('user:message', {
        text: 'establish runtime epoch',
        instanceId: selected.instanceId,
        threadId: 'thr_epoch_recovery',
      });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      socket.__agentEvents.length = 0;

      const recovery = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_epoch_recovery',
        lastSeq: 999,
        lastEpoch: 'stale-runtime-epoch',
      });

      assert.equal(recovery.gap, true);
      assert.equal(recovery.rebuilt, true);
      assert.equal(recovery.replayed, 0);
      assert.equal(recovery.threadId, 'thr_epoch_recovery');
      assert.equal(recovery.snapshot.source, 'thread/read');
      assert.deepEqual(
        socket.__agentEvents.filter(event => event?.seq > 0).map(event => ({
          seq: event.seq, type: event.type, reason: event.payload?.reason,
        })),
        [],
      );
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up gap rebuilds the exact thread with thread/read instead of replaying a truncated tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-gap-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createGapRecoveryCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, eventBufferCap: 10 });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_gap_recovery', cwd: fixture.workDir, title: 'Gap Recovery',
      });
      socket.emit('user:message', {
        text: 'overflow recovery buffer',
        instanceId: selected.instanceId,
        threadId: 'thr_gap_recovery',
      });
      await waitForAgentEvent(socket, 'result');
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_completed');
      socket.__agentEvents.length = 0;

      const recovery = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_gap_recovery',
        lastSeq: 1,
      });

      assert.equal(recovery.gap, true);
      assert.equal(recovery.rebuilt, true);
      assert.equal(recovery.replayed, 0);
      assert.equal(recovery.instanceId, selected.instanceId);
      assert.equal(recovery.threadId, 'thr_gap_recovery');
      assert.equal(typeof recovery.epoch, 'string');
      assert.equal(Number.isInteger(recovery.throughSeq), true);
      assert.deepEqual(recovery.snapshot, {
        source: 'thread/read',
        title: 'Recovered gap thread',
        threadStatus: { type: 'idle' },
        messages: [
          { role: 'user', content: 'persisted question' },
          { role: 'assistant', content: 'persisted answer' },
        ],
      });
      const liveDuringRead = socket.__agentEvents.filter(event => event?.seq > 0);
      assert.deepEqual(liveDuringRead.map(event => event.type), ['thread_status', 'status']);
      assert.ok(
        liveDuringRead.every(event => recovery.throughSeq < event.seq),
        'snapshot watermark must be frozen before thread/read so concurrent live events are replayed',
      );

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const reads = calls.filter(call => call.method === 'thread/read');
      assert.equal(reads.length, 1);
      assert.deepEqual(reads[0].params, { threadId: 'thr_gap_recovery', includeTurns: true });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server forks the active app-server thread into a new viewed instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-fork-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'source turn' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      const ack = await emitWithAck(socket, 'session:fork', { ephemeral: true });
      assert.equal(ack.ok, true);
      assert.equal(ack.sessionId, 'thr_forked');
      assert.ok(ack.instanceId);

      const init = await waitForAgentEventMatching(socket, 'init', event => event.payload?.sessionId === 'thr_forked');
      assert.equal(init.payload.cwd, fixture.workDir);

      const instances = await waitForAgentEventMatching(socket, 'instances', event => event.payload?.viewingInstanceId === ack.instanceId);
      assert.ok(instances.payload.instances.some(item => item.instanceId === ack.instanceId && item.sessionId === 'thr_forked'));

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const fork = calls.find(call => call.method === 'thread/fork');
      assert.ok(fork, 'session:fork should call thread/fork');
      assert.deepEqual(fork.params, {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: true,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server starts chatgpt device-code login and forwards account notifications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-login-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const ack = await emitWithAck(socket, 'account:loginStart', { type: 'chatgptDeviceCode' });
      assert.equal(ack.ok, true);
      assert.equal(ack.loginId, 'login_fake');
      assert.equal(ack.userCode, 'ABCD-EFGH');
      assert.equal(ack.verificationUrl, 'https://openai.com/device');

      const pending = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'pending');
      assert.equal(pending.payload.loginId, 'login_fake');

      const completed = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'completed');
      assert.equal(completed.payload.success, true);

      const updated = await waitForAgentEvent(socket, 'account_updated');
      assert.deepEqual(updated.payload, { authMode: 'chatgpt', planType: 'plus' });

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const loginStart = calls.find(call => call.method === 'account/login/start');
      assert.deepEqual(loginStart.params, { type: 'chatgptDeviceCode' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:list preserves UTF-8 when an app-server frame splits inside a code point', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-transport-utf8-integration-test-'));
  const codexBin = createChunkedUtf8CodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const result = await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir });

      assert.equal(result.ok, true);
      assert.equal(result.threads[0].title, '跨端会话');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:collaborationMode updates a loaded thread without sending a user message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-collab-mode-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const fixture = await startIsolatedServer({
    codexBin: createFakeCodexBin(root),
    rpcLog,
  });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const empty = await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      assert.equal(empty.threadId, null);
      const deferred = await emitWithAck(socket, 'thread:collaborationMode', { mode: 'plan', cwd: fixture.workDir });
      assert.equal(deferred.ok, true);
      assert.equal(deferred.applied, false);
      assert.equal(deferred.deferred, true);
      assert.equal(deferred.mode, 'plan');

      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
      });
      assert.equal(selected.ok, true);
      const applied = await emitWithAck(socket, 'thread:collaborationMode', {
        threadId: 'thr_fake',
        mode: 'plan',
        cwd: fixture.workDir,
      });
      assert.equal(applied.ok, true);
      assert.equal(applied.applied, true);
      assert.equal(applied.mode, 'plan');

      const event = await waitForAgentEvent(socket, 'collaboration_mode');
      assert.equal(event.payload.mode, 'plan');
      assert.equal(event.payload.applied, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(call => call.method === 'thread/settings/update'));
      assert.ok(!calls.some(call => call.method === 'turn/start'));
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:collaborationMode defers when app-server rejects the experimental method', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-collab-mode-unsupported-'));
  const fixture = await startIsolatedServer({
    codexBin: createUnsupportedCollaborationModeCodexBin(root),
  });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:select', { threadId: 'thr_fake', cwd: fixture.workDir });
      const result = await emitWithAck(socket, 'thread:collaborationMode', {
        threadId: 'thr_fake',
        mode: 'plan',
        cwd: fixture.workDir,
      });
      assert.equal(result.ok, true);
      assert.equal(result.applied, false);
      assert.equal(result.deferred, true);
      assert.equal(result.reason, 'unsupported');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server exposes P1 native app-server controls over Socket.IO', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-p1-controls-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const threadList = await emitWithAck(socket, 'thread:list', { archived: false });
      assert.equal(threadList.ok, true);
      assert.equal(threadList.threads[0].id, 'thr_fake');

      assert.equal((await emitWithAck(socket, 'thread:rename', { threadId: 'thr_fake', name: 'Mobile run' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:archive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:unarchive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:compact', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:rollback', { threadId: 'thr_fake', numTurns: 2 })).ok, true);

      const compact = await waitForAgentEvent(socket, 'compact');
      assert.equal(compact.payload.status, 'compacted');

      const models = await emitWithAck(socket, 'models:read', {});
      assert.equal(models.ok, true);
      assert.equal(models.models[0].model, 'gpt-5.5');
      assert.equal(models.capabilities.webSearch, true);

      const dir = await emitWithAck(socket, 'fs:readDirectory', { path: fixture.workDir });
      assert.equal(dir.ok, true);
      assert.equal(dir.entries[0].fileName, 'README.md');

      const file = await emitWithAck(socket, 'fs:readFile', { path: join(fixture.workDir, 'README.md') });
      assert.equal(file.ok, true);
      assert.equal(Buffer.from(file.dataBase64, 'base64').toString('utf8'), 'hello from fake file');

      writeFileSync(join(fixture.workDir, 'src-app.js'), 'export const ok = true\n');
      const search = await emitWithAck(socket, 'files:search', { cwd: fixture.workDir, query: 'src-app' });
      assert.equal(search.ok, true);
      assert.ok(search.paths.includes('src-app.js'));

      const ping = await emitWithAck(socket, 'conn:ping', {});
      assert.equal(ping.ok, true);
      assert.equal(typeof ping.t, 'number');

      const git = await emitWithAck(socket, 'git:status', { cwd: fixture.workDir });
      assert.equal(git.ok, false);
      assert.equal(git.errorCode, 'not_git');

      const account = await emitWithAck(socket, 'account:read', {});
      assert.equal(account.ok, true);
      assert.equal(account.account.account.type, 'chatgpt');
      assert.equal(account.usage.summary.lifetimeTokens, 123);
      assert.equal(account.rateLimits.rateLimits.limitId, 'codex');

      const mcp = await emitWithAck(socket, 'mcp:read', {});
      assert.equal(mcp.ok, true);
      assert.equal(mcp.servers[0].name, 'github');

      const skills = await emitWithAck(socket, 'skills:read', {});
      assert.equal(skills.ok, true);
      assert.equal(skills.entries[0].cwd, fixture.workDir);

      const detected = await emitWithAck(socket, 'externalAgentConfig:detect', {});
      assert.equal(detected.ok, true);
      assert.equal(detected.items[0].description, 'AGENTS.md');

      const imported = await emitWithAck(socket, 'externalAgentConfig:import', { migrationItems: detected.items });
      assert.equal(imported.ok, true);
      assert.equal(imported.importId, 'import_fake');

      const deleted = await emitWithAck(socket, 'thread:delete', { threadId: 'thr_fake' });
      assert.equal(deleted.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'thread/list',
        'thread/name/set',
        'thread/archive',
        'thread/unarchive',
        'thread/compact/start',
        'thread/rollback',
        'model/list',
        'modelProvider/capabilities/read',
        'fs/readDirectory',
        'fs/readFile',
        'account/read',
        'account/usage/read',
        'account/rateLimits/read',
        'mcpServerStatus/list',
        'skills/list',
        'externalAgentConfig/detect',
        'externalAgentConfig/import',
        'thread/delete',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server reads and resumes native app-server threads without local session metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-native-thread-history-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const history = await emitWithAck(socket, 'thread:history', { threadId: 'thr_fake' });
      assert.equal(history.ok, true);
      assert.equal(history.source, 'thread/read');
      assert.equal(history.thread.id, 'thr_fake');
      assert.deepEqual(history.messages, [
        { role: 'user', content: 'hello from native thread\n@README.md\n$release\n[Image]' },
        { role: 'assistant', content: 'hello from Codex app-server' },
      ]);

      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
        title: 'Fake thread',
      });
      assert.equal(selected.ok, true);
      assert.equal(selected.sessionId, 'thr_fake');

      socket.emit('user:message', { text: 'continue native thread' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const resume = calls.find(call => call.method === 'thread/resume');
      assert.ok(resume, 'selected native thread should resume through app-server');
      assert.equal(resume.params.threadId, 'thr_fake');

      const turnStart = calls.find(call =>
        call.method === 'turn/start'
        && call.params?.input?.[0]?.text === 'continue native thread'
      );
      assert.ok(turnStart, 'follow-up should be sent to the selected native thread');
      assert.equal(turnStart.params.threadId, 'thr_fake');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message forwards CLI turn overrides onto turn/start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-turn-overrides-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-turn-overrides');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_cli_settings',
        cwd: fixture.workDir,
        title: 'CLI settings',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'use cli settings',
        clientRequestId: 'req-cli-settings',
        instanceId: selected.instanceId,
        threadId: 'thr_cli_settings',
        turn: {
          model: 'gpt-5.6-sol',
          effort: 'max',
          approvalPolicy: 'untrusted',
          sandbox: 'read-only',
          serviceTier: 'fast',
        },
      });
      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const turnStart = calls.find(call =>
        call.method === 'turn/start'
        && call.params?.input?.[0]?.text === 'use cli settings'
      );
      assert.ok(turnStart, 'CLI settings should ride along with turn/start');
      assert.equal(turnStart.params.model, 'gpt-5.6-sol');
      assert.equal(turnStart.params.effort, 'max');
      assert.equal(turnStart.params.approvalPolicy, 'untrusted');
      assert.equal(turnStart.params.serviceTier, 'fast');
      assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server advertises privileged surfaces as disabled and rejects them by default', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      const init = await waitForAgentEvent(socket, 'init');
      assert.deepEqual(init.payload.features, { admin: false, labs: false });

      const admin = await emitWithAck(socket, 'admin:unlock', { confirmText: 'ENABLE ADMIN' });
      assert.equal(admin.ok, false);
      assert.equal(admin.errorCode, 'feature_disabled');

      const labs = await emitWithAck(socket, 'p3:capabilities', { cwd: fixture.workDir });
      assert.equal(labs.ok, false);
      assert.equal(labs.errorCode, 'feature_disabled');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('server gates P2 admin app-server controls with unlock, per-action confirmation, and audit log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-p2-admin-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, adminEnabled: true });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const filePath = join(fixture.workDir, 'admin.txt');
      const denied = await emitWithAck(socket, 'admin:fsWriteFile', {
        path: filePath,
        dataBase64: Buffer.from('secret file body').toString('base64'),
        adminConfirm: 'admin:fsWriteFile',
      });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Admin/);

      const deniedMarketplaceSecret = 'denied-marketplace-password-123';
      const deniedMarketplace = await emitWithAck(socket, 'admin:marketplaceAdd', {
        source: `https://user:${deniedMarketplaceSecret}@example.com/denied.git`,
        refName: 'main',
        adminConfirm: 'admin:marketplaceAdd',
      });
      assert.equal(deniedMarketplace.ok, false);

      const badUnlock = await emitWithAck(socket, 'admin:unlock', { confirmText: 'yes' });
      assert.equal(badUnlock.ok, false);

      const unlock = await emitWithAck(socket, 'admin:unlock', { confirmText: 'ENABLE ADMIN' });
      assert.equal(unlock.ok, true);
      assert.equal(unlock.adminMode, true);

      const missingActionConfirm = await emitWithAck(socket, 'admin:fsWriteFile', {
        path: filePath,
        dataBase64: Buffer.from('secret file body').toString('base64'),
      });
      assert.equal(missingActionConfirm.ok, false);
      assert.match(missingActionConfirm.error, /confirm/i);

      const actions = [
        ['admin:configWrite', { keyPath: 'model', value: 'gpt-5.5', mergeStrategy: 'replace' }],
        ['admin:configBatchWrite', { edits: [{ keyPath: 'approval_policy', value: 'on-request', mergeStrategy: 'upsert' }], reloadUserConfig: true }],
        ['admin:pluginInstall', { pluginName: 'gh', remoteMarketplaceName: 'official' }],
        ['admin:pluginUninstall', { pluginId: 'plugin_gh' }],
        ['admin:marketplaceAdd', { source: 'https://example.com/market.git', refName: 'main' }],
        ['admin:marketplaceRemove', { marketplaceName: 'community' }],
        ['admin:marketplaceUpgrade', { marketplaceName: 'community' }],
        ['admin:fsWriteFile', { path: filePath, dataBase64: Buffer.from('secret file body').toString('base64') }],
        ['admin:fsRemove', { path: filePath, recursive: false, force: true }],
        ['admin:fsCopy', { sourcePath: join(fixture.workDir, 'a.txt'), destinationPath: join(fixture.workDir, 'b.txt'), recursive: false }],
        ['admin:mcpToolCall', { threadId: 'thr_fake', server: 'github', tool: 'search', arguments: { secret: 'should-not-log' } }],
        ['admin:accountLogout', {}],
      ];
      for (const [event, payload] of actions) {
        const ack = await emitWithAck(socket, event, { ...payload, adminConfirm: event });
        assert.equal(ack.ok, true, `${event}: ${ack.error || ''}`);
      }

      const errorMarketplaceSecret = 'error-marketplace-password-456';
      const failedMarketplace = await emitWithAck(socket, 'admin:marketplaceAdd', {
        source: `https://user:${errorMarketplaceSecret}@example.com/audit-error.git`,
        refName: 'main',
        adminConfirm: 'admin:marketplaceAdd',
      });
      assert.equal(failedMarketplace.ok, false);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'config/value/write',
        'config/batchWrite',
        'plugin/install',
        'plugin/uninstall',
        'marketplace/add',
        'marketplace/remove',
        'marketplace/upgrade',
        'fs/writeFile',
        'fs/remove',
        'fs/copy',
        'mcpServer/tool/call',
        'account/logout',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }

      const auditPath = join(fixture.dataDir, 'admin-audit.jsonl');
      assert.equal(statSync(auditPath).mode & 0o777, 0o600);
      const audit = readFileSync(auditPath, 'utf8');
      assert.match(audit, /"event":"unlock"/);
      assert.match(audit, /"event":"success"/);
      assert.match(audit, /"event":"denied"/);
      assert.match(audit, /"action":"admin:mcpToolCall"/);
      assert.doesNotMatch(audit, /secret file body/);
      assert.doesNotMatch(audit, /should-not-log/);
      assert.doesNotMatch(audit, new RegExp(deniedMarketplaceSecret));
      assert.doesNotMatch(audit, new RegExp(errorMarketplaceSecret));
      assert.match(audit, /https:\/\/user:\*\*\*@example\.com/);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('admin unlock expires before a privileged action reaches app-server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-admin-expiry-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({
    codexBin,
    rpcLog,
    adminEnabled: true,
    adminUnlockTtlMs: 25,
  });
  const socket = await connectSocket(fixture.url, fixture.authToken, 'device-admin-expiry');
  try {
    await waitForAgentEvent(socket, 'init');
    const unlock = await emitWithAck(socket, 'admin:unlock', { confirmText: 'ENABLE ADMIN' });
    assert.equal(unlock.ok, true);
    assert.ok(unlock.expiresAt > Date.now());
    await new Promise(resolve => setTimeout(resolve, 40));

    const expired = await emitWithAck(socket, 'admin:fsWriteFile', {
      path: join(fixture.workDir, 'must-not-write.txt'),
      dataBase64: Buffer.from('blocked').toString('base64'),
      adminConfirm: 'admin:fsWriteFile',
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.errorCode, 'admin_locked');
    assert.match(expired.error, /expired/i);
    assert.equal(existsSync(rpcLog), false);
  } finally {
    socket.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('admin unlock rate-limits repeated phrase failures by device', async () => {
  const fixture = await startIsolatedServer({
    adminEnabled: true,
    adminUnlockMaxFailures: 2,
    adminUnlockWindowMs: 60_000,
  });
  const socket = await connectSocket(fixture.url, fixture.authToken, 'device-admin-unlock-rate-limit');
  try {
    await waitForAgentEvent(socket, 'init');
    for (const confirmText of ['wrong-one', 'wrong-two']) {
      const denied = await emitWithAck(socket, 'admin:unlock', { confirmText });
      assert.equal(denied.ok, false);
    }

    const limited = await emitWithAck(socket, 'admin:unlock', { confirmText: 'wrong-three' });
    assert.equal(limited.ok, false);
    assert.equal(limited.errorCode, 'rate_limited');
    assert.equal(limited.retryable, true);

    const correctButLimited = await emitWithAck(socket, 'admin:unlock', { confirmText: 'ENABLE ADMIN' });
    assert.equal(correctButLimited.ok, false);
    assert.equal(correctButLimited.errorCode, 'rate_limited');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('server exposes P3 experimental controls only behind feature flag', async () => {
  const disabledFixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(disabledFixture.url, disabledFixture.authToken);
    try {
      const denied = await emitWithAck(socket, 'p3:terminalSpawn', { command: ['bash'] });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /P3.*disabled/i);
    } finally {
      socket.disconnect();
    }
  } finally {
    await disabledFixture.close();
  }

  const root = mkdtempSync(join(tmpdir(), 'ccm-p3-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, p3Experimental: true });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const capabilities = await emitWithAck(socket, 'p3:capabilities', { cwd: fixture.workDir });
      assert.equal(capabilities.ok, true);

      const terminal = await emitWithAck(socket, 'p3:terminalSpawn', {
        cwd: fixture.workDir,
        processId: 'term_server',
        command: ['bash', '-lc', 'echo p3'],
        cols: 100,
        rows: 30,
      });
      assert.equal(terminal.ok, true);
      const termOutput = await waitForAgentEvent(socket, 'term_output');
      assert.equal(termOutput.payload.processId, 'term_server');
      assert.equal(termOutput.payload.text, 'p3\n');

      const write = await emitWithAck(socket, 'p3:terminalWrite', { processId: 'term_server', text: 'pwd\n' });
      assert.equal(write.ok, true);
      const resize = await emitWithAck(socket, 'p3:terminalResize', { processId: 'term_server', cols: 120, rows: 40 });
      assert.equal(resize.ok, true);
      const terminate = await emitWithAck(socket, 'p3:terminalTerminate', { processId: 'term_server' });
      assert.equal(terminate.ok, true);

      const turns = await emitWithAck(socket, 'p3:threadTurns', { threadId: 'thr_fake' });
      assert.equal(turns.ok, true);
      assert.equal(turns.source, 'thread/read');
      assert.equal(turns.turns[0].id, 'turn_fake');

      const search = await emitWithAck(socket, 'p3:threadSearch', { query: 'fake', limit: 5 });
      assert.equal(search.ok, true);
      assert.equal(search.source, 'thread/list');
      assert.equal(search.results[0].id, 'thr_fake');

      const realtime = await waitForAgentEvent(socket, 'realtime');
      assert.equal(realtime.payload.event, 'sdp');
      const remote = await waitForAgentEvent(socket, 'remote_control');
      assert.equal(remote.payload.serverName, 'local');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const initialize = calls.find(call => call.method === 'initialize');
      assert.equal(initialize.params.capabilities.experimentalApi, true);
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'experimentalFeature/list',
        'command/exec',
        'command/exec/write',
        'command/exec/resize',
        'command/exec/terminate',
        'thread/read',
        'thread/list',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startIsolatedServer({ codexBin, rpcLog, spawnLog, adminEnabled = false, adminUnlockTtlMs, adminUnlockMaxFailures, adminUnlockWindowMs, p3Experimental = false, eventBufferCap, vapid, initialPushSubscriptions, initialTrustedDevices, pushMaxSubscriptions, allowedOrigins = [], trustedProxyIps = [], allowInsecureRemote = false, authMaxFailures, authWindowMs, pendingDeviceLimit } = {}) {
  const previous = snapshotEnv();
  const root = mkdtempSync(join(tmpdir(), 'ccm-server-test-'));
  let workDir = join(root, 'work');
  let altWorkDir = join(root, 'alt-work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(altWorkDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (Array.isArray(initialPushSubscriptions)) {
    writeFileSync(join(dataDir, 'push-subscriptions.json'), JSON.stringify(initialPushSubscriptions));
  }
  if (Array.isArray(initialTrustedDevices)) {
    writeFileSync(join(dataDir, 'trusted-devices.json'), JSON.stringify(initialTrustedDevices));
  }
  workDir = realpathSync(workDir);
  altWorkDir = realpathSync(altWorkDir);

  process.env.CODEX_SERVER_NO_START = '1';
  process.env.CODEX_DATA_DIR = dataDir;
  process.env.WORK_DIR = workDir;
  process.env.WORK_DIRS = altWorkDir;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.AUTH_TOKEN = 'server-integration-token';
  if (allowedOrigins.length) process.env.CODEX_ALLOWED_ORIGINS = allowedOrigins.join(',');
  else delete process.env.CODEX_ALLOWED_ORIGINS;
  if (trustedProxyIps.length) process.env.CODEX_TRUSTED_PROXY_IPS = trustedProxyIps.join(',');
  else delete process.env.CODEX_TRUSTED_PROXY_IPS;
  if (allowInsecureRemote) process.env.CODEX_ALLOW_INSECURE_REMOTE = '1';
  else delete process.env.CODEX_ALLOW_INSECURE_REMOTE;
  if (Number.isInteger(authMaxFailures) && authMaxFailures > 0) {
    process.env.CODEX_AUTH_MAX_FAILURES = String(authMaxFailures);
  } else {
    delete process.env.CODEX_AUTH_MAX_FAILURES;
  }
  if (Number.isInteger(authWindowMs) && authWindowMs > 0) {
    process.env.CODEX_AUTH_WINDOW_MS = String(authWindowMs);
  } else {
    delete process.env.CODEX_AUTH_WINDOW_MS;
  }
  if (Number.isInteger(pendingDeviceLimit) && pendingDeviceLimit > 0) {
    process.env.CODEX_PENDING_DEVICE_LIMIT = String(pendingDeviceLimit);
  } else {
    delete process.env.CODEX_PENDING_DEVICE_LIMIT;
  }
  if (codexBin) process.env.CODEX_BIN = codexBin;
  if (rpcLog) process.env.CODEX_FAKE_RPC_LOG = rpcLog;
  if (spawnLog) process.env.CODEX_FAKE_SPAWN_LOG = spawnLog;
  if (adminEnabled) process.env.CODEX_ADMIN_ENABLED = '1';
  else delete process.env.CODEX_ADMIN_ENABLED;
  if (Number.isInteger(adminUnlockTtlMs) && adminUnlockTtlMs > 0) {
    process.env.CODEX_ADMIN_UNLOCK_TTL_MS = String(adminUnlockTtlMs);
  } else {
    delete process.env.CODEX_ADMIN_UNLOCK_TTL_MS;
  }
  if (Number.isInteger(adminUnlockMaxFailures) && adminUnlockMaxFailures > 0) {
    process.env.CODEX_ADMIN_UNLOCK_MAX_FAILURES = String(adminUnlockMaxFailures);
  } else {
    delete process.env.CODEX_ADMIN_UNLOCK_MAX_FAILURES;
  }
  if (Number.isInteger(adminUnlockWindowMs) && adminUnlockWindowMs > 0) {
    process.env.CODEX_ADMIN_UNLOCK_WINDOW_MS = String(adminUnlockWindowMs);
  } else {
    delete process.env.CODEX_ADMIN_UNLOCK_WINDOW_MS;
  }
  if (p3Experimental) process.env.CODEX_P3_EXPERIMENTAL = '1';
  else delete process.env.CODEX_P3_EXPERIMENTAL;
  if (Number.isInteger(pushMaxSubscriptions) && pushMaxSubscriptions > 0) {
    process.env.CODEX_PUSH_MAX_SUBSCRIPTIONS = String(pushMaxSubscriptions);
  } else {
    delete process.env.CODEX_PUSH_MAX_SUBSCRIPTIONS;
  }
  if (Number.isInteger(eventBufferCap) && eventBufferCap > 0) {
    process.env.CODEX_EVENT_BUFFER_CAP = String(eventBufferCap);
  } else {
    delete process.env.CODEX_EVENT_BUFFER_CAP;
  }
  if (vapid) {
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:codex-chat-mobile@example.com';
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  }

  const serverModule = await import(`../server.js?serverIntegration=${Date.now()}-${Math.random()}`);
  const server = serverModule.startServer();
  assert.ok(server && typeof server.address === 'function', 'startServer should return the listening http.Server');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    workDir,
    altWorkDir,
    dataDir,
    authToken: process.env.AUTH_TOKEN,
    async close() {
      await new Promise(resolve => serverModule.stopServer(resolve));
      restoreEnv(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function connectSocket(url, token, deviceToken) {
  const socket = socketClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token, ...(deviceToken ? { deviceToken } : {}) },
  });
  socket.__agentEvents = [];
  socket.on('agent:event', event => {
    socket.__agentEvents.push(event);
  });
  await once(socket, 'connect');
  return socket;
}

async function createAuthSessionCookie(fixture, deviceToken, { forwardedProto } = {}) {
  const response = await fetch(`${fixture.url}/auth/session`, {
    method: 'POST',
    headers: {
      'x-auth-token': fixture.authToken,
      'x-device-token': deviceToken,
      ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
    },
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function waitForCondition(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // Atomic writers may briefly replace the path between poll iterations.
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function waitForAgentEvent(socket, type) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      reject(new Error(`Timed out waiting for agent:event ${type}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function waitForAgentEventMatching(socket, type, predicate) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type && predicate(event)) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      const seen = (socket.__agentEvents || []).slice(-10).map(event => ({
        type: event?.type,
        reason: event?.payload?.reason,
        message: event?.payload?.message,
      }));
      reject(new Error(`Timed out waiting for matching agent:event ${type}; recent=${JSON.stringify(seen)}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type || !predicate(event)) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

function createUnsupportedCollaborationModeCodexBin(root) {
  const file = join(root, 'fake-codex-no-collab.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import readline from 'node:readline';
const threadId = 'thr_fake';
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/settings/update') {
    return send({
      id: message.id,
      error: { code: -32601, message: 'thread/settings/update requires experimentalApi capability' },
    });
  }
  if (message.method === 'thread/list') {
    return send({ id: message.id, result: { data: [{
      id: threadId,
      preview: 'fake thread',
      name: 'Fake thread',
      cwd: process.env.WORK_DIR,
      createdAt: 1710000000,
      updatedAt: 1710000100,
      status: { type: 'idle' },
    }], nextCursor: null } });
  }
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: threadId } } });
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createFakeCodexBin(root) {
  const file = join(root, 'fake-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
	import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const spawnLogPath = process.env.CODEX_FAKE_SPAWN_LOG;
if (spawnLogPath) appendFileSync(spawnLogPath, JSON.stringify({ pid: process.pid }) + '\\n');
const threadId = 'thr_fake';
const turnId = 'turn_fake';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function log(message) {
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  log(message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
	  if (message.method === 'turn/start') {
	    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
	    if (message.params?.input?.some(item => item.text === 'request routed approval')) {
	      setTimeout(() => send({
	        id: 9001,
	        method: 'item/commandExecution/requestApproval',
	        params: {
	          threadId: message.params.threadId,
	          turnId,
	          itemId: 'item_approval',
	          command: ['pwd'],
	          cwd: process.env.WORK_DIR,
	          availableDecisions: ['accept', 'decline']
	        }
	      }), 5);
	    } else if (message.params?.input?.some(item => item.text === 'request legacy approval')) {
	      setTimeout(() => send({
	        id: 9005,
	        method: 'applyPatchApproval',
	        params: {
	          conversationId: message.params.threadId,
	          callId: 'legacy_patch_call',
	          fileChanges: {},
	          reason: 'legacy write',
	          grantRoot: null
	        }
	      }), 5);
	    } else if (message.params?.input?.some(item => item.text === 'request revoked approval')) {
	      setTimeout(() => {
	        send({
	          id: 9002,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_revoked_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => send({
	          method: 'serverRequest/resolved',
	          params: { requestId: 9002, threadId: message.params.threadId }
	        }), 10);
	      }, 5);
	    } else if (message.params?.input?.some(item => item.text === 'request failed approval')) {
	      setTimeout(() => {
	        send({
	          id: 9003,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_failed_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => send({
	          method: 'turn/failed',
	          params: { threadId: message.params.threadId, turn: { id: turnId, error: { message: 'failed' } } }
	        }), 10);
	      }, 5);
	    } else if (message.params?.input?.some(item => item.text === 'request exited approval')) {
	      setTimeout(() => {
	        send({
	          id: 9004,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_exited_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => process.exit(17), 10);
	      }, 5);
	    }
	    return;
	  }
	  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [{
	    id: threadId,
	    sessionId: threadId,
	    preview: 'fake thread',
	    name: 'Fake thread',
	    modelProvider: 'openai',
	    createdAt: 1710000000,
	    updatedAt: 1710000100,
	    recencyAt: 1710000100,
	    cwd: process.env.WORK_DIR,
	    status: { type: 'idle' },
	    turns: []
	  }], nextCursor: null, backwardsCursor: null } });
	  if (message.method === 'thread/name/set') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/settings/update') {
	    send({ id: message.id, result: {} });
	    setTimeout(() => send({
	      method: 'thread/settings/updated',
	      params: {
	        threadId: message.params.threadId,
	        threadSettings: { collaborationMode: message.params.collaborationMode },
	      },
	    }), 5);
	    return;
	  }
	  if (message.method === 'thread/archive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/unarchive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/delete') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/compact/start') {
	    send({ id: message.id, result: {} });
	    setTimeout(() => send({ method: 'thread/compacted', params: { threadId: message.params.threadId, turnId } }), 5);
	    return;
	  }
	  if (message.method === 'thread/rollback') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
	  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{ id: 'model_1', model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text'], serviceTiers: [], defaultServiceTier: null, isDefault: true }], nextCursor: null } });
	  if (message.method === 'modelProvider/capabilities/read') return send({ id: message.id, result: { namespaceTools: true, imageGeneration: false, webSearch: true } });
	  if (message.method === 'fs/readDirectory') return send({ id: message.id, result: { entries: [{ fileName: 'README.md', isDirectory: false, isFile: true }] } });
	  if (message.method === 'fs/readFile') return send({ id: message.id, result: { dataBase64: Buffer.from('hello from fake file').toString('base64') } });
	  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: false } });
	  if (message.method === 'account/usage/read') return send({ id: message.id, result: { summary: { lifetimeTokens: 123, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [] } });
	  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: null, secondary: null, credits: null, individualLimit: null, planType: 'plus', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null } });
	  if (message.method === 'mcpServerStatus/list') return send({ id: message.id, result: { data: [{ name: 'github', serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' }], nextCursor: null } });
	  if (message.method === 'skills/list') return send({ id: message.id, result: { data: [{ cwd: process.env.WORK_DIR, skills: [{ name: 'release', description: 'Release helper', path: process.env.WORK_DIR + '/.agents/skills/release/SKILL.md', enabled: true }], errors: [] }] } });
	  if (message.method === 'externalAgentConfig/detect') return send({ id: message.id, result: { items: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: process.env.WORK_DIR, details: null }] } });
	  if (message.method === 'externalAgentConfig/import') return send({ id: message.id, result: { importId: 'import_fake' } });
	  if (message.method === 'config/value/write') return send({ id: message.id, result: {} });
	  if (message.method === 'config/batchWrite') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/install') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/uninstall') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/add') {
	    if (message.params?.source?.includes('audit-error')) {
	      return send({ id: message.id, error: { code: -32000, message: 'marketplace failed for ' + message.params.source } });
	    }
	    return send({ id: message.id, result: {} });
	  }
	  if (message.method === 'marketplace/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/upgrade') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/writeFile') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/copy') return send({ id: message.id, result: {} });
	  if (message.method === 'mcpServer/tool/call') return send({ id: message.id, result: { result: { ok: true } } });
	  if (message.method === 'account/logout') return send({ id: message.id, result: {} });
	  if (message.method === 'experimentalFeature/list') {
	    send({ method: 'thread/realtime/sdp', params: { threadId, sdp: 'v=0' } });
	    send({ method: 'remoteControl/status/changed', params: { status: { type: 'connected' }, serverName: 'local', installationId: 'install_fake', environmentId: 'env_fake' } });
	    return send({ id: message.id, result: { data: [{ name: 'p3-terminal', enabled: true }] } });
	  }
	  if (message.method === 'command/exec') {
	    send({ method: 'command/exec/outputDelta', params: { processId: message.params.processId, stream: 'stdout', deltaBase64: Buffer.from('p3\\n').toString('base64'), capReached: false } });
	    return send({ id: message.id, result: { exitCode: 0 } });
	  }
	  if (message.method === 'command/exec/write') return send({ id: message.id, result: {} });
	  if (message.method === 'command/exec/resize') return send({ id: message.id, result: {} });
	  if (message.method === 'command/exec/terminate') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [{ id: turnId, items: [
	    { type: 'userMessage', id: 'u1', content: [
	      { type: 'text', text: 'hello from native thread', text_elements: [] },
	      { type: 'mention', name: 'README.md', path: '/private/work/README.md' },
	      { type: 'skill', name: 'release', path: '/private/skills/release/SKILL.md' },
	      { type: 'localImage', path: '/private/uploads/image.png' }
	    ] },
	    { type: 'agentMessage', id: 'a1', text: 'hello from Codex app-server' },
	    { id: 'item_fake' }
	  ] }] } } });
	  if (message.method === 'thread/fork') {
    send({ id: message.id, result: { thread: { id: 'thr_forked', forkedFromId: threadId } } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.method === 'account/login/start') {
    send({ id: message.id, result: {
      type: 'chatgptDeviceCode',
      loginId: 'login_fake',
      verificationUrl: 'https://openai.com/device',
      userCode: 'ABCD-EFGH'
    } });
    setTimeout(() => {
      send({ method: 'account/login/completed', params: { loginId: 'login_fake', success: true, error: null } });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
      setTimeout(() => process.exit(0), 20);
    }, 10);
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createPersistentReceiptCodexBin(root) {
  const file = join(root, 'persistent-receipt-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const acceptedPath = logPath + '.accepted.jsonl';
const turnId = 'turn_reconcile_restart';
const itemId = 'user_reconcile_restart';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function acceptedMessages() {
  if (!existsSync(acceptedPath)) return [];
  return readFileSync(acceptedPath, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    appendFileSync(acceptedPath, JSON.stringify({
      threadId: message.params.threadId,
      clientId: message.params.clientUserMessageId,
      input: message.params.input,
    }) + '\\n');
    return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  }
  if (message.method === 'thread/read') {
    const accepted = acceptedMessages().filter(entry => entry.threadId === message.params.threadId);
    return send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          turns: accepted.map(entry => ({
            id: turnId,
            items: [{
              type: 'userMessage',
              id: itemId,
              clientId: entry.clientId,
              content: entry.input,
            }],
          })),
        },
      },
    });
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createQueuedTransitionCodexBin(root) {
  const file = join(root, 'queued-transition-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const threadId = 'thr_queued_transition';
let turnCount = 0;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === 'turn/start') {
    turnCount += 1;
    const turnId = turnCount === 1 ? 'turn_blocker' : 'turn_queued_transition';
    if (turnCount === 1) {
      setTimeout(() => {
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        setTimeout(() => send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        }), 20);
      }, 80);
      return;
    }
    return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(file, 0o755);
  return file;
}

function createChunkedUtf8CodexBin(root) {
  const file = join(root, 'fake-codex-chunked-utf8.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function sendSplitInsideUtf8(message) {
  const frame = Buffer.from(JSON.stringify(message) + '\\n');
  const marker = Buffer.from('跨');
  const index = frame.indexOf(marker);
  process.stdout.write(frame.subarray(0, index + 1));
  setTimeout(() => process.stdout.write(frame.subarray(index + 1)), 5);
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/list') return sendSplitInsideUtf8({
    id: message.id,
    result: {
      data: [{
        id: 'thr_utf8',
        name: '跨端会话',
        preview: 'chunked UTF-8',
        cwd: process.cwd(),
        createdAt: 1710000000,
        updatedAt: 1710000001,
        status: { type: 'idle' }
      }],
      nextCursor: null
    }
  });
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createGapRecoveryCodexBin(root) {
  const file = join(root, 'fake-codex-gap-recovery.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const threadId = 'thr_gap_recovery';
const turnId = 'turn_gap_recovery';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setImmediate(() => {
      for (let index = 0; index < 11; index++) {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: 'item_gap', delta: String(index % 10) },
        });
      }
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    });
    return;
  }
  if (message.method === 'thread/read') {
    send({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'active', activeFlags: [] } },
    });
    setTimeout(() => send({ id: message.id, result: { thread: {
      id: message.params.threadId,
      name: 'Recovered gap thread',
      status: { type: 'idle' },
      turns: [{ id: 'turn_persisted', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'persisted question' }] },
        { type: 'agentMessage', text: 'persisted answer' },
      ] }],
    } } }), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createExternalThreadStatusCodexBin(root) {
  const file = join(root, 'fake-codex-external-thread-status.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/list') {
    send({
      method: 'thread/status/changed',
      params: {
        threadId: 'thr_external_status',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    });
    setTimeout(() => send({
      id: message.id,
      result: {
        data: [{
          id: 'thr_external_status',
          name: 'External active thread',
          preview: 'running elsewhere',
          cwd: process.env.WORK_DIR,
          createdAt: 1710000000,
          updatedAt: 1710000001,
          status: { type: 'idle' },
        }],
        nextCursor: null,
      },
    }), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(file, 0o700);
  return file;
}

function createMultiplexFakeCodexBin(root) {
  const file = join(root, 'fake-codex-multiplex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const rl = readline.createInterface({ input: process.stdin });

function log(kind, frame = null) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind, pid: process.pid, frame }) + '\\n');
}

function send(frame) {
  log('out', frame);
  process.stdout.write(JSON.stringify(frame) + '\\n');
}

log('spawn');
rl.on('line', line => {
  const message = JSON.parse(line);
  log('in', message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    const isA = threadId.endsWith('_a');
    const turnId = isA ? 'turn_mux_a' : 'turn_mux_b';
    const prefix = isA ? 'A' : 'B';
    const responseDelay = isA ? 18 : 4;
    setTimeout(() => send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } }), responseDelay);
    setTimeout(() => send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }), responseDelay + 10);
    setTimeout(() => send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item_' + prefix, delta: prefix + '-one' } }), responseDelay + 20);
    setTimeout(() => send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item_' + prefix, delta: prefix + '-two' } }), responseDelay + 40);
    setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }), responseDelay + 60);
    setTimeout(() => send({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } }), responseDelay + 70);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
