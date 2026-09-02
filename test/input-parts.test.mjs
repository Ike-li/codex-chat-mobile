import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInputParts } from '../input-parts.js';

test('resolveInputParts canonicalizes a workspace mention inside the runtime cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-mention-'));
  try {
    mkdirSync(join(cwd, 'src'));
    const filePath = join(cwd, 'src', 'server.js');
    writeFileSync(filePath, 'export const ok = true;');

    const parts = await resolveInputParts([{
      kind: 'mention',
      name: 'untrusted-name',
      path: filePath,
    }], { cwd });

    assert.deepEqual(parts, [{
      kind: 'mention',
      name: 'src/server.js',
      path: realpathSync(filePath),
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts accepts only an enabled skill returned by skills/list', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-skill-'));
  try {
    const skillPath = '/trusted/skills/release/SKILL.md';
    const parts = await resolveInputParts([{
      kind: 'skill',
      name: 'release',
      path: skillPath,
    }], {
      cwd,
      skillEntries: [{
        cwd,
        skills: [
          { name: 'disabled', path: '/trusted/skills/disabled/SKILL.md', enabled: false },
          { name: 'release', path: skillPath, enabled: true },
        ],
      }],
    });

    assert.deepEqual(parts, [{ kind: 'skill', name: 'release', path: skillPath }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts admits an HTTPS image URL only through the explicit remote-image gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-url-'));
  try {
    const parts = await resolveInputParts([{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }], {
      cwd,
      allowRemoteImages: true,
      resolveHostname: async hostname => {
        assert.equal(hostname, 'images.example.test');
        return ['93.184.216.34'];
      },
    });

    assert.deepEqual(parts, [{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects site-local IPv6 remote image resolution', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-site-local-'));
  try {
    await assert.rejects(
      resolveInputParts([{
        kind: 'imageUrl',
        url: 'https://images.example.test/reference.png',
      }], {
        cwd,
        allowRemoteImages: true,
        resolveHostname: async () => ['fec0::1234'],
      }),
      /non-public address/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects an unsupported browser-supplied part kind', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-unsupported-'));
  try {
    await assert.rejects(
      resolveInputParts([{ kind: 'rawAppServerInput', type: 'text', text: 'bypass' }], { cwd }),
      /Unsupported input part kind/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// 远程图片 URL 由浏览器提供，来自信任边界之外。默认这条路是关的；一旦显式打开，
// 每一层校验都得在真正发起请求之前挡住 —— 否则服务端就成了让人代打内网的跳板。
// 下面用一个「被调用就失败」的解析桩，确保拒绝发生在解析之前那一层。
function refuseDns(label = 'DNS') {
  return async () => { throw new Error(`${label} 不该被调用`); };
}

async function rejectsImageUrl(part, message, options = {}) {
  await assert.rejects(
    resolveInputParts([{ kind: 'imageUrl', ...part }], {
      cwd: tmpdir(),
      allowRemoteImages: true,
      resolveHostname: refuseDns(),
      ...options,
    }),
    message,
  );
}

test('远程图片 URL：畸形、超长、非 HTTPS、带凭证的一律在解析前拒绝', async () => {
  await rejectsImageUrl({ url: 'not a url' }, /URL is invalid/);
  await rejectsImageUrl({ url: '' }, /URL is invalid/);
  await rejectsImageUrl({ url: 42 }, /URL is invalid/);
  await rejectsImageUrl({ url: `https://a.example/${'x'.repeat(2100)}` }, /URL is invalid/);
  await rejectsImageUrl({ url: 'http://images.example.test/a.png' }, /HTTPS without credentials/);
  await rejectsImageUrl({ url: 'https://user@images.example.test/a.png' }, /HTTPS without credentials/);
  await rejectsImageUrl({ url: 'https://user:pw@images.example.test/a.png' }, /HTTPS without credentials/);
});

// 内网拦截实际走三条路，分开表达才不会把结论记反：
//   1. localhost 这类保留名 —— 主机名闸拦下，不查 DNS
//   2. IPv4 私网字面量 —— isIP 认出来后直接过地址闸，也不查 DNS
//   3. 其他名字（含 [::1]，方括号让 isIP 判不出来）—— 解析一次，再过地址闸
// 共同性质是三条都 fail closed；下面连「查没查 DNS」一起断言，免得日后有人
// 以为字面量也走解析，从而在错误的地方加缓存或放宽。
test('远程图片 URL：保留主机名在主机名闸拦下，不查 DNS', async () => {
  let resolved = 0;
  await rejectsImageUrl(
    { url: 'https://localhost/a.png' },
    /hostname is not allowed/,
    { resolveHostname: async () => { resolved += 1; return ['127.0.0.1']; } },
  );
  assert.equal(resolved, 0);
});

test('远程图片 URL：私网 IPv4 字面量过地址闸，不查 DNS', async () => {
  let resolved = 0;
  const countingDns = { resolveHostname: async () => { resolved += 1; return ['93.184.216.34']; } };
  for (const host of ['10.1.2.3', '192.168.0.1', '169.254.169.254', '127.0.0.1']) {
    await rejectsImageUrl({ url: `https://${host}/a.png` }, /resolves to a non-public address/, countingDns);
  }
  assert.equal(resolved, 0, 'IP 字面量不需要解析；如果这里变成非 0，说明字面量分支被绕过了');
});

test('远程图片 URL：普通主机名解析一次，解到环回地址仍然拒绝', async () => {
  let resolved = 0;
  await rejectsImageUrl(
    { url: 'https://internal.corp.example/a.png' },
    /resolves to a non-public address/,
    { resolveHostname: async () => { resolved += 1; return ['127.0.0.1']; } },
  );
  assert.equal(resolved, 1, '名字必须真的过一次解析，光看字面量拦不住内部 DNS');
});

test('远程图片 URL：解析结果只要有一个非公网地址就整体拒绝', async () => {
  for (const answer of [[], ['93.184.216.34', '127.0.0.1'], null, 'not-an-array']) {
    await rejectsImageUrl(
      { url: 'https://images.example.test/a.png' },
      /resolves to a non-public address/,
      { resolveHostname: async () => answer },
    );
  }
});

test('远程图片 URL：detail 只接受协议认可的四个取值', async () => {
  const ok = { resolveHostname: async () => ['93.184.216.34'] };
  for (const detail of ['auto', 'low', 'high', 'original']) {
    const parts = await resolveInputParts(
      [{ kind: 'imageUrl', url: 'https://images.example.test/a.png', detail }],
      { cwd: tmpdir(), allowRemoteImages: true, ...ok },
    );
    assert.equal(parts[0].detail, detail);
  }
  await rejectsImageUrl({ url: 'https://images.example.test/a.png', detail: 'huge' }, /detail is invalid/, ok);
});

test('远程图片 URL：不带 detail 时不要在结果里塞一个空字段', async () => {
  const parts = await resolveInputParts(
    [{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }],
    { cwd: tmpdir(), allowRemoteImages: true, resolveHostname: async () => ['93.184.216.34'] },
  );
  assert.deepEqual(parts, [{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }]);
});

test('远程图片 URL：门没打开时，连合法的公网地址也不放行', async () => {
  await assert.rejects(
    resolveInputParts([{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }], {
      cwd: tmpdir(),
      resolveHostname: refuseDns(),
    }),
    /.+/,
    'allowRemoteImages 缺省即关闭，这是默认安全的那一半',
  );
});
