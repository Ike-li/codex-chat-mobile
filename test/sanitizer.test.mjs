// test/sanitizer.test.mjs —— 日志脱敏模块单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, maskToken, sanitizePath, stripControlSequences } from '../sanitizer.js';

// ---- stripControlSequences ----

test('stripControlSequences: 清除 ANSI 转义序列', () => {
  assert.equal(stripControlSequences('\x1b[32mPASS\x1b[0m'), 'PASS');
  assert.equal(stripControlSequences('\x1b[1;31mERROR\x1b[0m'), 'ERROR');
  assert.equal(stripControlSequences('no escapes'), 'no escapes');
});

test('stripControlSequences: 清除控制字符', () => {
  assert.equal(stripControlSequences('hello\x00world'), 'helloworld');
  assert.equal(stripControlSequences('line\x08back'), 'lineback');
});

test('stripControlSequences: 非字符串返回空', () => {
  assert.equal(stripControlSequences(null), '');
  assert.equal(stripControlSequences(undefined), '');
  assert.equal(stripControlSequences(123), '');
});

// ---- maskToken ----

test('maskToken: 遮蔽长 token', () => {
  assert.equal(maskToken('sk-abc123def456ghi789'), 'sk-a****i789');
});

test('maskToken: 短 token 全部遮蔽', () => {
  assert.equal(maskToken('short'), '***');
  assert.equal(maskToken('12345678901'), '***'); // 11 chars
});

test('maskToken: 空/null 返回 ***', () => {
  assert.equal(maskToken(''), '***');
  assert.equal(maskToken(null), '***');
  assert.equal(maskToken(undefined), '***');
});

test('maskToken: 正好 12 字符显示首尾', () => {
  assert.equal(maskToken('123456789012'), '1234****9012');
});

// ---- sanitizePath ----

test('sanitizePath: 替换 macOS 用户目录', () => {
  assert.equal(sanitizePath('/Users/raylee/code/test'), '<home>/code/test');
});

test('sanitizePath: 替换 Linux 用户目录', () => {
  assert.equal(sanitizePath('/home/user/projects'), '<home>/projects');
});

test('sanitizePath: 替换 /tmp/', () => {
  assert.equal(sanitizePath('/tmp/test-file'), '<tmp>/test-file');
});

test('sanitizePath: 替换 /var/', () => {
  assert.equal(sanitizePath('/var/log/test'), '<var>/log/test');
});

test('sanitizePath: 替换 Windows 路径', () => {
  assert.equal(sanitizePath('C:\\Users\\admin\\file'), '<home>\\file');
  assert.equal(sanitizePath('C:\\Windows\\System32'), '<windows>\\System32');
  assert.equal(sanitizePath('C:\\Program Files\\app'), '<program-files>\\app');
});

test('sanitizePath: 非字符串返回空', () => {
  assert.equal(sanitizePath(null), '');
  assert.equal(sanitizePath(undefined), '');
});

// ---- sanitize (集成测试) ----

test('sanitize: 清除 OpenAI API key', () => {
  assert.equal(sanitize('key=sk-abc123def456ghi789jkl'), 'key=***');
  assert.equal(sanitize('api-key=sk_test_abcdefghijklmnop'), 'api-key=***');
});

test('sanitize: 清除 GitHub token', () => {
  assert.equal(sanitize('ghp_abcdefghij1234567890abcdef'), '***');
  assert.equal(sanitize('gho_abcdefghij1234567890abcdef'), '***');
  assert.equal(sanitize('github_pat_abcdefghij1234567890abcdef'), '***');
});

test('sanitize: 清除 JWT token', () => {
  assert.equal(sanitize('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl'), '***');
});

test('sanitize: 清除私钥', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIB...data...\n-----END RSA PRIVATE KEY-----';
  assert.equal(sanitize(key), '***');
});

test('sanitize: 清除 Bearer token', () => {
  assert.equal(sanitize('Authorization: Bearer abcdefghij1234567890abcdef'), 'Authorization: Bearer ***');
});

test('sanitize: 清除环境变量中的 secret', () => {
  assert.equal(sanitize('SECRET_KEY=supersecretvalue123'), 'SECRET_KEY=***');
  assert.equal(sanitize('password = mysecretpass'), 'password = ***');
});

test('sanitize: 清除 AWS 凭证', () => {
  assert.equal(sanitize('AKIAIOSFODNN7EXAMPLE'), '***');
  assert.equal(sanitize('AWS_SESSION_TOKEN=faketoken123'), '***');
});

test('sanitize: 清除 Anthropic API key', () => {
  assert.equal(sanitize('sk-ant-abcdefghij1234567890abcdef'), '***');
});

test('sanitize: 清除 URL 中的密码', () => {
  assert.equal(sanitize('https://user:password123@example.com'), 'https://user:***@example.com');
});

test('sanitize: 清除 Basic auth', () => {
  assert.equal(sanitize('Basic dXNlcjpwYXNz'), 'Basic ***');
});

test('sanitize: 保留普通文本', () => {
  assert.equal(sanitize('hello world'), 'hello world');
  assert.equal(sanitize('no secrets here'), 'no secrets here');
});

test('sanitize: 非字符串返回空', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(123), '');
});
