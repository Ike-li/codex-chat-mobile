# Codex App-Server Protocol Upgrade Runbook

1. Update `.codex-version` to the target `@openai/codex` version.
2. Install that exact CLI locally: `npm i -g @openai/codex@$(cat .codex-version)`.
3. Regenerate the stable baseline: `codex app-server generate-ts --out .protocol/stable`.
4. Run `npm run protocol:check`.
5. If the report shows method or type drift, update the bridge mappings and regenerate `.protocol/stable` until the check passes.
6. Run the four regression layers: `npm run lint`, `npm test`, coverage checks, and Playwright E2E.
7. Do a real-device smoke test before merging.
