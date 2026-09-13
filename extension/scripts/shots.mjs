/**
 * Renders the popup and options UIs against seeded data and saves screenshots.
 * Uses a file:// harness that stubs `chrome.*`, so no live extension session is needed.
 *
 * Run: node scripts/shots.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.tmp/shots');
await mkdir(outDir, { recursive: true });

const now = Date.now();
const seg = (from, to, content) => ({ from, to, content });

const records = [
  {
    schemaVersion: 1,
    key: 'BV139bD6gEa8:40960721402',
    bvid: 'BV139bD6gEa8',
    aid: 117104095268420,
    cid: 40960721402,
    page: 1,
    title: 'Pi 大道至简：超越 Codex 和 Claude Code 的极简 Agent 全攻略',
    owner: 'AI 产品观察',
    category: '科技',
    duration: 1832,
    pubdate: 1763000000,
    description: '拆解极简 Agent 的设计取舍：为什么工具越少越好，以及上下文管理才是真正的瓶颈。',
    url: 'https://www.bilibili.com/video/BV139bD6gEa8/',
    cover: 'https://i0.hdslb.com/bfs/archive/demo-cover.jpg',
    tags: ['agent', 'context-engineering'],
    actions: { like: true, coin: 2, favorite: true, share: true },
    relation: { fetchedAt: now - 60000, source: 'api' },
    watched: { firstAt: now - 86400000, lastAt: now - 82000000, visits: 2, secondsWatched: 1740, maxProgressRatio: 0.95, completed: true },
    subtitle: {
      track: { id: '1497922385058359296', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
      availableTracks: [],
      segments: [seg(0, 4.2, '今天我们来聊一个极简的 agent 架构。'), seg(4.2, 9.8, '核心观点是：工具不是越多越好。'), seg(9.8, 15.4, '真正稀缺的是上下文，而不是工具数量。')],
      plainText: '今天我们来聊一个极简的 agent 架构。\n核心观点是：工具不是越多越好。\n真正稀缺的是上下文，而不是工具数量。',
      digest: '9f2c'.padEnd(64, '0'),
      fetchedAt: now - 82000000,
      observations: 2,
      warnings: [],
    },
    analysis: {
      summary: '演讲者认为 Agent 的能力上限由上下文管理决定，而非工具数量；他给出一个只有少数工具、靠明确的状态文件维持记忆的极简实现，并用真实任务对比了它与主流框架的差异。',
      outline: ['[00:00-00:04] 为什么工具膨胀会让 agent 变差', '[00:04-00:10] 上下文即状态：用文件而非隐式记忆', '[00:10-00:15] 与 Codex / Claude Code 的任务对比'],
      keyPoints: ['工具越少，选择成本越低，失败模式越可预测', '把中间状态写进文件，比塞进上下文窗口更可靠', '极简架构更适合长链路任务'],
      provider: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      createdAt: now - 81000000,
      subtitleDigest: '9f2c'.padEnd(64, '0'),
    },
    userNotes: {
      highlights: ['“上下文是稀缺资源”这一句解释了为什么塞更多工具反而更差', '状态文件的具体写法值得复用'],
      questions: ['如果任务需要十几个工具，该怎么分层而不是堆在一个 agent 里？', '状态文件的 schema 需不需要版本化？'],
      freeform: '可以拿自己的字幕导出流程做一次对照实验。',
    },
    steps: {
      subtitle: { state: 'ok', at: now - 82000000 },
      analysis: { state: 'ok', at: now - 81000000 },
      notion: {
        state: 'ok',
        at: now - 80000000,
        pageId: 'page-1',
        url: 'https://www.notion.so/page-1',
        completedBatches: 3,
        subtitleDigest: '9f2c'.padEnd(64, '0'),
        library: { state: 'present', checkedAt: now - 60000, matchedBy: '视频ID' },
        created: ['视频ID', '摘要'],
        skipped: ['标签'],
      },
    },
    createdAt: now - 86400000,
    updatedAt: now - 80000000,
  },
  {
    schemaVersion: 1,
    key: 'BV1xx411c7mD:789',
    bvid: 'BV1xx411c7mD',
    aid: 123456,
    cid: 789,
    page: 1,
    title: '从零实现一个向量检索：HNSW 到底在做什么',
    owner: '手写 AI',
    category: '计算机技术',
    duration: 2410,
    pubdate: 1759000000,
    description: '用图解的方式讲清 HNSW 的层级图、邻居选择与搜索过程。',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    tags: ['retrieval'],
    actions: { like: true, coin: 1, favorite: false, share: false },
    relation: { fetchedAt: now - 120000, source: 'local', error: '未登录，无法从 B站 读取点赞 / 投币 / 收藏 状态' },
    watched: { firstAt: now - 3600000, lastAt: now - 1800000, visits: 1, secondsWatched: 1500, maxProgressRatio: 0.62, completed: false },
    subtitle: {
      track: { id: '2', language: 'zh-Hans', label: '中文（简体）', source: 'page' },
      availableTracks: [],
      segments: [seg(0, 5, 'HNSW 的本质是一个多层跳表。'), seg(5, 11, '上层稀疏用来快速接近目标。')],
      plainText: 'HNSW 的本质是一个多层跳表。\n上层稀疏用来快速接近目标。',
      digest: 'a1b2'.padEnd(64, '0'),
      fetchedAt: now - 1800000,
      observations: 2,
      warnings: [],
    },
    userNotes: { highlights: [], questions: [], freeform: '' },
    steps: { subtitle: { state: 'ok', at: now - 1800000 }, analysis: { state: 'idle' }, notion: { state: 'idle' } },
    createdAt: now - 3600000,
    updatedAt: now - 1800000,
  },
  {
    schemaVersion: 1,
    key: 'BV1yy411c7mD:321',
    bvid: 'BV1yy411c7mD',
    aid: 654321,
    cid: 321,
    page: 1,
    title: '为什么你的 RAG 效果不好：分块策略的七个陷阱',
    owner: '检索工程笔记',
    category: '科技',
    duration: 1200,
    pubdate: 1755000000,
    description: '分块粒度、重叠、元数据与父子块的实际取舍。',
    url: 'https://www.bilibili.com/video/BV1yy411c7mD/',
    tags: ['rag'],
    actions: { like: false, coin: 0, favorite: false, share: true },
    relation: { fetchedAt: now - 7000000, source: 'api' },
    watched: { firstAt: now - 7200000, lastAt: now - 7000000, visits: 1, secondsWatched: 300, maxProgressRatio: 0.25, completed: false },
    userNotes: { highlights: [], questions: [], freeform: '' },
    steps: {
      subtitle: { state: 'error', at: now - 7000000, error: '连续 4 次读取未取得一致的字幕正文（摘要：7f5f250f25fa, a0a377ec939f）。可能是 B站返回了其他视频的内容或 CDN 缓存错乱；本次不写入 Notion，稍后重试。' },
      analysis: { state: 'idle' },
      notion: { state: 'idle' },
    },
    createdAt: now - 7200000,
    updatedAt: now - 7000000,
  },
];

const stats = {
  total: records.length,
  withSubtitle: 2,
  withAnalysis: 1,
  synced: 1,
  pending: 1,
  needsReview: 1,
  topTags: [],
};

const settings = {
  notion: { enabled: true, token: 'secret_demo_token', parentType: 'data_source_id', parentId: '1f2e3d4c5b6a7890', titleProperty: 'title' },
  ai: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo', model: 'gpt-4o-mini', language: '中文', prompt: '你是一个知识管理助手…' },
  subtitle: { language: 'auto', consensusReads: 2, maxAttempts: 4 },
  webhook: { enabled: false, url: '' },
  general: { captureWatched: true, notifyOnSync: true },
};

const seed = JSON.stringify({ records, stats, settings });

function stub(seedJson) {
  return `<script>
const SEED = ${seedJson};
const PARAMS = new URL(location.href).searchParams;
const IDX = Math.min(SEED.records.length - 1, Number(PARAMS.get('idx') ?? '0') || 0);
// notion=off renders the flow with Notion disabled (no Notion step, agent handoff instead).
if (PARAMS.get('notion') === 'off') SEED.settings.notion.enabled = false;
// ai=<baseUrl> renders the popup as if that endpoint were configured (provider mark check).
if (PARAMS.get('ai')) SEED.settings.ai.baseUrl = PARAMS.get('ai');
window.chrome = {
  runtime: {
    getURL(path) { return 'chrome-extension://stub/' + path; },
    openOptionsPage() {},
    async sendMessage(message) {
      switch (message && message.type) {
        case 'get-settings': return { ok: true, data: SEED.settings };
        case 'stats': return { ok: true, data: SEED.stats };
        case 'list-records': return { ok: true, data: SEED.records };
        case 'get-current': return { ok: true, data: { identity: { bvid: SEED.records[IDX].bvid, aid: SEED.records[IDX].aid, cid: SEED.records[IDX].cid, page: 1 }, record: SEED.records[IDX], loginState: { isLogin: true, checkedAt: Date.now() } } };
        case 'refresh-actions': return { ok: true, data: SEED.records[IDX] };
        case 'get-record': {
          const url = new URL(location.href);
          const key = url.searchParams.get('key');
          return { ok: true, data: SEED.records.find((r) => r.key === key) ?? SEED.records[0] };
        }
        // Persist like the real worker does, so a re-read after autosave returns the saved notes.
        case 'save-notes': {
          const target = SEED.records.find((record) => record.key === message.key);
          if (target) target.userNotes = message.notes;
          window.__noteSaved = JSON.stringify(message.notes);
          return { ok: true, data: null };
        }
        case 'probe-login': return { ok: true, data: { isLogin: true, checkedAt: Date.now() } };
        default: return { ok: true, data: null };
      }
    },
  },
  permissions: { async request() { return true; } },
  tabs: {
    async query() { return [{ id: 1 }]; },
    async create(options) { window.__lastTabUrl = options?.url ?? ''; },
    async get() { return { id: 1 }; },
  },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};
</script>`;
}

function harness(title, bundle) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>${title}</title>
<link rel="stylesheet" href="../../dist/styles.css" />
</head><body>
${stub(seed)}
<div id="app"></div>
<script src="../../dist/${bundle}"></script>
</body></html>`;
}

await writeFile(path.join(outDir, 'harness-popup.html'), harness('popup', 'popup.js'));
await writeFile(path.join(outDir, 'harness-options.html'), harness('options', 'options.js'));
await writeFile(path.join(outDir, 'harness-viewer.html'), harness('viewer', 'viewer.js'));

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const viewerKey = encodeURIComponent(records[0].key);
const shots = [
  { file: 'harness-popup.html', name: 'popup', width: 396, height: 900, full: false },
  { file: 'harness-options.html', name: 'options-records', width: 1000, height: 900, full: false },
  { file: `harness-viewer.html?key=${viewerKey}`, name: 'viewer', width: 1000, height: 900, full: false },
];

for (const scheme of ['light', 'dark']) {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
    await page.emulateMedia({ colorScheme: scheme });
    const [filePath, query] = shot.file.split('?');
    const pageUrl = pathToFileURL(path.join(outDir, filePath)).href + (query ? `?${query}` : '');
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const target = path.join(outDir, `${shot.name}-${scheme}.png`);
    await page.screenshot({ path: target, fullPage: shot.full });
    console.log('saved', path.relative(root, target));
    await page.close();
  }
}

// Options tabs (light only) for layout review
const tabs = ['notion', 'ai', 'capture', 'export'];
for (const tab of tabs) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(pathToFileURL(path.join(outDir, 'harness-options.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.evaluate((label) => {
    const buttons = Array.from(document.querySelectorAll('.tab'));
    const index = { notion: 1, ai: 2, capture: 3, export: 4 }[label];
    buttons[index]?.click();
  }, tab);
  await page.waitForTimeout(250);
  const target = path.join(outDir, `options-${tab}.png`);
  await page.screenshot({ path: target });
  console.log('saved', path.relative(root, target));
  await page.close();
}

await browser.close();
