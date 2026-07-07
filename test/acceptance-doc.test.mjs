import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const testingDoc = readFileSync(new URL('../docs/TESTING.md', import.meta.url), 'utf8');
const readDoc = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('testing documentation records the ten required acceptance cases and dimensions', () => {
  for (const text of ['案例 1', '案例 2', '案例 3', '案例 4', '案例 5', '案例 6', '案例 7', '案例 8', '案例 9', '案例 10']) {
    assert.match(testingDoc, new RegExp(text), `missing ${text}`);
  }
  for (const text of ['创建任务', '执行命令', '触发权限', '产生失败', '重试恢复', '部署或审核结果',
    '文件上传', '附件注入', '状态栏', '历史浏览', '工作目录', '实例切换', 'Web Push', '模型切换', '权限档切换', 'PWA']) {
    assert.match(testingDoc, new RegExp(text), `missing keyword: ${text}`);
  }
  for (const text of ['功能等价', '状态可见', '失败可恢复', '权限可控']) {
    assert.match(testingDoc, new RegExp(text));
  }
});

test('testing documentation covers all 18 manual smoke scenarios', () => {
  for (const tc of ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6', 'TC-7', 'TC-8', 'TC-9', 'TC-10',
    'TC-11', 'TC-12', 'TC-13', 'TC-14', 'TC-15', 'TC-16', 'TC-17', 'TC-18']) {
    assert.match(testingDoc, new RegExp(tc), `missing ${tc}`);
  }
});

