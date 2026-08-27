import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const allContent = html + '\n' + appJs;

// 形态无关的样式表读取器:样式在独立文件里就读文件,否则回落到 index.html 的 <style> 块。
// 这让 CSS 断言表达的是「应用样式表里有这条规则」,与规则的物理位置解耦。
const cssUrl = new URL('../public/css/app.css', import.meta.url);
const css = existsSync(cssUrl)
  ? readFileSync(cssUrl, 'utf8')
  : (html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '');
// 回退分支的正则若失配会静默返回空串,让所有 doesNotMatch 假绿。这条断言在模块加载期
// 就让整个文件崩掉,而不是给出一片虚假的绿。
assert.ok(css.length > 20000, '应用样式表读取失败——读取器与当前文件形态失配');

test('HTML loads the application from an external module and contains no inline scripts', () => {
  assert.match(html, /<script\s+type="module"\s+src="\/js\/app\.js"><\/script>/);
  assert.match(html, /<script\s+src="\/vendor\/marked\.min\.js"><\/script>/);
  assert.match(html, /<script\s+src="\/vendor\/purify\.min\.js"><\/script>/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=/i);
    assert.equal(body.trim(), '');
  }
});

test('every stylesheet and script the shell references resolves to a file under public/', () => {
  // 引用完整性零守护时,拆分资源(抽 CSS、拆模块)一旦写错路径,单测全绿而页面裸奔。
  let checked = 0;
  const references = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel="stylesheet"/i.test(tag)) continue;
    references.push(tag.match(/\bhref="([^"]+)"/i)?.[1]);
  }
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    references.push(src);
  }

  for (const target of references) {
    assert.ok(target, '引用标签缺少 href/src');
    if (/^(?:https?:)?\/\//.test(target)) continue;
    // socket.io 客户端由 socket.io 中间件在运行时动态提供,public/ 下没有这个文件。
    if (target === '/socket.io/socket.io.js') continue;
    checked += 1;
    assert.ok(
      existsSync(new URL(`../public${target}`, import.meta.url)),
      `index.html references missing asset ${target}`,
    );
  }
  assert.ok(checked >= 5, `资源扫描器失配——只检出 ${checked} 个本地引用`);
});

test('application styles live in an external stylesheet loaded after the hljs themes', () => {
  assert.ok(existsSync(cssUrl), 'public/css/app.css 必须存在');
  assert.doesNotMatch(html, /<style>/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);

  // app.css 必须排在 hljs 主题之后,否则 .hljs 的覆盖关系会反转。
  // 用引用顺序的索引断言,不用行号——行号会随任何无关编辑漂移。
  const sheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
    .map(([tag]) => tag.match(/\bhref="([^"]+)"/i)?.[1]);
  const appIdx = sheets.indexOf('/css/app.css');
  const darkIdx = sheets.indexOf('/vendor/github-dark.min.css');
  assert.ok(darkIdx >= 0, 'hljs 主题样式表应仍被引用');
  assert.ok(appIdx > darkIdx, `app.css(#${appIdx})必须排在 github-dark(#${darkIdx})之后`);
});

