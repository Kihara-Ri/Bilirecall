/**
 * End-to-end test: loads the built extension into Chrome, serves a fixture video page on
 * https://www.bilibili.com/video/**, and verifies that the content-script hook -> service
 * worker -> subtitle consensus -> stored record pipeline works.
 *
 * Scenario A: the subtitle CDN returns a stable body  -> record is stored with observations: 2.
 * Scenario B: the CDN returns a different body each read (the reported B站 bug)
 *             -> the record is flagged needs_review and no wrong text is trusted.
 *
 * Run: node scripts/e2e.mjs   (requires Google Chrome + a built dist/)
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const LIST_BVID = 'BV1yy411c7mD';
const LIST_CID = 987654;
const BVID = 'BV1xx411c7mD';
const CID = 789;
const AID = 123456;
const TRACK_URL = 'https://aisubtitle.hdslb.com/bfs/subtitle/fixture.json';

const cors = (body, type = 'application/json') => ({
  status: 200,
  headers: {
    'content-type': type,
    'access-control-allow-origin': 'https://www.bilibili.com',
    'access-control-allow-credentials': 'true',
  },
  body,
});

const navBody = JSON.stringify({
  code: 0,
  data: { isLogin: true, mid: 9001, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } },
});

const viewBody = JSON.stringify({
  code: 0,
  data: {
    bvid: BVID,
    aid: AID,
    title: '端到端测试视频',
    pic: '',
    tname: '科技',
    pubdate: 1700000000,
    desc: '这是 E2E 夹具视频',
    owner: { name: 'E2E UP' },
    pages: [{ cid: CID, page: 1, part: 'P1', duration: 100 }],
  },
});

const playerBody = JSON.stringify({
  code: 0,
  data: {
    aid: AID,
    cid: CID,
    bvid: BVID,
    need_login_subtitle: false,
    subtitle: { subtitles: [{ id: 1, id_str: '1', lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: TRACK_URL }] },
  },
});

function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body>
  <h1>E2E fixture</h1><video id="v"></video>
  <script>
    window.runSequence = async () => {
      await fetch('https://api.bilibili.com/x/web-interface/view?bvid=${BVID}');
      await fetch('https://api.bilibili.com/x/player/wbi/v2?bvid=${BVID}&cid=${CID}&aid=${AID}');
      await fetch('https://api.bilibili.com/x/web-interface/archive/like', { method: 'POST', body: 'bvid=${BVID}&like=1' });
      await fetch('https://api.bilibili.com/x/web-interface/share/add', { method: 'POST', body: 'bvid=${BVID}' });
      return true;
    };
  </script></body></html>`;
}

async function launch() {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bilivault-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Bundled Chromium is required: branded Chrome (M137+) ignores --load-extension.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  return { context, userDataDir };
}

async function readStorage(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const deadline = Date.now() + 25000;
  let record;
  while (Date.now() < deadline) {
    const data = await worker.evaluate(() => chrome.storage.local.get(null));
    record = data?.[`rec:${BVID}:${CID}`];
    const steps = record?.steps ?? {};
    const busy = ['subtitle', 'analysis', 'notion'].some((step) => steps[step]?.state === 'running');
    const failed = ['subtitle', 'analysis', 'notion'].some((step) => steps[step]?.state === 'error');
    const queueLength = Array.isArray(data?.['sync-queue']) ? data['sync-queue'].length : 0;
    // The like and the B站 state read must both have landed, then the pipeline must be settled.
    const started = ['subtitle', 'analysis', 'notion'].some((step) => steps[step]?.state !== 'idle');
    if (record?.actions?.like && record?.relation && !busy && (failed || (queueLength === 0 && started))) return { data, record };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { data: null, record: undefined };
}

async function workerOf(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return worker;
}

async function scenario(label, subtitleFactory, config = {}) {
  const { context, userDataDir } = await launch();
  try {
    const worker = await workerOf(context);
    if (config.settings) {
      await worker.evaluate((stored) => chrome.storage.local.set({ settings: stored }), config.settings);
    }

    const page = await context.newPage();
    let reads = 0;
    let notionPages = 0;

    // Default-deny so the test can never leak to the real B站 / Notion APIs
    // (Playwright matches the most recently registered route first).
    await context.route('https://api.bilibili.com/**', (route) => route.abort());
    await context.route('https://aisubtitle.hdslb.com/**', (route) => route.abort());
    await context.route('https://api.notion.com/**', (route) => route.abort());
    await context.route('https://api.openai.com/**', (route) => route.abort());

    await context.route('**/video/' + BVID + '/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml() }),
    );
    await context.route('https://api.bilibili.com/x/web-interface/nav**', (route) => route.fulfill(cors(navBody)));
    await context.route(
      (url) => url.hostname === 'api.bilibili.com' && /^\/x\/web-interface\/(wbi\/)?view$/.test(url.pathname),
      (route) => route.fulfill(cors(viewBody)),
    );
    await context.route('https://api.bilibili.com/x/player/wbi/v2**', (route) => route.fulfill(cors(playerBody)));
    await context.route('https://api.bilibili.com/x/web-interface/archive/like', (route) =>
      route.fulfill(cors(JSON.stringify({ code: 0, data: {} }))),
    );
    await context.route('https://api.bilibili.com/x/web-interface/share/add', (route) =>
      route.fulfill(cors(JSON.stringify({ code: 0, data: {} }))),
    );
    // The three states the extension mirrors. Note coin and favorite were never touched by
    // this browser: they can only come from the B站 API read.
    // B站's own lists, for the archive sync: one watched / liked / favourited video.
    await context.route(
      (url) => url.hostname === 'api.bilibili.com' && /^\/x\/web-interface\/history\/cursor$/.test(url.pathname),
      (route) =>
        route.fulfill(
          cors(
            JSON.stringify({
              code: 0,
              data: {
                list: [
                  {
                    title: '历史里的视频',
                    cover: '',
                    author_name: '历史UP',
                    author_mid: 5,
                    duration: 240,
                    progress: 90,
                    is_finish: 0,
                    view_at: 1763000000,
                    history: { oid: 4242, bvid: LIST_BVID, cid: LIST_CID, business: 'archive' },
                  },
                  { title: '直播房间（应被忽略）', history: { oid: 1, business: 'live' } },
                ],
              },
            }),
          ),
        ),
    );
    await context.route(
      (url) => url.hostname === 'api.bilibili.com' && /^\/x\/space\/like\/video$/.test(url.pathname),
      (route) => route.fulfill(cors(JSON.stringify({ code: 0, data: { list: [{ bvid: BVID, aid: AID, title: '端到端测试视频', owner: { mid: 1, name: 'E2E UP' }, pic: '', duration: 600 }] } }))),
    );
    await context.route(
      (url) => url.hostname === 'api.bilibili.com' && /^\/x\/v3\/fav\/folder\/created\/list-all$/.test(url.pathname),
      (route) => route.fulfill(cors(JSON.stringify({ code: 0, data: { list: [{ id: 777, title: '默认收藏夹', media_count: 1 }] } }))),
    );
    await context.route(
      (url) => url.hostname === 'api.bilibili.com' && /^\/x\/v3\/fav\/resource\/list$/.test(url.pathname),
      (route) => route.fulfill(cors(JSON.stringify({ code: 0, data: { medias: [{ bvid: BVID, id: AID, title: '端到端测试视频', upper: { mid: 1, name: 'E2E UP' }, cover: '', duration: 600 }] } }))),
    );
    await context.route('https://api.bilibili.com/x/web-interface/archive/relation**', (route) => {
      if (config.relation === 'unavailable') return route.fulfill(cors(JSON.stringify({ code: -101, message: '账号未登录' })));
      return route.fulfill(cors(JSON.stringify({ code: 0, data: { like: true, coin: 2, favorite: true, multiply: 2 } })));
    });
    await context.route('https://aisubtitle.hdslb.com/**', (route) => {
      reads += 1;
      return route.fulfill(cors(JSON.stringify({ body: subtitleFactory(reads) })));
    });

    if (config.ai) {
      await context.route('https://api.openai.com/**', (route) =>
        route.fulfill(
          config.ai.ok
            ? {
                status: 200,
                headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
                body: JSON.stringify({ choices: [{ message: { content: '{"summary":"夹具摘要","outline":["第一节"],"keyPoints":["要点"]}' } }] }),
              }
            : { status: config.ai.status ?? 500, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'fixture ai failure' } }) },
        ),
      );
    }
    // A miniature Notion: adding a property through PATCH really does extend the schema, so the
    // auto-column path is exercised end to end instead of being mocked away.
    const notionSchema = { Name: { type: 'title' }, URL: { type: 'url' } };
    const addedColumns = [];
    const pageProperties = {};
    if (config.notion) {
      await context.route('https://api.notion.com/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('/query')) {
          // The duplicate guard asks the data source whether this 视频ID is already a page.
          const existing = config.notionExisting ? [{ id: 'page-existing', url: 'https://www.notion.so/existing' }] : [];
          return route.fulfill(cors(JSON.stringify({ results: existing })));
        }
        if (pathname.startsWith('/v1/data_sources/')) {
          if (route.request().method() === 'PATCH') {
            const patch = JSON.parse(route.request().postData() ?? '{}');
            for (const [name, definition] of Object.entries(patch.properties ?? {})) {
              addedColumns.push(name);
              notionSchema[name] = { type: Object.keys(definition)[0] };
            }
          }
          return route.fulfill(cors(JSON.stringify({ properties: notionSchema })));
        }
        if (pathname === '/v1/pages') {
          notionPages += 1;
          const body = JSON.parse(route.request().postData() ?? '{}');
          for (const [name, value] of Object.entries(body.properties ?? {})) {
            pageProperties[name] = value?.rich_text?.[0]?.text?.content ?? value?.url ?? value?.date?.start ?? 'set';
          }
          return route.fulfill(cors(JSON.stringify({ id: 'page-1', url: 'https://www.notion.so/page-1' })));
        }
        return route.fulfill(cors(JSON.stringify({})));
      });
    }

    await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.runSequence());

    const { data, record } = await readStorage(context);

    // Driving the archive sync the way a user does: the button on the options page.
    let archiveToast = '';
    let archiveRecord = null;
    let archiveRecords = 0;
    if (config.archive) {
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId()}/options.html`, { waitUntil: 'load' });
      await options.waitForSelector('.app .brand-name', { timeout: 10000 });
      await options.click('button:has-text("同步 B站 记录")');
      await options.waitForSelector('.toast', { timeout: 20000 }).catch(() => undefined);
      archiveToast = (await options.textContent('.toast').catch(() => '')) ?? '';
      await options.waitForTimeout(600);
      archiveRecords = await options.locator('.record').count();
      await options.close();
      const worker = await workerOf(context);
      const after = await worker.evaluate(() => chrome.storage.local.get(null));
      archiveRecord = after?.[`rec:${LIST_BVID}:${LIST_CID}`] ?? null;
    }

    return {
      label,
      archiveToast,
      archiveRecords,
      archiveRecord,
      reads,
      notionPages,
      title: record?.title,
      owner: record?.owner,
      like: record?.actions?.like,
      coin: record?.actions?.coin,
      favorite: record?.actions?.favorite,
      share: record?.actions?.share,
      relationSource: record?.relation?.source,
      relationError: record?.relation?.error,
      subtitleState: record?.subtitle ? 'ok' : 'none',
      subtitleStep: record?.steps?.subtitle?.state,
      subtitleError: record?.steps?.subtitle?.error,
      observations: record?.subtitle?.observations,
      plainText: record?.subtitle?.plainText,
      analysisStep: record?.steps?.analysis?.state,
      analysisError: record?.steps?.analysis?.error,
      analysisSummary: record?.analysis?.summary,
      notionState: record?.steps?.notion?.state,
      notionUrl: record?.steps?.notion?.url,
      notionSkipped: record?.steps?.notion?.skipped,
      addedColumns,
      pageProperties,
      queue: (data?.['sync-queue'] ?? []).length,
    };
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

/** Unpacked extensions get an id derived from their absolute path. */
function extensionId() {
  return [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

async function uiSmoke() {
  const { context, userDataDir } = await launch();
  try {
    await workerOf(context);
    const id = extensionId();
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'load' });
    await options.waitForSelector('.app .brand-name', { timeout: 10000 });
    const optionsTitle = await options.title();
    const optionsBrand = await options.textContent('.brand-name');
    const statTiles = await options.locator('.stat').count();
    // Regression guard: a build that forgets styles.css ships an unstyled UI.
    const tokenApplied = await options.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--text').trim() !== '',
    );
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' });
    await popup.waitForSelector('.popup .brand-name', { timeout: 10000 });
    const popupBrand = await popup.textContent('.brand-name');
    return { optionsTitle, optionsBrand, statTiles, popupBrand, tokenApplied };
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

/** The viewer page is the "see everything + download" surface; check it against seeded storage. */
async function viewerSmoke() {
  const { context, userDataDir } = await launch();
  try {
    const worker = await workerOf(context);
    const key = `${BVID}:${CID}`;
    const record = {
      schemaVersion: 2,
      key,
      bvid: BVID,
      aid: AID,
      cid: CID,
      page: 1,
      title: '夹具字幕页',
      owner: 'E2E UP',
      category: '科技',
      duration: 100,
      url: `https://www.bilibili.com/video/${BVID}/`,
      tags: [],
      actions: { like: true, coin: 2, favorite: false, share: true },
      relation: { fetchedAt: Date.now(), source: 'api' },
      watched: { firstAt: 1, lastAt: 1, visits: 1, secondsWatched: 0, maxProgressRatio: 0, completed: false },
      steps: { subtitle: { state: 'ok', at: 1 }, analysis: { state: 'ok', at: 1 }, notion: { state: 'idle' } },
      subtitle: {
        track: { id: '1', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
        availableTracks: [],
        segments: [
          { from: 0, to: 1, content: '夹具第一句' },
          { from: 1, to: 2, content: '夹具第二句' },
        ],
        plainText: '夹具第一句\n夹具第二句',
        digest: 'a'.repeat(64),
        fetchedAt: 1,
        observations: 2,
        warnings: [],
      },
      analysis: {
        summary: '夹具摘要正文',
        outline: ['提纲一'],
        keyPoints: ['要点一'],
        provider: 'fixture',
        model: 'm',
        createdAt: 1,
        subtitleDigest: 'a'.repeat(64),
      },
      userNotes: { highlights: ['亮点'], questions: [], freeform: '' },
      createdAt: 1,
      updatedAt: 1,
    };
    await worker.evaluate(async (seeded) => {
      await chrome.storage.local.set({ [`rec:${seeded.key}`]: seeded, 'record-index': [seeded.key] });
    }, record);

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId()}/viewer.html?key=${encodeURIComponent(key)}`, { waitUntil: 'load' });
    await page.waitForSelector('.cues li', { timeout: 10000 });
    const cueCount = await page.locator('.cues li').count();
    const firstCue = await page.textContent('.cues li .cue-text');
    const summary = await page.textContent('.viewer-summary');
    // Scope to the summary section: the notes section renders lists too.
    const listItems = await page.locator('#analysis .viewer-list li').count();
    await page.fill('.viewer-search', '第二');
    await page.waitForTimeout(150);
    const filteredCues = await page.locator('.cues li').count();
    await page.fill('.viewer-search', '');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("下载 SRT")'),
    ]);
    const downloadName = download.suggestedFilename();
    const downloadPath = await download.path();
    const srt = downloadPath ? await readFile(downloadPath, 'utf8') : '';

    // The options page exposes a self-test that reads the live state for this account.
    await context.route('https://api.bilibili.com/x/web-interface/archive/relation**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 0, data: { like: true, coin: 2, favorite: false } }) }),
    );
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId()}/options.html`, { waitUntil: 'load' });
    await options.waitForSelector('.tabs .tab', { timeout: 10000 });
    await options.click('.tabs .tab:nth-child(4)');
    await options.click('button:has-text("测试 B站 状态读取")');
    await options.waitForSelector('.toast', { timeout: 10000 });
    const relationToast = (await options.textContent('.toast')) ?? '';

    return { cueCount, firstCue, summary, listItems, filteredCues, downloadName, srt: srt.slice(0, 120), relationToast };
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

