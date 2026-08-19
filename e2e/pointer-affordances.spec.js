// e2e/pointer-affordances.spec.js —— 悬停态在触摸设备上的门控守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// #attach-btn 基础态是 background: transparent;悬停态(桌面)是 var(--bg) #f8f9fa。
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// #attach-btn 带 transition: background 0.15s。悬停后立刻读会读到过渡起点的旧值,
// 于是"底色没变"会平凡地成立。必须等连续两次采样一致(过渡结束)再断言。
async function settledBackgroundColor(locator) {
  let previous = null;
  for (let i = 0; i < 20; i += 1) {
    const current = await locator.evaluate(el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor);
    if (current === previous) return current;
    previous = current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return previous;
}

test.describe('触摸设备的指针能力门控', () => {
  test('无 hover 能力时悬停不改变按钮底色,但 :hover 伪类仍会匹配', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 先确认这确实是"粗指针、无 hover 能力"的环境,否则下面的断言毫无意义。
    // globalThis.* 是本仓库 e2e 的既有写法:这些回调在浏览器里跑,但 eslint 按 Node 检查。
    const pointer = await page.evaluate(() => ({
      hover: globalThis.matchMedia('(hover: hover)').matches,
      coarse: globalThis.matchMedia('(pointer: coarse)').matches,
    }));
    expect(pointer, 'mobile-chrome 应模拟粗指针且无 hover 能力').toEqual({ hover: false, coarse: true });

    const attachBtn = page.locator('#attach-btn');
    await expect(attachBtn).toBeVisible();
    expect(await settledBackgroundColor(attachBtn)).toBe(TRANSPARENT);

    await attachBtn.hover();

    // 关键鉴别:伪类确实命中了,说明底色没变是 @media (hover: hover) 门控的功劳,
    // 而不是"指针压根没停在按钮上"这种平凡原因。
    const pseudoMatched = await attachBtn.evaluate(el => el.matches(':hover'));
    expect(pseudoMatched, '触摸模拟下 page.hover() 仍应让 :hover 伪类匹配').toBe(true);

    expect(await settledBackgroundColor(attachBtn), '触摸设备上悬停不应留下"假高亮"').toBe(TRANSPARENT);
  });

  // 文本正则读不出"浏览器真把这些规则解析进了一条 (hover: hover) 媒体规则"。
  // 例如把条件写错成 @media (hover hover),整块会被静默丢弃,单测却照样绿。
  test('浏览器把每一条悬停规则都解析进 (hover: hover) 媒体块', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const hoverRules = await page.evaluate(() => {
      const gated = [];
      const ungated = [];
      const walk = (rules, condition) => {
        for (const rule of rules) {
          if (rule.cssRules && rule.media) {
            walk(rule.cssRules, rule.conditionText);
            continue;
          }
          if (!rule.selectorText || !rule.selectorText.includes(':hover')) continue;
          (condition && condition.includes('hover: hover') ? gated : ungated).push(rule.selectorText);
        }
      };
      for (const sheet of globalThis.document.styleSheets) {
        try {
          walk(sheet.cssRules, null);
        } catch {
          // 跨源样式表读不到 cssRules,本项目的 vendor 主题是同源的,忽略即可。
        }
      }
      return { gated, ungated };
    });

    expect(hoverRules.ungated, '不应存在未被门控的悬停规则').toEqual([]);
    expect(hoverRules.gated.length, '门控块内应有悬停规则').toBeGreaterThan(0);
    for (const selector of [
      '.session-item:hover',
      '.badge-pill:hover',
      '.slash-item:hover',
      '#composer-defaults:hover',
      '#attach-btn:hover',
      '.popover-item:hover',
      '.popover-item.selected:hover',
      '.attach-chip-remove:hover',
    ]) {
      expect(hoverRules.gated, `${selector} 应被解析进 (hover: hover) 媒体块`).toContain(selector);
    }
  });
});
