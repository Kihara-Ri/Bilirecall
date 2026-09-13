import { applyArchiveItem, archiveOf, archiveSummary, markDroppedFromHistory, planArchiveSync } from '../lib/archive';
import { BiliClient, type BiliListVideo, type VideoInfo } from '../lib/bili';
import { applyAction, hasAnyAction, mergeWatch } from '../lib/events';
import type { Track } from '../lib/subtitle';
import { BiliVaultError } from '../lib/errors';
import { browserFetch } from '../lib/http';
import { normalizeCoverUrl } from '../lib/media';
import { NotionClient, notionConfigured, reviewSchema } from '../lib/notion';
import { pingAi, summarize } from '../lib/ai';
import { agentBrief, buildBundle } from '../lib/export';
import { aiUsable, notionMissing, notionUsable, plannedSteps, STEP_ORDER } from '../lib/pipeline';
import { fetchActions } from '../lib/relation';
import { ChromeStorageStore, Repository, hasMetadata, newRecord } from '../lib/store';
import type { Settings, StepState, VideoRecord } from '../lib/types';
import type {
  BackgroundResult,
  ContentMessage,
  CurrentVideoState,
  PageIdentity,
  PageSnapshotPayload,
  PageVideoPayload,
  PipelineResult,
  PipelineStep,
  PipelineStepResult,
  RuntimeRequest,
  StatsResult,
  WatchPayload,
} from '../lib/messages';

const ALARM = 'bilivault-queue';

const store = new ChromeStorageStore();
const repo = new Repository(store);
const bili = new BiliClient(browserFetch);

const snapshots = new Map<number, PageSnapshotPayload>();
const videos = new Map<number, PageVideoPayload>();
const metadataAttempts = new Map<string, number>();
const relationAttempts = new Map<string, number>();
let processing = false;
let loginState: { isLogin: boolean; checkedAt: number } | undefined;

const keyOf = (identity: PageIdentity): string => `${identity.bvid}:${identity.cid}`;

/**
 * Records are read-modify-written from several page events at once (a like and a share can
 * land in the same tick). Chaining per record key keeps the later write from resurrecting a
 * stale copy of the earlier one.
 */
const recordLocks = new Map<string, Promise<unknown>>();
function withRecord<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = recordLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  recordLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** ---------------------------------------------------------------- B站 列表 → 本地归档 */

/** 单次同步最多新建多少条记录（其余下次再同步）。 */
const MAX_IMPORT = 40;
/** 单次同步最多读多少条 B站 状态（点赞 / 投币 / 收藏 在同一个接口里返回）。 */
const MAX_RELATION = 20;
/** 观看历史按游标最多翻几页（30 条/页）。 */
const HISTORY_PAGES = 10;

export interface ArchiveSyncResult {
  created: number;
  updated: number;
  /** B站 历史已经不再返回、但本地继续保留的条数。 */
  dropped: number;
  /** 本次读到 B站 状态的条数（投币只能这样逐条读，B站 没有投币列表接口）。 */
  inspected: number;
  sources: Array<{ name: string; count: number; error?: string }>;
}

/**
 * 把 B站 的历史 / 点赞 / 收藏并进本地归档。
 *
 * B站 的历史记录会过期，所以本地这份才是长期保存的：合并只做加法，字幕、摘要、你的笔记、
 * 流程状态与 Notion 回执都不动；从 B站 列表里消失的视频只被标记，不会被删掉。
 */