const stable = await scenario('stable CDN', () => [
  { from: 0, to: 1, content: '第一句' },
  { from: 1, to: 2, content: '第二句' },
]);
const unstable = await scenario('unstable CDN (B站 bug)', (read) => [{ from: 0, to: 1, content: `随机内容-${read}` }]);

const aiFailure = await scenario('AI step fails', () => [{ from: 0, to: 1, content: '第一句' }], {
  settings: {
    ai: { enabled: true, apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'fixture' },
    notion: { enabled: true, token: 't', parentType: 'data_source_id', parentId: 'ds' },
  },
  ai: { ok: false, status: 500 },
  notion: true,
});

const fullPipeline = await scenario('subtitle -> ai -> notion', () => [{ from: 0, to: 1, content: '第一句' }], {
  settings: {
    ai: { enabled: true, apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'fixture' },
    notion: { enabled: true, token: 't', parentType: 'data_source_id', parentId: 'ds' },
  },
  ai: { ok: true },
  notion: true,
});

const noRelation = await scenario('B站 state read unavailable', () => [{ from: 0, to: 1, content: '第一句' }], {
  relation: 'unavailable',
});

// B站's history expires, so the extension keeps its own durable archive: the sync pulls the account's
// lists in, and the merged record keeps the history playback while gaining the B站 action state.
const archiveSync = await scenario('B站 列表 → 本地归档', () => [{ from: 0, to: 1, content: '第一句' }], {
  settings: { notion: { enabled: false } },
  archive: true,
});