test('bilingual READMEs keep their language contract and stay cross-linked', () => {
  const readmeEn = readDoc('../README.md');
  const readmeZh = readDoc('../README.zh-CN.md');

  const englishHeadings = ['## Features', '## How It Works', '## Quick Start', '## Configuration',
    '## Commands', '## Security', '## Key Files', '## Documentation', '## Contributing', '## License'];
  for (const heading of englishHeadings) {
    assert.match(readmeEn, new RegExp(`^${heading}$`, 'm'), `README.md missing heading ${heading}`);
  }

  const chineseHeadings = ['## 当前形态', '## 本地运行', '## 常用命令', '## 核心文件', '## 文档规则', '## 许可证'];
  for (const heading of chineseHeadings) {
    assert.match(readmeZh, new RegExp(`^${heading}$`, 'm'), `README.zh-CN.md missing heading ${heading}`);
  }

  assert.match(readmeEn, /\((?:\.\/)?README\.zh-CN\.md\)/, 'README.md must link to README.zh-CN.md');
  assert.match(readmeZh, /\((?:\.\/)?README\.md\)/, 'README.zh-CN.md must link back to README.md');
  assert.doesNotMatch(readmeEn, /^## (当前形态|本地运行|常用命令|核心文件|文档规则)$/m);
  assert.match(readmeEn, /actions\/workflows\/test\.yml\/badge\.svg/, 'README.md must carry the CI badge');

  for (const target of ['docs/PROTOCOL.md', 'docs/EVENTS.md', 'docs/REMOTE_ACCESS.md', 'docs/GUIDE.md']) {
    assert.match(readmeEn, new RegExp(target), `README.md missing link to ${target}`);
    assert.match(readmeZh, new RegExp(target), `README.zh-CN.md missing link to ${target}`);
  }
});

test('maintained Chinese docs use Chinese section titles', () => {
  const docs = {
    'README.zh-CN.md': readDoc('../README.zh-CN.md'),
    'CLAUDE.md': readDoc('../CLAUDE.md'),
    'ARCHITECTURE.md': readDoc('../docs/ARCHITECTURE.md'),
    'TESTING.md': readDoc('../docs/TESTING.md'),
    'PROTOCOL_UPGRADE.md': readDoc('../docs/PROTOCOL_UPGRADE.md'),
    'PROTOCOL.md': readDoc('../docs/PROTOCOL.md'),
    'EVENTS.md': readDoc('../docs/EVENTS.md'),
    'REMOTE_ACCESS.md': readDoc('../docs/REMOTE_ACCESS.md'),
    'GUIDE.md': readDoc('../docs/GUIDE.md'),
  };
  const requiredHeadings = {
    'README.zh-CN.md': ['## 当前形态', '## 本地运行', '## 常用命令', '## 核心文件', '## 文档规则'],
    'CLAUDE.md': ['## 项目规则', '## 常用命令', '## 维护文档'],
    'ARCHITECTURE.md': ['# 架构', '## 运行链路', '## 状态模型', '## 协议边界', '## 安全模型', '## 维护中的设计决策'],
    'TESTING.md': ['# 测试', '## 必跑门禁', '## 自动化覆盖', '## 验收矩阵', '## 手工冒烟清单', '## 真实 Codex 冒烟边界'],
    'PROTOCOL_UPGRADE.md': ['# 协议升级操作手册', '## 步骤', '## 规则'],
    'PROTOCOL.md': ['# Codex App Server 协议参考', '## 三层集合模型', '## 产品主干接口', '## 实验门控接口', '## 传输与运维约定', '## 与本项目实现的映射', '## 升级与验证'],
    'EVENTS.md': ['# Socket.IO 事件契约索引', '## 客户端到服务端', '## 服务端到客户端', '## agent:event 信封类型', '## 契约测试位置'],
    'REMOTE_ACCESS.md': ['# 远程访问指南', '## HTTPS 与 PWA/Push 的硬限制', '## 方案对比', '## AUTH_TOKEN 实践', '## 排错清单'],
    'GUIDE.md': ['# 使用走查', '## 安装与启动', '## 从手机连接', '## 第一轮对话', '## 审批一条命令', '## 历史与多实例', '## 安装为 PWA'],
  };

  for (const [name, headings] of Object.entries(requiredHeadings)) {
    for (const heading of headings) {
      assert.match(docs[name], new RegExp(`^${heading}$`, 'm'), `${name} missing heading ${heading}`);
    }
  }

  const combined = Object.values(docs).join('\n');
  assert.doesNotMatch(combined, /^## (Current Shape|Run Locally|Commands|Key Files|Documentation Policy|Project Rules|Maintained Docs|Runtime Flow|State Model|Protocol Boundary|Security Model|Maintained Design Decisions|Required Gates|Automated Coverage|Acceptance Matrix|Manual Smoke Checklist|Real Codex Smoke Boundary|Steps|Rules)$/m);
  assert.doesNotMatch(combined, /^# (Architecture|Testing|Protocol Upgrade Runbook)$/m);
});

test('open source community files exist and stay consistent', () => {
  const license = readDoc('../LICENSE');
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);

  const pkg = JSON.parse(readDoc('../package.json'));
  assert.equal(pkg.license, 'AGPL-3.0-only');

  const contributing = readDoc('../CONTRIBUTING.md');
  for (const heading of ['## Ground Rules', '## Development Setup', '## Test Gates', '## Protocol Changes', '## Commits and Pull Requests']) {
    assert.match(contributing, new RegExp(`^${heading}$`, 'm'), `CONTRIBUTING.md missing heading ${heading}`);
  }
  for (const text of ['npm run lint', 'npm test', 'npm run protocol:check', 'npm run test:e2e', 'mock', 'TDD']) {
    assert.match(contributing, new RegExp(text), `CONTRIBUTING.md missing: ${text}`);
  }

  const security = readDoc('../SECURITY.md');
  for (const heading of ['## Threat Model', '## Deployment Rules', '## Supported Versions', '## Reporting a Vulnerability']) {
    assert.match(security, new RegExp(`^${heading}$`, 'm'), `SECURITY.md missing heading ${heading}`);
  }
  for (const text of ['AUTH_TOKEN', 'loopback']) {
    assert.match(security, new RegExp(text), `SECURITY.md missing: ${text}`);
  }

  const readmeEn = readDoc('../README.md');
  for (const target of ['CONTRIBUTING\\.md', 'SECURITY\\.md', 'LICENSE', 'AGPL-3\\.0']) {
    assert.match(readmeEn, new RegExp(target), `README.md missing reference: ${target}`);
  }
});

test('acceptance matrix doubles as a feature inventory with code entry points', () => {
  assert.match(testingDoc, /代码入口/, 'TESTING.md acceptance matrix must map cases to code entry points');
});

test('roadmap and archive keep history separated from maintained docs', () => {
  const roadmap = readDoc('../ROADMAP.md');
  for (const heading of ['# Roadmap', '## Shipped', '## In Progress', '## Candidates']) {
    assert.match(roadmap, new RegExp(`^${heading}$`, 'm'), `ROADMAP.md missing heading ${heading}`);
  }

  const archiveReadme = readDoc('../docs/archive/README.md');
  assert.match(archiveReadme, /历史存档/);
  assert.match(archiveReadme, /不再维护/);
  for (const name of [
    'codex-app-server-interface-map-gpt-5-codex.md',
    'codex-app-server-接口地图-合并版-claude-fable-5+gpt-5-codex.md',
    'codex-app-server-接口对照清单-claude-fable-5.md',
    'codex-app-server-架构设计-claude-fable-5.md',
  ]) {
    assert.ok(existsSync(new URL(`../docs/archive/${name}`, import.meta.url)), `missing archived doc ${name}`);
  }
});

test('readme image references resolve to files in the repo', () => {
  let localImages = 0;
  for (const readmePath of ['../README.md', '../README.zh-CN.md']) {
    const content = readDoc(readmePath);
    for (const [, target] of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (/^https?:/.test(target)) continue;
      localImages += 1;
      assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${readmePath} references missing image ${target}`);
    }
  }
  assert.ok(localImages >= 2, 'both READMEs should embed at least one local screenshot');
});
