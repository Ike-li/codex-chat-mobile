# 协议升级操作手册

升级 pin 住的 Codex CLI app-server 协议时使用这份流程。

## 步骤

1. 将 `.codex-version` 更新为目标 `@openai/codex` 版本。
2. 本地安装完全一致的 CLI：

   ```bash
   npm i -g @openai/codex@$(cat .codex-version)
   ```

3. 重新生成稳定协议导出：

   ```bash
   codex app-server generate-ts --out .protocol/stable
   ```

4. 运行漂移检查：

   ```bash
   npm run protocol:check
   ```

5. 如果报告出现 method 或 type 漂移，先更新 `agent-appserver.js`、协议 fixtures 和聚焦测试，再重新生成基线。
6. 运行完整验证包：

   ```bash
   npm run lint
   npm test
   npm run protocol:check
   npm run test:e2e
   ```

7. 确定性门禁通过后，再做真实设备冒烟。

## 规则

- 不能把服务成功启动当成协议兼容的证明。
- experimental app-server 方法必须留在产品门控之后。
- 未知 item 或 notification type 必须保留可见兜底信封。
- 日常 Playwright 路径必须保持 mock 驱动、零 token。
