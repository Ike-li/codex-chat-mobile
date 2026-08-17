export function createConfirmController({
  modal,
  titleEl,
  bodyEl,
  inputWrap,
  inputEl,
  okBtn,
  cancelBtn,
} = {}) {
  let pending = null;

  function finish(value) {
    if (modal) modal.hidden = true;
    const resolve = pending;
    pending = null;
    if (resolve) resolve(value);
  }

  function open({ title = '', body = '', mode = 'confirm', initial = '', danger = false } = {}) {
    if (pending) finish(mode === 'prompt' ? null : false);
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body || '';
    if (inputWrap) inputWrap.hidden = mode !== 'prompt';
    if (inputEl) {
      inputEl.value = mode === 'prompt' ? String(initial ?? '') : '';
      if (mode === 'prompt') {
        inputEl.focus?.();
        inputEl.select?.();
      }
    }
    if (okBtn) okBtn.dataset.danger = danger ? 'true' : 'false';
    if (modal) modal.hidden = false;
    return new Promise(resolve => {
      pending = resolve;
    });
  }

  if (okBtn) {
    okBtn.onclick = () => {
      if (inputWrap && !inputWrap.hidden) {
        const value = String(inputEl?.value ?? '').trim();
        finish(value || null);
        return;
      }
      finish(true);
    };
  }
  if (cancelBtn) cancelBtn.onclick = () => finish(inputWrap && !inputWrap.hidden ? null : false);

  return {
    confirm(options = {}) {
      return open({ ...options, mode: 'confirm' });
    },
    prompt(options = {}) {
      return open({ ...options, mode: 'prompt' });
    },
    close() {
      finish(inputWrap && !inputWrap.hidden ? null : false);
    },
  };
}
