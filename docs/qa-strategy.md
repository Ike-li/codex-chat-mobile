# QA Strategy — codex-chat-mobile

> **Owner:** Ike-li  
> **Created:** 2026-07-02  
> **Review cadence:** Quarterly  
> **Maturity:** Growing  
> **Last revised:** 2026-07-02

---

## 1. Executive Summary

codex-chat-mobile 是一个将本地 Codex CLI 投送到手机的开源桥接工具。当前有 7 个测试文件（931 行），使用 `node:test` 原生框架，无 CI/CD、无 E2E、无覆盖率度量。

**核心策略：** 以安全边界和协议兼容性为最高优先级，先建立单元测试基线（80%+ 覆盖率），再补充关键路径 E2E，最终通过 GitHub Actions 实现 PR 门禁。独立开发者场景下，测试投入聚焦高风险区域，避免过度工程化。

**关键指标：**
- 单元覆盖率：80%+（业务逻辑模块）
- E2E 覆盖：8 个关键用户旅程全覆盖
- 失败率：<2%（30 天滚动窗口）
- CI 反馈时间：<5 分钟（PR 级别）

---

## 2. Scope & Objectives

### In Scope

- **后端模块：** `server.js`, `agent-appserver.js`, `sessions.js`, `uploads.js`, `statusline.js`, `history.js`, `e2ee.js`, `server-security.js`, `sanitizer.js`, `devices.js`, `relay.js`, `push.js`
- **前端：** `public/index.html`（SPA）, Service Worker, Web Manifest
- **脚本：** `scripts/` 下的 smoke 测试和场景验收脚本
- **测试类型：** 单元测试、集成测试、E2E 测试、安全测试

### Out of Scope

- **Codex CLI 本身** — 只测试桥接层，不测试上游 codex 二进制
- **性能/负载测试** — 本地工具无高并发需求，暂不投入
- **视觉回归测试** — 单页面应用，UI 变化频繁，ROI 低
- **多浏览器兼容性** — 目标为现代移动浏览器（Chrome/Safari），不做 IE 兼容

### Objectives

| # | 目标 | 时间线 | 衡量标准 |
|---|------|--------|----------|
| O1 | 建立单元测试基线，覆盖所有业务逻辑模块 | 4 周内 | c8 报告显示 ≥80% 行覆盖率 |
| O2 | 修复悬挂测试，100% 测试可通过 | 1 周内 | `npm test` 退出码 0，无超时 |
| O3 | 配置 GitHub Actions CI，PR 自动运行测试 | 2 周内 | PR 提交后 <5 分钟收到 pass/fail |
| O4 | 为 8 个关键用户旅程建立 E2E 测试 | 8 周内 | Playwright 测试覆盖全部关键流程 |
| O5 | 建立安全测试覆盖（AUTH_TOKEN、设备认证、文件边界） | 6 周内 | 安全相关模块 100% 单元覆盖 |

---

## 3. Test Levels & Types

| Level | 覆盖范围 | 负责人 | 框架 | 目标占比 | 运行频率 |
|-------|---------|--------|------|---------|---------|
| **单元** | 函数级：输入输出、边界条件、错误处理 | 开发者 | `node:test` + `node:assert` | 70-80% | 每次提交 |
| **集成** | 模块交互：Socket.IO 事件流、JSON-RPC 通知映射、Express 路由 | 开发者 | `node:test` + `socket.io-client` | 15-20% | 每个 PR |
| **E2E** | 关键用户旅程：创建任务、审批、重连、设备认证 | 开发者 | Playwright（推荐） | 5-10% | PR smoke + 合并前完整 |
| **安全** | AUTH_TOKEN 鉴权、loopback 绑定、文件权限、CSP | 开发者 | `node:test` + 手动渗透 | 专项 | 每次发布前 |

### 测试类型补充说明

**单元测试** — 核心投入。覆盖所有业务逻辑模块的函数级测试，mock 外部依赖（codex CLI、文件系统、网络）。

**集成测试** — 验证模块间交互。Socket.IO 事件从 server.js 到 agent-appserver.js 的完整流转；JSON-RPC 通知到前端事件的映射链路。

