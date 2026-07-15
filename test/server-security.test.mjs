import { test } from 'node:test';
import assert from 'node:assert/strict';
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
