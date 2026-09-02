import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isLocalAccess,
  isLoopbackAddress,
  isLoopbackHostHeader,
  resolveListenHost,
  normalizeAddress,
  hostnameFromHeader,
  evaluateTransportSecurity,
  evaluateSocketHandshakeSecurity,
  parseGatewaySecurityPolicy,
} from '../server-security.js';

// ---- normalizeAddress ----

test('normalizeAddress: strips ::ffff: prefix', () => {
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:10.0.0.1'), '10.0.0.1');
});

test('normalizeAddress: lowercases and trims', () => {
  assert.equal(normalizeAddress('  LOCALHOST  '), 'localhost');
  assert.equal(normalizeAddress('::1'), '::1');
});

test('normalizeAddress: handles empty/null/undefined', () => {
  assert.equal(normalizeAddress(''), '');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
});

// ---- hostnameFromHeader ----

test('hostnameFromHeader: extracts host from IPv6 bracket notation', () => {
  assert.equal(hostnameFromHeader('[::1]:3001'), '::1');
  assert.equal(hostnameFromHeader('[fe80::1]:8080'), 'fe80::1');
});

test('hostnameFromHeader: strips port from IPv4', () => {
  assert.equal(hostnameFromHeader('127.0.0.1:3001'), '127.0.0.1');
  assert.equal(hostnameFromHeader('example.com:80'), 'example.com');
});

test('hostnameFromHeader: returns host as-is when no port', () => {
  assert.equal(hostnameFromHeader('localhost'), 'localhost');
  assert.equal(hostnameFromHeader('127.0.0.1'), '127.0.0.1');
});

test('hostnameFromHeader: handles empty/null/undefined', () => {
  assert.equal(hostnameFromHeader(''), '');
  assert.equal(hostnameFromHeader(null), '');
  assert.equal(hostnameFromHeader(undefined), '');
});

// ---- isLoopbackAddress ----

test('isLoopbackAddress: recognizes all loopback formats', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('127.255.255.255'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('localhost'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('isLoopbackAddress: rejects non-loopback addresses', () => {
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('0.0.0.0'), false);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress('example.com'), false);
  assert.equal(isLoopbackAddress('::2'), false);
  assert.equal(isLoopbackAddress('fe80::1'), false);
});

test('isLoopbackAddress: handles empty/null/undefined', () => {
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

// ---- isLoopbackHostHeader ----

test('isLoopbackHostHeader: recognizes loopback with port', () => {
  assert.equal(isLoopbackHostHeader('localhost:3001'), true);
  assert.equal(isLoopbackHostHeader('127.0.0.1:8080'), true);
  assert.equal(isLoopbackHostHeader('[::1]:3001'), true);
});

test('isLoopbackHostHeader: rejects non-loopback hosts', () => {
  assert.equal(isLoopbackHostHeader('public.example.com'), false);
  assert.equal(isLoopbackHostHeader('0.0.0.0:3001'), false);
  assert.equal(isLoopbackHostHeader('10.0.0.1:3001'), false);
});

// ---- isLocalAccess ----

test('isLocalAccess: requires both loopback socket AND host header', () => {
  // Both loopback → true
  assert.equal(isLocalAccess({ remoteAddress: '127.0.0.1', hostHeader: 'localhost:3001' }), true);
  assert.equal(isLocalAccess({ remoteAddress: '::1', hostHeader: '127.0.0.1:3001' }), true);
  assert.equal(isLocalAccess({ remoteAddress: '::ffff:127.0.0.1', hostHeader: '[::1]:3001' }), true);
});

test('isLocalAccess: rejects when either is non-loopback', () => {
  // Remote loopback, host public → false
  assert.equal(isLocalAccess({ remoteAddress: '127.0.0.1', hostHeader: 'public.example.com' }), false);
  // Remote public, host loopback → false
  assert.equal(isLocalAccess({ remoteAddress: '10.0.0.42', hostHeader: 'localhost:3001' }), false);
  // Both public → false
  assert.equal(isLocalAccess({ remoteAddress: '10.0.0.1', hostHeader: 'public.example.com' }), false);
});

test('isLocalAccess: handles missing fields', () => {
  assert.equal(isLocalAccess({}), false);
  assert.equal(isLocalAccess({ remoteAddress: '' }), false);
  assert.equal(isLocalAccess({ hostHeader: '' }), false);
});

// ---- resolveListenHost ----

test('server defaults to loopback binding', () => {
  assert.equal(resolveListenHost({ env: {}, authToken: '' }), '127.0.0.1');
});

test('server refuses non-loopback host without AUTH_TOKEN', () => {
  assert.throws(
    () => resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: '' }),
    /AUTH_TOKEN/
  );
});

test('server allows explicit remote bind only when AUTH_TOKEN is set', () => {
  assert.equal(resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: 'a'.repeat(32) }), '0.0.0.0');
});

