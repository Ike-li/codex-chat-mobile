import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const doc = readFileSync(new URL('../docs/scenario-acceptance.md', import.meta.url), 'utf8');

test('scenario acceptance records the ten required cases and dimensions', () => {
  for (const text of ['案例 1', '案例 2', '案例 3', '案例 4', '案例 5', '案例 6', '案例 7', '案例 8', '案例 9', '案例 10']) {
    assert.match(doc, new RegExp(text), `missing ${text}`);
  }
  for (const text of ['创建任务', '执行命令', '触发权限', '产生失败', '重试恢复', '部署或审核结果',
    '文件上传', '附件注入', '状态栏', '历史浏览', '工作目录', '实例切换', 'Web Push', '模型切换', '权限档切换', 'PWA']) {
    assert.match(doc, new RegExp(text), `missing keyword: ${text}`);
  }
  for (const text of ['功能等价', '状态可见', '失败可恢复', '权限可控']) {
    assert.match(doc, new RegExp(text));
  }
});

test('manual test cases cover all 18 scenarios', () => {
  const manual = readFileSync(new URL('../docs/manual-test-cases.md', import.meta.url), 'utf8');
  for (const tc of ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6', 'TC-7', 'TC-8', 'TC-9', 'TC-10',
    'TC-11', 'TC-12', 'TC-13', 'TC-14', 'TC-15', 'TC-16', 'TC-17', 'TC-18']) {
    assert.match(manual, new RegExp(tc), `missing ${tc}`);
  }
});
