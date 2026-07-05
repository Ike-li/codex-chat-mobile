#!/usr/bin/env node
// scripts/check-coverage-delta.js —— 检查覆盖率是否下降。
// 用于 PR 检查：对比当前覆盖率与基线，确保不下降。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_FILE = join(process.cwd(), '.coverage-baseline.json');

// Thresholds for minimum acceptable coverage
const MIN_THRESHOLDS = {
  statements: 80,
  branches: 60,
  functions: 80,
  lines: 80,
};

// Maximum allowed decrease from baseline
const MAX_DECREASE = 2; // percentage points

function parseCoverage(output) {
  const match = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
  if (!match) return null;
  return {
    statements: parseFloat(match[1]),
    branches: parseFloat(match[2]),
    functions: parseFloat(match[3]),
    lines: parseFloat(match[4]),
  };
}

try {
  // Run tests with coverage
  console.log('📊 运行测试并收集覆盖率...');
  const output = execSync('npx c8 node --test test/*.test.mjs 2>&1 | tail -20', {
    encoding: 'utf8',
    timeout: 60000,
  });

  const current = parseCoverage(output);
  if (!current) {
    console.error('❌ 无法解析覆盖率报告');
    process.exit(1);
  }

  console.log('\n当前覆盖率:');
  console.log(`  语句: ${current.statements}%`);
  console.log(`  分支: ${current.branches}%`);
  console.log(`  函数: ${current.functions}%`);
  console.log(`  行:   ${current.lines}%`);

  // Check minimum thresholds
  let failed = false;
  for (const [key, min] of Object.entries(MIN_THRESHOLDS)) {
    if (current[key] < min) {
      console.error(`❌ ${key} 覆盖率 ${current[key]}% 低于最低阈值 ${min}%`);
      failed = true;
    }
  }

  // Check against baseline if exists
  if (existsSync(BASELINE_FILE)) {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    console.log('\n基线覆盖率:');
    console.log(`  语句: ${baseline.statements}%`);
    console.log(`  分支: ${baseline.branches}%`);
    console.log(`  函数: ${baseline.functions}%`);
    console.log(`  行:   ${baseline.lines}%`);

    console.log('\n覆盖率变化:');
    for (const key of ['statements', 'branches', 'functions', 'lines']) {
      const delta = current[key] - baseline[key];
      const symbol = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
      console.log(`  ${symbol} ${key}: ${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`);
      if (delta < -MAX_DECREASE) {
        console.error(`❌ ${key} 覆盖率下降超过 ${MAX_DECREASE}%`);
        failed = true;
      }
    }
  } else {
    // Save current as baseline
    console.log('\n📝 保存当前覆盖率作为基线...');
    writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2));
  }

  if (failed) {
    console.error('\n❌ 覆盖率检查未通过');
    process.exit(1);
  } else {
    console.log('\n✅ 覆盖率检查通过');
  }
} catch (err) {
  console.error('❌ 运行失败:', err.message);
  process.exit(1);
}