test('server refuses a weak AUTH_TOKEN for a remote bind', () => {
  assert.throws(
    () => resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: 'short-secret' }),
    /32 characters/
  );
});

test('resolveListenHost: allows loopback host without AUTH_TOKEN', () => {
  assert.equal(resolveListenHost({ env: { HOST: '127.0.0.1' }, authToken: '' }), '127.0.0.1');
  assert.equal(resolveListenHost({ env: { HOST: 'localhost' }, authToken: '' }), 'localhost');
});

test('resolveListenHost: uses custom HOST from env', () => {
  assert.equal(resolveListenHost({ env: { HOST: '192.168.1.100' }, authToken: 'a'.repeat(32) }), '192.168.1.100');
});

// ---- Host header injection ----

test('isLoopbackHostHeader: rejects host injection attempts', () => {
  // Double host header
  assert.equal(isLoopbackHostHeader('localhost, public.example.com'), false);
  // Null byte injection
  assert.equal(isLoopbackHostHeader('localhost\0.evil.com'), false);
  // Whitespace injection
  assert.equal(isLoopbackHostHeader(' localhost :3001'), true); // trimmed, still loopback
});

test('transport security rejects a direct remote HTTP request by default', () => {
  assert.deepEqual(evaluateTransportSecurity({
    remoteAddress: '10.0.0.42',
    hostHeader: 'codex.example.com',
    socketEncrypted: false,
  }, {
    trustedProxyIps: [],
    allowInsecureRemote: false,
  }), {
    ok: false,
    reason: 'https_required',
    local: false,
    remote: true,
    secure: false,
    viaTrustedProxy: false,
    effectiveProtocol: 'http',
  });
});

test('transport security accepts HTTPS asserted by an explicitly trusted proxy', () => {
  assert.deepEqual(evaluateTransportSecurity({
    remoteAddress: '127.0.0.1',
    hostHeader: 'codex.example.com',
    socketEncrypted: false,
    forwardedProtoHeader: 'https',
  }, {
    trustedProxyIps: ['127.0.0.1'],
    allowInsecureRemote: false,
  }), {
    ok: true,
    reason: null,
    local: false,
    remote: true,
    secure: true,
    viaTrustedProxy: true,
    effectiveProtocol: 'https',
  });
});

test('socket handshake security rejects a remote origin outside the exact allowlist', () => {
  const result = evaluateSocketHandshakeSecurity({
    remoteAddress: '10.0.0.42',
    hostHeader: 'codex.example.com',
    socketEncrypted: true,
    originHeader: 'https://evil.example',
  }, {
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: [],
    allowInsecureRemote: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
  assert.equal(result.normalizedOrigin, 'https://evil.example');
});

test('gateway security policy canonicalizes and deduplicates exact origins and proxy IPs', () => {
  assert.deepEqual(parseGatewaySecurityPolicy({
    CODEX_ALLOWED_ORIGINS: ' https://codex.example.com/,https://codex.example.com:443,https://two.example ',
    CODEX_TRUSTED_PROXY_IPS: '127.0.0.1,::ffff:127.0.0.1,::1',
    CODEX_ALLOW_INSECURE_REMOTE: '0',
  }), {
    allowedOrigins: ['https://codex.example.com', 'https://two.example'],
    trustedProxyIps: ['127.0.0.1', '::1'],
    allowInsecureRemote: false,
  });
});

// ackError 是 26 个 socket 处理器共用的失败出口（thread:*、models:read、files:search、
// account:read、mcp:read、externalAgentConfig:import、p3:* 等），它给出的字符串会被
// appendSystem(ack?.error, true) 直接渲染进手机上的消息列表。
//
// 全仓其他用户可见的错误都过 sanitize()——agent-appserver 的 turn/start、turn/steer、
// 启动失败都是。ackError 曾是唯一一条绕过去的：原始 error.message 直送浏览器。后果很具体：
// externalAgentConfig:import 解析带 API key 的外部配置、mcp:read 读带凭证的 MCP 配置、
// account:* 走认证流程，这些地方的报错都可能把密钥带在 message 里，最后显示在屏幕上并
// 进入用户的截图。控制字符同理——escHtml 挡 HTML，不挡 ANSI 转义。
async function importServerHelpers() {
  const prev = process.env.CODEX_SERVER_NO_START;
  process.env.CODEX_SERVER_NO_START = '1';
  try {
    return await import(`../server.js?ackError=${Date.now()}-${Math.random()}`);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SERVER_NO_START;
    else process.env.CODEX_SERVER_NO_START = prev;
  }
}

test('ackError 抹掉错误信息里的密钥，不把它送到手机屏幕上', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];

  ackError(payload => acks.push(payload), new Error(
    'failed to parse config: OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  ));

  assert.equal(acks[0].ok, false);
  assert.doesNotMatch(
    acks[0].error,
    /sk-proj-abcdefghijklmnopqrstuvwxyz012345/,
    '密钥不能出现在返回给浏览器的错误里',
  );
  assert.match(acks[0].error, /failed to parse config/, '有用的部分要留着，否则没法排查');
});

test('ackError 剥掉控制字符，避免 ANSI 转义污染消息列表', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];
  const ansi = '\u001b[31mfatal\u001b[0m bad state';

  ackError(payload => acks.push(payload), new Error(ansi));

  assert.ok(!acks[0].error.includes('\u001b'), 'escHtml 只挡 HTML，不挡终端控制序列');
  assert.match(acks[0].error, /fatal/);
});