// Re-running the Notion step for a video that is already a page must not create a second one.
const duplicate = await scenario('re-push refused when the video is already in the library', () => [{ from: 0, to: 1, content: '第一句' }], {
  settings: {
    ai: { enabled: true, apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'fixture' },
    notion: { enabled: true, token: 't', parentType: 'data_source_id', parentId: 'ds' },
  },
  ai: { ok: true },
  notion: true,
  notionExisting: true,
});

const ui = await uiSmoke();
const viewer = await viewerSmoke();

const checks = [
  ['stable: real title captured (not the BV id)', stable.title === '端到端测试视频'],
  ['stable: real uploader captured (not 未知UP主)', stable.owner === 'E2E UP'],
  ['stable: like recorded (local action confirmed by B站)', stable.like === true],
  ['stable: coin read from the B站 API (never touched locally)', stable.coin === 2],
  ['stable: favorite read from the B站 API (never touched locally)', stable.favorite === true],
  ['stable: share stays a local observation', stable.share === true],
  ['stable: state provenance is the API', stable.relationSource === 'api'],
  ['stable: subtitle present', stable.subtitleState === 'ok'],
  ['stable: two independent reads agreed', stable.observations === 2],
  ['stable: exact subtitle text', stable.plainText === '第一句\n第二句'],
  ['stable: queue drained', stable.queue === 0],
  ['unstable: subtitle rejected', unstable.subtitleState === 'none'],
  ['unstable: error reported on the subtitle step', unstable.subtitleStep === 'error' && /一致/.test(unstable.subtitleError ?? '')],
  ['unstable: analysis not attempted after the failure', unstable.analysisStep !== 'error'],
  ['unstable: kept retrying past a single read', unstable.reads >= 3],

  ['relation-down: keeps the local echo', noRelation.like === true && noRelation.coin === 0],
  ['relation-down: says so instead of pretending', noRelation.relationSource === 'local' && /未登录/.test(noRelation.relationError ?? '')],

  ['ai-fail: subtitle still succeeded', aiFailure.subtitleState === 'ok'],
  ['ai-fail: error surfaced on the AI step', aiFailure.analysisStep === 'error' && /500/.test(aiFailure.analysisError ?? '')],
  ['ai-fail: notion step left untouched', aiFailure.notionState === 'idle'],
  ['ai-fail: no Notion page was created', aiFailure.notionPages === 0],

  ['pipeline: subtitle ok', fullPipeline.subtitleState === 'ok'],
  ['pipeline: analysis ok and stored', fullPipeline.analysisStep === 'ok' && fullPipeline.analysisSummary === '夹具摘要'],
  ['pipeline: notion ok with a page url', fullPipeline.notionState === 'ok' && Boolean(fullPipeline.notionUrl)],
  ['pipeline: exactly one page created', fullPipeline.notionPages === 1],
  ['pipeline: 视频ID column was added automatically', fullPipeline.addedColumns.includes('视频ID')],
  ['pipeline: page carries 视频ID / UP主 / 日期 / 摘要', ['视频ID', 'UP主', '日期', '摘要'].every((name) => fullPipeline.pageProperties[name])],
  ['pipeline: 视频ID value is the BV id', fullPipeline.pageProperties['视频ID'] === BVID],
  ['pipeline: queue drained', fullPipeline.queue === 0],
  ['archive: the sync button reports what it pulled', /新增 1/.test(archiveSync.archiveToast) && /更新 1/.test(archiveSync.archiveToast)],
  ['archive: the history video became a local record', Boolean(archiveSync.archiveRecord)],
  ['archive: it is marked as coming from B站 历史', (archiveSync.archiveRecord?.archive?.origins ?? []).includes('history')],
  ['archive: history playback was kept', archiveSync.archiveRecord?.watched?.secondsWatched === 90],
  ['archive: B站 action state was read (点赞 / 投币 / 收藏)', archiveSync.archiveRecord?.actions?.like === true && archiveSync.archiveRecord?.actions?.coin === 2 && archiveSync.archiveRecord?.actions?.favorite === true],
  ['archive: the record list shows both videos', archiveSync.archiveRecords >= 2],

  ['dup: no duplicate page created', duplicate.notionPages === 0],
  ['dup: record points at the page already in the library', duplicate.notionUrl === 'https://www.notion.so/existing'],
  ['dup: step counts as done, not failed', duplicate.notionState === 'ok'],

  ['ui: options page renders', ui.optionsBrand === 'BiliVault' && ui.optionsTitle === 'BiliVault · 设置'],
  ['ui: stat tiles rendered', ui.statTiles === 9],
  ['ui: stylesheet applied (not unstyled)', ui.tokenApplied === true],
  ['ui: popup renders', ui.popupBrand === 'BiliVault'],

  ['viewer: renders every subtitle cue', viewer.cueCount === 2 && viewer.firstCue === '夹具第一句'],
  ['viewer: shows the AI summary and its lists', viewer.summary?.includes('夹具摘要正文') && viewer.listItems === 2],
  ['viewer: search filters the cue list', viewer.filteredCues === 1],
  ['viewer: downloads SRT with real timings', viewer.downloadName === `${BVID}.srt` && viewer.srt.includes('00:00:00,000 --> 00:00:01,000') && viewer.srt.includes('夹具第一句')],
  ['options: B站 state self-test reports the live values', /读取成功/.test(viewer.relationToast) && /点赞=true/.test(viewer.relationToast) && /投币=2/.test(viewer.relationToast)],
];

console.log(JSON.stringify({ stable, unstable, aiFailure, fullPipeline, noRelation, ui, viewer }, null, 2));
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`${failed} e2e check(s) failed`);
  process.exit(1);
}
console.log('all e2e checks passed');
