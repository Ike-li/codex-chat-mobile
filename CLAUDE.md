# AGENTS.md

## 项目规则

- 和软件相关的修改默认遵循 TDD：先写能表达预期的失败测试，再做最小实现或文档修复，最后运行真实验证。
- 先读现有代码、测试和文档；不要凭项目名或旧方案稿猜架构。
- 生产基线是通过 stdio 运行的 `codex app-server`，不再使用旧的 `codex exec --json` 方案。
- 默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server。
- 不要提交本地状态、密钥、运行日志、Playwright 报告、`.playwright-mcp/` 或 `data/`。

## 常用命令

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

## 维护文档

- `README.md`：英文项目概览（开源主入口）。
- `README.zh-CN.md`：README 的中文镜像，必须与英文版同步维护。
- `CONTRIBUTING.md`：贡献流程、测试门禁和 PR 约定（英文）。
- `SECURITY.md`：威胁模型、部署规则和漏洞披露（英文）。
- `LICENSE`：AGPL-3.0 全文，与 package.json 的 `license` 字段保持一致。
- `ROADMAP.md`：已完成 / 进行中 / 候选（英文）。
- `docs/GETTING_STARTED.md`：Web 端首次成功教程。
- `docs/WEB_UI_MAP.md`：页面区域、状态和操作入口参考。
- `docs/RECIPES.md`：常见 Web 端任务配方。
- `docs/CAPABILITY_MATRIX.md`：功能条件、返回和持久化矩阵。
- `docs/TROUBLESHOOTING.md`：按症状组织的 Web 端故障排查。
- `docs/CONCEPTS.md`：thread/runtime、可靠投递和跨端共享解释。
- `docs/WEB_CAPABILITIES.md`：Web 端完整能力参考。
- `docs/SHOWCASE.md`：功能巡览（截图取自 mock，零额度）。
- `docs/GUIDE.md`：端到端使用走查。
- `docs/REMOTE_ACCESS.md`：从手机连接的 HTTPS/PWA/Push 硬限制与方案。
- `docs/ARCHITECTURE.md`：当前架构和安全模型。
- `docs/PROTOCOL.md`：Codex app-server 协议参考。
- `docs/API.md`：接口参考（HTTP + Socket.IO 事件签名）。
- `docs/TESTING.md`：测试门禁、验收矩阵和手工冒烟清单。
- `docs/SMOKE_MATRIX.md`：71 条可视化验收用例（判据为可见画面，人与浏览器智能体通用）。
- `docs/PROTOCOL_UPGRADE.md`：Codex app-server 协议升级流程。
- `docs/archive/`：历史存档，不再维护，不作为事实来源。

文档结构由 `test/acceptance-doc.test.mjs` 契约测试守护；调整文档结构时先改契约测试。