async function syncArchiveFromBilibili(): Promise<ArchiveSyncResult> {
  const nav = await bili.nav();
  if (!nav.isLogin || !nav.mid) throw new BiliVaultError('B站 未登录（或读不到账号 mid），无法同步历史记录');

  const sources: Array<{ name: string; run: () => Promise<BiliListVideo[]> }> = [
    { name: '观看历史', run: () => bili.history(HISTORY_PAGES) },
    { name: '点赞', run: () => bili.liked(nav.mid) },
    { name: '收藏', run: () => bili.favorites(nav.mid) },
  ];
  const pulled: Array<{ name: string; items: BiliListVideo[]; error?: string }> = [];
  for (const source of sources) {
    try {
      pulled.push({ name: source.name, items: await source.run() });
    } catch (error) {
      pulled.push({ name: source.name, items: [], error: message(error) });
    }
  }

  const now = Date.now();
  const all = await repo.list();
  const incoming = pulled.flatMap((entry) => entry.items);
  const { fresh, known } = planArchiveSync(all, incoming);

  let created = 0;
  const createdBvids = new Set<string>();
  const touched: VideoRecord[] = [];

  // 已经在本地归档里的：直接合并（新增的来源、元信息、观看进度）
  for (const { record, item } of known) touched.push(applyArchiveItem(record, item, now));

  // 新的：历史项自带 cid，点赞 / 收藏要先读一次视频信息才有 cid
  for (const item of fresh.slice(0, MAX_IMPORT)) {
    let entry = item;
    if (!entry.cid) {
      try {
        const info = await bili.view(entry.bvid);
        entry = {
          ...entry,
          aid: entry.aid || info.aid,
          cid: info.cid,
          title: entry.title || info.title,
          owner: entry.owner || info.owner,
          ownerMid: entry.ownerMid ?? info.ownerMid,
          cover: entry.cover || info.cover,
          duration: entry.duration || info.duration,
        };
      } catch (error) {
        log('archive import failed for', entry.bvid, message(error));
        continue;
      }
    }
    if (!entry.cid) continue;
    const record = newRecord({
      bvid: entry.bvid,
      aid: entry.aid,
      cid: entry.cid,
      title: entry.title || entry.bvid,
      owner: entry.owner,
      ownerMid: entry.ownerMid,
      cover: entry.cover,
      duration: entry.duration,
      url: `https://www.bilibili.com/video/${entry.bvid}/`,
    });
    touched.push(applyArchiveItem(record, entry, now));
    createdBvids.add(entry.bvid);
    created += 1;
  }

  // 点赞 / 收藏 的状态来自列表本身；投币没有列表接口，只能逐条读 relation（限量，优先新记录）
  const inspected = [...touched]
    .sort((a, b) => Number(createdBvids.has(b.bvid)) - Number(createdBvids.has(a.bvid)))
    .slice(0, MAX_RELATION);
  for (const record of inspected) {
    try {
      const snapshot = await fetchActions(record.bvid, record.aid);
      record.actions = { like: snapshot.like, coin: snapshot.coin, favorite: snapshot.favorite, share: record.actions.share };
      record.relation = {
        fetchedAt: snapshot.fetchedAt,
        source: 'api',
        warnings: snapshot.warnings.length ? snapshot.warnings : undefined,
      };
    } catch (error) {
      log('relation read failed for', record.bvid, message(error));
    }
  }

  // B站 清掉的历史：标记但不删除
  const historyPull = pulled.find((entry) => entry.name === '观看历史');
  const historyItems = historyPull?.items ?? [];
  const seenHistory = new Set(historyItems.map((item) => item.bvid));
  const windowStart = historyItems.length ? Math.min(...historyItems.map((item) => item.watchedAt ?? now)) : 0;
  const droppedChanges =
    historyPull && !historyPull.error && historyItems.length
      ? markDroppedFromHistory(all, { seen: seenHistory, windowStart, now })
      : [];

  for (const record of [...touched, ...droppedChanges]) await repo.upsert(record);

  return {
    created,
    updated: known.length,
    dropped: droppedChanges.filter((record) => archiveOf(record).droppedFromHistory).length,
    inspected: inspected.length,
    sources: pulled.map((entry) => ({ name: entry.name, count: entry.items.length, error: entry.error })),
  };
}

/** Thrown when a step is intentionally not executed (config off / already done). */
class StepSkipped extends Error {}
/** Thrown when a step's prerequisite is missing. */
class StepBlocked extends Error {}

function log(...args: unknown[]): void {
  console.log('[BiliVault]', ...args);
}

/** Joins a Notion rich-text array into plain text (titles, headings). */
function textOf(richText: unknown): string {
  return Array.isArray(richText) ? richText.map((part: any) => String(part?.plain_text ?? '')).join('') : '';
}

