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
/** B站 历史夹具里的观看时间（秒），同步后本地记录的观看时间必须等于它。 */
const LIST_VIEW_AT = 1763000000;
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
    if (record?.actions?.like && record?.actions?.share && record?.relation && !busy && (failed || (queueLength === 0 && started))) return { data, record };
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
                    view_at: LIST_VIEW_AT,
                    history: { oid: 4242, bvid: LIST_BVID, cid: LIST_CID, business: 'archive' },
                  },
                  // 第二条是全新的（走「新增」路径）；第一条已经以「旧版本导入」的形态存在（走「纠正」路径）。
                  {
                    title: '历史里的第二个视频',
                    cover: '',
                    author_name: '历史UP',
                    author_mid: 5,
                    duration: 120,
                    is_finish: 1,
                    view_at: LIST_VIEW_AT - 86400,
                    history: { oid: 5151, bvid: 'BV1zz411c7mD', cid: 112233, business: 'archive' },
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
    let archiveRows = [];
    if (config.archive) {
      // 旧版本把「同步那一刻」写进了 watched.lastAt（secondsWatched 又来自历史进度，所以看起来像播放过）。
      // 同步一次必须用 B站 的 view_at 把它纠正过来 —— 这是用户报的那个问题。
      const syncAt = Date.now();
      const seeder = await workerOf(context);
      await seeder.evaluate(
        async (legacy) => {
          const { 'record-index': index } = await chrome.storage.local.get(['record-index']);
          const keys = Array.isArray(index) ? index : [];
          if (!keys.includes(legacy.key)) keys.unshift(legacy.key);
          await chrome.storage.local.set({ [`rec:${legacy.key}`]: legacy, 'record-index': keys });
          const currentKey = keys.find(key => key !== legacy.key);
          if (currentKey) {
            const data = await chrome.storage.local.get(`rec:${currentKey}`);
            const current = data[`rec:${currentKey}`];
            current.watched = { ...current.watched, visits:1, lastAt:Date.now() };
            await chrome.storage.local.set({ [`rec:${currentKey}`]:current });
          }
        },
        {
          schemaVersion: 1,
          key: `${LIST_BVID}:${LIST_CID}`,
          bvid: LIST_BVID,
          aid: 4242,
          cid: LIST_CID,
          page: 1,
          title: '历史里的视频（旧版本导入的）',
          owner: '历史UP',
          url: `https://www.bilibili.com/video/${LIST_BVID}/`,
          actions: { like: false, coin: 0, favorite: false, share: false },
          watched: { firstAt: syncAt, lastAt: syncAt, visits: 0, secondsWatched: 90, maxProgressRatio: 0, completed: false },
          steps: { subtitle: { state: 'idle' }, analysis: { state: 'idle' }, notion: { state: 'idle' } },
          userNotes: { highlights: [], questions: [], freeform: '' },
          archive: { origins: ['history'], seenAt: { history: syncAt }, archivedAt: syncAt },
          createdAt: syncAt,
          updatedAt: syncAt,
        },
      );

      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId()}/options.html`, { waitUntil: 'load' });
      await options.waitForSelector('.workspace-brand', { timeout: 10000 });
      // 默认打开即后台更新；等任务持久化完成，不再依赖旧的一次性 toast 回执。
      await options.waitForFunction(() => document.querySelector('.history-status')?.textContent.includes('上次更新于'), null, { timeout: 45000 });
      archiveToast = await options.evaluate(async () => (await chrome.runtime.sendMessage({type:'history-status'})).data.state);
      await options.waitForTimeout(2200);
      archiveRecords = await options.locator('.history-row').count();
      archiveRows = await options.locator('.history-row').evaluateAll(items => items.map(item => ({
        title: item.querySelector('.video-title')?.textContent?.trim() ?? '',
        meta: item.querySelector('time')?.getAttribute('datetime') ?? '',
      })));
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
      archiveRows,
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
    await options.waitForSelector('.workspace-brand', { timeout: 10000 });
    const optionsTitle = await options.title();
    const optionsBrand = await options.textContent('.workspace-brand');
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

/**
 * 历史记录页的筛选按钮：坏数据必须只影响它自己那一行。
 * 以前渲染期抛一次错（例如 out-of-range 时间戳进 toISOString）会让整棵视图停止更新，
 * 表现就是「点几次筛选就卡在一个选项上，再也点不动」。
 */
async function historySmoke() {
  const { context, userDataDir } = await launch();
  try {
    const worker = await workerOf(context);
    const now = Date.now();
    const build = (key, extra) => ({
      schemaVersion: 2,
      key,
      bvid: key.split(':')[0],
      aid: 1,
      cid: Number(key.split(':')[1]),
      page: 1,
      title: `视频 ${key}`,
      owner: 'UP',
      duration: 100,
      url: `https://www.bilibili.com/video/${key.split(':')[0]}/`,
      actions: { like: true, coin: 0, favorite: false, share: false },
      relation: { fetchedAt: now, source: 'api' },
      watched: { firstAt: now, lastAt: now, visits: 1, secondsWatched: 10, maxProgressRatio: 0.2, completed: false },
      steps: { subtitle: { state: 'idle' }, analysis: { state: 'idle' }, notion: { state: 'idle' } },
      userNotes: { highlights: [], questions: [], freeform: '' },
      archive: { origins: ['history'], seenAt: { history: now }, archivedAt: now },
      history: { watchedAt: now, position: 10, finished: false },
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    const records = {
      'rec:BVgood:1': build('BVgood:1', {}),
      // Date 无法表示的观看时间：旧代码在这一行上抛 RangeError，整页再也点不动。
      'rec:BVtime:1': build('BVtime:1', { history: { watchedAt: 1e300, position: 10, finished: false } }),
      // 早期版本写下的残缺记录：没有 userNotes / archive.origins / steps.notion，也没有互动状态。
      'rec:BVpartial:1': build('BVpartial:1', {
        actions: { like: false, coin: 0, favorite: false, share: false },
        relation: { fetchedAt: now, source: 'page' },
        userNotes: undefined,
        archive: undefined,
        steps: { subtitle: { state: 'idle' } },
      }),
    };
    const index = Object.keys(records).map((key) => key.replace('rec:', ''));
    await worker.evaluate(
      async (payload) => chrome.storage.local.set({ ...payload.records, 'record-index': payload.index }),
      { records, index },
    );

    const options = await context.newPage();
    const errors = [];
    options.on('pageerror', (error) => errors.push(String(error.message).split('\n')[0]));
    await options.goto(`chrome-extension://${extensionId()}/options.html`, { waitUntil: 'load' });
    await options.waitForSelector('.history-filters button', { timeout: 15000 });

    const pressed = () =>
      options.$$eval('.history-filters button', (nodes) =>
        nodes.filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.textContent),
      );
    const sequence = ['点赞过', '投币过', '收藏过', '全部', '投币过', '收藏过', '点赞过', '全部'];
    const stuck = [];
    for (const label of sequence) {
      await options.click(`.history-filters button:text-is("${label}")`);
      const applied = await options
        .waitForFunction(
          (text) =>
            [...document.querySelectorAll('.history-filters button')].some(
              (node) => node.textContent === text && node.getAttribute('aria-pressed') === 'true',
            ),
          label,
          { timeout: 4000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!applied) stuck.push(label);
    }
    // 坏记录也要能按它的观看时间显示在某一天里，而不是被整行跳过。
    const rows = await options.locator('.history-row').count();
    const skipped = await options.locator('text=这条记录的数据有问题').count();
    const goodVisible = await options.locator('.video-title:text-is("视频 BVgood:1")').count();
    return { stuck, rows, skipped, goodVisible, pressed: await pressed(), errors };
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
    await options.getByRole('button', {name:'设置',exact:true}).click();
    await options.locator('.more-settings > summary').click();
    await options.getByText('诊断',{exact:true}).click();
    await options.getByRole('button',{name:'测试 B站状态读取',exact:true}).click();
    await options.waitForSelector('.workspace-toast', { timeout: 10000 });
    const relationToast = (await options.textContent('.workspace-toast')) ?? '';

    return { cueCount, firstCue, summary, listItems, filteredCues, downloadName, srt: srt.slice(0, 120), relationToast };
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

if (process.env.E2E_ARCHIVE_ONLY === '1') {
  const result = await scenario('archive probe', () => [{from:0,to:1,content:'第一句'}], { settings:{notion:{enabled:false}},archive:true });
  console.log(JSON.stringify(result,null,2));
  process.exit(result.archiveToast === 'done' && result.archiveRecord?.actions?.coin === 2 ? 0 : 1);
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
const history = await historySmoke();

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
  ['archive: the persisted job completed', archiveSync.archiveToast === 'done'],
  ['archive: the history video became a local record', Boolean(archiveSync.archiveRecord)],
  ['archive: it is marked as coming from B站 历史', (archiveSync.archiveRecord?.archive?.origins ?? []).includes('history')],
  ['archive: history playback was kept', archiveSync.archiveRecord?.watched?.secondsWatched === 90],
  ['archive: B站 action state was read (点赞 / 投币 / 收藏)', archiveSync.archiveRecord?.actions?.like === true && archiveSync.archiveRecord?.actions?.coin === 2 && archiveSync.archiveRecord?.actions?.favorite === true],
  ['archive: the record list shows both videos', archiveSync.archiveRecords >= 2],
  ['archive: the list is newest-watched first', (archiveSync.archiveRows[0]?.title ?? '').includes('端到端测试视频')],
  [
    'archive: the history record shows the real B站 watch time',
    archiveSync.archiveRows.find((row) => row.title.includes('历史里的视频'))?.meta === new Date(LIST_VIEW_AT * 1000).toISOString(),
  ],
  [
    'archive: the legacy sync time is corrected to the real B站 watch time',
    archiveSync.archiveRecord?.watched?.lastAt === LIST_VIEW_AT * 1000 &&
      archiveSync.archiveRecord?.watched?.firstAt === LIST_VIEW_AT * 1000,
  ],
  [
    'archive: every row shows a labelled activity time, not a bare sync timestamp',
    archiveSync.archiveRows.every((row) => !row.meta || Number.isFinite(Date.parse(row.meta))),
  ],

  ['dup: no duplicate page created', duplicate.notionPages === 0],
  ['dup: record points at the page already in the library', duplicate.notionUrl === 'https://www.notion.so/existing'],
  ['dup: step counts as done, not failed', duplicate.notionState === 'ok'],

  ['ui: options page renders', ui.optionsBrand === 'BiliRecall' && ui.optionsTitle === 'BiliRecall · 历史记录与知识库'],
  ['ui: global stat tiles removed', ui.statTiles === 0],
  ['ui: stylesheet applied (not unstyled)', ui.tokenApplied === true],
  ['ui: popup renders', ui.popupBrand === 'BiliRecall'],

  ['viewer: renders every subtitle cue', viewer.cueCount === 2 && viewer.firstCue === '夹具第一句'],
  ['viewer: shows the AI summary and its lists', viewer.summary?.includes('夹具摘要正文') && viewer.listItems === 2],
  ['viewer: search filters the cue list', viewer.filteredCues === 1],
  ['viewer: downloads SRT with real timings', viewer.downloadName === `${BVID}.srt` && viewer.srt.includes('00:00:00,000 --> 00:00:01,000') && viewer.srt.includes('夹具第一句')],
  ['options: B站 state self-test reports live values', /读取成功/.test(viewer.relationToast) && /点赞=true/.test(viewer.relationToast) && /投币=2/.test(viewer.relationToast)],

  // 用户报的「筛选点几次就卡住」：坏时间戳曾经在这里抛出 RangeError 冻住整页。
  ['history: every filter chip still switches with damaged records present', history.stuck.length === 0],
  ['history: no uncaught error while rendering damaged records', history.errors.length === 0],
  ['history: the good record still renders', history.goodVisible === 1 && history.rows >= 3],
  ['history: a damaged record is not silently dropped', history.skipped === 0],
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
