#!/usr/bin/env node
// scripts/check-coverage.js —— CI 覆盖率门禁检查。
// 从 c8 报告中提取覆盖率，检查是否达到阈值。
import { execSync } from 'node:child_process';

const THRESHOLDS = {
  statements: 80,
  branches: 60,
  functions: 80,
  lines: 80,
};

// Run coverage and parse output
try {
  execSync('node --test test/*.test.mjs 2>&1', {
    encoding: 'utf8',
    timeout: 60000,
  });

  // Parse c8-like coverage from node:test --experimental-test-coverage
  // Fallback: just check npm test passes
  console.log('✅ 所有单元测试通过');

  // For now, run c8 separately
  const coverageOutput = execSync('npx c8 node --test test/*.test.mjs 2>&1 | tail -20', {
    encoding: 'utf8',
    timeout: 60000,
  });

  // Parse the All files line
  const match = coverageOutput.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
  if (match) {
    const stmts = parseFloat(match[1]);
    const branches = parseFloat(match[2]);
    const funcs = parseFloat(match[3]);
    const lines = parseFloat(match[4]);

    console.log(`\n覆盖率报告:`);
    console.log(`  语句: ${stmts}% (阈值: ${THRESHOLDS.statements}%)`);
    console.log(`  分支: ${branches}% (阈值: ${THRESHOLDS.branches}%)`);
    console.log(`  函数: ${funcs}% (阈值: ${THRESHOLDS.functions}%)`);
    console.log(`  行:   ${lines}% (阈值: ${THRESHOLDS.lines}%)`);

    let failed = false;
    if (stmts < THRESHOLDS.statements) { console.error(`❌ 语句覆盖率 ${stmts}% 低于阈值 ${THRESHOLDS.statements}%`); failed = true; }
    if (branches < THRESHOLDS.branches) { console.error(`❌ 分支覆盖率 ${branches}% 低于阈值 ${THRESHOLDS.branches}%`); failed = true; }
    if (funcs < THRESHOLDS.functions) { console.error(`❌ 函数覆盖率 ${funcs}% 低于阈值 ${THRESHOLDS.functions}%`); failed = true; }
    if (lines < THRESHOLDS.lines) { console.error(`❌ 行覆盖率 ${lines}% 低于阈值 ${THRESHOLDS.lines}%`); failed = true; }

    if (failed) {
      console.error('\n❌ 覆盖率未达到阈值要求');
      process.exit(1);
    } else {
      console.log('\n✅ 覆盖率全部达标');
    }
  } else {
    console.error('⚠️ 无法解析覆盖率报告');
    process.exit(1);
  }
} catch (err) {
  console.error('❌ 测试运行失败:', err.message);
  process.exit(1);
}