// ---------------------------------------------------------------- metadata

function applyInfo(record: VideoRecord, info: VideoInfo): void {
  if (info.title) record.title = info.title;
  if (info.owner) record.owner = info.owner;
  if (info.ownerMid) record.ownerMid = info.ownerMid;
  const cover = normalizeCoverUrl(info.cover);
  if (cover) record.cover = cover;
  if (info.category) record.category = info.category;
  if (info.duration) record.duration = info.duration;
  if (info.pubdate) record.pubdate = info.pubdate;
  if (info.description) record.description = info.description;
  record.url = `https://www.bilibili.com/video/${record.bvid}/${record.page > 1 ? `?p=${record.page}` : ''}`;
}

function infoFromRecord(record: VideoRecord): VideoInfo {
  return {
    bvid: record.bvid,
    aid: record.aid,
    cid: record.cid,
    page: record.page,
    title: record.title,
    part: '',
    owner: record.owner,
    ownerMid: record.ownerMid,
    cover: record.cover ?? '',
    category: record.category ?? '',
    duration: record.duration ?? 0,
    pubdate: record.pubdate ?? 0,
    description: record.description ?? '',
    url: record.url,
    tags: record.tags,
  };
}

/** Fetch title / UP主 from the API and store them. Never throws. */
async function refreshVideoInfo(record: VideoRecord): Promise<VideoInfo> {
  try {
    const info = await bili.view(record.bvid);
    applyInfo(record, info);
    record.metadataError = undefined;
    return { ...info, cid: record.cid, page: record.page };
  } catch (error) {
    record.metadataError = message(error);
    log('view() failed for', record.bvid, record.metadataError);
    return infoFromRecord(record);
  }
}

/** Only called when metadata is missing, and at most once a minute per video. */
async function ensureMetadata(record: VideoRecord, options: { force?: boolean } = {}): Promise<void> {
  // The page hook gives us title/UP主 without the cover, so a missing cover tops up too.
  if (hasMetadata(record) && normalizeCoverUrl(record.cover)) return;
  const last = metadataAttempts.get(record.key) ?? 0;
  if (!options.force && Date.now() - last < 60_000) return;
  metadataAttempts.set(record.key, Date.now());
  await refreshVideoInfo(record);
  await repo.upsert(record);
}

/**
 * Mirror the state B站 itself shows for this video. The page hook only tells us that
 * *something* changed; the server is what we trust, so a like given on another device shows
 * up here too. Never throws: on failure the local observation is kept and `relation.error`
 * explains why.
 */
async function refreshActions(record: VideoRecord, options: { force?: boolean } = {}): Promise<void> {
  const last = relationAttempts.get(record.key) ?? 0;
  if (!options.force && Date.now() - last < 5_000) return;
  relationAttempts.set(record.key, Date.now());
  try {
    const snapshot = await fetchActions(record.bvid, record.aid);
    record.actions = { like: snapshot.like, coin: snapshot.coin, favorite: snapshot.favorite, share: record.actions.share };
    record.relation = {
      fetchedAt: snapshot.fetchedAt,
      source: 'api',
      warnings: snapshot.warnings.length ? snapshot.warnings : undefined,
    };
  } catch (error) {
    record.relation = {
      fetchedAt: Date.now(),
      source: 'local',
      error: message(error),
      warnings: record.relation?.warnings,
    };
  }
  await repo.upsert(record);
}

// ---------------------------------------------------------------- step state

async function setStep(record: VideoRecord, step: PipelineStep, next: StepState): Promise<void> {
  record.steps = { ...record.steps, [step]: { ...record.steps[step], ...next } };
  await repo.upsert(record);
}

// ---------------------------------------------------------------- steps

function pageTracksFor(record: VideoRecord): Track[] | undefined {
  for (const snapshot of snapshots.values()) {
    if (snapshot.identity.cid === record.cid && snapshot.tracks.length) return snapshot.tracks as Track[];
  }
  return undefined;
}

