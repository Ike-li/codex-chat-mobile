export const SANITIZE_CONFIG = {
  FORBID_TAGS: ['label', 'form', 'button', 'select', 'textarea', 'option', 'fieldset', 'legend'],
  FORBID_ATTR: ['style', 'for', 'tabindex', 'accesskey', 'autofocus', 'contenteditable', 'draggable'],
};

const hookedPurifiers = new WeakSet();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureLinkHook(DOMPurify) {
  if (!DOMPurify?.addHook || hookedPurifiers.has(DOMPurify)) return;
  hookedPurifiers.add(DOMPurify);
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function decodeBasicEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function languageFromClass(className) {
  const match = String(className || '').match(/(?:^|\s)language-([a-z0-9_+-]+)/i);
  return match ? match[1] : '';
}

export function enhanceCodeBlocks(html, hljs) {
  return String(html || '').replace(/<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (_, className, body) => {
    const language = languageFromClass(className);
    const decoded = decodeBasicEntities(body);
    let highlighted = body;
    if (hljs?.highlight && language) {
      try {
        highlighted = hljs.highlight(decoded, { language }).value;
      } catch {
        highlighted = body;
      }
    }
    const cls = className ? ` class="${className}"` : '';
    return `<div class="code-block-wrap"><button type="button" class="code-copy-btn">复制</button><pre><code${cls}>${highlighted}</code></pre></div>`;
  });
}

export function renderMarkdown(raw, deps = globalThis) {
  const marked = deps.marked;
  const DOMPurify = deps.DOMPurify;
  const text = String(raw ?? '');
  if (!marked?.parse || !DOMPurify?.sanitize) return escapeHtml(text);
  ensureLinkHook(DOMPurify);
  const sanitized = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), SANITIZE_CONFIG);
  return enhanceCodeBlocks(sanitized, deps.hljs || globalThis.hljs);
}
