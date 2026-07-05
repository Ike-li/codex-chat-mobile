# Sprint Test Plan — Sprint 1: QA Foundation

> **Sprint:** 2026-07-02 → 2026-07-15 (2 周)  
> **Owner:** Ike-li  
> **Strategy:** [docs/qa-strategy.md](../qa-strategy.md)  
> **Context:** [.agents/qa-project-context.md](../.agents/qa-project-context.md)

---

## Scope

### 目标

建立可运行的测试基线：修复现有测试问题、配置覆盖率度量、搭建 CI、补充高风险模块单元测试。

### In-Scope 功能

| # | 功能 | 变更类型 | 风险等级 | 优先级 |
|---|------|---------|---------|--------|
| F1 | 测试基础设施修复 | 修复 | Critical | P0 |
| F2 | 覆盖率工具配置 | 新增 | High | P0 |
| F3 | GitHub Actions CI | 新增 | High | P0 |
| F4 | 安全模块单元测试 | 新增 | Critical | P0 |
| F5 | 协议模块单元测试 | 新增 | Critical | P0 |
| F6 | 文件操作模块单元测试 | 新增 | High | P1 |

### Out-of-Scope

- E2E 测试（Phase 2）
- 视觉回归测试
- 性能/负载测试
- 前端 SPA 单元测试（需要 jsdom 或浏览器环境，defer 到 Phase 2）

---

## Coverage Summary

### 当前状态

| 指标 | 值 |
|------|-----|
| 测试文件数 | 7 |
| 测试行数 | 931 |
| 通过率 | 6/7 (86%) — `new-modules.test.mjs` 悬挂 |
| 覆盖率 | 未度量 |
| CI | 无 |

### 目标状态（Sprint 结束）

| 指标 | 目标 |
|------|------|
| 测试通过率 | 100% (7/7 或更多) |
| 业务逻辑覆盖率 | ≥80%（安全/协议模块 ≥90%） |
| CI 反馈时间 | <5 分钟 |
| 测试文件数 | ≥12（新增 5+ 个测试文件） |

---

## Feature Decomposition & Test Scenarios

### F1: 测试基础设施修复

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F1.1 | `new-modules.test.mjs` 悬挂测试修复 — mock `session.send()` 依赖 | 修复 | P0 |
| F1.2 | 测试文件拆分 — 将 `new-modules.test.mjs` 拆分为 `uploads.test.mjs`, `statusline.test.mjs`, `history.test.mjs` | 重构 | P1 |
| F1.3 | 测试文件迁移至源文件同目录（co-located） | 重构 | P2 |

### F2: 覆盖率工具配置

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F2.1 | 安装 c8 作为 devDependency | 配置 | P0 |
| F2.2 | 配置 c8 覆盖率报告（text + lcov） | 配置 | P0 |
| F2.3 | 添加 `npm run coverage` 脚本 | 配置 | P0 |
| F2.4 | 建立覆盖率基线报告 | 度量 | P0 |

### F3: GitHub Actions CI

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F3.1 | 创建 `.github/workflows/test.yml` — PR 触发 | 配置 | P0 |
| F3.2 | 配置 Node.js 20 矩阵 | 配置 | P0 |
| F3.3 | 集成 c8 覆盖率报告到 CI | 配置 | P1 |
| F3.4 | 配置分支保护规则 — CI 不通过不允许合并 | 配置 | P1 |

### F4: 安全模块单元测试

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F4.1 | `server-security.js` — `isLocalAccess()` 正确识别本地/远程地址 | 单元 | P0 |
| F4.2 | `server-security.js` — `isLoopbackAddress()` IPv4/IPv6 边界 | 单元 | P0 |
| F4.3 | `server-security.js` — `isLoopbackHostHeader()` 防 Host 头注入 | 单元 | P0 |
| F4.4 | `server-security.js` — `normalizeAddress()` 格式化正确性 | 单元 | P0 |
| F4.5 | `devices.js` — `isDeviceTrusted()` 白名单逻辑 | 单元 | P0 |
| F4.6 | `devices.js` — `addPendingDevice()` / `approveDevice()` / `denyDevice()` 状态流转 | 单元 | P0 |
| F4.7 | `devices.js` — `getLatestPendingDevice()` 边界（空列表、多设备） | 单元 | P1 |
| F4.8 | `server.js` AUTH_TOKEN — timingSafeEqual 正确性（相同/不同 token） | 单元 | P0 |
| F4.9 | `server.js` AUTH_TOKEN — 空 token 拒绝非 loopback 绑定 | 单元 | P0 |