async function runSubtitleStep(record: VideoRecord, settings: Settings): Promise<void> {
  await setStep(record, 'subtitle', { state: 'running', error: undefined });
  const info = await refreshVideoInfo(record);
  const subtitle = await bili.resolveSubtitle(info, {
    pageTracks: pageTracksFor(record),
    preferredLanguage: settings.subtitle.language,
    consensusReads: settings.subtitle.consensusReads,
    maxAttempts: settings.subtitle.maxAttempts,
  });
  const changed = record.subtitle?.digest !== subtitle.digest;
  record.subtitle = subtitle;
  record.steps = {
    ...record.steps,
    subtitle: { state: 'ok', at: Date.now(), error: undefined },
    // A changed body invalidates the derived analysis and the Notion page.
    analysis: changed && record.analysis ? { ...record.steps.analysis, state: 'idle' } : record.steps.analysis,
    notion: changed ? { ...record.steps.notion, state: 'idle' } : record.steps.notion,
  };
  await repo.upsert(record);
}

async function runAnalysisStep(record: VideoRecord, settings: Settings): Promise<void> {
  if (!aiUsable(settings)) throw new StepSkipped('未启用 AI 摘要');
  const subtitle = record.subtitle;
  if (!subtitle) throw new StepBlocked('还没有字幕，请先完成第 1 步');
  await setStep(record, 'analysis', { state: 'running', error: undefined });
  let analysis;
  try {
    analysis = await summarize(record, settings);
  } catch (error) {
    // A missing optional host permission surfaces as an opaque network error; explain it.
    if (error instanceof TypeError || /failed to fetch|network/i.test(message(error))) {
      let origin = '';
      try {
        origin = new URL(settings.ai.baseUrl).origin + '/*';
      } catch {
        throw new BiliVaultError('AI Base URL 不是合法网址，请在设置页修正');
      }
      const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
      if (!granted) throw new BiliVaultError(`无法访问 ${origin}：请在设置页「AI 摘要」点击「测试 AI」授予该域名权限`);
    }
    throw error;
  }
  record.analysis = { ...analysis, subtitleDigest: subtitle.digest };
  record.steps = { ...record.steps, analysis: { state: 'ok', at: Date.now(), error: undefined } };
  await repo.upsert(record);
}

async function runNotionStep(record: VideoRecord, settings: Settings): Promise<void> {
  if (!notionUsable(settings)) throw new StepSkipped(`无法写入 Notion：${notionMissing(settings.notion)}`);
  const subtitle = record.subtitle;
  if (!subtitle) throw new StepBlocked('还没有字幕，请先完成第 1 步');
  // The cover is part of the page, and the write happens now: top it up even if the capture path
  // already considered the metadata complete.
  await ensureMetadata(record, { force: true });
  await setStep(record, 'notion', { ...record.steps.notion, state: 'running', error: undefined });
  const client = new NotionClient(settings.notion.token);
  const target = {
    token: settings.notion.token,
    parentId: settings.notion.parentId,
    parentType: settings.notion.parentType,
    titleProperty: settings.notion.titleProperty,
    autoColumns: settings.notion.autoColumns,
  };
  // Re-running the step must never create a second page: if the knowledge base already holds this
  // 视频ID, refuse the push and point the record at the page that is already there.
  const existing = await client.checkLibrary(record, target).catch(() => ({ state: 'unsupported' as const }));
  if (existing.state === 'present' && existing.pageId) {
    record.steps = {
      ...record.steps,
      notion: {
        ...record.steps.notion,
        state: 'ok',
        error: undefined,
        pageId: existing.pageId,
        url: existing.url || record.steps.notion.url,
        subtitleDigest: subtitle.digest,
        library: { state: 'present', checkedAt: Date.now(), matchedBy: existing.matchedBy },
      },
    };
    await repo.upsert(record);
    throw new StepSkipped(
      `Notion 里已经有这条视频（按「${existing.matchedBy ?? '视频ID'}」匹配到 ${record.bvid}），已拒绝重复推送并指向已有页面`,
    );
  }
  const result = await client.upload(record, target);
  record.steps = {
    ...record.steps,
    notion: {
      state: 'ok',
      at: Date.now(),
      error: undefined,
      pageId: result.pageId,
      url: result.url,
      completedBatches: result.completedBatches,
      subtitleDigest: subtitle.digest,
      written: result.written,
      skipped: result.skipped,
      created: result.created.length ? result.created : undefined,
      library: { state: 'present' as const, checkedAt: Date.now(), matchedBy: result.written[0] },
    },
  };
  await repo.upsert(record);
  if (settings.general.notifyOnSync) {
    void chrome.notifications
      .create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'BiliVault 已写入 Notion',
        message: record.title.slice(0, 120),
      })
      .catch(() => undefined);
  }
}

