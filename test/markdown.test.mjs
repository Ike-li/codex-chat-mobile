import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, SANITIZE_CONFIG } from '../public/js/markdown.js';

await import('../public/vendor/marked.min.js');

// 这个文件测的是**接线**，不是消毒本身。下面的 sanitizeWithConfig 是测试自己手写的
// 正则替身，另有两条用 `sanitize: value => value`（原样返回）—— 它们能回答「有没有把
// SANITIZE_CONFIG 传给 DOMPurify」「enhanceCodeBlocks 有没有正确包装代码块」，
// 回答不了「DOMPurify 拦不拦得住某个 payload」。
//
// 真正的消毒边界由 e2e/markdown-sanitization.spec.js 守：真浏览器、真 vendor 库、
// 判据是「脚本执行了没有」。放在这里做不到 —— 仓库里没有 jsdom，vendor 里的
// DOMPurify 是浏览器构建；更要紧的是生产代码里 enhanceCodeBlocks 跑在 sanitize
// **之后**，而在「压根不消毒」的替身下，消毒后注入根本无法被发现。

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

test('renderMarkdown 把 SANITIZE_CONFIG 交给 DOMPurify，并把它的输出当最终结果', () => {
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

test('SANITIZE_CONFIG 声明了挡 label/for 的意图（实际拦截由 e2e 验证）', () => {
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