test('ackError 对非 Error 的抛出物也给得出可读的字符串', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];

  ackError(payload => acks.push(payload), 'plain string failure');
  ackError(payload => acks.push(payload), null);

  assert.equal(acks[0].error, 'plain string failure');
  assert.equal(acks[1].ok, false);
  assert.ok(acks[1].error, '兜底也要有话说，不能是空串让页面显示一片空白');
});

test('ackError 没有 ack 回调时不抛异常', async () => {
  const { ackError } = await importServerHelpers();
  assert.doesNotThrow(() => ackError(undefined, new Error('no ack')));
});

test('送往浏览器的错误文案一律经过 sanitize', () => {
  // 这是一条绊线，守的是一整类问题而不是某一处：只要有人再写一处
  // `${err.message}` 直插用户可见文案，这里就会红。
  //
  // 判据是「会不会到浏览器」：console.* 是宿主机自己的终端，主人看自己的完整报错
  // 天经地义，不脱敏；emit / ack / payload.message 会跨网络到手机上，必须脱敏。
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    // 两种写法都要管：模板插值 `…${err.message}…`，以及 { error: err.message }。
    // 第一版只查了前者，于是 message:reconcile、结构化输入校验和 dispatch_failed
    // 三处漏网 —— 一条只覆盖一半形态的绊线，比没有绊线更危险，因为它会让人以为查过了。
    const interpolated = /\$\{(?:err|error)\??\.message/.test(line);
    const assigned = /^\s*error:\s*(?:err|error)\??\.message/.test(line);
    if (!interpolated && !assigned) return;
    if (/sanitize\(/.test(line)) return;
    if (/console\.(error|warn|log)/.test(line)) return;
    // 审计文件那条路整条 entry 都会过 sanitizeAdminAuditValue 递归脱敏，不必在写入点重复。
    const window = lines.slice(Math.max(0, index - 8), index).join('\n');
    if (/append(?:SecurityAudit|HostConfigAudit)\(/.test(window)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    offenders,
    [],
    '这些行把原始 err.message 插进了会发到浏览器的文案里。上游报错可能带 API key、'
    + 'Bearer token 或 ANSI 转义 —— 前两者会显示在手机屏幕上并进入截图，后者会污染消息列表。'
    + '用 sanitize(...) 包一层；如果这条确实只进宿主机的 console，改用 console.*。',
  );
});

test('任何向全部 socket 广播的循环都必须过 deviceApproved 过滤', () => {
  // pending 设备是「凭证对了、但人还没点同意」的设备。服务端有五处广播循环
  // 各自写着一行 `if (socket.deviceApproved !== true) continue;`——同一个不变量
  // 复制了五遍，从其中一处漏掉不会有任何东西报警。
  //
  // 漏了会泄什么，按严重程度：needs-you 广播带审批 payload（agent 要执行的命令原文）、
  // instances 广播带 cwd（宿主机目录路径）、thread 状态带会话名、状态栏带其内容。
  //
  // 判据只看会不会发数据：遍历 socket 去 disconnect、去收集列表、去清字段的循环
  // 不需要这道闸，所以规则是「循环体里出现 socket.emit 就必须出现 deviceApproved」。
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const offenders = [];

  lines.forEach((line, index) => {
    if (!/for \(const socket of io\.sockets\.sockets\.values\(\)\) \{/.test(line)) return;
    // 从循环起始行做花括号配平，取出循环体。
    let depth = 0;
    let body = '';
    for (let i = index; i < lines.length; i += 1) {
      body += `${lines[i]}\n`;
      for (const char of lines[i]) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
      }
      if (depth === 0 && i > index) break;
    }
    if (!/socket\.emit\(/.test(body)) return; // 不发数据的循环不需要这道闸
    if (/deviceApproved/.test(body)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });

  assert.deepEqual(
    offenders,
    [],
    '这些广播循环没有过滤未批准设备。pending 设备持有有效会话但人还没点同意，'
    + '它不该看到审批命令、宿主机路径或会话名。加上 `if (socket.deviceApproved !== true) continue;`。',
  );
});