test('code blocks ship only the dark hljs theme so token colours match the dark pre background', () => {
  // .codex .bubble.md pre 与 .tool-output 都硬编码了 #1e1e1e 暗底,而两个 hljs 主题原本
  // 按 prefers-color-scheme 互斥加载:浅色下生效的是 github-light,它的深灰/深蓝 token
  // 前景色压在这块黑底上几乎读不出来。代码块统一走暗色 ⇒ 只保留 github-dark 且不带 media。
  assert.match(html, /<link rel="stylesheet" href="\/vendor\/github-dark\.min\.css">/);
  assert.doesNotMatch(html, /github-light/, 'github-light 不应再被引用');
  assert.ok(
    !existsSync(new URL('../public/vendor/github-light.min.css', import.meta.url)),
    '未被引用的 vendor 文件应删除',
  );
  // 上面那条引用完整性守护只检查「被引用的文件存在」,不检查「文件都被引用」——
  // 删文件不会让它变红,所以这里主动补一条反向断言,并同步第三方登记。
  const notices = readFileSync(new URL('../public/vendor/THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  assert.doesNotMatch(notices, /github-light/, '第三方登记必须与实际打包的文件一致');
  assert.match(notices, /github-dark\.min\.css/);
});

test('extracting the stylesheet drops dead rules without gutting shared scrollbar styling', () => {
  // #quick-actions:HTML 里没有这个元素;.premium-popover:HTML 与 JS 全无引用。
  assert.doesNotMatch(css, /#quick-actions/, '#quick-actions 无宿主元素,规则应删除');
  assert.doesNotMatch(appJs, /#quick-actions/, '#quick-actions 选择器永远返回空集,绑定应删除');
  assert.doesNotMatch(css, /\.premium-popover/, '.premium-popover 无任何引用,规则应删除');
  // #session-list 同样无宿主,但它出现在几条共享滚动条规则的选择器列表里。
  // 只能摘掉这一项,整条删会连带干掉 #messages / .tool-output 的滚动条样式。
  assert.doesNotMatch(css, /#session-list/, '#session-list 无宿主元素,应从所有选择器中摘除');
  assert.match(css, /#messages, \.tool-output \{[^}]*scrollbar-width:\s*thin/s);
  for (const part of ['', '-thumb', '-track']) {
    assert.match(
      css,
      new RegExp(`#messages::-webkit-scrollbar${part}, \\.tool-output::-webkit-scrollbar${part} \\{`),
      `共享滚动条规则 ::-webkit-scrollbar${part} 不能被整条删掉`,
    );
  }
});

test('composer send controls use vector icons and keep them when switching mode', () => {
  const composerHtml = html.slice(html.indexOf('id="input-area"'), html.indexOf('id="session-settings"'));
  assert.match(composerHtml, /id="send-btn"[^>]*>[\s\S]*<svg class="icon-send"/);
  assert.match(composerHtml, /id="send-btn"[\s\S]*<svg class="icon-stop"/);
  assert.match(composerHtml, /id="followup-btn"[^>]*>[\s\S]*<svg class="icon-send"/);
  assert.doesNotMatch(composerHtml, />\s*[↑■]\s*</);
  assert.match(css, /#send-btn\[data-mode="stop"\][\s\S]*\.icon-send/);
  assert.match(css, /#send-btn\[data-mode="stop"\][\s\S]*\.icon-stop/);
  assert.doesNotMatch(appJs, /sendBtn\.textContent\s*=/);
  assert.match(appJs, /sendBtn\.dataset\.mode = state\.mode/);
});

test('mobile shell exposes session state and quick terminal controls', () => {
  assert.match(allContent, /id="session-meta"/);
  assert.match(allContent, /id="send-btn"/);
  assert.match(allContent, /id="send-btn"/);
  assert.match(allContent, /id="followup-btn"/);
  assert.match(allContent, /resolveComposerPrimaryMode/);
  assert.match(allContent, /data-mode/);
  assert.doesNotMatch(html, /id="interrupt-btn"/);
  assert.match(allContent, /id="attach-btn"/);
  assert.match(allContent, /id="composer-defaults"/);
  assert.match(allContent, /id="session-settings"/);
  assert.match(appJs, /followUpVisible/);
  assert.match(appJs, /\$\('followup-btn'\)\.onclick = sendMessage/);
  assert.doesNotMatch(appJs, /async function sendMessage\(\) \{\s*if \(busy\) return;/);
});

test('client handles queued input, reconnect catch-up, status, and ANSI output', () => {
  assert.match(allContent, /case 'status'/);
  assert.match(allContent, /case 'queued_message'/);
  assert.match(allContent, /case 'dequeued_message'/);
  assert.match(allContent, /case 'tool_output_delta'/);
  assert.match(allContent, /socket\.emit\('catch-up'/);
  assert.match(allContent, /function renderAnsi/);
  assert.match(allContent, /function setBusy\(b\)/);
  assert.match(allContent, /if \(!b\) hideTyping\(\)/);
  assert.match(allContent, /aria-live="polite"/);
});

test('no unreachable button handlers survive with their orphaned state', () => {
  // `#retry-last-btn` 与 `#copy-latest-btn` 的 id 从未出现在 index.html —— 引入时只写了
  // JS,没配 HTML。`$()` 返回 null,`if (btn)` 空值守卫让它们静默失败,两个处理函数
  // 永远调不到,而 `lastFailedText` / `latestOutputText` 一直在被赋值。
  // 此前反倒有断言要求这两个函数存在,等于用测试给死代码背书。
  for (const symbol of [
    'retry-last-btn', 'retryLastBtn', 'retryLastFailed', 'lastFailedText', 'rememberFailure',
    'copy-latest-btn', 'copyLatestBtn', 'copyLatestOutput', 'latestOutputText',
  ]) {
    assert.ok(!appJs.includes(symbol), `app.js 仍残留不可达的 ${symbol}`);
  }
  assert.doesNotMatch(css, /#retry-last-btn/, '样式表仍有无宿主元素的 #retry-last-btn 规则');
  // showCopyFallback 是 .copy-fallback 的唯一创建者,它走后这两条规则也没了宿主。
  assert.doesNotMatch(css, /\.copy-fallback/, '样式表仍有无创建者的 .copy-fallback 规则');
});

test('client applies app-server thread status to thread and instance activity', () => {
  assert.match(allContent, /case 'thread_status'/);
  assert.match(allContent, /function handleThreadStatus\(payload\)/);
  assert.match(allContent, /from '\/js\/thread-status\.js'/);
  assert.match(allContent, /applyThreadStatus\(appThreads, payload\)/);
  assert.match(allContent, /mergeThreadList\(sessionsByCwd\.get\(cwd\) \|\| \[\], ack\.threads/);
  assert.match(allContent, /threadStatusPresentation\(/);
  assert.match(allContent, /instance\.sessionId === payload\.threadId/);
  assert.match(allContent, /statusRevision/);
  assert.match(allContent, /thread-status-dot/);
  assert.match(allContent, /scheduleThreadListRefresh\(\)/);
});

test('client applies runtime message receipt transitions to the persistent outbox', () => {
  assert.match(allContent, /case 'message_receipt'/);
  assert.match(allContent, /messageOutbox\.acceptReceipt\(ev\.payload\)/);
});

test('client reconciles optimistic and queued message bubbles by clientRequestId', () => {
  assert.match(allContent, /dataset\.clientRequestId/);
  assert.match(allContent, /promoteOfflineBubble\(clientRequestId\)/);
  assert.match(allContent, /promoteQueuedBubble\(clientRequestId/);
  assert.match(allContent, /appendUserBubble\(ev\.payload\.text, ev\.payload\.attachments, ev\.payload\.parts, ev\.payload\.clientRequestId\)/);
  assert.doesNotMatch(allContent, /offlineUserBubbles\.findIndex\(q => q\.text === text\)/);
});

test('code block copy degrades to a selection fallback when the clipboard API is unavailable', () => {
  // 这里原本还断言 latestOutputText / rememberOutput / showCopyFallback —— 那条链服务的是
  // 从不存在的 #copy-latest-btn,已随死代码一并移除。仍然活着的是代码块的复制按钮,
  // 它在 navigator.clipboard 不可用时回退到 fallbackCopyText。
  assert.match(appJs, /function fallbackCopyText\(text\)/);
  assert.match(appJs, /else fallbackCopyText\(code\)/);
});

test('mobile keyboard uses visual viewport safe area instead of fixed screen height', () => {
  assert.match(allContent, /--app-height/);
  assert.match(allContent, /--keyboard-inset/);
  assert.match(allContent, /visualViewport/);
  assert.match(allContent, /function syncVisualViewport\(\)/);
  assert.match(allContent, /resize', syncVisualViewport/);
  assert.match(allContent, /scroll', syncVisualViewport/);
});

test('client checks auth requirement before opening the socket', () => {
  assert.match(allContent, /id="auth-gate"/);
  assert.match(allContent, /id="auth-token-input"/);
  assert.match(allContent, /autoConnect: false/);
  assert.match(allContent, /function bootstrapAuth\(\)/);
  assert.match(allContent, /fetch\('\/health'/);
  assert.match(allContent, /connectSocket\(\{ allowEmpty: true \}\)/);
  assert.match(allContent, /function connectSocket\(/);
  assert.match(allContent, /bootstrapAuth\(\);/);
  assert.match(allContent, /authForm\.addEventListener\('submit'/);
  assert.match(allContent, /socket\.connect\(\)/);
  assert.match(allContent, /socket\.on\('connect_error'/);
});

test('browser exchanges the host token for an HttpOnly session without persisting it', () => {
  assert.match(allContent, /fetch\('\/auth\/session'/);
  assert.match(allContent, /credentials: 'same-origin'/);
  assert.doesNotMatch(allContent, /localStorage\.setItem\('codex_auth_token'/);
  assert.doesNotMatch(allContent, /localStorage\.getItem\('codex_auth_token'/);
  assert.doesNotMatch(allContent, /socket\.auth = \{ token: authToken/);
});

test('client creates device credentials with Web Crypto instead of Math.random', () => {
  assert.match(allContent, /crypto\.randomUUID\(\)/);
  assert.match(allContent, /crypto\.getRandomValues\(/);
  assert.doesNotMatch(allContent, /deviceToken = 'dev_' \+ Math\.random/);
});

test('client binds push subscriptions with the current auth and device credentials', () => {
  assert.match(allContent, /'x-device-token': deviceToken/);
  assert.match(allContent, /credentials: 'same-origin'/);
  assert.doesNotMatch(allContent, /fetch\('\/push\/subscribe'[\s\S]{0,300}'x-auth-token'/);
  assert.match(allContent, /if \(!subscribeResponse\.ok\)/);
});

test('command and file-change cards use structured card models', () => {
  assert.match(appJs, /from '\/js\/tool-cards\.js'/);
  assert.match(appJs, /commandCard\(/);
  assert.match(appJs, /fileChangeCard\(/);
  assert.match(appJs, /tool-card command-card/);
  assert.match(appJs, /file-change-card/);
  assert.match(appJs, /tool-exit/);
});

test('client renders rich approval, user input, and raw item cards', () => {
  assert.match(allContent, /case 'user_input_request'/);
  assert.match(allContent, /case 'raw_item'/);
  assert.match(allContent, /function renderApprovalDetails/);
  assert.match(allContent, /function handleUserInputRequest/);
  assert.match(allContent, /function handleRawItem/);
  assert.match(allContent, /payload\.changes/);
  assert.match(allContent, /payload\.permissions/);
  assert.match(allContent, /JSON\.stringify\(payload\.item/);
});

test('client marks user-input cards complete only after a successful server ACK', () => {
  const start = allContent.indexOf('function handleUserInputRequest');
  const end = allContent.indexOf('function renderQuestion', start);
  const handler = allContent.slice(start, end);
  assert.match(handler, /socket\.emit\('user:approval',[\s\S]*ack =>/);
  assert.match(handler, /if \(!ack\?\.ok\)/);
  assert.ok(handler.indexOf('if (!ack?.ok)') < handler.indexOf('markInputCardDone'));
});

test('client keeps unknown needs visible but never renders them as actionable', () => {
  const start = allContent.indexOf('function renderNeedsYouPanel');
  const end = allContent.indexOf('function openNeed', start);
  const handler = allContent.slice(start, end);
  assert.match(handler, /need\.state === 'unknown'/);
  assert.match(handler, /结果未知，等待上游终态/);
  assert.match(allContent, /need\.state !== 'pending'/);
});

test('web UI does not expose ChatGPT account login', () => {
  assert.doesNotMatch(html, /id="account-login-btn"/);
  assert.doesNotMatch(html, /id="account-login-panel"/);
  assert.doesNotMatch(html, />登录</);
  assert.doesNotMatch(allContent, /function startChatgptDeviceLogin/);
  assert.doesNotMatch(allContent, /socket\.emit\('account:loginStart'/);
  assert.doesNotMatch(allContent, /socket\.emit\('account:loginCancel'/);
  assert.match(allContent, /case 'account_login'/);
  assert.match(allContent, /case 'account_updated'/);
});

test('client renders summary and full reasoning streams separately', () => {
  assert.match(allContent, /case 'reasoning'/);
  assert.match(allContent, /function appendReasoning/);
  assert.match(allContent, /summary_part_added/);
  assert.match(allContent, /reasoning-summary/);
  assert.match(allContent, /reasoning-full/);
  assert.match(allContent, /payload\.channel/);
});

test('main chrome hides live instance tabs; drawer new session is per-workspace', () => {
  assert.match(allContent, /function createNewSession/);
  assert.match(appJs, /createNewSession\(btn\.dataset\.newCwd\)/);
  assert.doesNotMatch(html, /id="new-session-btn"/);
  assert.doesNotMatch(html, /id="drawer-fab-new"/);
  assert.doesNotMatch(html, /id="instance-tabs"/);
  assert.doesNotMatch(allContent, /id="new-instance-btn"/);
  assert.doesNotMatch(allContent, /id="fork-instance-btn"/);
});

test('drawer header is a titled panel with close, not brand or duplicate new-session', () => {
  assert.match(html, /id="drawer-title"[^>]*>工作区与会话/);
  assert.match(html, /id="drawer-close"/);
  assert.match(html, /aria-labelledby="drawer-title"/);
  assert.doesNotMatch(html, /class="drawer-logo"/);
  assert.doesNotMatch(html, /id="drawer-project"/);
  assert.doesNotMatch(html, /class="drawer-search-pill"/);
  assert.doesNotMatch(html, /id="new-session-btn"/);
  assert.doesNotMatch(html, /id="drawer-fab-new"/);
  assert.doesNotMatch(css, /\.drawer-logo\s*\{/);
  assert.doesNotMatch(css, /\.drawer-search-pill\s*\{/);
  assert.doesNotMatch(css, /\.drawer-fab\s*\{/);
  assert.doesNotMatch(css, /#new-session-btn\s*\{/);
  assert.doesNotMatch(appJs, /\$\('new-session-btn'\)/);
  assert.doesNotMatch(appJs, /\$\('drawer-fab-new'\)/);
  assert.match(appJs, /\$\('drawer-close'\)\.onclick\s*=\s*closeDrawer/);
});

test('drawer hides the tools panel and labels conversations by project', () => {
  assert.match(html, /id="drawer-tools"[^>]*\bhidden\b/);
  assert.match(appJs, /from '\/js\/project-label\.js'/);
  assert.match(appJs, /function renderDrawerProject/);
  assert.doesNotMatch(appJs, / · native/);
});

test('opening the drawer pins projects at the top and does not start at the bottom', () => {
  assert.match(css, /#drawer \{[^}]*overflow:\s*hidden/);
  assert.match(css, /#drawer-body \{[^}]*min-height:\s*0/);
  assert.match(appJs, /function resetDrawerScroll/);
  const start = appJs.indexOf("$('menu-btn').onclick");
  const end = appJs.indexOf('function closeDrawer', start);
  assert.match(appJs.slice(start, end), /resetDrawerScroll\(\)/);
});

test('drawer lists every allowlisted workspace so the user can switch projects', () => {
  assert.match(html, /id="drawer-projects"/);
  assert.match(html, /id="drawer-body"/);
  assert.match(appJs, /function renderDrawerProjects/);
  assert.doesNotMatch(appJs, /drawer-section-label">项目/, 'drawer title already names the panel; do not repeat 项目');
  assert.match(appJs, /function toggleDirExpand/);
  assert.match(appJs, /from '\/js\/drawer-dirs\.js'/);
  assert.match(appJs, /dir-toggle/);
  assert.match(appJs, /dir-new/);
  assert.match(appJs, /dir-subtree/);
  assert.match(appJs, /createNewSession\(btn\.dataset\.newCwd\)/);
  assert.match(appJs, /toggleDirExpand\(btn\.dataset\.cwd\)/);
});

test('header chrome uses a workspace pill, RTT chip and home/new actions', () => {
  assert.match(html, /id="thread-title"/);
  assert.match(html, /id="header-project"/);
  assert.match(html, /id="header-context"/);
  assert.match(html, /id="header-changes"/);
  assert.match(html, /id="conn-rtt"/);
  assert.match(html, /id="header-home"/);
  assert.match(html, /id="header-new"/);
  assert.match(html, /id="status-dot"/);
  assert.match(html, /id="menu-btn"/);
  assert.doesNotMatch(html, /id="header-copy"/);
  assert.doesNotMatch(html, /id="btnConsole"/);
  assert.match(allContent, /function renderThreadTitle/);
  assert.match(allContent, /新会话/);
  const headerHtml = html.slice(html.indexOf('<div id="header">'), html.indexOf('id="input-area"'));
  const inputHtml = html.slice(html.indexOf('id="input-area"'));
  assert.match(inputHtml, /id="composer-defaults"/);
  assert.doesNotMatch(headerHtml, /id="composer-defaults"/);
  assert.match(html, /id="mode-list"/);
  assert.match(appJs, /from '\/js\/header-chrome\.js'/);
  assert.match(appJs, /conn:ping/);
  assert.match(appJs, /formatRttChip/);
  assert.match(appJs, /formatWorkspaceChangeBadge/);
  assert.match(appJs, /\$\('header-home'\)\.onclick/);
  assert.match(appJs, /\$\('header-new'\)\.onclick/);
  assert.match(appJs, /\$\('header-context'\)\.onclick/);
});

test('client keeps session fork available without a main-chrome tab strip', () => {
  assert.match(allContent, /function forkCurrentSession/);
  assert.match(allContent, /socket\.emit\('session:fork'/);
});

test('client exposes P1 native app-server controls and readonly status panels', () => {
  for (const id of [
    'native-controls',
    'native-thread-refresh',
    'native-compact-btn',
    'native-rollback-btn',
    'native-models-btn',
    'native-files-btn',
    'native-account-btn',
    'native-mcp-btn',
    'native-skills-btn',
    'native-import-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  for (const event of [
    'thread:list',
    'thread:archive',
    'thread:unarchive',
    'thread:delete',
    'thread:rename',
    'thread:collaborationMode',
    'thread:compact',
    'thread:rollback',
    'models:read',
    'fs:readDirectory',
    'fs:readFile',
    'account:read',
    'mcp:read',
    'skills:read',
    'externalAgentConfig:detect',
    'externalAgentConfig:import',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(allContent, /function refreshNativeThreads/);
  assert.match(allContent, /function renderNativeThreadList/);
  assert.match(allContent, /function startCompact/);
  assert.match(allContent, /function rollbackThread/);
  assert.match(allContent, /function loadNativeModels/);
  assert.match(allContent, /function openFileBrowser/);
  assert.match(allContent, /function readNativeFile/);
  assert.match(allContent, /function loadAccountPanel/);
  assert.match(allContent, /function loadMcpPanel/);
  assert.match(allContent, /function loadSkillsPanel/);
  assert.match(allContent, /function detectExternalAgentConfig/);

  for (const [id, handler] of [
    ['native-compact-btn', 'startCompact'],
    ['native-rollback-btn', 'rollbackThread'],
    ['native-models-btn', 'loadNativeModels'],
    ['native-account-btn', 'loadAccountPanel'],
    ['native-mcp-btn', 'loadMcpPanel'],
    ['native-skills-btn', 'loadSkillsPanel'],
    ['native-import-btn', 'detectExternalAgentConfig'],
  ]) {
    assert.match(allContent, new RegExp(`\\$\\('${id}'\\)\\.onclick = ${handler}`));
  }
  assert.match(allContent, /\$\('native-thread-refresh'\)\.onclick = \(\) => refreshNativeThreads\(true\)/);
  assert.match(allContent, /\$\('native-files-btn'\)\.onclick = \(\) => openFileBrowser\(serverCwd\)/);
});

test('empty landing is a question plus task cards, not a slash-command menu', () => {
  const emptyHtml = html.slice(html.indexOf('id="empty-state"'), html.indexOf('id="at-mention-popup"'));
  assert.match(emptyHtml, /id="empty-heading"/);
  assert.match(emptyHtml, /我们来构建什么？/);
  assert.match(emptyHtml, /id="empty-project"/);
  assert.match(emptyHtml, /探索并理解代码/);
  assert.match(emptyHtml, /data-prompt=/);
  assert.doesNotMatch(emptyHtml, /empty-logo/);
  assert.doesNotMatch(emptyHtml, /empty-mark/);
  assert.doesNotMatch(emptyHtml, /查看系统状态/);
  assert.match(appJs, /dataset\.prompt/);
  assert.match(appJs, /empty-project/);
});

test('chat transcript uses a user pill and a full-width assistant column', () => {
  assert.match(css, /\.msg\.user\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(css, /\.msg\.codex\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.user \.bubble\s*\{[^}]*border-radius:\s*18px/s);
  assert.match(css, /#messages\s*\{[^}]*max-width:\s*720px/s);
  assert.match(css, /#input-area\s*\{[^}]*max-width:\s*720px/s);
  assert.doesNotMatch(css, /--user-bg:\s*#0d0d0d/);
});

test('tool and approval cards span the transcript column, not a 360px bubble', () => {
  assert.match(css, /\.tool-card\s*\{[^}]*max-width:\s*100%/s);
  assert.doesNotMatch(css, /\.tool-card\s*\{[^}]*max-width:\s*360px/s);
  assert.match(css, /\.approval-btns\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.reasoning-card\s*\{[^}]*background:\s*transparent/s);
  assert.doesNotMatch(css, /width: min\(340px/);
});

test('needs-you banner and reasoning sit in the transcript column', () => {
  assert.match(css, /#needs-you-panel\s*\{[^}]*max-width:\s*720px/s);
  assert.match(css, /#needs-you-panel\s*\{[^}]*border-radius:\s*14px/s);
  // 带前导点的选择器字面量:markup 里是 class="reasoning-fold"(无点),只有样式表里才有 `.`。
  assert.match(css, /\.reasoning-fold/);
  assert.match(css, /\.reasoning-body/);
  assert.match(appJs, /reasoning-fold/);
  assert.match(appJs, /reasoning-body/);
});

test('connection chrome sits in the transcript column and collapsed reasoning is short', () => {
  assert.match(css, /#conn-banner\s*\{[^}]*max-width:\s*720px/s);
  assert.match(css, /#conn-banner\s*\{[^}]*border-radius:\s*14px/s);
  assert.match(css, /#pending-panel\s*\{[^}]*max-width:\s*720px/s);
  assert.match(css, /\.reasoning-card\[data-streaming="true"\] \.reasoning-label/);
  assert.match(appJs, /reasoning-label/);
  assert.match(appJs, /<span class="reasoning-label">思考中<\/span>/);
  assert.doesNotMatch(appJs, /fold\.open = false/);
});

test('accent green is split into a text-grade tier and a decorative tier', () => {
  // 文字档:#0d8265 on #ffffff = 4.77:1、on --bg #f8f9fa = 4.53:1,两者都过 WCAG AA 正文。
  assert.match(css, /--accent-text:\s*#0d8265/);
  // 深色下 #10a37f 已达 5.33:1(on --surface #1c1c1c),文字档回落到装饰档同值。
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const darkBlock = css.slice(darkStart, css.indexOf('* { box-sizing', darkStart));
  assert.ok(darkStart >= 0 && darkBlock.length > 0);
  assert.match(darkBlock, /--accent-text:\s*#10a37f/);
  // 装饰档余量注释:在 --bg 上仅 3.03:1,提亮 --bg 会跌破 3:1 非文本标准。
  assert.match(css, /3\.03:1/);

  // 文字用法一律走文字档。
  assert.match(css, /\.drawer-project-item\.active\s*\{[^}]*color:\s*var\(--accent-text\)/s);
  assert.match(css, /\.codex \.bubble\.md a\s*\{[^}]*color:\s*var\(--accent-text\)/s);
  assert.match(css, /\.approve-btn\s*\{[^}]*background:\s*var\(--accent-text\)/s);
  // 搜索结果卡标题的内联 style CSS 够不着,必须在 JS 里换档。
  assert.doesNotMatch(appJs, /color:var\(--accent-light\)/);
  assert.match(appJs, /color:var\(--accent-text\)/);

  // 装饰用法保持装饰档,不随文字档下沉。
  assert.match(css, /#header-context svg\s*\{[^}]*color:\s*var\(--accent-light\)/s);
  assert.match(css, /#status-dot\.connected\s*\{[^}]*background:\s*var\(--accent-light\)/s);
  assert.match(css, /\.badge-dot\s*\{[^}]*color:\s*var\(--accent-light\)/s);
  assert.match(css, /\.popover-item-check\s*\{[^}]*color:\s*var\(--accent-light\)/s);
});

test('color-mix tokens sit behind an @supports guard that keeps hard-coded fallbacks in front', () => {
  // color-mix() 需要 Safari 16.2+ / Chrome 111+,而本项目现基线约 Safari 15.4 / Chrome 108。
  // 它的降级不是优雅降级:自定义属性接受任意 token,不支持的引擎不会回落到前一条声明,
  // 而是在使用处(background: var(--banner-warn))触发 invalid at computed-value time,
  // background 变成 unset —— 横幅会完全没有底色。所以硬编码 fallback 必须留在守护块之前。
  const supportsAt = css.indexOf('@supports (color: color-mix(');
  assert.ok(supportsAt > 0, 'color-mix 必须被 @supports (color: color-mix(…)) 守护');

  const beforeSupports = css.slice(0, supportsAt);
  for (const [name, fallback] of [
    ['--info-surface', /--info-surface:\s*#e8f4ff/],
    ['--warn-surface', /--warn-surface:\s*#fff4e0/],
    ['--success-surface', /--success-surface:\s*#e8f7ef/],
    ['--diff-add', /--diff-add:\s*rgba\(16,\s*163,\s*127,\s*0\.12\)/],
    ['--diff-del', /--diff-del:\s*rgba\(223,\s*28,\s*28,\s*0\.1\)/],
  ]) {
    assert.match(beforeSupports, fallback, `${name} 的硬编码 fallback 必须排在 @supports 之前`);
  }
  // 别名只是一跳间接:守护块之外它必须指向上面那些硬编码 fallback。
  assert.match(beforeSupports, /--banner-info:\s*var\(--info-surface\)/);
  assert.match(beforeSupports, /--banner-warn:\s*var\(--warn-surface\)/);
  assert.match(beforeSupports, /--banner-success:\s*var\(--success-surface\)/);

  // --diff-* 的 rgba 精确等于既有语义色(#10a37f / #df1c1c),是零观感变化的等价替换,
  // 用它确立 color-mix 的写法惯例。
  const guarded = css.slice(supportsAt);
  assert.match(guarded, /--diff-add:\s*color-mix\(in srgb, var\(--accent-light\) 12%, transparent\)/);
  assert.match(guarded, /--diff-del:\s*color-mix\(in srgb, var\(--error\) 10%, transparent\)/);
  assert.match(guarded, /--diff-add:\s*color-mix\(in srgb, var\(--accent-light\) 20%, transparent\)/);
  assert.match(guarded, /--diff-del:\s*color-mix\(in srgb, var\(--error\) 18%, transparent\)/);
});

test('each banner semantic derives surface/border/text from a single base colour', () => {
  const supportsAt = css.indexOf('@supports (color: color-mix(');
  const beforeSupports = css.slice(0, supportsAt);
  const guarded = css.slice(supportsAt);

  // 基色刻意留在守护块之外:它们是纯 hex 不需要守护,而且 --warn 被守护块之外的规则
  // (#status-dot.busy 等)直接引用 —— 放进 @supports 会让不支持的引擎读到 undefined,
  // background 同样变成 unset。
  assert.match(beforeSupports, /--info:\s*#2f7fd6/);
  assert.match(beforeSupports, /--warn:\s*#e09a10/);
  assert.match(beforeSupports, /--success:\s*#1a9d6d/);

  // 每语义 1 基色 + 3 派生。派生公式只写一遍:var() 惰性求值,--surface/--text 换成
  // 深色值后 8 个派生 token 自动跟随,深色块只需要覆盖混比。
  for (const [token, base, against] of [
    ['--info-surface', '--info', '--surface'],
    ['--info-border', '--info', '--surface'],
    ['--warn-surface', '--warn', '--surface'],
    ['--warn-border', '--warn', '--surface'],
    ['--warn-text', '--warn', '--text'],
    ['--success-surface', '--success', '--surface'],
    ['--success-border', '--success', '--surface'],
    ['--success-text', '--success', '--text'],
  ]) {
    assert.match(
      guarded,
      new RegExp(`\\${token}:\\s*color-mix\\(in srgb, var\\(\\${base}\\) var\\(\\${token}-mix\\), var\\(\\${against}\\)\\)`),
      `${token} 应由 var(${base}) 与 var(${against}) 按 var(${token}-mix) 派生`,
    );
  }
  // --info-text 现状就是正文色,没有混色可言,不进守护块。
  assert.match(beforeSupports, /--info-text:\s*var\(--text\)/);

  // 混比必须分模式:浅色是「白 + 一点色」,深色是「暗面 + 较多色」。
  const guardedDarkStart = guarded.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(guardedDarkStart > 0, '守护块内应有深色混比覆盖');
  const guardedLight = guarded.slice(0, guardedDarkStart);
  const guardedDark = guarded.slice(guardedDarkStart);
  for (const [token, light, dark] of [
    ['--info-surface-mix', '12%', '20%'],
    ['--info-border-mix', '30%', '42%'],
    ['--warn-surface-mix', '12%', '15%'],
    ['--warn-border-mix', '42%', '32%'],
    ['--warn-text-mix', '46%', '70%'],
    ['--success-surface-mix', '12%', '12%'],
    ['--success-border-mix', '48%', '33%'],
    ['--success-text-mix', '66%', '55%'],
  ]) {
    assert.match(guardedLight, new RegExp(`\\${token}:\\s*${light}`), `${token} 浅色档`);
    assert.match(guardedDark, new RegExp(`\\${token}:\\s*${dark}`), `${token} 深色档`);
  }

  // 深色的绿基色单独下沉一档:浅色基色 #1a9d6d 明度不够,和 --text 怎么混都出不来
  // 深色下 #87e0a2 那种高亮薄荷绿文字。蓝/琥珀两个基色两模式共用。
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const darkFallbacks = css.slice(darkStart, supportsAt);
  assert.match(darkFallbacks, /--success:\s*#2ecc71/);
  assert.doesNotMatch(darkFallbacks, /--info:\s*#/);
  assert.doesNotMatch(darkFallbacks, /--warn:\s*#/);
});

test('banner components read semantic tokens instead of per-element hard-coded colours', () => {
  // token 层之后就是组件层。语义色的模式差异全部收敛进 token,组件规则里不该再出现
  // 散落的同色系硬编码,也不该再为深色重写一遍颜色。
  const componentCss = css.slice(css.indexOf('* { box-sizing'));

  for (const [selector, declarations] of [
    ['#conn-banner\\[data-tone="info"\\]', ['var\\(--banner-info\\)', 'var\\(--info-text\\)', 'var\\(--info-border\\)']],
    ['#conn-banner\\[data-tone="warn"\\]', ['var\\(--banner-warn\\)', 'var\\(--warn-text\\)', 'var\\(--warn-border\\)']],
    ['#conn-banner\\[data-tone="success"\\]', ['var\\(--banner-success\\)', 'var\\(--success-text\\)', 'var\\(--success-border\\)']],
    ['#pending-panel', ['var\\(--banner-warn\\)', 'var\\(--warn-border\\)']],
    ['#needs-you-panel', ['var\\(--banner-warn\\)', 'var\\(--warn-border\\)']],
    ['\\.needs-you-heading', ['var\\(--warn-text\\)']],
  ]) {
    for (const declaration of declarations) {
      assert.match(
        componentCss,
        new RegExp(`${selector}\\s*\\{[^}]*${declaration}`, 's'),
        `${selector.replace(/\\/g, '')} 应引用 ${declaration.replace(/\\/g, '')}`,
      );
    }
  }

  // 只换 background 会造成"底色变了、描边没跟上"的半迁移 —— 连带的 border/text 硬编码
  // 必须整组迁走。
  for (const literal of [
    '#c5dff5', '#2a4a66', // info border(浅/深)
    '#f0d49a', '#5a4520', // warn border(浅/深)
    '#6e4c00', '#e0b05a', '#7b4c00', // warn text(横幅/重试按钮)
    '#0d6b45', '#24543a', // success text / border(深)
    '#e8a020', // 琥珀装饰档:状态点与重试按钮描边
  ]) {
    assert.ok(!componentCss.includes(literal), `组件规则里不应再有硬编码 ${literal}`);
  }

  // 派生 token 自身模式感知 ⇒ 组件层不再需要任何 prefers-color-scheme 覆盖。
  assert.doesNotMatch(
    componentCss,
    /@media \(prefers-color-scheme: dark\)/,
    '颜色的深浅差异应全部收敛到 token 层',
  );

  // 有意保留的例外:RTT 芯片的警告态。#9a5f22 on --bg 已是 4.94:1(过 AA),
  // 归并到 --warn-text 会推到 7.22:1 —— 不必要的超额收益,代价是芯片肉眼可辨地变深棕。
  // 这条断言把"不归并"固化成契约,避免后来者把它当成遗漏顺手统一掉。
  assert.match(
    componentCss,
    /#conn-rtt\[data-tone="warn"\]\s*\{[^}]*color:\s*#9a5f22/s,
    'RTT 芯片警告态应保留 #9a5f22——它已过 AA,归并只会无谓加深观感',
  );

  // 绕过变量的同色硬编码。
  assert.match(componentCss, /\.thread-status-dot\.running\s*\{[^}]*background:\s*var\(--accent-light\)/s);
});

test('markdown styling covers every element gfm actually emits', () => {
  // marked 开着 gfm: true,但样式表原本只覆盖 p / ul,ol / pre / code / a。
  // 表格、标题、引用、分隔线的观感由 e2e/markdown-typography.spec.js 守护;
  // 下面这几个在浏览器里难以稳定构造,用规则存在性兜底。
  assert.match(
    css,
    /\.codex \.bubble\.md img\s*\{[^}]*max-width:\s*100%[^}]*height:\s*auto/s,
    '回复里贴的图不加约束会按原始像素宽度撑破阅读栏',
  );
  assert.match(css, /\.codex \.bubble\.md li\s*\{[^}]*margin-bottom/s, '列表项之间要有呼吸');
  assert.match(css, /\.codex \.bubble\.md li:last-child\s*\{[^}]*margin-bottom:\s*0/s);
  assert.match(css, /\.codex \.bubble\.md strong\s*\{[^}]*font-weight/s);
  assert.match(css, /\.codex \.bubble\.md em\s*\{[^}]*font-style:\s*italic/s);
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'th', 'td']) {
    assert.ok(css.includes(`.codex .bubble.md ${tag}`), `.codex .bubble.md ${tag} 应有规则`);
  }
});

test('the body font stack drops the never-loaded Outfit family', () => {
  // 全仓库没有 @font-face、没有字体文件、也没有外链 —— 'Outfit' 从来没被加载过,
  // 一直在空转 fallback 到 -apple-system。删掉让声明诚实,零视觉变化。
  assert.doesNotMatch(css, /Outfit/);
  assert.doesNotMatch(css, /@font-face/, '不引入任何字体文件');
  assert.match(css, /body \{[^}]*font-family:\s*-apple-system, BlinkMacSystemFont/s);
});

test('hover affordances are gated behind (hover: hover) and touch targets keep an :active fallback', () => {
  // 触屏点一下会让 :hover 粘住,直到点别处才消失。所有悬停态必须关进 @media (hover: hover)。
  // 这里不能用 /selector\s*\{[^}]*/ —— `[^}]*` 会被嵌套规则的第一个 } 提前截断,
  // 改用切片定域:从 @media 起数花括号深度,回到 0 处即块尾(与缩进无关)。
  const hoverStart = css.indexOf('@media (hover: hover) {');
  assert.ok(hoverStart >= 0, '样式表应有 @media (hover: hover) 块');
  let hoverEnd = -1;
  for (let i = hoverStart, depth = 0; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0) { hoverEnd = i + 1; break; }
  }
  assert.ok(hoverEnd > hoverStart, '@media (hover: hover) 块未闭合');
  const hoverBlock = css.slice(hoverStart, hoverEnd);
  assert.ok(hoverBlock.length > 100);

  for (const selector of [
    '.session-item:hover',
    '.badge-pill:hover',
    '.slash-item:hover',
    '#composer-defaults:hover',
    '#attach-btn:hover',
    '#send-btn:hover:not(:disabled)',
    '#followup-btn:hover',
    '.popover-item:hover',
    '.attach-chip-remove:hover',
  ]) {
    assert.ok(hoverBlock.includes(selector), `${selector} 应落在 @media (hover: hover) 内`);
  }

  // 门控之外不允许再有裸悬停规则(注释里提到 :hover 不算)。
  const outsideHover = (css.slice(0, hoverStart) + css.slice(hoverEnd))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(outsideHover, /:hover/);

  // 陷阱 A:#composer-defaults 的 :hover 与 :focus-visible 原本共用声明块。
  // 整块包进媒体查询会让键盘焦点态在触摸设备上一并丢失,必须拆开。
  assert.ok(!hoverBlock.includes('#composer-defaults:focus-visible'));
  assert.match(css, /#composer-defaults:focus-visible\s*\{[^}]*color:\s*var\(--text\)/s);

  // 陷阱 B:.popover-item.selected 与 .popover-item:hover 同特异度(0,2,0)且在其后,
  // 导致悬停一个已选中项反而比未选中更浅。用 0,3,0 的独立规则修掉,与源序无关。
  // wash 必须走 token:深色下 rgba(0,0,0,…) 几乎看不见。
  assert.match(css, /\.popover-item\.selected\s*\{[^}]*background:\s*var\(--hover-wash\)/s);
  assert.match(hoverBlock, /\.popover-item:hover\s*\{[^}]*background:\s*var\(--hover-wash-hover\)/s);
  assert.match(hoverBlock, /\.popover-item\.selected:hover\s*\{[^}]*background:\s*var\(--hover-wash-strong\)/s);

  // 陷阱 C:这 5 个宿主原本只有 hover 一种反馈,门控后在移动端会变成零点按反馈。
  for (const selector of [
    '.session-item:active',
    '.badge-pill:active',
    '.slash-item:active',
    '.popover-item:active',
    '.attach-chip-remove:active',
  ]) {
    assert.ok(css.includes(selector), `${selector} 应提供触摸点按反馈`);
  }
  // :active 兜底必须排在 hover 块之后,否则桌面端按下时会被同特异度的 :hover 压过。
  assert.ok(css.indexOf('.session-item:active') > hoverStart);
  assert.ok(css.indexOf('.slash-item:active') > hoverStart);
  assert.ok(css.indexOf('.popover-item:active') > hoverStart);
});

test('scrollable overlays and nested panes contain their scroll chain', () => {
  // 浮层/嵌套滚动区滚到边界后继续滑,会把滚动传递给背后的 #messages 或 body。
  // overscroll-behavior: contain 把滚动链截断在自己身上。
  for (const selector of [
    // 浮层
    '#drawer-body',
    '.slash-popup',
    '#at-mention-popup',
    // 同一个 <div id="session-settings-body" class="workspace-body"> 同时命中这两条规则,
    // 只改一条会漏掉另一个用到该规则的面板。
    '#session-settings-body',
    '.workspace-body',
    '#native-panel',
    // 嵌套滚动区
    '#messages',
    '.empty-state',
    '.reasoning-body',
    '.tool-output',
    '.codex .bubble.md pre',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      css,
      new RegExp(`${escaped}\\s*\\{[^}]*overscroll-behavior:\\s*contain`, 's'),
      `${selector} 应含 overscroll-behavior: contain`,
    );
  }
});

test('mobile shell exposes connection banner, workspace sheet, confirm sheet and @ mention search', () => {
  const workspaceJs = readFileSync(new URL('../public/js/workspace-panel.js', import.meta.url), 'utf8');
  assert.match(html, /id="conn-banner"/);
  assert.match(html, /id="workspace-modal"/);
  assert.match(html, /id="confirm-modal"/);
  assert.match(html, /id="at-mention-popup"/);
  assert.match(html, /id="attach-preview-modal"/);
  assert.match(html, /id="push-subscribe-btn"/);
  assert.match(html, /id="header-project"/);
  assert.match(html, /highlight\.min\.js/);
  assert.match(appJs, /from '\/js\/connection-banner\.js'/);
  assert.match(appJs, /from '\/js\/workspace-panel\.js'/);
  assert.match(appJs, /from '\/js\/confirm-dialog\.js'/);
  assert.match(appJs, /files:search/);
  assert.match(workspaceJs, /git:status/);
  assert.match(appJs, /pickPastedImage/);
  assert.match(appJs, /m\.kind === 'command'/);
});

test('assistant bubbles stream stable text and render sanitized markdown when complete', () => {
  assert.match(appJs, /from '\/js\/markdown\.js'/);
  assert.match(appJs, /from '\/js\/transcript-stream\.js'/);
  assert.match(appJs, /createTranscriptStream/);
  assert.match(appJs, /streamingEl\.textContent = text/);
  assert.match(appJs, /streamingEl\.innerHTML = renderMarkdown\(text\)/);
  assert.match(appJs, /delete streamingEl\.dataset\.streaming/);
  assert.match(appJs, /renderMarkdown\(m\.content \|\| ''\)/);
  assert.doesNotMatch(appJs, /escHtml\(m\.content\.slice\(0, 500\)\)/);
});

test('streaming tokens stay out of the live region and turn completion is announced once', () => {
  assert.match(html, /id="messages" aria-live="off"/);
  assert.match(html, /id="turn-announcer"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(appJs, /function announceTurnComplete/);
  assert.match(appJs, /announceTurnComplete\(payload\?\.ok === false \? '回复失败' : '回复完成'\)/);
});

test('client uses app-server threads as the only session drawer and history source', () => {
  assert.match(allContent, /socket\.emit\('thread:history'/);
  assert.match(allContent, /function loadNativeThreadHistory/);
  assert.match(allContent, /renderHistoryMessages/);
  assert.match(allContent, /thread:select', \{ threadId: s\.id, cwd: s\.cwd, title: s\.title \}/);
  assert.match(allContent, /loadNativeThreadHistory\(s\)/);
  assert.match(allContent, /sessionsByCwd\.get\(cwd\)/);
  assert.match(allContent, /if \(socket\.connected\) refreshNativeThreads\(\)/);
  assert.doesNotMatch(allContent, /\bcodexSessions\b/);
  assert.doesNotMatch(allContent, /socket\.emit\('session:history'/);
  assert.doesNotMatch(allContent, /socket\.emit\('session:list'/);
  assert.doesNotMatch(allContent, /case 'session_list'/);
  assert.doesNotMatch(allContent, /function handleSessionList/);
  assert.doesNotMatch(allContent, /function loadHistory/);
  assert.doesNotMatch(allContent, /source === 'codex'/);
});

test('client stores the current thread as a browser preference partitioned by cwd', () => {
  assert.match(allContent, /from '\/js\/thread-preferences\.js'/);
  assert.match(allContent, /getCurrentThread\(localStorage, serverCwd\)/);
  assert.match(allContent, /setCurrentThread\(localStorage, serverCwd, currentSessionId\)/);
  assert.match(allContent, /clearCurrentThread\(localStorage, serverCwd/);
  assert.doesNotMatch(allContent, /codex_current_session_id/);
});

test('client buffers live events while applying an epoch-aware thread/read recovery snapshot', () => {
  assert.match(allContent, /from '\/js\/recovery-state\.js'/);
  assert.match(allContent, /function requestCatchUp/);
  assert.match(allContent, /lastEpoch[,}]/);
  assert.match(allContent, /bufferRecoveryEvent\(activeRecovery, ev\)/);
  assert.match(allContent, /completeRecovery\(state, ack\)/);
  assert.match(allContent, /recovery\.snapshot\.messages/);
  assert.match(allContent, /codex_last_epoch:/);
});

test('client persists one stable message request before clearing input or draining it', () => {
  assert.match(allContent, /from '\/js\/message-request\.js'/);
  assert.match(allContent, /from '\/js\/message-outbox\.js'/);
  assert.match(allContent, /from '\/js\/indexeddb-outbox\.js'/);
  assert.match(allContent, /from '\/js\/socket-ack\.js'/);
  assert.match(allContent, /createMessageRequest\(/);
  assert.match(allContent, /await messageOutbox\.enqueue\(request\)/);
  assert.match(allContent, /emitWithAck\(socket, 'user:message', payload/);
  assert.match(allContent, /messageOutbox\.drain\(options\)/);
  assert.doesNotMatch(allContent, /\bofflineQueue\b/);

  const sendBody = allContent.slice(allContent.indexOf('async function sendMessage()'));
  assert.ok(sendBody.indexOf('await messageOutbox.enqueue(request)') < sendBody.indexOf("inputEl.value = '';"));
});

test('new messages drain the complete active view lane instead of bypassing its FIFO head', () => {
  const sendBody = allContent.slice(allContent.indexOf('async function sendMessage()'));
  assert.match(sendBody, /shouldSend: outboxRequestMatchesView/);
  assert.doesNotMatch(sendBody, /shouldSend: stored => stored\.clientRequestId === request\.clientRequestId/);
});

test('client reconciles unknown outbox results through the read-only gateway path before draining', () => {
  assert.match(allContent, /let gatewayEpoch = null;/);
  assert.match(allContent, /getGatewayEpoch: \(\) => gatewayEpoch/);
  assert.match(allContent, /reconcileTransport: async payload/);
  assert.match(allContent, /emitWithAck\(socket, 'message:reconcile'/);
  assert.match(allContent, /gatewayEpoch = payload\.gatewayEpoch/);
  assert.match(allContent, /await messageOutbox\.reconcile\(/);
  assert.match(allContent, /request\.state === 'needs_reconcile'/);
  assert.match(allContent, /结果未知/);
  assert.match(allContent, /messageOutbox\.retryAfterConfirmation\(/);
  assert.match(allContent, /再次发送可能重复执行/);
});

test('confirmed unknown retries bind a fresh request to the current view lane', () => {
  const start = allContent.indexOf('retryButton.onclick = async () =>');
  const end = allContent.indexOf("el.querySelector('.bubble')?.appendChild(retryButton);", start);
  const handler = allContent.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /const target = await ensureViewTarget\(\)/);
  assert.match(handler, /retryAfterConfirmation\(clientRequestId, \{ target \}\)/);
  assert.match(handler, /renderedOutboxStates\.delete\(clientRequestId\)/);
  assert.match(handler, /dataset\.clientRequestId = replacement\.clientRequestId/);
  assert.match(handler, /offlineUserBubbles\.splice\(/);
  assert.match(handler, /shouldSend: outboxRequestMatchesView/);
  assert.doesNotMatch(handler, /shouldSend: request => request\.clientRequestId === clientRequestId/);
});

test('client surfaces provisional orphans, reconciles attempted ones, and rebinds only unattempted ones', () => {
  assert.match(allContent, /from '\/js\/outbox-recovery\.js'/);
  assert.match(allContent, /let instanceSnapshotReceived = false/);
  assert.match(allContent, /isProvisionalInstanceOrphan\(/);

  const start = allContent.indexOf('async function syncOutboxView()');
  const end = allContent.indexOf('syncVisualViewport();', start);
  const syncBody = allContent.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(syncBody, /orphanedAttemptIds/);
  assert.match(syncBody, /shouldReconcile:[\s\S]*orphanedAttemptIds\.has/);
  assert.match(syncBody, /await ensureViewTarget\(\)/);
  assert.match(syncBody, /messageOutbox\.rebindUnattempted\(/);
  assert.match(syncBody, /restoreProvisionalOutboxTarget\(/);
  assert.match(syncBody, /unboundRecovery[,}]/);
  assert.match(syncBody, /shouldSend: outboxRequestMatchesView/);

  const instancesStart = allContent.indexOf('function handleInstances(payload)');
  const instancesEnd = allContent.indexOf('function renderInstanceTabs()', instancesStart);
  const instancesHandler = allContent.slice(instancesStart, instancesEnd);
  assert.match(instancesHandler, /instanceSnapshotReceived = true/);
  assert.match(instancesHandler, /syncOutboxView\(\)/);
});

test('client sends selected files and skills as durable structured input parts', () => {
  assert.match(allContent, /let currentInputParts = \[\]/);
  assert.match(allContent, /function addInputPart\(part\)/);
  assert.match(allContent, /addInputPart\(\{ kind: 'mention'/);
  assert.match(allContent, /addInputPart\(\{ kind: 'skill'/);
  assert.match(allContent, /createMessageRequest\(\{ text, attachments, parts, target, turn \}\)/);
  assert.doesNotMatch(allContent, /const mention = `@\$\{path\}`/);
});

test('composer settings expose CLI model, reasoning, approval and sandbox without slash messages', () => {
  assert.match(appJs, /from '\/js\/cli-settings\.js'/);
  assert.match(html, /data-testid="composer-defaults"/);
  assert.match(html, /id="session-settings"/);
  assert.match(appJs, /formatComposerPermission/);
  assert.match(appJs, /openSessionSettings/);
  assert.match(html, /id="approval-list"/);
  assert.match(html, /id="sandbox-list"/);
  assert.match(html, /id="model-list"/);
  assert.match(html, /id="reasoning-list"/);
  assert.match(allContent, /function loadComposerModels/);
  assert.match(allContent, /function renderCliSettingsPopovers/);
  assert.match(allContent, /data-approval/);
  assert.match(allContent, /data-sandbox/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/model '/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/reasoning '/);
  assert.doesNotMatch(appJs, /inputEl\.value = '\/approval-policy '/);
  assert.doesNotMatch(appJs, /inputEl\.value = val;\s*closeSessionSettings\(\);\s*sendMessage\(\)/);
  assert.match(appJs, /socket\.emit\('thread:collaborationMode'/);
  assert.match(appJs, /parseCollaborationModeSlash/);
  assert.match(appJs, /case 'collaboration_mode'/);
  assert.match(html, /id="mode-list"[\s\S]*data-mode="default"/);
  assert.match(html, /id="mode-list"[\s\S]*data-mode="plan"/);
  assert.doesNotMatch(html, /id="mode-list"[\s\S]*data-value="\/chat"/);
  assert.doesNotMatch(html, /data-value="unlessTrusted"/);
  assert.doesNotMatch(html, /data-reasoning="超高"/);
});

test('client exposes P2 admin controls behind unlock and per-action confirmation', () => {
  for (const id of [
    'native-admin-btn',
    'admin-unlock-btn',
    'admin-lock-btn',
    'admin-config-write-btn',
    'admin-config-batch-btn',
    'admin-plugin-install-btn',
    'admin-plugin-uninstall-btn',
    'admin-marketplace-add-btn',
    'admin-marketplace-remove-btn',
    'admin-marketplace-upgrade-btn',
    'admin-fs-write-btn',
    'admin-fs-remove-btn',
    'admin-fs-copy-btn',
    'admin-mcp-call-btn',
    'admin-logout-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  assert.match(allContent, /function openAdminPanel/);
  assert.match(allContent, /function unlockAdminMode/);
  assert.match(allContent, /function lockAdminMode/);
  assert.match(allContent, /function runAdminAction/);
  assert.match(allContent, /promptRequired\('Unlock phrase', 'ENABLE ADMIN'\)/);
  assert.match(allContent, /promptRequired\('Confirm action', eventName\)/);
  assert.match(allContent, /adminConfirm: confirmation/);

  for (const event of [
    'admin:unlock',
    'admin:lock',
    'admin:configWrite',
    'admin:configBatchWrite',
    'admin:pluginInstall',
    'admin:pluginUninstall',
    'admin:marketplaceAdd',
    'admin:marketplaceRemove',
    'admin:marketplaceUpgrade',
    'admin:fsWriteFile',
    'admin:fsRemove',
    'admin:fsCopy',
    'admin:mcpToolCall',
    'admin:accountLogout',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(allContent, /\$\('native-admin-btn'\)\.onclick = openAdminPanel/);
});

test('client exposes P3 experimental labs controls and isolated event renderers', () => {
  for (const id of [
    'native-p3-btn',
    'p3-capabilities-btn',
    'p3-terminal-spawn-btn',
    'p3-terminal-write-btn',
    'p3-terminal-resize-btn',
    'p3-terminal-terminate-btn',
    'p3-thread-turns-btn',
    'p3-thread-search-btn',
  ]) {
    assert.match(allContent, new RegExp(`id="${id}"`));
  }

  for (const event of [
    'p3:capabilities',
    'p3:terminalSpawn',
    'p3:terminalWrite',
    'p3:terminalResize',
    'p3:terminalTerminate',
    'p3:threadTurns',
    'p3:threadSearch',
  ]) {
    assert.match(allContent, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  for (const type of ['term_output', 'term_exit', 'realtime', 'remote_control']) {
    assert.match(allContent, new RegExp(`case '${type}'`));
  }

  assert.match(allContent, /function openP3Panel/);
  assert.match(allContent, /function spawnP3Terminal/);
  assert.match(allContent, /function handleP3TerminalOutput/);
  assert.match(allContent, /function handleP3Realtime/);
  assert.match(allContent, /function handleP3RemoteControl/);
  assert.match(allContent, /\$\('native-p3-btn'\)\.onclick = openP3Panel/);
});

test('a stuck outbox record tells the truth and offers the user a way out', () => {
  assert.match(appJs, /requiresManualDisposal/);
  assert.match(appJs, /from '\/js\/outbox-recovery\.js'/);

  const start = appJs.indexOf('function appendOfflineBubble(');
  const end = appJs.indexOf('function promoteOfflineBubble(', start);
  const bubble = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);

  // 「连接后将恢复到当前会话」只能对真的会被 rebindUnattempted 接回的记录说。
  assert.match(bubble, /连接后将恢复到当前会话/);
  assert.match(bubble, /requiresManualDisposal|manualDisposal/);
  assert.doesNotMatch(
    bubble,
    /unboundRecovery\s*\?\s*\(needsReconcile[\s\S]{0,120}连接后将恢复到当前会话'\)\s*\n\s*:\s*\(needsReconcile/,
    '不能只按 needsReconcile 二分——尝试过的孤儿记录永远不会被恢复',
  );

  // 卡死的记录必须能被丢弃，且丢弃前要确认（可能已经在服务端执行过）。
  assert.match(bubble, /outbox-discard-btn/);
  assert.match(bubble, /confirmDialog\.confirm\(/);
  assert.match(bubble, /messageOutbox\.discard\(/);
  assert.match(bubble, /renderedOutboxStates\.delete\(/);
  assert.match(bubble, /el\.remove\(\)/);

  assert.match(css, /\.outbox-discard-btn\s*\{/);
});

test('the outbox view passes each record its own disposal verdict', () => {
  const start = appJs.indexOf('async function syncOutboxViewOnce()');
  const end = appJs.indexOf('syncVisualViewport();', start);
  const syncBody = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(syncBody, /requiresManualDisposal\(request, \{ orphaned: unboundRecovery \}\)/);
  assert.match(syncBody, /manualDisposal/);
});

test('composer shows and sends the same effective settings', () => {
  // 必须真的从模块导入——只断言「文中出现过这个名字」会漏掉忘记 import 的情况，
  // 那样运行时才会炸。
  const importBlock = appJs.slice(0, appJs.indexOf("from '/js/cli-settings.js'"));
  assert.match(importBlock, /^\s*effectiveComposerSettings,$/m);

  // 有效设置必须集中在一处算出来，供显示与发送共用。
  assert.match(appJs, /function effectiveTurnSettings\(\)/);
  assert.match(appJs, /effectiveComposerSettings\(currentTurnSettings\(\), \{[\s\S]{0,120}\}\)/);

  // 发送路径：不能再用裸的 currentTurnSettings()，否则用户没选过模型时
  // turn/start 不带 model，app-server 会回落到自己的默认模型并报 400。
  const sendStart = appJs.indexOf('async function sendMessage(');
  const sendBody = appJs.slice(sendStart, sendStart + 6000);
  assert.ok(sendStart >= 0);
  assert.match(sendBody, /const turn = effectiveTurnSettings\(\)/);
  assert.doesNotMatch(sendBody, /const turn = currentTurnSettings\(\)/);

  // 列表选中态必须走同一份有效设置，否则审批/沙箱列表会一项 .selected 都没有，
  // 而胶囊却已经显示了服务端默认值。
  const renderStart = appJs.indexOf('function renderCliSettingsPopovers()');
  const renderEnd = appJs.indexOf('function ', renderStart + 40);
  const renderBody = appJs.slice(renderStart, renderEnd);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(renderBody, /effectiveTurnSettings\(\)/);
  assert.doesNotMatch(renderBody, /'approval', selectedApproval\)/);
  assert.doesNotMatch(renderBody, /'sandbox', selectedSandbox\)/);
  // 五组必须一视同仁。当初只接了 approval/sandbox，漏掉思考强度与服务档位，
  // 结果面板里前三组有勾、后两组一个选中都没有。
  assert.doesNotMatch(renderBody, /'reasoning',\s*selectedReasoning,/);
  assert.doesNotMatch(renderBody, /'speed',\s*selectedServiceTier,/);
  assert.match(renderBody, /'reasoning',\s*effective\.effort,/);
  assert.match(renderBody, /'speed',\s*effective\.serviceTier,/);
  assert.doesNotMatch(renderBody, /option\.id === selectedReasoning/);

  // 持久化仍然只存用户显式选过的值——把服务端默认固化进 localStorage 会让
  // 之后服务端改了默认也跟不上。
  assert.match(appJs, /saveCliSettings\(localStorage, currentTurnSettings\(\)\)/);
});

test('the speed group is a plain single-choice list, like every other group', () => {
  // speed 曾是整个设置面板里唯一的 toggle：选了「快速」之后想回默认，只能再点一次
  // 同一行——不可发现，而且「标准」这一行当时根本不存在。对齐 Codex 桌面端后
  // 它就是一组普通单选，默认档是列表里看得见、能点回去的一项。
  const speedStart = appJs.indexOf("$('speed-list')?.addEventListener('click'");
  assert.ok(speedStart >= 0);
  const speedBody = appJs.slice(speedStart, speedStart + 400);
  assert.doesNotMatch(speedBody, /selectedServiceTier === next \? '' : next/);
  assert.match(speedBody, /selectedServiceTier = next;/);

  // 标准档的 id 是空串（表示不下发 serviceTier），选中判定不能把空 id 一律当没选。
  const renderStart = appJs.indexOf('function renderPopoverItems(');
  assert.ok(renderStart >= 0);
  const renderBody = appJs.slice(renderStart, renderStart + 700);
  assert.doesNotMatch(renderBody, /item\.id && item\.id === selectedId/);
  assert.match(renderBody, /item\.id === selectedId/);

  // 分组标题跟桌面端一致叫「速度」，比协议字段名「服务档位」更接近用户心智。
  assert.match(html, /id="speed-section-label"[^>]*>速度</);

  // 模型不支持档位时整组要真的消失。.popover-list 的 display:flex 会压过 [hidden]
  // 自带的 display:none，只藏标题、留一个带 padding 的空容器。
  assert.match(css, /\.popover-list\[hidden\]\s*\{[^}]*display:\s*none/);
});

test('an outbox bubble is redrawn when its state changes', () => {
  const start = appJs.indexOf('async function syncOutboxViewOnce()');
  const end = appJs.indexOf('syncVisualViewport();', start);
  const body = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);

  // 旧写法只按 id 去重，记录从 pending 变成 needs_reconcile / rejected 后气泡不会重绘：
  // 文案停在「弱网等待同步」，重试与丢弃按钮也长不出来，用户只能靠刷新才看得到真实状态。
  assert.doesNotMatch(body, /if \(renderedOutboxStates\.has\(request\.clientRequestId\)\) continue;/);
  // 去重键必须带上状态，状态变了就重画。
  assert.match(appJs, /renderedOutboxStates/);
  assert.match(body, /renderedOutboxStates\.get\(/);
  assert.match(body, /dropRenderedOutboxBubble\(/);

  // 光有状态比对不够：状态是在 drain 内部变的，得有人触发重新渲染。
  const sendStart = appJs.indexOf('async function sendMessage(');
  const sendBody = appJs.slice(sendStart, sendStart + 6000);
  assert.match(sendBody, /drainMessageOutbox\([\s\S]{0,80}\)\.then\(\(\) => syncOutboxView\(\)\)/);
});

test('reconnect attempts do not spam the transcript with error rows', () => {
  const start = appJs.indexOf("socket.on('connect_error'");
  const end = appJs.indexOf("window.addEventListener('offline'", start);
  const body = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);

  // Socket.IO 断线后会持续重连，每次失败都触发一次 connect_error。逐条往消息区堆红条
  // 会把真实对话挤出视野（实测断线 53 秒堆了 9 条），而横幅已经在显示「自动重连中」并计时。
  assert.match(body, /lastConnectErrorNotice/);
  assert.match(body, /if \(message === lastConnectErrorNotice\) return;/);
  // unauthorized 仍要立刻打断并要求重新登录，不能被去重逻辑吞掉。
  assert.ok(body.indexOf("unauthorized") < body.indexOf('lastConnectErrorNotice'),
    'unauthorized 分支必须排在去重之前');

  // 重连成功后要复位，否则下次断线就再也不提示了。
  assert.match(appJs, /lastConnectErrorNotice = ''/);
});

test('a failed outbox record is never hidden just because the view moved on', () => {
  assert.match(appJs, /shouldSurfaceInOutboxView/);
  const start = appJs.indexOf('async function syncOutboxViewOnce()');
  const end = appJs.indexOf('syncVisualViewport();', start);
  const body = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // 旧的两条件过滤会把「带 threadId 但 thread 已消失」的失败记录整个藏起来，
  // 用户既看不到消息没发出去，也没有入口清掉它。
  assert.doesNotMatch(body, /outboxRequestMatchesView\(request\) \|\| orphanedRequestIds\.has\(request\.clientRequestId\)\s*\)\);/);
  assert.match(body, /shouldSurfaceInOutboxView\(request, \{/);
  // 浮出来的外来记录必须标明它不属于当前会话，否则用户会以为是本会话发的。
  assert.match(body, /foreignThread/);
});

test('a stale approval card states the real reason it went away', () => {
  assert.match(appJs, /needResolutionLabel/);
  const start = appJs.indexOf('function handleNeedsYouChanged(');
  const end = appJs.indexOf('function openPendingNeedsYouDeepLink(', start);
  const body = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // 不能再对所有非 pending 状态一律写死「已在其他设备处理」：超时和撤销时那是假话。
  assert.doesNotMatch(body, /已在其他设备处理/);
  assert.match(body, /needResolutionLabel\(need\.state\)/);
});

test('attachment tray clears its DOM when the last chip is removed', () => {
  const start = appJs.indexOf('function renderAttachTray()');
  const end = appJs.indexOf('function ', start + 40);
  const body = appJs.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // 空态分支早返回前必须清空容器，否则移除最后一个附件后 .attach-chip 仍留在 DOM 里，
  // 且残留 chip 的 onclick 闭包还指着旧的数组下标。
  const emptyBranch = body.slice(0, body.indexOf('attachTray.hidden = false'));
  assert.match(emptyBranch, /attachTray\.innerHTML = ''/);
});

test('dark-mode hard-coded washes and on-fill colours live in theme tokens', () => {
  // 组件层禁止再开 prefers-color-scheme:深浅差异全部收敛到 :root token。
  // 这些 token 修的是已知在深色下发亮/不可读的硬编码残留。
  const supportsAt = css.indexOf('@supports (color: color-mix(');
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkStart >= 0 && supportsAt > darkStart);
  const lightRoot = css.slice(0, darkStart);
  const darkRoot = css.slice(darkStart, supportsAt);
  const componentCss = css.slice(css.indexOf('* { box-sizing'));

  for (const [token, light, dark] of [
    ['--on-accent', /#fff(?:fff)?/i, /#0d0d0d/i],
    ['--on-accent-text', /#fff(?:fff)?/i, /#fff(?:fff)?/i],
    ['--on-error', /#fff(?:fff)?/i, /#fff(?:fff)?/i],
    ['--glass', /rgba\(\s*255\s*,\s*255\s*,\s*255/i, /rgba\(\s*(?:28|255)/i],
    ['--glass-soft', /rgba\(\s*255\s*,\s*255\s*,\s*255/i, /rgba\(\s*(?:28|255)/i],
    ['--scrollbar-thumb', /rgba\(\s*0\s*,\s*0\s*,\s*0/i, /rgba\(\s*255\s*,\s*255\s*,\s*255/i],
    ['--spinner-track', /rgba\(\s*0\s*,\s*0\s*,\s*0/i, /rgba\(\s*255\s*,\s*255\s*,\s*255/i],
    ['--error-surface', /#fdf0f0/i, /#[0-9a-f]{3,8}/i],
    ['--error-border', /#f[0-9a-f]{5}/i, /#[0-9a-f]{3,8}/i],
    // 深色文字档必须比基色 #df1c1c 更亮:后者 on --error-surface #3a1a1a 只有 3.22:1。
    ['--error-text', /#df1c1c/i, /#ff8888/i],
    ['--hover-wash', /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.02\s*\)/i, /rgba\(\s*255\s*,\s*255\s*,\s*255/i],
    ['--hover-wash-hover', /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.03\s*\)/i, /rgba\(\s*255\s*,\s*255\s*,\s*255/i],
    ['--hover-wash-strong', /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.06\s*\)/i, /rgba\(\s*255\s*,\s*255\s*,\s*255/i],
  ]) {
    assert.match(lightRoot, new RegExp(`${token}:\\s*${light.source}`, 'i'), `${token} 浅色档`);
    assert.match(darkRoot, new RegExp(`${token}:\\s*${dark.source}`, 'i'), `${token} 深色档`);
  }

  // 组件只引用 token,不再写死白玻璃 / 白字 / 浅粉面 / 黑拇指。
  assert.match(componentCss, /\.slash-popup\s*\{[^}]*background:\s*var\(--glass\)/s);
  assert.match(componentCss, /#attach-tray\s*\{[^}]*background:\s*var\(--glass-soft\)/s);
  assert.match(componentCss, /#confirm-ok\s*\{[^}]*color:\s*var\(--on-accent\)/s);
  assert.match(componentCss, /#confirm-ok\[data-danger="true"\]\s*\{[^}]*color:\s*var\(--on-error\)/s);
  assert.match(componentCss, /\.approve-btn\s*\{[^}]*color:\s*var\(--on-accent-text\)/s);
  assert.match(componentCss, /\.mini-spinner\s*\{[^}]*border:\s*2px\s+solid\s+var\(--spinner-track\)/s);
  assert.match(componentCss, /\.error-msg \.bubble\s*\{[^}]*background:\s*var\(--error-surface\)/s);
  assert.match(componentCss, /\.error-msg \.bubble\s*\{[^}]*color:\s*var\(--error-text\)/s);
  assert.match(componentCss, /\.error-msg \.bubble\s*\{[^}]*border:\s*1px\s+solid\s+var\(--error-border\)/s);
  assert.match(componentCss, /\.deny-btn\s*\{[^}]*color:\s*var\(--error-text\)/s);
  assert.match(componentCss, /\.deny-btn\s*\{[^}]*border-color:\s*var\(--error-border\)/s);
  assert.match(componentCss, /\.deny-btn:active\s*\{[^}]*background:\s*var\(--error-surface\)/s);
  assert.match(componentCss, /\.native-danger\s*\{[^}]*border-color:\s*var\(--error-border\)/s);
  assert.match(componentCss, /\.command-card\[data-ok="true"\]\s*\{[^}]*border-color:\s*var\(--success-border\)/s);
  assert.match(componentCss, /\.command-card\[data-ok="false"\]\s*\{[^}]*border-color:\s*var\(--error-border\)/s);

  // 滚动条拇指提到 :root,组件只消费变量(局部再声明会盖掉深色档)。
  assert.match(lightRoot, /--scrollbar-thumb:/);
  assert.doesNotMatch(
    componentCss,
    /#messages,\s*\.tool-output\s*\{[^}]*--scrollbar-thumb:\s*rgba\(\s*0/s,
    'scrollbar-thumb 不应在组件规则里写死浅色 rgba',
  );

  // 防回潮:这些字面量曾是深色事故源。
  for (const literal of [
    'rgba(255, 255, 255, 0.9)',
    'rgba(255,255,255,0.6)',
    'rgba(0, 0, 0, 0.1)', // mini-spinner 旧轨道
  ]) {
    assert.ok(!componentCss.includes(literal), `组件规则不应再含 ${literal}`);
  }
  assert.doesNotMatch(componentCss, /\.slash-popup\s*\{[^}]*background:\s*rgba\(255/s);
  assert.doesNotMatch(componentCss, /#confirm-ok\s*\{[^}]*color:\s*#fff/s);
});


test('type and space scales live in :root tokens and chrome prefers them', () => {
  const rootBlock = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  for (const [token, px] of [
    ['--font-2xs', '10px'],
    ['--font-xs', '11px'],
    ['--font-sm', '12px'],
    ['--font-md', '13px'],
    ['--font-body', '14px'],
    ['--font-user', '15px'],
    ['--font-lg', '16px'],
    ['--space-1', '4px'],
    ['--space-2', '6px'],
    ['--space-3', '8px'],
    ['--space-4', '10px'],
    ['--space-5', '12px'],
    ['--space-6', '14px'],
    ['--space-7', '16px'],
    ['--space-8', '20px'],
    ['--space-9', '24px'],
  ]) {
    assert.match(rootBlock, new RegExp(`${token}:\\s*${px}`), `${token} 应声明为 ${px}`);
  }

  // 等价值迁移后,10–16px 字号应几乎全部走 token;白名单留给极少数装饰/几何例外。
  const bare = [...css.matchAll(/font-size:\s*(10|11|12|13|14|15|16)px/g)];
  assert.ok(
    bare.length <= 3,
    `10–16px 裸 font-size 应 ≤3(实际 ${bare.length})——请改用 var(--font-*)`,
  );
  assert.match(css, /font-size:\s*var\(--font-user\)/);
  assert.match(css, /font-size:\s*var\(--font-sm\)/);
  assert.match(css, /font-size:\s*var\(--font-xs\)/);
});

test('ui-icon is an inline 1em glyph so mixed text does not wrap or blow up', () => {
  // display:block 会让非 flex 宿主(error bubble / plan step / attach chip / push 钮)
  // 把 SVG 单独占一行;没有默认宽高时,未进白名单的宿主(设备授权标题)会落到 UA 的 300×150。
  const componentCss = css.slice(css.indexOf('* { box-sizing'));
  const uiIcon = componentCss.match(/^\.ui-icon\s*\{[^}]*\}/m)?.[0] || '';
  assert.match(uiIcon, /display:\s*inline-block/, '.ui-icon 默认必须是 inline-block');
  assert.match(uiIcon, /width:\s*1em/, '.ui-icon 默认宽 1em,跟随宿主字号');
  assert.match(uiIcon, /height:\s*1em/, '.ui-icon 默认高 1em');
  assert.doesNotMatch(uiIcon, /display:\s*block/, '.ui-icon 不得默认 display:block');
});

test('a sheet raised from the drawer covers the drawer instead of hiding behind it', () => {
  // 抽屉里的 Rename / Delete 会拉起 .sheet-overlay。抽屉是靠左停靠的 300px 侧栏,
  // sheet 是铺满宽度的底部卡片——两者同一坐标系,z-index 谁大谁在上。sheet 排在下面时
  // 它并没有消失,只从抽屉右边缘露出一截,看起来就像弹窗错开到了主页面上。
  const zIndexOf = selector => {
    const block = css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] || '';
    const value = block.match(/z-index:\s*(\d+)/)?.[1];
    assert.ok(value, `${selector} 应显式声明 z-index`);
    return Number(value);
  };
  const sheet = zIndexOf('\\.sheet-overlay');
  const drawer = zIndexOf('#drawer');
  const drawerOverlay = zIndexOf('#drawer-overlay');
  const authGate = zIndexOf('#auth-gate');

  assert.ok(sheet > drawer, `.sheet-overlay(${sheet}) 必须盖住 #drawer(${drawer})`);
  assert.ok(sheet > drawerOverlay, `.sheet-overlay(${sheet}) 必须盖住 #drawer-overlay(${drawerOverlay})`);
  // 认证闸门是最后一道墙,任何业务弹窗都不该越过它。
  assert.ok(sheet < authGate, `.sheet-overlay(${sheet}) 不得盖过 #auth-gate(${authGate})`);
});

test('the drawer offers a way back to archived threads', () => {
  // 会话列表默认只拉未归档,所以列表里永远不会出现 archived 的行,
  // 行内那颗 Unarchive 按钮也就永远渲染不出来。没有这个开关,归档就是单程票。
  assert.match(html, /id="drawer-archived-toggle"/, '抽屉需要「显示已归档」入口');
  assert.match(appJs, /drawer-archived-toggle/, 'app.js 必须绑定该入口');
  // 数赋值语句,不要写成 /=\s*(?!false)/ 这类否定前瞻——\s* 会回溯到 0 字符,
  // 让 `let showArchivedThreads = false;` 这行自己就匹配上,断言恒真。
  const writes = [...appJs.matchAll(/showArchivedThreads\s*=(?!=)/g)];
  assert.ok(
    writes.length >= 2,
    `showArchivedThreads 除初始化外必须有写入点(实际 ${writes.length} 处赋值)`,
  );
  assert.match(appJs, /data-action="unarchive"|'unarchive'/, '取消归档动作必须仍然可达');

  // 归档/未归档是两份列表,来回切会同时挂起两个 thread:list。响应无顺序保证,晚到的那份
  // 若不认领自己属于哪个视图,就会盖掉用户已切回去的列表(实测在慢响应下必现)。
  // 这条只能靠源码契约守护:复现它需要给 mock 注入不对称延迟,不适合进常规回归。
  const listFn = appJs.match(/function refreshThreadsForCwd[\s\S]*?\n {2}\}/)?.[0] || '';
  assert.ok(listFn, '未找到 refreshThreadsForCwd');
  assert.match(listFn, /const requestedArchived = showArchivedThreads/, '必须捕获请求时的视图');
  assert.match(
    listFn,
    /requestedArchived !== showArchivedThreads\)\s*return/,
    'thread:list 的回调必须丢弃已切走视图的过期响应',
  );
});