### F5: 协议模块单元测试

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F5.1 | `agent-appserver.js` — `handleNotification()` 所有 item 类型映射 | 单元 | P0 |
| F5.2 | `agent-appserver.js` — `item/agentMessage/delta` 流式文本累积 | 单元 | P0 |
| F5.3 | `agent-appserver.js` — `item/completed(commandExecution)` → tool_result | 单元 | P0 |
| F5.4 | `agent-appserver.js` — `turn/completed` / `turn/failed` 状态转换 | 单元 | P0 |
| F5.5 | `agent-appserver.js` — `thread/tokenUsage/updated` 事件映射 | 单元 | P1 |
| F5.6 | `agent-appserver.js` — `turn/diff/updated` 事件映射 | 单元 | P1 |
| F5.7 | `agent-appserver.js` — 未知通知类型静默忽略 | 单元 | P1 |

### F6: 文件操作模块单元测试

| ID | 场景 | 类型 | 优先级 |
|----|------|------|--------|
| F6.1 | `uploads.js` — `validateAttachments()` 文件数量上限 | 单元 | P1 |
| F6.2 | `uploads.js` — `validateAttachments()` 单文件大小上限 (10MB) | 单元 | P1 |
| F6.3 | `uploads.js` — `validateAttachments()` 缺少 data 字段 | 单元 | P1 |
| F6.4 | `uploads.js` — `saveAttachments()` 写入权限 0600 | 单元 | P1 |
| F6.5 | `uploads.js` — `pruneExpiredUploads()` 过期清理 | 单元 | P1 |
| F6.6 | `file-security.js` — `writeOwnerOnlyFile()` 权限正确性 | 单元 | P1 |

---

## Effort Estimation

| 类别 | 测试数 | 编写时间 | 执行时间 | 合计 |
|------|--------|---------|---------|------|
| F1: 基础设施修复 | 3 | 4h | — | 4h |
| F2: 覆盖率配置 | 4 | 2h | — | 2h |
| F3: CI 配置 | 4 | 3h | — | 3h |
| F4: 安全模块测试 | 9 | 5h | <1m | 5h |
| F5: 协议模块测试 | 7 | 4h | <1m | 4h |
| F6: 文件操作测试 | 6 | 3h | <1m | 3h |
| **缓冲（25%）** | — | — | — | **6h** |
| **总计** | **33** | **21h** | — | **27h** |

**可用容量：** 2 周 × 5 天 × 4 小时（开发时间的 50% 分配给测试）= 40 小时  
**计划使用：** 21 小时 (53%)  
**缓冲：** 6 小时 (15%)  
**剩余容量：** 13 小时 (32%) — 用于 bug 修复、意外问题、探索性测试

---

## Prioritization Matrix

```
        HIGH RISK
           │
    F4.1-4.9 (安全)  │  F5.1-5.4 (协议核心)
    F1.1 (悬挂修复)   │
    F3.1-3.2 (CI)    │
           │
  ─────────┼─────────────────────────
           │
    F2.1-2.4 (覆盖率) │  F5.5-5.7 (协议边缘)
    F6.1-6.6 (文件)   │  F1.2-1.3 (重构)
           │
        LOW RISK
        
  ← LOW EFFORT          HIGH EFFORT →
```

**执行顺序：**
1. **DO FIRST:** F1.1 → F4.1-4.9 → F3.1-3.2（高风险 + 低/中 effort）
2. **DO SECOND:** F5.1-5.4 → F2.1-2.4（高风险 + 中 effort）
3. **DO THIRD:** F6.1-6.6 → F5.5-5.7（中风险 + 低 effort）
4. **DEFER:** F1.2-1.3（低风险 + 中 effort — 重构可后续进行）

