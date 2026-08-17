import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, SANITIZE_CONFIG } from '../public/js/markdown.js';

await import('../public/vendor/marked.min.js');

function sanitizeWithConfig(html, cfg) {
  let out = String(html || '');
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const tag of cfg?.FORBID_TAGS || []) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  for (const attr of cfg?.FORBID_ATTR || []) {
    out = out.replace(new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'), '');
  }
  return out;
}

test('renderMarkdown turns GFM emphasis and code into HTML', () => {
  const html = renderMarkdown('**bold** and `code`', {
    marked: globalThis.marked,
    DOMPurify: { sanitize: value => value },
  });
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('renderMarkdown strips script tags after sanitize', () => {
  const html = renderMarkdown('hello <script>alert(1)</script>', {
    marked: { parse: raw => raw },
    DOMPurify: {
      sanitize(html, cfg) {
        assert.deepEqual(cfg.FORBID_TAGS, SANITIZE_CONFIG.FORBID_TAGS);
        return sanitizeWithConfig(html, cfg);
      },
    },
  });
  assert.match(html, /hello/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /alert\(1\)/);
});

test('renderMarkdown cannot emit a label that targets a button', () => {
  const html = renderMarkdown('<label for="send-btn">click</label><button id="send-btn">ok</button>', {
    marked: { parse: raw => raw },
    DOMPurify: {
      sanitize(html, cfg) {
        assert.ok(cfg.FORBID_TAGS.includes('label'));
        assert.ok(cfg.FORBID_ATTR.includes('for'));
        return sanitizeWithConfig(html, cfg);
      },
    },
  });
  assert.doesNotMatch(html, /<label/i);
  assert.doesNotMatch(html, /\sfor=/i);
});

test('renderMarkdown wraps fenced code for copy and highlights when hljs is present', () => {
  const html = renderMarkdown('```js\nconst ok = 1\n```', {
    marked: {
      parse: () => '<pre><code class="language-js">const ok = 1</code></pre>',
    },
    DOMPurify: { sanitize: value => value },
    hljs: {
      highlight(code, opts) {
        assert.equal(opts.language, 'js');
        return { value: '<span class="hljs-keyword">const</span> ok = 1' };
      },
    },
  });
  assert.match(html, /code-block-wrap/);
  assert.match(html, /code-copy-btn/);
  assert.match(html, /hljs-keyword/);
  assert.doesNotMatch(html, /<script/i);
});