**E2E 测试** — 仅覆盖关键路径。通过 Playwright 在真实浏览器中验证完整用户旅程，使用 mock codex app-server 避免依赖真实 CLI。

**安全测试** — 专项覆盖。AUTH_TOKEN timingSafeEqual 正确性、设备白名单绕过测试、WORK_DIR 边界 enforcement、文件上传权限验证。

---

## 4. Test Pyramid Analysis

### 当前状态

```
         E2E: 0 (0%)
        ┌─────────┐
        │  手工    │  ← docs/manual-test-cases.md
        │  验收    │  ← scripts/scenario-server.js
        └─────────┘
      集成: ~40% (~370 行)
    ┌─────────────────┐
    │ Socket.IO 事件流 │
    │ JSON-RPC 映射    │
    │ Express 路由     │
    └─────────────────┘
  单元: ~60% (~560 行)
┌───────────────────────┐
│ uploads / statusline  │
│ history / e2ee        │
│ sanitizer / devices   │
│ server-security       │
└───────────────────────┘
```

**当前形状：** 倒金字塔（缺少 E2E，集成偏多）— 集成测试占比高是因为现有测试主要验证事件映射契约，这本身是合理的。

**问题：**
- 无 E2E 层 — 关键用户旅程只有手工验收
- 覆盖率未度量 — 不知道实际缺口在哪里
- 1 个悬挂测试 — `new-modules.test.mjs` 的 `session.send()` 测试依赖真实 codex 二进制

### 目标状态

```
         E2E: 5-10% (~15 个测试)
        ┌─────────┐
        │ Playwright│  ← 8 个关键旅程
        │  测试    │
        └─────────┘
      集成: 15-20% (~30 个测试)
    ┌─────────────────┐
    │ Socket.IO 端到端 │
    │ JSON-RPC 完整流  │
    └─────────────────┘
  单元: 70-80% (~120 个测试)
┌───────────────────────┐
│ 所有业务逻辑模块       │
│ 边界条件 + 错误路径    │
└───────────────────────┘
```

**目标比率：** 单元 75% : 集成 18% : E2E 7%

**行动计划：**
1. **第一步：** 修复悬挂测试，度量当前覆盖率基线
2. **第二步：** 补充单元测试至 80% 覆盖率（优先安全和协议模块）
3. **第三步：** 建立 Playwright E2E，覆盖 8 个关键旅程
4. **第四步：** 集成测试保持现有水平，补充缺失的端到端链路

---

## 5. Risk Assessment Matrix

### 评分方法

Impact × Likelihood → 风险等级

| Impact | Likelihood | 得分 | 等级 |
|--------|-----------|------|------|
| 5 - 灾难性 | 5 - 几乎确定 | 25 | CRIT |
| 4 - 严重 | 4 - 很可能 | 16 | CRIT |
| 3 - 中等 | 3 - 可能 | 9 | MED |
| 2 - 轻微 | 2 - 不太可能 | 4 | LOW |
| 1 - 可忽略 | 1 - 罕见 | 1 | LOW |

### 风险矩阵

| 功能区域 | Impact | Likelihood | 得分 | 等级 | 测试策略 |
|---------|--------|-----------|------|------|---------|
| **安全边界**（AUTH_TOKEN、设备认证、loopback） | 5 | 4 | 20 | CRIT | 100% 单元覆盖 + 安全专项测试 + 手动渗透 |
| **协议兼容性**（JSON-RPC、事件映射） | 5 | 3 | 15 | CRIT | 契约测试 + 集成测试 + 上游变更监控 |
| **文件操作安全**（uploads、WORK_DIR 边界） | 4 | 3 | 12 | HIGH | 单元覆盖 + 边界条件测试 + 权限验证 |
| **实时通信**（Socket.IO、断线重连） | 3 | 3 | 9 | MED | 集成测试 + E2E 关键路径 |
| **辅助功能**（Push、E2EE、历史） | 2 | 2 | 4 | LOW | 单元测试覆盖主要路径 |

### 测试优先级排序

