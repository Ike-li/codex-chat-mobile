import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmController } from '../public/js/confirm-dialog.js';

function fakeEl(initial = {}) {
  const el = {
    hidden: initial.hidden ?? true,
    className: initial.className || '',
    textContent: '',
    value: initial.value || '',
    dataset: {},
    classList: {
      add(name) { el.className = `${el.className} ${name}`.trim(); },
      remove(name) { el.className = el.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
      contains(name) { return el.className.split(/\s+/).includes(name); },
    },
    focus() { el.focused = true; },
    select() { el.selected = true; },
  };
  return el;
}

function harness() {
  const modal = fakeEl();
  const titleEl = fakeEl();
  const bodyEl = fakeEl();
  const inputWrap = fakeEl();
  const inputEl = fakeEl({ value: 'old' });
  const okBtn = fakeEl();
  const cancelBtn = fakeEl();
  const controller = createConfirmController({
    modal,
    titleEl,
    bodyEl,
    inputWrap,
    inputEl,
    okBtn,
    cancelBtn,
  });
  return { modal, titleEl, bodyEl, inputWrap, inputEl, okBtn, cancelBtn, controller };
}

test('confirm resolves true on ok and false on cancel', async () => {
  const { controller, modal, inputWrap, okBtn, cancelBtn, titleEl } = harness();
  const pending = controller.confirm({ title: '删除会话', body: '不可恢复' });
  assert.equal(modal.hidden, false);
  assert.equal(titleEl.textContent, '删除会话');
  assert.equal(inputWrap.hidden, true);
  okBtn.onclick();
  assert.equal(await pending, true);
  assert.equal(modal.hidden, true);

  const cancelled = controller.confirm({ title: '再问一次' });
  cancelBtn.onclick();
  assert.equal(await cancelled, false);
});

test('prompt returns trimmed text or null and never resolves empty as a value', async () => {
  const { controller, inputWrap, inputEl, okBtn, cancelBtn } = harness();
  const pending = controller.prompt({ title: '重命名', initial: '  Draft  ' });
  assert.equal(inputWrap.hidden, false);
  assert.equal(inputEl.value, '  Draft  ');
  inputEl.value = '  Ready  ';
  okBtn.onclick();
  assert.equal(await pending, 'Ready');

  const empty = controller.prompt({ title: '空' });
  inputEl.value = '   ';
  okBtn.onclick();
  assert.equal(await empty, null);

  const cancelled = controller.prompt({ title: '取消', initial: 'keep' });
  cancelBtn.onclick();
  assert.equal(await cancelled, null);
});
