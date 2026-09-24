import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = await build({ stdin: { contents: "export {newRecord} from './src/lib/store'; export {DEFAULT_SETTINGS} from './src/lib/types';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
const { newRecord, DEFAULT_SETTINGS } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const profile = await mkdtemp(path.join(os.tmpdir(), 'bilivault-race-'));
const dist = path.join(root, 'dist');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
let release;
let syncing = false;
let entered;
let enteredPromise;
const arm = () => { enteredPromise = new Promise(resolve => { entered = resolve; }); };
const failures = [];
try {
  // 延迟真实后台的外部请求，精确复现请求期间编辑/删除，而非依赖随机计时。
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/chat/completions')) {
      const gate = new Promise(resolve => { release = resolve; });
      entered();
      await gate;
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"message":"fixture failure"}}' });
    }
    if (syncing && url.hostname === 'api.bilibili.com') {
      let data = { list: [], medias: [] };
      if (url.pathname.endsWith('/nav')) data = { isLogin: true, mid: 1 };
      if (url.pathname.includes('history/cursor')) data = { list: [{ title: '旧观看记录', author_name: 'UP', view_at: 1700000000, progress: 10, duration: 100, history: { bvid: 'BVlegacy', cid: 45, oid: 1, business: 'archive', page: 1 } }], cursor: {} };
      if (url.pathname.includes('archive/relation')) data = { like: true, coin: 1, favorite: false };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
    }
    if (url.hostname === 'api.bilibili.com') {
      const data = url.pathname.includes('has/like') ? 0 : url.pathname.includes('coins') ? { multiply: 0 } : { favoured: false };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: -412, data }) });
    }
    if (url.hostname !== 'api.notion.com') return route.abort();
    let data = { properties: { '视频ID': { type: 'rich_text' } } };
    if (url.pathname.endsWith('/query')) {
      const gate = new Promise(resolve => { release = resolve; });
      entered();
      await gate;
      data = { results: [{ id: 'fixture-page', url: 'https://notion.so/fixture-page' }] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const send = request => page.evaluate(request => chrome.runtime.sendMessage(request), request);
  for (const action of ['notes', 'delete', 'pipeline-delete', 'relation-error']) {
    const record = newRecord({ bvid: 'BVrace', aid: 1, cid: 2, page: 1, url: 'https://www.bilibili.com/video/BVrace/' });
    record.library = { saved: true };
    record.subtitle = { digest: 'fixture', plainText: '字幕夹具', segments: [] };
    const settings = { ...DEFAULT_SETTINGS, notionEnabled: true, ai: { ...DEFAULT_SETTINGS.ai, enabled: true, apiKey: 'fixture-only', baseUrl: 'https://api.bilibili.com/v1' }, notion: { ...DEFAULT_SETTINGS.notion, enabled: true, token: 'fixture-only', parentId: 'fixture-parent', parentType: 'data_source_id' } };
    await worker.evaluate(async ({ record, settings }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ settings, 'record-index': [record.key], [`rec:${record.key}`]: record });
    }, { record, settings });
    if (action === 'relation-error') {
      await send({ type: 'refresh-actions', key: record.key, force: true });
      const saved = await worker.evaluate(async key => (await chrome.storage.local.get(`rec:${key}`))[`rec:${key}`], record.key);
      assert.equal(saved.relation.source, 'local');
      assert.match(saved.relation.error, /未能确认/);
      console.log('PASS failed interaction endpoints remain unconfirmed');
      continue;
    }
    arm();
    if (action === 'pipeline-delete') {
      const pipeline = send({ type: 'sync-now', key: record.key, step: 'analysis' });
      await Promise.race([enteredPromise, pipeline.then(value => { throw new Error('Pipeline returned before gate: ' + JSON.stringify(value)); })]);
      let deleted = false;
      const deletion = send({ type: 'delete-record', key: record.key }).then(value => { deleted = true; return value; });
      await page.waitForTimeout(100);
      assert.equal(deleted, false, 'Deletion must wait for the active record lock');
      release();
      await Promise.all([pipeline, deletion]);
      const saved = await worker.evaluate(async key => (await chrome.storage.local.get(`rec:${key}`))[`rec:${key}`], record.key);
      assert.equal(saved, undefined);
      console.log('PASS active pipeline cannot resurrect deleted record');
      continue;
    }
    const check = send({ type: 'check-notion', key: record.key });
    await Promise.race([enteredPromise, check.then(result => { throw new Error('Check returned before gate: ' + JSON.stringify(result)); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Notion query not reached')), 10000))]);
    if (action === 'notes') {
      assert.equal((await send({ type: 'save-notes', key: record.key, notes: { highlights: [], questions: [], freeform: '请求期间的新笔记' } })).ok, true);
    } else assert.equal((await send({ type: 'delete-record', key: record.key })).ok, true);
    release();
    await check;
    const saved = await worker.evaluate(async key => (await chrome.storage.local.get(`rec:${key}`))[`rec:${key}`], record.key);
    try {
      if (action === 'notes') assert.equal(saved?.userNotes.freeform, '请求期间的新笔记');
      else assert.equal(saved, undefined);
      console.log(`PASS Notion response preserves concurrent ${action}`);
    } catch (error) { failures.push(`${action}: ${error.message}`); }
  }
  const records = Array.from({ length: 20 }, (_, cid) => newRecord({ bvid: 'BVindex', cid, aid: 1, page: 1, url: 'https://www.bilibili.com/video/BVindex/' }));
  await worker.evaluate(async records => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ 'record-index': records.map(r => r.key), ...Object.fromEntries(records.map(r => [`rec:${r.key}`, r])) });
  }, records);
  await Promise.all(records.map((record, i) => send(i % 2 ? { type: 'save-notes', key: record.key, notes: { highlights: [], questions: [], freeform: '并发笔记' } } : { type: 'delete-record', key: record.key })));
  const index = await worker.evaluate(async () => (await chrome.storage.local.get('record-index'))['record-index']);
  assert.deepEqual(index.sort(), records.filter((_, i) => i % 2).map(r => r.key).sort());
  console.log('PASS concurrent cross-record saves and deletes preserve shared index');

  syncing = true;
  const legacy = newRecord({ bvid: 'BVlegacy', cid: 45, aid: 1, page: 1, url: 'https://www.bilibili.com/video/BVlegacy/' });
  await worker.evaluate(async ({ legacy, settings }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings, 'record-index': [legacy.key], [`rec:${legacy.key}`]: legacy });
  }, { legacy, settings: DEFAULT_SETTINGS });
  await send({ type: 'sync-bilibili', force: true });
  let status;
  for (let i = 0; i < 80; i++) {
    status = await send({ type: 'history-status' });
    if (status.data?.state === 'done' || status.data?.state === 'error') break;
    await page.waitForTimeout(250);
  }
  assert.equal(status.data?.state, 'done', JSON.stringify(status));
  const enriched = await worker.evaluate(async key => (await chrome.storage.local.get(`rec:${key}`))[`rec:${key}`], legacy.key);
  assert.equal(enriched.actions.like, true);
  assert.equal(enriched.library.saved, false);
  const syncAll = await send({ type: 'sync-all' });
  assert.equal(syncAll.data?.queued, 0);
  console.log('PASS legacy history enrichment stays outside knowledge and sync-all');
  assert.deepEqual(failures, []);
} finally {
  release?.();
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