1. **P0 — 安全边界**：`server-security.js`, `devices.js`, AUTH_TOKEN 逻辑
2. **P0 — 协议兼容性**：`agent-appserver.js` 事件映射、JSON-RPC 通知处理
3. **P1 — 文件操作**：`uploads.js` 验证、权限、WORK_DIR 边界
4. **P1 — 核心流程**：创建任务、审批、断线重连（E2E）
5. **P2 — 辅助功能**：Push 通知、E2EE、历史解析

---

## 6. Environment Strategy

| 环境 | 用途 | 测试类型 | 数据 | 触发方式 |
|------|------|---------|------|---------|
| **本地开发** | 开发者反馈 | 单元、集成 | mock + 临时目录 | 保存时 |
| **CI** | 自动化验证 | 单元、集成、lint | 临时 | push/PR |
| **本地 E2E** | 关键路径验证 | E2E（Playwright） | mock codex app-server | 手动 + PR |

**环境说明：**
- 无远程部署 — 所有测试在本地或 CI runner 上运行
- codex CLI 依赖 — 单元测试 mock 掉 codex 二进制；集成/E2E 使用 mock app-server
- 测试数据策略 — `mkdtempSync` 创建临时目录，测试后自动清理

---

## 7. Tool Selection Rationale

### 工具选型矩阵

| 标准（权重） | node:test | Vitest | Jest |
|-------------|-----------|--------|------|
| **适配技术栈**（25%） | 5 — 原生，零依赖 | 4 — 需安装 | 3 — ESM 支持较弱 |
| **团队熟悉度**（20%） | 5 — 已在使用 | 3 — 需学习 | 3 — 需学习 |
| **社区与文档**（15%） | 3 — 较新，生态小 | 5 — 活跃 | 5 — 成熟 |
| **CI 集成**（15%） | 5 — 原生支持 | 5 — 优秀 | 4 — 需配置 |
| **维护成本**（10%） | 5 — 零依赖升级 | 4 — 较低 | 3 — 较高 |
| **执行速度**（10%） | 4 — 快 | 5 — 极快 | 4 — 快 |
| **许可证成本**（5%） | 5 — 免费 | 5 — 免费 | 5 — 免费 |
| **加权总分** | **4.55** | **4.25** | **3.55** |

**决策：** 保持 `node:test` 作为单元/集成测试框架。理由：已使用、零依赖、原生 ESM 支持、与 Node.js 版本同步演进。

### E2E 工具选型

| 标准（权重） | Playwright | Cypress | Puppeteer |
|-------------|-----------|---------|-----------|
| **移动浏览器支持**（30%） | 5 — 原生支持 | 3 — 有限 | 4 — Chrome only |
| **Socket.IO 测试**（25%） | 5 — 优秀 | 4 — 良好 | 3 — 需手动 |
| **学习曲线**（20%） | 4 — 中等 | 5 — 简单 | 3 — 较陡 |
| **社区活跃度**（15%） | 5 — 极活跃 | 4 — 活跃 | 3 — 维护模式 |
| **许可证**（10%） | 5 — Apache 2.0 | 5 — MIT | 5 — Apache 2.0 |
| **加权总分** | **4.75** | **3.85** | **3.55** |

**决策：** 推荐 Playwright 作为 E2E 框架。理由：移动浏览器支持优秀、Socket.IO 测试能力强、社区活跃。

### 覆盖率工具

**推荐 c8** — 原生 V8 覆盖率，零配置，与 node:test 无缝集成。替代 Istanbul（需要额外配置）。

---

## 8. CI Scaling Levers

当前规模无需复杂 CI 优化，但预留以下策略：

| 策略 | 适用场景 | 预期收益 |
|------|---------|---------|
| **测试文件并行** | node:test 原生支持 `--test-concurrency` | 单元测试时间减半 |
| **变更影响分析** | 仅运行受影响模块的测试 | PR 反馈时间 <2 分钟 |
| **E2E 分片** | Playwright `--shard` 参数 | E2E 时间线性缩短 |
| **依赖缓存** | GitHub Actions cache | 减少 npm install 时间 |

**当前目标：** PR 反馈 <5 分钟。如后续测试量增长超过 200 个，再启用分片和变更影响分析。

---

## 9. Entry/Exit Criteria

### 单元测试

**Entry：**
- 代码可编译（ESM 模块无语法错误）
- 函数有明确的输入/输出契约
- 外部依赖已 mock

