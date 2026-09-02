// e2e/assert-mock-backend.js —— Playwright globalSetup：确认 E2E 接的是 mock，不是真 Codex CLI。
//
// 为什么需要运行时检查而不是静态检查配置：playwright.config.js 里
// `reuseExistingServer: !process.env.CI` 在本地是 true。如果 E2E 端口上恰好已经跑着
// 一个接了真 Codex CLI 的 server（比如自己开着调试实例，或 PORT 被设成了同一个值），
// Playwright 会直接复用它，整轮 E2E 就跑在真 CLI 上烧模型额度 —— 项目规则要求日常回归零额度。
// 配置文件本身是对的，错的是运行环境，只有向正在监听的后端问一句才拦得住。
//
// 判据取 /health 的 versions.codex：mock 报 "mock-codex 0.1.0"，真 CLI 报 "codex-cli 0.147.0"。
// 这个值来自 server.js 启动时对 CODEX_BIN 执行 `--version`，是后端真实接了谁的直接证据。

const MOCK_VERSION_PREFIX = 'mock-codex';

async function probeHealth(url, { attempts = 6, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      return response;
    } catch {
      // 端口上没人监听。等一下再试，避免把「mock 还在启动」误判成「没有 server」。
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}

export default async function assertMockBackend(config) {
  const port = config?.webServer?.port ?? config?.webServer?.[0]?.port;
  if (!port) {
    throw new Error('assert-mock-backend: 读不到 playwright.config.js 的 webServer.port');
  }
  const healthUrl = `http://127.0.0.1:${port}/health`;

  const response = await probeHealth(healthUrl);
  if (!response) {
    // 端口空着：Playwright 接下来会用 webServer.command 起 mock，没有复用风险。
    return;
  }

  if (!response.ok) {
    throw new Error(
      `assert-mock-backend: ${port} 端口上有服务在跑，但 /health 返回 ${response.status}。\n`
      + 'mock server 的 AUTH_TOKEN 是空的，/health 应该直接可读；需要鉴权说明这不是 mock。\n'
      + `先停掉它：lsof -ti :${port} | xargs kill`,
    );
  }

  const body = await response.json().catch(() => null);
  const codexVersion = String(body?.versions?.codex ?? '');
  if (!codexVersion.startsWith(MOCK_VERSION_PREFIX)) {
    throw new Error(
      `assert-mock-backend: ${port} 端口上跑的不是 mock —— /health 报告 CODEX_BIN 是 "${codexVersion || '(未知)'}"。\n`
      + 'reuseExistingServer 会复用它，整轮 E2E 将跑在真 Codex CLI 上并消耗模型额度。\n'
      + `先停掉它：lsof -ti :${port} | xargs kill`,
    );
  }
}