async function postWebhook(record: VideoRecord, settings: Settings): Promise<void> {
  if (!settings.webhook.enabled || !settings.webhook.url) return;
  try {
    await browserFetch(settings.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'video.valuable', briefly: agentBrief(record), record }),
    });
  } catch (error) {
    log('webhook failed', error);
  }
}

/**
 * Runs the steps in order. A failing step reports its own error and stops the pipeline,
 * so a subtitle failure never gets hidden behind a Notion failure.
 */
async function runPipeline(key: string, options: { only?: PipelineStep } = {}): Promise<PipelineResult> {
  const settings = await repo.getSettings();
  const record = await repo.get(key);
  if (!record) return { ok: false, steps: [] };

  const requested: PipelineStep[] = options.only ? [options.only] : plannedSteps(record, settings);

  const results: PipelineStepResult[] = [];
  if (!requested.length) {
    return { ok: true, steps: STEP_ORDER.map((step) => ({ step, state: 'skipped', reason: '已完成' })) };
  }

  let failed = false;
  for (const step of requested) {
    // Steps after a failure are not attempted, and their state is left untouched.
    if (failed) break;
    try {
      if (step === 'subtitle') await runSubtitleStep(record, settings);
      else if (step === 'analysis') await runAnalysisStep(record, settings);
      else await runNotionStep(record, settings);
      results.push({ step, state: 'ok' });
    } catch (error) {
      if (error instanceof StepSkipped) {
        results.push({ step, state: 'skipped', reason: error.message });
        continue;
      }
      if (error instanceof StepBlocked) {
        await setStep(record, step, { state: 'error', error: error.message, at: Date.now() });
        results.push({ step, state: 'error', error: error.message });
        failed = true;
        continue;
      }
      const text = message(error);
      await setStep(record, step, { state: 'error', error: text, at: Date.now() });
      results.push({ step, state: 'error', error: text });
      failed = true;
    }
  }

  if (!failed) await postWebhook(record, settings);
  return { ok: !failed, steps: results };
}

async function processQueue(limit = 2): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const queue = await repo.queue();
    for (const key of queue.slice(0, limit)) {
      const result = await runPipeline(key);
      if (result.ok) await repo.dequeue(key);
      else await repo.rotate(key);
      log('processed', key, result.ok ? 'ok' : JSON.stringify(result.steps.filter((s) => s.state === 'error')));
    }
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------- content messages

async function upsertFromSnapshot(snapshot: PageSnapshotPayload, tabId?: number): Promise<VideoRecord> {
  const video = tabId !== undefined ? videos.get(tabId) : undefined;
  const key = keyOf(snapshot.identity);
  const existing = await repo.get(key);
  const base =
    existing ??
    newRecord({
      bvid: snapshot.identity.bvid,
      aid: snapshot.identity.aid,
      cid: snapshot.identity.cid,
      page: snapshot.identity.page,
      title: video?.title || '',
      owner: video?.owner || '',
      cover: video?.cover,
      category: video?.category,
      duration: video?.duration,
      pubdate: video?.pubdate,
      description: video?.description,
      url: video?.url || snapshot.url,
    });
  const merged: VideoRecord = {
    ...base,
    title: video?.title || base.title,
    owner: video?.owner || base.owner,
    ownerMid: video?.ownerMid ?? base.ownerMid,
    cover: video?.cover || base.cover,
    category: video?.category || base.category,
    duration: video?.duration || base.duration,
    pubdate: video?.pubdate || base.pubdate,
    description: video?.description || base.description,
    url: video?.url || snapshot.url || base.url,
  };
  const saved = await repo.upsert(merged);
  if (!hasMetadata(saved)) void ensureMetadata(saved);
  return saved;
}