**Exit：**
- 所有分支覆盖
- 边界条件测试通过
- 无 skip/todo 测试
- 覆盖率 ≥80%（c8 报告）

### 集成测试

**Entry：**
- 单元测试通过
- 依赖模块可用或已 stub
- 测试数据已准备

**Exit：**
- 所有模块交互路径覆盖
- 错误路径已验证
- 无 flaky 测试

### E2E 测试

**Entry：**
- 集成测试通过
- 应用可本地启动
- mock codex app-server 就绪

**Exit：**
- 8 个关键用户旅程全部通过
- 无 P0/P1 缺陷
- 移动视口布局正确

### 发布

**Entry：**
- 所有测试层级通过
- 无 CRITICAL/HIGH 缺陷
- 安全专项测试通过

**Exit：**
- 本地 smoke 测试通过
- `npm test` 退出码 0
- 变更日志已更新

---

## 10. Quality Gates & Definition of Done

### PR Gate（每个 PR）

| 检查项 | 阈值 | 工具 |
|--------|------|------|
| 单元测试通过 | 100% pass | `npm test` |
| 覆盖率不下降 | ≥基线 | c8 diff |
| 无新增 lint 错误 | 0 errors | ESLint（待配置） |
| 至少一个 reviewer 批准 | 1 approval | GitHub |

### Merge Gate（合并到 dev）

| 检查项 | 阈值 | 工具 |
|--------|------|------|
| PR gate 全部通过 | — | GitHub Actions |
| E2E smoke 通过 | 关键路径 green | Playwright |
| 分支与 dev 同步 | 无冲突 | GitHub |

### Deploy Gate（合并到 master）

| 检查项 | 阈值 | 工具 |
|--------|------|------|
| Merge gate 全部通过 | — | GitHub Actions |
| 安全专项测试通过 | 100% pass | `npm test` + 手动检查 |
| 变更日志已更新 | — | 人工审查 |

### Nightly Gate（定时）

| 检查项 | 阈值 | 工具 |
|--------|------|------|
| 完整 E2E 套件 | 100% pass | Playwright |
| 依赖漏洞扫描 | 0 critical/high | `npm audit` |
| 覆盖率报告 | ≥80% | c8 |

---

## 11. Metrics & KPIs

| 指标 | 定义 | 目标 | 当前值 | 跟踪频率 |
|------|------|------|--------|---------|
| **代码覆盖率** | c8 行覆盖率（业务逻辑模块） | ≥80% | **91.51%** | 每个 PR |
| **测试金字塔比率** | 单元:集成:E2E | 75:18:7 (±10%) | **94.7:0:5.3** (178:0:10) | 每月 |
| **Flaky 率** | 非确定性失败占比 | <2% | **0%** | 每周 |
| **缺陷逃逸率** | 生产环境发现的缺陷占比 | <5% | N/A (无生产部署) | 每次发布 |
| **MTTR** | 从发现到修复的时间 | <4h P0, <24h P1 | N/A | 每次事件 |
| **CI 反馈时间** | push 到 pass/fail 信号 | <5 分钟 | **~4s** (单元) | 每周 |
| **测试通过率** | `npm test` 通过率 | 100% on dev/master | **100%** | 每次提交 |
| **自动化率** | 自动化测试用例占比 | >80% | **100%** (关键路径) | 每季度 |

### 使用说明

- 跟踪趋势而非绝对值 — 从 30% 到 60% 覆盖率是巨大进步
- 设定现实目标 — 从 20% 到 90% 一个季度是幻想，不是计划
- 每季度与团队回顾 — 庆祝改进，调查突增
- 永远不要用指标惩罚团队

---

## 12. Timeline & Milestones

### Phase 1 — 基础建设 ✅ 完成（2026-07-02）

**目标：** 建立可运行的测试基线

