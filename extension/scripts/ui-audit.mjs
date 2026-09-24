/**
 * Programmatic UI audit (the model cannot view images, so layout/contrast are measured).
 * Checks: no gradients, WCAG contrast for text, no horizontal overflow, no element overlap,
 * and that the key parts of each view are actually rendered.
 *
 * Run: node scripts/ui-audit.mjs   (after `node scripts/shots.mjs` wrote the harnesses)
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.tmp/shots');

const AUDIT = () => {
  const targets = [
    '.history-time', '.history-status', '.history-info p', '.setting-field > span', '.setting-toggle small', '.workspace-nav .active', '.video-title', '.video-meta', '.card-sub',
    '.pill.on', '.pill.off', 'button.primary', '.tab.active', '.record-meta',
    '.badge.ok', '.badge.warn', '.stat-label', '.stat-value', '.field-label', '.field-hint',
    '.check-desc', '.check-title', '.hint', '.empty-text', '.empty-title', '.brand-name',
    '.brand-sub', '.statbar', '.record-title', '.toast', '.seg button', '.seg button.active',
    '.context-title', '.context-sub', '.record-error',
    '.step-row .k', '.step-row .v.ok', '.step-row .v.warn', '.step-row .v.mute', '.chip-tab', '.chip-tab.active',
    '.action.off', '.action.like.on', '.action.favorite.on', '.action.share.on', '.preview-text',
    '.viewer-title', '.viewer-meta', '.viewer-sub', '.viewer-summary', '.viewer-list li', '.cue-ts', '.cue-text', '.viewer-nav a',
  ];

  const parseColor = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const effectiveBg = (el) => {
    let node = el;
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const gradients = [];
  const contrastResults = [];
  const missing = [];

  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.backgroundImage && style.backgroundImage.includes('gradient')) {
      gradients.push(el.className || el.tagName);
    }
  }

  for (const selector of targets) {
    const el = document.querySelector(selector);
    if (!el) {
      missing.push(selector);
      continue;
    }
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    const ratio = contrast(fg, bg);
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? 3 : 4.5;
    contrastResults.push({ selector, ratio: Math.round(ratio * 100) / 100, threshold, pass: ratio >= threshold - 0.02 });
  }

  const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const clipped = [];
  for (const el of document.querySelectorAll('.card, .record, .toolbar, .stat, .app-header, .tabs, .export-card, .form-card')) {
    if (el.scrollWidth > el.clientWidth + 1) clipped.push(el.className);
  }

  // Vertical overlap between sibling blocks in the main flow.
  const overlaps = [];
  for (const container of document.querySelectorAll('.stack, .content')) {
    const kids = Array.from(container.children).map((el) => el.getBoundingClientRect());
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].top < kids[i - 1].bottom - 1) overlaps.push(container.className + ' #' + i);
    }
  }

  const tokensLoaded = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
  const rendered = {
    stylesheet: document.styleSheets.length > 0 && Boolean(tokensLoaded),
    videoTitle: !!document.querySelector('.video-title'),
    steps: document.querySelectorAll('.step').length,
    statusList: document.querySelectorAll('.status-list li').length,
    records: document.querySelectorAll('.history-row').length,
    navigation: document.querySelectorAll('.workspace-nav nav button').length,
    statTiles: document.querySelectorAll('.stat').length,
    tabs: document.querySelectorAll('.tab').length,
    formCards: document.querySelectorAll('.form-card').length,
    exportCards: document.querySelectorAll('.export-card').length,
    actionChips: document.querySelectorAll('.action').length,
    actionsLit: document.querySelectorAll('.action.on').length,
    signalsNote: document.querySelectorAll('.signals-note').length,
    previews: document.querySelectorAll('.preview').length,
    cues: document.querySelectorAll('.cues li').length,
    // 我的记录：空框虚线 / 有内容实线，提示是框内顶部的一行（图标在文字前），右侧不再重复。
    note: (() => {
      const box = document.querySelector('.note-editor');
      if (!box) return null;
      const row = [...document.querySelectorAll('.step-row')].find((item) =>
        item.querySelector('.k')?.textContent.includes('我的记录'),
      );
      const hint = box.querySelector('.note-hint');
      const editorRect = box.getBoundingClientRect();
      const hintRect = hint?.getBoundingClientRect();
      return {
        shape: box.classList.contains('empty') ? 'empty' : 'filled',
        border: getComputedStyle(box).borderTopStyle,
        hint: hint?.textContent?.trim() ?? null,
        hintIconFirst: hint?.firstElementChild?.tagName.toLowerCase() === 'svg',
        hintAtInput: hintRect ? Math.abs(hintRect.top - box.querySelector('textarea').getBoundingClientRect().top) < 1 : null,
        hintInside: hintRect ? hintRect.top >= editorRect.top - 0.5 && hintRect.bottom <= editorRect.bottom + 0.5 : null,
        // 提示在三个分类按钮**下面**。
        hintBelowTabs: (() => {
          const tabs = box.querySelector('.chip-tabs')?.getBoundingClientRect();
          return tabs && hintRect ? hintRect.top >= tabs.bottom - 0.5 : null;
        })(),
        runLabel: [...document.querySelectorAll('.actions button')].find((button) =>
          /^(执行|执行中…|全部已完成)$/.test(button.textContent.trim()),
        )?.textContent.trim() ?? null,
        boxes: [box, ...box.querySelectorAll('*')].filter((el) => {
          const style = getComputedStyle(el);
          return parseFloat(style.borderTopWidth) > 0 && el.getBoundingClientRect().width > 250;
        }).length,
        rowValue: row?.querySelector('.v')?.textContent?.trim() ?? null,
        rowButtons: row ? row.querySelectorAll('button').length : null,
      };
    })(),
    // 通知是浮层：钉在顶部弹出，不参与布局。
    toast: (() => {
      const toast = document.querySelector('.toast');
      if (!toast) return null;
      const style = getComputedStyle(toast);
      const rect = toast.getBoundingClientRect();
      const header = document.querySelector('.app-header')?.getBoundingClientRect();
      return {
        position: style.position,
        top: Math.round(rect.top),
        inFlowParent: /content|stack/.test(toast.parentElement.className),
        overlapsHeader: header ? rect.top < header.bottom : null,
      };
    })(),
    toastBaselineHeight: window.__beforeToast ?? null,
    // 记录列表显示的时间与顺序（由近到远）。
    recordTimes: [...document.querySelectorAll('.record-meta')].map((meta) =>
      (meta.textContent ?? '').split(' · ').pop(),
    ),
    // 由近到远：每一条的时间都不晚于上一条。时间文案形如「观看 2026/9/13 11:50:02」。
    recordTimesDescending: (() => {
      const stamps = [...document.querySelectorAll('.record-meta')].map((meta) =>
        Date.parse((meta.textContent ?? '').split(' · ').pop().replace(/^[^ ]+\s/, '')),
      );
      return stamps.every((value, index) => index === 0 || stamps[index - 1] >= value);
    })(),
    // Per-row affordances: SRT download, AI provider badge, Notion details toggle.
    srtBadge: document.querySelectorAll('.file-badge').length,
    providerBadge: document.querySelectorAll('.provider-badge').length,
    // The SRT chip and the provider mark belong *right after* their label; the AI row must carry
    // the provider's own 24x24 logo rather than the generic 16x16 CPU fallback.
    // Notion 行的「写入详情」按钮应该在行的右侧，而不是紧贴在 Notion logo 后面。
    notionInfoRight: (() => {
      const button = document.querySelector('[aria-label="写入详情"]');
      const row = button?.closest('.step-row');
      if (!button || !row) return null;
      const rect = row.getBoundingClientRect();
      return Math.round(((button.getBoundingClientRect().left - rect.left) / rect.width) * 100);
    })(),
    // 观看进度文字与右侧刷新按钮的中心差（px），居中的时候是 0。
    progressCenterDelta: (() => {
      const sub = document.querySelector('.card-sub');
      const button = sub?.querySelector('button');
      const text = sub ? [...sub.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim()) : null;
      if (!sub || !button || !text) return null;
      const range = document.createRange();
      range.selectNodeContents(text);
      const line = range.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return Math.round(Math.abs((line.top + line.bottom) / 2 - (box.top + box.bottom) / 2) * 10) / 10;
    })(),
    badgesInline: [...document.querySelectorAll('.step-row')].slice(0, 2).map((row) => {
      const label = row.querySelector('.k');
      const value = row.querySelector('.v');
      const extra = [...row.children].find(
        (el) => el !== label && el !== value && !(el.tagName === 'BUTTON' && el.textContent.trim() === '↻'),
      );
      return {
        gap: extra && label ? Math.round(extra.getBoundingClientRect().left - label.getBoundingClientRect().right) : null,
        mark: extra?.querySelector('svg')?.getAttribute('viewBox') ?? null,
        pathLength: (extra?.querySelector('svg path')?.getAttribute('d') ?? '').length,
        valueRight: value ? Math.round(value.getBoundingClientRect().right) : null,
      };
    }),
    notionInfo: document.querySelectorAll('[aria-label="写入详情"]').length,
    details: document.querySelectorAll('.step-details li').length,
    noteDraft: window.__noteDraft ?? '',
    // 在行尾再敲一个空格之后的值：以前会被 trim 吞掉（表现为「笔记栏打不出空格」）。
    draftWithSpace: window.__draftWithSpace ?? '',
    noteSaved: window.__noteSaved ?? '',
    // Chrome caps the popup at 600px: the panel must fit without a scrollbar.
    popupOverflow: (() => {
      const popup = document.querySelector('.popup');
      return popup ? Math.max(0, popup.scrollHeight - popup.clientHeight) : 0;
    })(),
    viewerLink: window.__lastTabUrl ?? '',
    // 设置页到底申请了哪些主机权限（webhook / 本地模型都必须有入口）。
    permRequests: window.__permRequests ?? [],
    settingsToast: document.querySelector('.workspace-toast')?.textContent ?? '',
    // 内容脚本发给后台的消息（harness-content.html 用）。
    contentSent: (window.__sent ?? []).map((message) => message.type),
    contentWatch: (window.__sent ?? [])
      .filter((message) => message.type === 'watch')
      .map((message) => message.payload.secondsWatched),
    contentIdentities: (window.__sent ?? [])
      .filter((message) => message.type === 'page-snapshot')
      .map((message) => message.payload.identity.bvid),
    // 每条 page-video 的身份都必须是数字 aid（伪造消息用的是字符串 / 空 BV 号）。
    contentVideoAids: (window.__sent ?? [])
      .filter((message) => message.type === 'page-video')
      .map((message) => message.payload.identity.aid),
  };

  return {
    gradients,
    contrast: contrastResults,
    contrastFailures: contrastResults.filter((c) => !c.pass),
    pageOverflow,
    clipped,
    overlaps,
    rendered,
    height: document.body.scrollHeight,
  };
};

const VIEWER_KEY = encodeURIComponent('BV139bD6gEa8:40960721402');
const cases = [
  {
    file: 'harness-popup.html',
    label: 'popup',
    tabs: [null],
    // Clicking the preview must open the viewer page for this exact record.
    before: async (page) => {
      await page.click('button:has-text("查看全部")');
    },
    expect: (r) => [
      /viewer\.html\?key=BV139bD6gEa8%3A40960721402#subtitle$/.test(r.rendered.viewerLink)
        ? ''
        : `preview link opens the wrong URL: ${r.rendered.viewerLink}`,
      r.rendered.actionsLit === 4 ? '' : `expected 4 lit action icons, saw ${r.rendered.actionsLit}`,
      r.rendered.signalsNote === 0 ? '' : 'API state was available but a fallback note was shown',
      r.rendered.previews === 2 ? '' : `expected subtitle + summary previews, saw ${r.rendered.previews}`,
      // 字幕 + AI 摘要 + 我的记录 + Notion
      r.rendered.steps === 4 ? '' : `expected 4 flow rows, saw ${r.rendered.steps}`,
      r.rendered.note?.shape === 'filled' && r.rendered.note?.border === 'solid'
        ? ''
        : 'a filled note box must be a solid box: ' + JSON.stringify(r.rendered.note),
      r.rendered.note?.hint === null && r.rendered.note?.rowButtons === 1
        ? ''
        : 'a record with notes must not show the empty-state hint: ' + JSON.stringify(r.rendered.note),
      r.rendered.popupOverflow === 0 ? '' : `panel needs ${r.rendered.popupOverflow}px of scrolling`,
      r.rendered.srtBadge === 1 ? '' : `expected the SRT download badge, saw ${r.rendered.srtBadge}`,
      r.rendered.providerBadge === 1 ? '' : `expected the AI provider badge, saw ${r.rendered.providerBadge}`,
      r.rendered.badgesInline[0]?.gap !== null && r.rendered.badgesInline[0].gap <= 6
        ? ''
        : `the SRT chip is not next to 字幕 (gap ${r.rendered.badgesInline[0]?.gap}px)`,
      r.rendered.badgesInline[1]?.gap !== null && r.rendered.badgesInline[1].gap <= 6
        ? ''
        : `the provider mark is not next to AI 摘要 (gap ${r.rendered.badgesInline[1]?.gap}px)`,
      r.rendered.badgesInline[1]?.mark === '0 0 24 24' && r.rendered.badgesInline[1].pathLength > 400
        ? ''
        : `the AI row is not showing the provider's own logo: ${JSON.stringify(r.rendered.badgesInline[1])}`,
      r.rendered.notionInfo === 1 ? '' : `expected the Notion details button, saw ${r.rendered.notionInfo}`,
      r.rendered.details === 0 ? '' : 'Notion details must stay collapsed until asked for',
      // 我的记录：实线框 + 虚线框已经合成一个框。
      r.rendered.note?.boxes === 1 ? '' : 'the notes row still draws ' + r.rendered.note?.boxes + ' full-width boxes',
      // 写入详情按钮在最右侧（至少过半行）。
      r.rendered.notionInfoRight !== null && r.rendered.notionInfoRight >= 60
        ? ''
        : 'the write-details button is not on the right (at ' + r.rendered.notionInfoRight + '% of the row)',
      // 观看进度和刷新按钮垂直居中对齐。
      r.rendered.progressCenterDelta !== null && r.rendered.progressCenterDelta <= 1
        ? ''
        : '观看进度 and the refresh button are ' + r.rendered.progressCenterDelta + 'px off centre',
    ],
  },
  {
    // The info button is the only way to the write details, and it really does reveal them.
    file: 'harness-popup.html',
    label: 'popup/notion-details',
    tabs: [null],
    before: async (page) => {
      await page.click('[aria-label="写入详情"]');
    },
    expect: (r) => [r.rendered.details === 3 ? '' : `expected 3 detail lines, saw ${r.rendered.details}`],
  },
  {
    // The panel polls for step progress every 1.5s; typing must survive that poll.
    file: 'harness-popup.html?idx=1',
    label: 'popup/note-draft',
    tabs: [null],
    before: async (page) => {
      const box = page.locator('.note-editor textarea').first();
      const hint = page.locator('.note-hint');
      const rect = await hint.boundingBox();
      if (!rect) throw new Error('Missing note placeholder');
      await page.mouse.click(rect.x + 25, rect.y + rect.height / 2);
      if (!await box.evaluate(el => document.activeElement === el)) throw new Error('Placeholder click did not focus textarea');
      // 文本里带空格：编辑器与落库都必须原样保留词与词之间的空格。
      await page.keyboard.type('不要 被刷新 冲掉的 草稿');
      if (await hint.count()) throw new Error('Placeholder remains after typing');
      await box.fill('');
      if (!await hint.count()) throw new Error('Placeholder missing after clearing');
      await page.keyboard.type('不要 被刷新 冲掉的 草稿');
      await page.getByRole('button', { name: '待思考', exact: true }).click();
      if (!await hint.count()) throw new Error('Empty category lacks its own placeholder');
      await page.getByRole('button', { name: /印象深刻/ }).click();
      if (await hint.count()) throw new Error('Populated category has a placeholder');
      // The 1.5s poll lands while this is still an unsaved draft (autosave waits 2s).
      await page.waitForTimeout(2600);
      await page.evaluate(() => {
        window.__noteDraft = document.querySelector('.note-editor textarea')?.value ?? '';
      });
      // 光标放到行尾再敲一个空格：这一步以前必定被 trim 掉。
      await box.evaluate((el) => {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
      await page.keyboard.type(' 尾');
      await page.evaluate(() => {
        window.__draftWithSpace = document.querySelector('.note-editor textarea')?.value ?? '';
      });
    },
    expect: (r) => [
      r.rendered.noteDraft === '不要 被刷新 冲掉的 草稿'
        ? ''
        : `the 1.5s poll wiped the draft: ${JSON.stringify(r.rendered.noteDraft)}`,
      r.rendered.draftWithSpace === '不要 被刷新 冲掉的 草稿 尾'
        ? ''
        : `spaces typed in the note editor are dropped: ${JSON.stringify(r.rendered.draftWithSpace)}`,
      r.rendered.noteSaved.includes('"不要 被刷新 冲掉的 草稿"')
        ? ''
        : `the draft never reached the worker with its spaces: ${r.rendered.noteSaved}`,
      r.rendered.popupOverflow === 0 ? '' : `panel needs ${r.rendered.popupOverflow}px of scrolling`,
    ],
  },
  {
    // Notion off: the flow must drop that step and offer the agent handoff instead.
    file: 'harness-popup.html?idx=1&notion=off',
    label: 'popup/no-notion',
    tabs: [null],
    expect: (r) => [
      r.rendered.steps === 3 ? '' : `expected 字幕/AI摘要/我的记录 rows, saw ${r.rendered.steps}`,
      r.rendered.popupOverflow === 0 ? '' : `panel needs ${r.rendered.popupOverflow}px of scrolling`,
      // 空的时候：虚线框、只有一行提示（图标在文字前）、右侧什么都不放。
      r.rendered.note?.shape === 'empty' && r.rendered.note?.border === 'dashed' && r.rendered.note?.boxes === 1
        ? ''
        : 'the empty note box must be a single dashed box: ' + JSON.stringify(r.rendered.note),
      r.rendered.note?.hintIconFirst === true && r.rendered.note?.hintInside === true && r.rendered.note?.hintBelowTabs === true && r.rendered.note?.hintAtInput === true
        ? ''
        : 'the empty-state hint must sit under the tabs, inside the box, icon first: ' + JSON.stringify(r.rendered.note),
      r.rendered.note?.runLabel === '执行'
        ? ''
        : 'the run button should read 执行: ' + JSON.stringify(r.rendered.note?.runLabel),
      r.rendered.note?.rowValue === '' && r.rendered.note?.rowButtons === 0
        ? ''
        : 'the empty 我的记录 row must not repeat "还没有记录": ' + JSON.stringify(r.rendered.note),
    ],
  },
  {
    file: 'harness-popup.html?idx=1',
    label: 'popup/local-state',
    tabs: [null],
    expect: (r) => [
      r.rendered.signalsNote === 1 ? '' : 'missing the "state is local" note',
      r.rendered.actionsLit === 2 ? '' : `expected 2 lit action icons (like + coin), saw ${r.rendered.actionsLit}`,
      // 空记录：框是虚线，提示在框内（图标在前），右侧不重复「还没有记录」。
      r.rendered.note?.shape === 'empty' && r.rendered.note?.border === 'dashed' && r.rendered.note?.hintInside === true && r.rendered.note?.hintBelowTabs === true
        ? ''
        : 'the empty note box must be a dashed box with the hint under the tabs: ' + JSON.stringify(r.rendered.note),
      r.rendered.note?.runLabel === '执行'
        ? ''
        : 'the run button should read 执行: ' + JSON.stringify(r.rendered.note?.runLabel),
      r.rendered.note?.rowValue === '' && r.rendered.note?.rowButtons === 0
        ? ''
        : 'the empty 我的记录 row must not repeat "还没有记录": ' + JSON.stringify(r.rendered.note),
      r.rendered.popupOverflow === 0 ? '' : `panel needs ${r.rendered.popupOverflow}px of scrolling`,
    ],
  },
  {
    // 通知是顶部浮层：不再往内容里插一行，也就不会把面板顶出滚动条。
    file: 'harness-popup.html?idx=1',
    label: 'popup/toast',
    tabs: [null],
    before: async (page) => {
      await page.evaluate(() => {
        window.__beforeToast = document.body.scrollHeight;
      });
      await page.click('.conn');
      await page.waitForSelector('.toast', { timeout: 8000 });
      await page.waitForTimeout(300);
    },
    expect: (r) => [
      r.rendered.toast?.position === 'fixed' && r.rendered.toast?.top <= 16
        ? ''
        : 'the notification must float at the top: ' + JSON.stringify(r.rendered.toast),
      r.rendered.toast?.inFlowParent === false ? '' : 'the notification is still inside the content flow',
      r.height === r.rendered.toastBaselineHeight
        ? ''
        : `the notification changed the page height (${r.rendered.toastBaselineHeight} → ${r.height})`,
      r.rendered.popupOverflow === 0 ? '' : `panel needs ${r.rendered.popupOverflow}px of scrolling`,
    ],
  },
  {
    // Webhook 以前既没有主机权限入口（fetch 必失败），失败也只写进 SW 控制台。
    // 「授权并测试」必须真的申请该域名权限，并把结果说出来。
    file: 'harness-options.html?webhook=https://hooks.example.com/abc',
    label: 'options/webhook',
    tabs: ['settings'],
    before: async (page) => {
      await page.locator('details.more-settings > summary').click();
      await page.getByRole('button', { name: '授权并测试' }).click();
      await page.waitForSelector('.workspace-toast', { timeout: 8000 });
    },
    expect: (r) => [
      r.rendered.permRequests.includes('https://hooks.example.com/*')
        ? ''
        : `the webhook origin was never requested: ${JSON.stringify(r.rendered.permRequests)}`,
      /Webhook 已收到测试消息/.test(r.rendered.settingsToast)
        ? ''
        : `the webhook test reported nothing: ${JSON.stringify(r.rendered.settingsToast)}`,
    ],
  },
  {
    // 心跳降载 + 桥接校验：暂停时不再重复上报，伪造的（没有 BV 号的）快照必须被丢掉。
    file: 'harness-content.html',
    label: 'content/heartbeat',
    tabs: [null],
    before: async (page) => {
      // 先让内容脚本拿到身份（真实场景里来自 MAIN world 的 page-snapshot）。
      await page.evaluate(() => window.__snapshot({ bvid: 'BV1xx411c7mD', aid: 123456, cid: 789, page: 1 }));
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__set(10, false));
      await page.waitForTimeout(120);
      await page.evaluate(() => window.__set(10, true));
      await page.waitForTimeout(120);
      await page.evaluate(() => {
        window.__pausedWatchCount = window.__sent.filter((m) => m.type === 'watch').length;
      });
      await page.evaluate(() => window.__set(30, false));
      await page.waitForTimeout(120);
      // 同源脚本伪造的消息：没有 BV 号 / aid 是字符串 → 必须被丢弃。
      await page.evaluate(() => {
        window.__snapshot({ bvid: '', aid: 1, cid: 2 });
        window.postMessage({ source: 'bilivault-main', type: 'page-video', payload: { identity: { bvid: 'BV1xx411c7mD', aid: '1', cid: 2 }, title: 'T', owner: 'U' } }, '*');
      });
      await page.waitForTimeout(120);
    },
    expect: (r) => [
      JSON.stringify(r.rendered.contentWatch.slice(0, 3)) === '[10,30]'
        ? ''
        : `the heartbeat must report new positions only: ${JSON.stringify(r.rendered.contentWatch)}`,
      r.rendered.contentWatch.length === 2
        ? ''
        : `paused playback was reported again (${r.rendered.contentWatch.length} watch messages, expected 2)`,
      r.rendered.contentIdentities.join(',') === 'BV1xx411c7mD'
        ? ''
        : `a forged snapshot reached the worker: ${JSON.stringify(r.rendered.contentIdentities)}`,
      r.rendered.contentVideoAids.every((aid) => typeof aid === 'number')
        ? ''
        : `a forged page-video (string aid) reached the worker: ${JSON.stringify(r.rendered.contentVideoAids)}`,
    ],
  },
  { file: 'harness-options.html', label: 'options', tabs: ['history', 'library', 'settings'], expect: r => [r.rendered.navigation === 3 ? '' : 'expected three workspace entries', r.rendered.statTiles === 0 ? '' : 'global statistics must be removed'] },
  { file: 'harness-options.html', label: 'options/history', tabs: ['history'], expect: r => [r.rendered.records === 3 ? '' : 'history rows must render seeded videos'] },
  { file: `harness-viewer.html?key=${VIEWER_KEY}`, label: 'viewer', tabs: [null] },
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
let failures = 0;

for (const scheme of ['light', 'dark']) {
  for (const testCase of cases) {
    const tabs = testCase.tabs.length ? testCase.tabs : [null];
    for (const tab of tabs) {
      const page = await browser.newPage({ viewport: { width: testCase.label === 'popup' ? 396 : 1000, height: 900 } });
      await page.emulateMedia({ colorScheme: scheme });
      const [filePath, query] = testCase.file.split('?');
      await page.goto(
        pathToFileURL(path.join(dir, filePath)).href + (query ? `?${query}` : ''),
        { waitUntil: 'load' },
      );
      await page.waitForTimeout(250);
      if (tab) {
        await page.evaluate((label) => {
          if (label === 'notes') {
            document.querySelectorAll('.seg button')[1]?.click();
            return;
          }
          const index = { history: 0, library: 1, settings: 2 }[label];
          document.querySelectorAll('.workspace-nav nav button')[index]?.click();
        }, tab);
        await page.waitForTimeout(200);
      }
      if (testCase.before) await testCase.before(page);
      const result = await page.evaluate(AUDIT);
      const label = `${testCase.label}${tab ? '/' + tab : ''} [${scheme}]`;
      const problems = [];
      if (!result.rendered.stylesheet) problems.push('stylesheet not loaded (design tokens missing)');
      if (result.gradients.length) problems.push(`gradients: ${result.gradients.join(', ')}`);
      if (result.contrastFailures.length) {
        problems.push(
          'contrast: ' +
            result.contrastFailures.map((c) => `${c.selector} ${c.ratio}<${c.threshold}`).join(' | '),
        );
      }
      if (result.pageOverflow > 1) problems.push(`horizontal overflow ${result.pageOverflow}px`);
      if (result.clipped.length) problems.push(`clipped: ${result.clipped.join(', ')}`);
      if (result.overlaps.length) problems.push(`overlap: ${result.overlaps.join(', ')}`);
      if (testCase.expect) problems.push(...testCase.expect(result).filter(Boolean));
      const worst = Math.min(...result.contrast.map((c) => c.ratio));
      console.log(
        `${problems.length ? 'FAIL' : 'PASS'}  ${label.padEnd(26)} height=${result.height} worstContrast=${worst.toFixed(2)} rendered=${JSON.stringify(result.rendered)}`,
      );
      for (const problem of problems) console.log('        ' + problem);
      failures += problems.length ? 1 : 0;
      await page.close();
    }
  }
}

await browser.close();
console.log(failures ? failures + ' view(s) with issues' : 'all UI checks passed');
if (failures) process.exitCode = 1;