async function handleContent(message: ContentMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  const settings = await repo.getSettings();

  if (message.type === 'page-snapshot') {
    if (tabId !== undefined) snapshots.set(tabId, message.payload);
    await upsertFromSnapshot(message.payload, tabId);
    return;
  }

  if (message.type === 'page-video') {
    if (tabId !== undefined) videos.set(tabId, message.payload);
    const identity = message.payload.identity;
    if (!identity.cid) return;
    await upsertFromSnapshot(
      { identity, tracks: [], needLoginSubtitle: false, endpoint: 'page', url: message.payload.url, at: message.payload.at },
      tabId,
    );
    return;
  }

  if (message.type === 'watch') {
    if (!settings.general.captureWatched) return;
    const payload = message.payload as WatchPayload;
    const key = keyOf(payload.identity);
    return withRecord(key, async () => {
    const existing = await repo.get(key);
    const video = tabId !== undefined ? videos.get(tabId) : undefined;
    const base =
      existing ??
      newRecord({
        ...payload.identity,
        page: payload.identity.page,
        title: video?.title || '',
        owner: video?.owner || '',
        url: payload.url,
      });
    base.watched = mergeWatch(base.watched, {
      visits: payload.visits ?? 0,
      secondsWatched: payload.secondsWatched,
      maxProgressRatio: payload.progressRatio,
      completed: payload.completed,
      lastAt: payload.at,
    });
    if (video) {
      base.title = video.title || base.title;
      base.owner = video.owner || base.owner;
      base.cover = video.cover || base.cover;
      base.category = video.category || base.category;
      base.duration = video.duration || base.duration;
    }
    const saved = await repo.upsert(base);
    if (!hasMetadata(saved)) void ensureMetadata(saved);
    });
    return;
  }

  // action
  const signal = message.payload;
  let record =
    tabId !== undefined && snapshots.get(tabId) ? await repo.get(keyOf(snapshots.get(tabId)!.identity)) : undefined;
  if (!record && signal.bvid) {
    const all = await repo.list();
    record = all.find((r) => r.bvid === signal.bvid);
  }
  if (!record) {
    log('action without a known video', signal.kind, signal.bvid);
    return;
  }
  await withRecord(record.key, async () => {
    // Re-read inside the lock so a concurrent action cannot be lost.
    const current = (await repo.get(record!.key)) ?? record!;
    // Optimistic local echo, then the authoritative read from B站.
    current.actions = applyAction(current.actions, { ...signal, bvid: signal.bvid ?? current.bvid });
    await repo.upsert(current);
    await refreshActions(current, { force: true });
    // Acting on a video is the capture trigger; the pipeline decides what still needs doing.
    await repo.enqueue(current.key);
    await processQueue(2);
  });
}

// ---------------------------------------------------------------- UI requests