| 任务 | 状态 | 产出 |
|------|------|------|
| 修复 `new-modules.test.mjs` 悬挂测试 | ✅ | Mock `session.send()` 依赖，不再悬挂 |
| 配置 c8 覆盖率 | ✅ | `npm run coverage` 可用，基线 82.82% |
| 配置 GitHub Actions CI | ✅ | `.github/workflows/test.yml`，PR 自动运行 |
| 补充安全模块测试 | ✅ | 新增 `devices.test.mjs` (16 测试)，扩展 `server-security.test.mjs` (21 测试) |
| 补充协议模块测试 | ✅ | 扩展 `agent-appserver.test.mjs` 边界条件 (43 测试) |
| 补充文件操作测试 | ✅ | 新增 `file-security.test.mjs` (17 测试) |

**Exit 标准达成：** CI 运行单元测试，覆盖率基线已建立，安全/协议模块高优先级测试就位。

### Phase 2 — 覆盖扩展 ✅ 完成（2026-07-02）

**目标：** 关键路径 E2E 覆盖

| 任务 | 状态 | 产出 |
|------|------|------|
| 配置 Playwright | ✅ | `playwright.config.js`，Pixel 5 移动端模拟 |
| 创建 mock codex app-server | ✅ | `scripts/mock-codex-app-server.js` + `scripts/mock-codex.sh` |
| 创建 E2E 测试服务器 | ✅ | `scripts/mock-server.js` |
| 实现关键旅程 E2E | ✅ | 10 个 E2E 测试全部通过 |

**Exit 标准达成：** 10 个关键用户旅程有 E2E 覆盖，Playwright 集成到 CI。

### Phase 3 — 质量门禁 ✅ 完成（2026-07-02）

**目标：** 自动化质量门禁

| 任务 | 状态 | 产出 |
|------|------|------|
| PR gate 实现 | ✅ | `scripts/check-coverage.js` (绝对阈值) + `scripts/check-coverage-delta.js` (增量检查) |
| 安全扫描 | ✅ | `npm audit` 集成到 CI |
| Nightly gate | ✅ | GitHub Actions 每日 3:23 AM 运行 |
| E2E 集成到 CI | ✅ | Node 20 运行 Playwright |

**Exit 标准达成：** PR/merge/deploy/nightly 四级门禁全部启用。

### Phase 4 — 优化 ✅ 完成（2026-07-02）

**目标：** 持续改进

| 任务 | 状态 | 产出 |
|------|------|------|
| 提升 agent-appserver.js 覆盖率 | ✅ | 83.65% → 覆盖 checkIdle、buffer 裁剪、eventsSince、clearQueue |
| 添加审批流程 E2E | ✅ | 批准 + 拒绝两个场景 |
| 扩展 mock 支持 approval 回调 | ✅ | mock-codex-app-server.js 支持 approval 回调 |
| Nightly CI + 安全扫描 | ✅ | GitHub Actions nightly + npm audit |
| PR 覆盖率增量门禁 | ✅ | `scripts/check-coverage-delta.js` |

### 当前状态（2026-07-02）

| 指标 | 基线 | 当前 | 变化 |
|------|------|------|------|
| 单元测试 | 73 | **178** | +105 (+144%) |
| E2E 测试 | 0 | **10** | +10 |
| 语句覆盖率 | 82.82% | **91.51%** | +8.7% |
| 函数覆盖率 | 80.48% | **95.69%** | +15.2% |
| CI | 无 | **GitHub Actions** | — |
| E2E 框架 | 无 | **Playwright** | — |
| 覆盖率门禁 | 无 | **绝对 + 增量** | — |
| 安全扫描 | 无 | **npm audit** | — |

### 下一步

- **首次季度策略回顾** — 2026-10-02
- **补充 agent-appserver.js 剩余路径** — 目标 90%+
- **配置 ESLint** — 消除 lint 门禁占位符
- **覆盖率仪表板** — 可选，趋势可视化

---

## 13. Revision History

| 日期 | 版本 | 变更 | 原因 |
|------|------|------|------|
| 2026-07-02 | 1.0 | 初始版本 | 项目无 QA 基础，建立策略 |
| 2026-07-02 | 2.0 | Phase 1-4 全部完成 | 178 单元测试 + 10 E2E + 91.51% 覆盖率 + CI + 门禁 |

### Re-evaluation Triggers

- 新产品区域上线
- 团队规模变化
- 重大安全事件
- 上游 codex CLI 协议变更
- 缺陷逃逸到生产环境
