import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const checks = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(root, '.tmp/shots/harness-options.html')).href);
  await page.waitForSelector('.history-row');
  check('three navigation entries', (await page.locator('.workspace-nav nav button').count()) === 3);
  check('no global statistics', (await page.locator('.stat-grid').count()) === 0);
  for (const [name, field] of [
    ['点赞过', 'like'],
    ['投币过', 'coin'],
    ['收藏过', 'favorite'],
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    const count = await page.evaluate(
      (field) => window.__seed.records.filter((record) => Boolean(record.actions[field])).length,
      field,
    );
    check(`${name} filters records`, (await page.locator('.history-row').count()) === count);
  }
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索历史' }).fill('不存在的标题');
  check('search empty state', await page.getByText('没有找到相关视频', { exact: true }).isVisible());
  await page.getByRole('searchbox', { name: '搜索历史' }).fill('');
  // 大数据夹具：历史导入未收录，且精确观看位置可继续播放。
  await page.evaluate(() => {
    const base = window.__seed.records[0];
    window.__seed.records = Array.from({ length: 85 }, (_, i) => ({
      ...structuredClone(base),
      key: `BVfixture${i}:${i}`,
      bvid: `BVfixture${i}`,
      cid: i,
      title: `历史视频 ${i}`,
      library: { saved: false },
      history: { watchedAt: Date.now() - i * 60000, position: 30, finished: false },
      watched: { ...base.watched, visits: 0, maxProgressRatio: 0 },
      subtitle: undefined,
      analysis: undefined,
    }));
    // 直接改夹具也要通知界面：真实后台每次写入都会推进归档版本号。
    window.__touch();
  });
  await page.waitForFunction(() => document.querySelector('.video-title')?.textContent === '历史视频 0');
  check('first render bounded to 40 records', (await page.locator('.history-row').count()) === 40);
  check(
    'resume link uses exact current position',
    (await page.locator('.video-cover').first().getAttribute('href')).includes('t=30'),
  );
  await page.getByRole('button', { name: /加载更多/ }).click();
  check('load more appends the next batch', (await page.locator('.history-row').count()) === 80);
  await page.evaluate(() => window.scrollTo(0, 800));
  const scroll = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    window.__syncStatus = { state: 'running', phase: 'history', count: 120, lastCompletedAt: 0, warnings: [] };
  });
  await page.waitForFunction(() => document.querySelector('.history-status')?.textContent.includes('120'));
  check('background update preserves scroll', Math.abs((await page.evaluate(() => window.scrollY)) - scroll) < 2);
  check('background update preserves rendered rows', (await page.locator('.history-row').count()) === 80);
  await page.evaluate(() => {
    window.__syncStatus = {
      state: 'error',
      phase: 'history',
      count: 120,
      lastCompletedAt: 0,
      warnings: [],
      error: '请先登录 B站，再重试',
    };
  });
  await page.waitForSelector('a:has-text("去登录")');
  check('login failure retains local records', (await page.locator('.history-row').count()) === 80);
  await page.evaluate(() => {
    window.__syncStatus = { state: 'done', phase: 'done', count: 120, lastCompletedAt: Date.now(), warnings: [] };
    window.scrollTo(0, 0);
  });
  await page.locator('.row-menu summary').first().click();
  await page.getByRole('button', { name: '收录到知识库', exact: true }).first().click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  check('only explicit collection enters library', (await page.locator('.library-list > li').count()) === 1);
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('.row-menu summary').first().click();
  await page.getByRole('button', { name: '从本地历史移除', exact: true }).first().click();
  check('cancel removal preserves history', (await page.locator('.history-row').count()) === 40);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '从本地历史移除', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.video-title')?.textContent === '历史视频 1');
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  check('history removal does not delete knowledge', (await page.locator('.library-list > li').count()) === 1);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  check('single settings page has four main sections', (await page.locator('.settings-section h2').count()) === 4);
  check('advanced settings initially collapsed', (await page.locator('details.advanced[open]').count()) === 0);
  const ai = page.getByRole('switch', { name: /自动生成摘要/ });
  await ai.uncheck();
  check('disabled AI hides credentials', (await page.getByLabel('API 密钥', { exact: true }).count()) === 0);
  await ai.check();
  check(
    'hidden settings retain their values',
    (await page.getByLabel('API 密钥', { exact: true }).inputValue()) === 'sk-demo',
  );
  await page.evaluate(() => {
    window.__failSave = true;
  });
  await page.getByLabel('模型', { exact: true }).fill('changed-model');
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent.includes('保存失败'));
  check('failed save does not claim success', !(await page.locator('.save-status').textContent()).includes('已保存'));
  await page.evaluate(() => {
    window.__failSave = false;
  });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent.includes('已保存'));
  check(
    'retry persists the edited value',
    (await page.evaluate(() => window.__seed.settings.ai.model)) === 'changed-model',
  );
  await page.screenshot({ path: path.join(root, '.tmp/shots/workspace-settings.png'), fullPage: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['历史记录', '知识库', '设置']) {
      await page.getByRole('button', { name, exact: true }).click();
      check(
        `${name} has no horizontal overflow at ${width}px`,
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      );
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await page.screenshot({ path: path.join(root, '.tmp/shots/workspace-history.png') });
  check('no browser runtime errors', errors.length === 0);
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
