// 远程浏览器能不能连上网关。
//
// 这是本产品的主用途（手机连开发机），却一直没有任何测试覆盖，因为整套 E2E 都跑在
// loopback 上 —— 而 loopback 恰好走的是 evaluateSocketHandshakeSecurity 里**另一条**分支。
// 实跑 docs/SMOKE_MATRIX.md 的 VC-A02 时才发现：远程端的 socket 握手一律 403
// origin_required，页面停在断线横幅，永远到不了设备配对画面。
//
// 成因是三件事叠加，单看每一件都正常：
//   1. socket.io 默认先试 polling，失败才升级 websocket；
//   2. 浏览器对**同源** XHR 不发 Origin 头（跨源才发）；
//   3. 服务端对 remote 连接强制要求 Origin。
// 而真实远程部署（Tailscale Serve / cloudflared / HTTPS 反代）里，页面和 socket 永远同源。
// 于是 CODEX_ALLOWED_ORIGINS 白名单根本没机会被查 —— 它匹配的那个头压根没送来。
//
// 不需要局域网：isLocalAccess 要求 remoteAddress 和 Host 头**都**是 loopback，所以把
// 浏览器指到一个解析回 127.0.0.1 的非 loopback 主机名，就能走到远程那条分支。
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3401;
const HOSTNAME = 'gateway.test';
const ORIGIN = `http://${HOSTNAME}:${PORT}`;
// 一次性的本地凭据，随进程消失；不是任何真实部署的口令。
const TOKEN = 'e2e-remote-origin-handshake-token-0001';

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`] } });

let server;

test.beforeAll(async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ccm-remote-'));
  const dataDir = join(workDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'trusted-devices.json'), '[]');
  writeFileSync(join(dataDir, 'pending-devices.json'), '[]');
  writeFileSync(join(workDir, 'README.md'), 'remote origin handshake\n');

  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      // 后端仍是 mock：这条用例验的是网关的握手闸，不消耗任何模型额度。
      CODEX_BIN: join(ROOT, 'scripts/mock-codex.sh'),
      PORT: String(PORT),
      HOST: '127.0.0.1',
      WORK_DIR: workDir,
      WORK_DIRS: workDir,
      CODEX_DATA_DIR: dataDir,
      CODEX_SANDBOX: 'read-only',
      CODEX_APPROVAL_POLICY: 'on-request',
      AUTH_TOKEN: TOKEN,
      // 本机验收专用，等价于自愿放弃传输层加密；真实部署必须保持 0。
      CODEX_ALLOW_INSECURE_REMOTE: '1',
      CODEX_ALLOWED_ORIGINS: ORIGIN,
    },
    stdio: 'ignore',
  });

  // 判「在听」而不是判「200」：设了 AUTH_TOKEN 之后 /health 本身要鉴权，会回 401。
  // 拿 .ok 当就绪条件会一直等到超时，而服务其实早就起来了。
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`);
      return;
    } catch { /* 还没开始监听 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('远程握手用的网关没能在 18 秒内起来');
});

test.afterAll(() => server?.kill());

test('一台远程设备能连上网关并停在设备配对画面', async ({ page }) => {
  const rejections = [];
  page.on('response', async response => {
    if (!response.url().includes('socket.io/?')) return;
    if (response.status() < 400) return;
    rejections.push(`${response.status()} ${(await response.text().catch(() => '')).slice(0, 60)}`);
  });

  await page.goto(ORIGIN);
  await page.locator('#auth-token-input').fill(TOKEN);
  await page.locator('#auth-submit').click();

  // 判据是用户看得见的画面：整屏的「等待设备授权」，而不是断线横幅。
  // 不能把 rejections 拼进 expect 的 message —— 那个字符串在**调用时**就求值了，
  // 那会儿一次重试都还没发生，失败信息永远是空的。等断言真的失败了再去读。
  try {
    await expect(page.locator('#device-auth')).toBeVisible({ timeout: 20000 });
  } catch (err) {
    throw new Error(
      `远程设备没能连上网关，停在了断线画面。socket 握手被拒：`
      + `${rejections.join(' / ') || '(没抓到 4xx，病因在别处)'}\n${err.message}`,
    );
  }

  // 待批设备必须看到自己的设备号，否则用户无从批准。
  await expect(page.locator('#device-id-display')).not.toBeEmpty();

  expect(rejections, 'socket 握手不应当出现 4xx').toEqual([]);
});
