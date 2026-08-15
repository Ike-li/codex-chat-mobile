#!/usr/bin/env node
// scripts/check-coverage.js —— CI 覆盖率门禁检查。
// 运行与 npm test 相同的串行测试集合，并从 c8 JSON summary 读取稳定指标。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THRESHOLDS = {
  statements: 80,
  branches: 60,
  functions: 80,
  lines: 80,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const reportDir = mkdtempSync(join(tmpdir(), 'ccm-coverage-'));

try {
  const testFiles = readdirSync(join(ROOT, 'test'))
    .filter(file => file.endsWith('.test.mjs'))
    .sort()
    .map(file => join('test', file));
  const c8Bin = join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js');

  execFileSync(process.execPath, [
    c8Bin,
    '--reporter=json-summary',
    `--report-dir=${reportDir}`,
    `--temp-directory=${join(reportDir, 'tmp')}`,
    process.execPath,
    '--test',
    '--test-concurrency=1',
    ...testFiles,
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120_000,
  });

  console.log('✅ 所有覆盖率测试通过');
  const summary = JSON.parse(readFileSync(join(reportDir, 'coverage-summary.json'), 'utf8')).total;
  const actual = {
    statements: Number(summary.statements.pct),
    branches: Number(summary.branches.pct),
    functions: Number(summary.functions.pct),
    lines: Number(summary.lines.pct),
  };

  console.log('\n覆盖率报告:');
  console.log(`  语句: ${actual.statements}% (阈值: ${THRESHOLDS.statements}%)`);
  console.log(`  分支: ${actual.branches}% (阈值: ${THRESHOLDS.branches}%)`);
  console.log(`  函数: ${actual.functions}% (阈值: ${THRESHOLDS.functions}%)`);
  console.log(`  行:   ${actual.lines}% (阈值: ${THRESHOLDS.lines}%)`);

  const failed = Object.entries(THRESHOLDS)
    .filter(([metric, threshold]) => actual[metric] < threshold);
  if (failed.length > 0) {
    for (const [metric, threshold] of failed) {
      console.error(`❌ ${metric} 覆盖率 ${actual[metric]}% 低于阈值 ${threshold}%`);
    }
    console.error('\n❌ 覆盖率未达到阈值要求');
    process.exitCode = 1;
  } else {
    console.log('\n✅ 覆盖率全部达标');
  }
} catch (err) {
  console.error('❌ 覆盖率测试或报告生成失败:', err.message);
  process.exitCode = 1;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