async function currentTab(tabId?: number): Promise<chrome.tabs.Tab | undefined> {
  if (tabId !== undefined) return chrome.tabs.get(tabId).catch(() => undefined);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function bvidFromTab(tab?: chrome.tabs.Tab): Promise<string | undefined> {
  if (!tab?.url) return undefined;
  return tab.url.match(/BV[0-9A-Za-z]{10}/)?.[0];
}

async function getCurrent(tabId?: number): Promise<CurrentVideoState> {
  // The panel's account badge reads this. Without a probe here the first popup open would sit on
  // "检测中" forever, because nothing else asks B站 until you touch a video.
  if (!loginState || Date.now() - loginState.checkedAt > 60_000) {
    try {
      const nav = await bili.nav();
      loginState = { isLogin: nav.isLogin, checkedAt: Date.now() };
    } catch (error) {
      log('login probe failed:', message(error));
      loginState = { isLogin: false, checkedAt: Date.now() };
    }
  }
  const tab = await currentTab(tabId);
  const snapshot = tab?.id !== undefined ? snapshots.get(tab.id) : undefined;
  const video = tab?.id !== undefined ? videos.get(tab.id) : undefined;
  const identity = snapshot?.identity ?? video?.identity ?? null;
  if (!identity) {
    const bvid = await bvidFromTab(tab);
    if (bvid) {
      const found = (await repo.list()).find((r) => r.bvid === bvid);
      if (found) {
        void ensureMetadata(found);
        return { identity: { bvid: found.bvid, aid: found.aid, cid: found.cid, page: found.page }, record: found, loginState };
      }
    }
    return { identity: null, record: null, loginState };
  }
  const record = (await repo.get(keyOf(identity))) ?? null;
  if (record && !hasMetadata(record)) void ensureMetadata(record);
  // Keep the action icons honest without blocking the popup.
  if (record && (!record.relation || Date.now() - record.relation.fetchedAt > 60_000)) void refreshActions(record);
  return { identity, record, loginState };
}

async function stats(): Promise<StatsResult> {
  const records = await repo.list();
  const tags = new Map<string, number>();
  for (const record of records) for (const tag of record.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  const archive = archiveSummary(records);
  return {
    total: records.length,
    liked: archive.byAction.liked,
    coined: archive.byAction.coined,
    faved: archive.byAction.faved,
    shared: archive.byAction.shared,
    archived: archive.archived,
    dropped: archive.dropped,
    withSubtitle: records.filter((r) => r.subtitle).length,
    withAnalysis: records.filter((r) => r.analysis).length,
    synced: records.filter((r) => r.steps.notion.state === 'ok').length,
    pending: records.filter((r) => r.steps.notion.state === 'idle' || r.steps.notion.state === 'running').length,
    needsReview: records.filter((r) => r.steps.notion.state === 'error' || r.steps.subtitle.state === 'error').length,
    topTags: [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
  };
}

async function handleRequest(request: RuntimeRequest): Promise<BackgroundResult> {
  const settings = await repo.getSettings();
  switch (request.type) {
    case 'get-current':
      return { ok: true, data: await getCurrent(request.tabId) };
    case 'get-record':
      return { ok: true, data: (await repo.get(request.key)) ?? null };
    case 'list-records':
      return { ok: true, data: await repo.search(request.query ?? '') };
    case 'stats':
      return { ok: true, data: await stats() };
    case 'save-notes': {
      const record = await repo.get(request.key);
      if (!record) return { ok: false, error: '记录不存在' };
      record.userNotes = request.notes;
      await repo.upsert(record);
      // Saving a note is intent to keep this video, whether or not it was liked.
      const hasNotes = Boolean(
        record.userNotes.highlights.length || record.userNotes.questions.length || record.userNotes.freeform.trim(),
      );
      if (hasAnyAction(record.actions) || hasNotes) await repo.enqueue(record.key);
      return { ok: true, data: record };
    }
    case 'test-relation': {
      // Self-test against B站 with the real session: proves the endpoints work for this account.
      const newest = (await repo.list()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!newest) return { ok: false, error: '还没有任何视频记录，先打开一个 B站视频' };
      const { bvid } = newest;
      try {
        const snapshot = await fetchActions(bvid, newest.aid);
        return {
          ok: true,
          data: {
            bvid,
            via: snapshot.via,
            like: snapshot.like,
            coin: snapshot.coin,
            favorite: snapshot.favorite,
            warnings: snapshot.warnings,
          },
        };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'refresh-actions': {
      const record = await repo.get(request.key);
      if (!record) return { ok: false, error: '记录不存在' };
      await refreshActions(record, { force: request.force ?? true });
      return { ok: true, data: record };
    }
    case 'sync-now': {
      const result = await runPipeline(request.key, { only: request.step });
      const firstError = result.steps.find((s) => s.state === 'error');
      return { ok: result.ok, data: result, error: firstError?.error };
    }
    case 'sync-all': {
      // Everything that still has an unfinished step, and nothing that is already done.
      for (const record of await repo.list()) {
        if (plannedSteps(record, settings).length) await repo.enqueue(record.key);
      }
      void processQueue(3);
      return { ok: true, data: { queued: (await repo.queue()).length } };
    }
    case 'get-settings':
      return { ok: true, data: settings };
    case 'save-settings':
      return { ok: true, data: await repo.saveSettings(request.patch) };
    case 'sync-bilibili': {
      try {
        return { ok: true, data: await syncArchiveFromBilibili() };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'check-notion': {
      // "Is this video still a page in my knowledge base?" — the local record can be wrong
      // because a page may have been deleted (or renamed away) in Notion.
      if (!notionUsable(settings)) return { ok: false, error: `无法检查 Notion：${notionMissing(settings.notion)}` };
      const record = await repo.get(request.key);
      if (!record) return { ok: false, error: '记录不存在' };
      try {
        const client = new NotionClient(settings.notion.token);
        const check = await client.checkLibrary(record, {
          token: settings.notion.token,
          parentId: settings.notion.parentId,
          parentType: settings.notion.parentType,
        });
        if (check.state === 'unsupported') {
          return { ok: false, error: '父级是页面或缺少可用于匹配的列，无法检索；数据库 Data Source 支持按 视频ID 查询' };
        }
        record.steps = {
          ...record.steps,
          notion:
            check.state === 'present'
              ? {
                  ...record.steps.notion,
                  state: 'ok',
                  error: undefined,
                  pageId: check.pageId,
                  url: check.url,
                  library: { state: 'present', checkedAt: Date.now(), matchedBy: check.matchedBy },
                }
              : {
                  ...record.steps.notion,
                  state: 'idle',
                  error: undefined,
                  pageId: undefined,
                  url: undefined,
                  subtitleDigest: undefined,
                  library: { state: 'missing', checkedAt: Date.now(), matchedBy: check.matchedBy },
                },
        };
        await repo.upsert(record);
        return { ok: true, data: { ...check, record } };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'test-notion': {
      // Checks the token, then the parent itself: a valid token with an unshared or wrong-typed
      // data source is the failure people actually hit.
      if (!settings.notion.token) return { ok: false, error: '未填写 Notion Token' };
      if (!settings.notion.parentId) return { ok: false, error: '未填写 Data Source ID / Page ID' };
      try {
        const client = new NotionClient(settings.notion.token);
        const me = await client.request('GET', '/users/me');
        const bot = me.name ?? me.bot?.owner?.user?.name ?? 'bot';
        if (settings.notion.parentType === 'page_id') {
          const page = await client.request('GET', `/pages/${settings.notion.parentId}`);
          const title = textOf(page?.properties?.title?.title);
          return { ok: true, data: { bot, parentType: '页面 Page', parentTitle: title || '(无标题页面)', review: null } };
        }
        const schema = await client.request('GET', `/data_sources/${settings.notion.parentId}`);
        const review = reviewSchema(schema);
        return {
          ok: true,
          data: { bot, parentType: '数据库 Data Source', parentTitle: textOf(schema?.title) || '(未命名数据源)', review },
        };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'test-ai': {
      try {
        return { ok: true, data: { model: await pingAi(settings) } };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'probe-login': {
      try {
        const nav = await bili.nav();
        loginState = { isLogin: nav.isLogin, checkedAt: Date.now() };
        return { ok: true, data: loginState };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }
    case 'delete-record':
      await repo.remove(request.key);
      return { ok: true };
    case 'export-bundle':
      return { ok: true, data: buildBundle(await repo.list()) };
    case 'open-options':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: '未知请求' };
  }
}

chrome.runtime.onMessage.addListener((incoming: ContentMessage | RuntimeRequest, sender, sendResponse) => {
  const isContent =
    ['page-snapshot', 'page-video', 'action', 'watch'].includes((incoming as { type: string }).type) && sender.tab !== undefined;
  if (isContent) {
    void handleContent(incoming as ContentMessage, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: message(error) }));
    return true;
  }
  void handleRequest(incoming as RuntimeRequest)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: message(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  snapshots.delete(tabId);
  videos.delete(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void processQueue(1);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  log('installed');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

void processQueue(1);
