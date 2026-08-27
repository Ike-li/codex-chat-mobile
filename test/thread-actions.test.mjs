import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadActionConfirm } from '../public/js/thread-actions.js';

test('archive 必须二次确认,且文案指出会话去了哪、怎么找回', () => {
  const confirm = threadActionConfirm('archive');
  assert.ok(confirm, 'archive 静默执行时用户只看到会话凭空消失,无从判断是归档还是丢了');
  assert.match(confirm.title, /归档/);
  // 只说「已归档」不够——用户需要的是回去的路,否则确认框只是把消失预告了一遍。
  assert.match(confirm.body, /显示已归档/);
  // 归档可逆,染成危险色会让它读起来和删除一样重。
  assert.equal(confirm.danger, false);
});

test('delete 保持危险确认,文案明说不可撤销', () => {
  const confirm = threadActionConfirm('delete');
  assert.ok(confirm);
  assert.equal(confirm.danger, true);
  assert.match(confirm.body, /无法从本页撤销/);
  // 旧文案「删除后可从 Codex 历史中消失」语义含糊,读起来像漏字。
  assert.doesNotMatch(confirm.body, /可从 Codex/);
});

test('unarchive 与 rename 不拦确认框', () => {
  // unarchive 是把会话加回来,不是拿走;rename 走的是 prompt,自带输入确认。
  assert.equal(threadActionConfirm('unarchive'), null);
  assert.equal(threadActionConfirm('rename'), null);
  assert.equal(threadActionConfirm(''), null);
  assert.equal(threadActionConfirm(undefined), null);
});