---

## Resource Allocation

| 任务 | 负责人 | 工时 | 备注 |
|------|--------|------|------|
| F1: 基础设施修复 | Ike-li | 4h | 需理解 session.send() 依赖链 |
| F2: 覆盖率配置 | Ike-li | 2h | c8 安装 + npm scripts |
| F3: CI 配置 | Ike-li | 3h | GitHub Actions YAML |
| F4: 安全模块测试 | Ike-li | 5h | 需深入理解安全边界 |
| F5: 协议模块测试 | Ike-li | 4h | 已有部分测试，补充覆盖 |
| F6: 文件操作测试 | Ike-li | 3h | 部分已有，补充边界条件 |
| 缓冲 | — | 6h | Bug 修复 + 探索性测试 |

**利用率：** 21h / 40h = 53%（留有充足缓冲）

---

## Entry/Exit Criteria

### Entry Criteria

- [x] `.agents/qa-project-context.md` 已创建
- [x] `docs/qa-strategy.md` 已创建
- [ ] `npm test` 可运行（6/7 通过，1 个已知悬挂）
- [ ] 开发环境 Node.js ≥20 可用

### Exit Criteria

- [ ] `npm test` 100% 通过（无悬挂、无跳过）
- [ ] c8 覆盖率报告显示业务逻辑 ≥80%
- [ ] GitHub Actions CI 在 PR 时自动运行测试
- [ ] 安全模块（server-security, devices）覆盖率 ≥90%
- [ ] 协议模块（agent-appserver）覆盖率 ≥80%
- [ ] 所有新增测试有清晰的中文描述

---

## Schedule

| 天 | 任务 | 产出 |
|----|------|------|
| D1 | F1.1 修复悬挂测试；F2.1-2.3 c8 配置 | `npm test` 100% 通过；`npm run coverage` 可用 |
| D2 | F2.4 覆盖率基线；F3.1-3.2 CI 配置 | 覆盖率基线报告；GitHub Actions workflow |
| D3 | F4.1-4.5 安全模块测试（server-security） | server-security 覆盖率 ≥90% |
| D4 | F4.6-4.9 安全模块测试（devices + AUTH_TOKEN） | 安全模块覆盖率 ≥90% |
| D5 | F5.1-5.4 协议模块核心测试 | agent-appserver 核心事件映射覆盖 |
| D6 | F5.5-5.7 协议模块边缘测试；F6.1-6.3 文件操作测试 | 协议覆盖率 ≥80%；文件验证覆盖 |
| D7 | F6.4-6.6 文件操作测试；F3.3-3.4 CI 集成 | 文件操作覆盖率达标；CI 完整配置 |
| D8-9 | 缓冲：bug 修复、覆盖率缺口补充 | 覆盖率目标达成 |
| D10 | 验收：运行完整套件、覆盖率报告、CI 验证 | Sprint 完成 |

---

## Plan Risks

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `session.send()` 修复比预期复杂 | F1 延迟，阻塞后续 | 优先 mock 方案，必要时 skip 该测试 |
| c8 与 ESM 兼容性问题 | F2 延迟 | 备选方案：使用 `--experimental-test-coverage` |
| GitHub Actions 配置问题 | F3 延迟 | 本地先用 `act` 测试 workflow |
| 安全模块测试发现设计缺陷 | F4 超时 | 记录 issue，defer 修复到下个 sprint |
| codex CLI 依赖导致测试不稳定 | 测试 flaky | 所有单元测试 mock codex 依赖 |

---

## Daily Tracking

| 天 | 计划 | 实际 | 阻塞 | Bug 发现 | 缓冲消耗 |
|----|------|------|------|---------|---------|
| D1 | | | | | |
| D2 | | | | | |
| D3 | | | | | |
| D4 | | | | | |
| D5 | | | | | |
| D6 | | | | | |
| D7 | | | | | |
| D8 | | | | | |
| D9 | | | | | |
| D10 | | | | | |
