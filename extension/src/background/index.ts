import { archiveOf } from '../lib/archive';
import { HistorySync } from '../lib/history-sync';
import { inLibrary } from '../lib/history';
import { BiliClient, type VideoInfo } from '../lib/bili';
import { sanitizeActionSignal, sanitizeSnapshot, sanitizeVideo, sanitizeWatch } from '../lib/bridge';
import { applyAction, hasAnyAction, mergeWatch } from '../lib/events';
import { createStatsReader } from '../lib/stats';
import { watchChanged } from '../lib/watch';
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

const HISTORY_ALARM = 'bilivault-history';
const HISTORY_ALARM_PERIOD_MIN = 0.5;
const historySync = new HistorySync(store, repo, bili, async (bvid, aid) => {
  // 互动状态无批量接口，逐项间隔限速；失败也不立刻并发重试。
  await new Promise(resolve => setTimeout(resolve, 350));
  return fetchActions(bvid, aid);
}, withRecord);
let historyRunning = false;

/**
 * alarm 是持久唤醒保障，短循环只是让首屏后续批次更快到达，不依赖全局变量保活。
 * 任务停下来后**不撤闹钟**：它是自动更新的常驻调度器，下一轮到点由 ensureHistoryTick 开新任务。
 */
async function runHistoryBatches(): Promise<void> {
  if (historyRunning) return;
  historyRunning = true;
  try {
    for (let batch = 0; batch < 10; batch += 1) {
      const status = await historySync.tick();
      if (status.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { historyRunning = false; }
}

/**
 * 自动更新闹钟与设置保持一致：`autoUpdateHistory` 开着就常驻（周期到点自动开新任务，历史才能
 * 不打开插件页面也对齐 B站）；关掉时只有在没有任务运行的情况下才撤掉——手动「更新历史」仍需要
 * 闹钟把被 SW 休眠打断的任务续完。
 */
async function ensureHistoryAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HISTORY_ALARM);
  if ((await repo.getSettings()).general.autoUpdateHistory) {
    if (!existing) await chrome.alarms.create(HISTORY_ALARM, { periodInMinutes: HISTORY_ALARM_PERIOD_MIN });
  } else if (existing && (await historySync.status()).state !== 'running') {
    await chrome.alarms.clear(HISTORY_ALARM);
  }
}

/** 周期唤醒入口：按节流/退避规则尝试开新任务，再驱动批次，收尾时让闹钟与设置对齐。 */
async function ensureHistoryTick(): Promise<void> {
  if ((await repo.getSettings()).general.autoUpdateHistory) await historySync.start(false);
  await runHistoryBatches();
  await ensureHistoryAlarm();
}

/** Thrown when a step is intentionally not executed (config off / already done). */
class StepSkipped extends Error {}
/** Thrown when a step's prerequisite is missing. */
class StepBlocked extends Error {}

function log(...args: unknown[]): void {
  console.log('[BiliRecall]', ...args);
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
        title: 'BiliRecall 已写入 Notion',
        message: record.title.slice(0, 120),
      })
      .catch(() => undefined);
  }
}

/** Webhook 的外发上限：用户自建端点挂住时不能拖住流水线。 */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** 只发 http(s)：其它协议即使被填进来也发不出去（也拿不到主机权限）。 */
function webhookUsable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 缺主机权限时 fetch 只抛 TypeError，这里换成用户能照着做的说法。 */
function webhookErrorHint(error: unknown, url: string): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Webhook ${Math.round(WEBHOOK_TIMEOUT_MS / 1000)} 秒内没有响应`;
  }
  if (error instanceof TypeError) {
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      /* 保持原样 */
    }
    return `无法访问 ${origin}：请在该地址的设置里点「授权并测试」允许域名权限`;
  }
  return message(error);
}

async function postWebhook(record: VideoRecord, settings: Settings): Promise<void> {
  if (!settings.webhook.enabled || !settings.webhook.url || !webhookUsable(settings.webhook.url)) return;
  try {
    const response = await browserFetch(settings.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'video.valuable', briefly: agentBrief(record), record }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    // 以前这里连状态码都不看：端点未授权（缺主机权限）或 404 都只留在 SW 控制台里。
    if (response.status >= 300) log('webhook failed', record.key, 'HTTP', response.status);
  } catch (error) {
    log('webhook failed', record.key, webhookErrorHint(error, settings.webhook.url));
  }
}

/**
 * 在**记录锁之外**取最新记录并发送 Webhook。
 * 锁内发送意味着一个慢端点会把同一视频的笔记保存、互动刷新一起堵到 15 秒超时——
 * 用户看到「后台响应超时，请重试」，实际写入却已经落库。
 */
async function postWebhookOutsideLock(key: string): Promise<void> {
  try {
    const settings = await repo.getSettings();
    if (!settings.webhook.enabled || !settings.webhook.url) return;
    const record = await repo.get(key);
    if (record) await postWebhook(record, settings);
  } catch (error) {
    log('webhook failed', key, message(error));
  }
}

/**
 * Runs the steps in order. A failing step reports its own error and stops the pipeline,
 * so a subtitle failure never gets hidden behind a Notion failure.
 */
async function runPipeline(key: string, options: { only?: PipelineStep } = {}): Promise<PipelineResult> {
  // 历史、笔记、页面动作与流水线共用记录锁，防止旧对象写回覆盖刚收到的互动/笔记。
  const result = await withRecord(key, () => runPipelineLocked(key, options));
  // Webhook 是尽力而为的外发，放在锁外：慢端点不该阻塞同一视频的其他写入。
  if (result.ok) void postWebhookOutsideLock(key);
  return result;
}

async function runPipelineLocked(key: string, options: { only?: PipelineStep }): Promise<PipelineResult> {
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

async function refreshRecordLater(key: string, kind: 'metadata' | 'actions'): Promise<void> {
  return withRecord(key, async () => {
    const latest = await repo.get(key);
    if (!latest) return;
    if (kind === 'metadata') await ensureMetadata(latest);
    else await refreshActions(latest);
  });
}

async function upsertFromSnapshot(snapshot: PageSnapshotPayload, tabId?: number): Promise<VideoRecord> {
  return withRecord(keyOf(snapshot.identity), () => upsertSnapshotLocked(snapshot, tabId));
}

async function upsertSnapshotLocked(snapshot: PageSnapshotPayload, tabId?: number): Promise<VideoRecord> {
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
  if (!hasMetadata(saved)) void refreshRecordLater(saved.key, 'metadata');
  return saved;
}

async function handleContent(message: ContentMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  const settings = await repo.getSettings();

  // 内容脚本已经校验过一次；这里是落库前的第二道（也是唯一可信的一道）：
  // 页面上的任何脚本都能伪造桥接消息，形状不对就什么都不做。
  if (message.type === 'page-snapshot') {
    const payload = sanitizeSnapshot(message.payload);
    if (!payload) return;
    if (tabId !== undefined) snapshots.set(tabId, payload);
    await upsertFromSnapshot(payload, tabId);
    return;
  }

  if (message.type === 'page-video') {
    const payload = sanitizeVideo(message.payload);
    if (!payload) return;
    if (tabId !== undefined) videos.set(tabId, payload);
    await upsertFromSnapshot(
      { identity: payload.identity, tracks: [], needLoginSubtitle: false, endpoint: 'page', url: payload.url, at: payload.at },
      tabId,
    );
    return;
  }

  if (message.type === 'watch') {
    if (!settings.general.captureWatched) return;
    const payload = sanitizeWatch(message.payload);
    if (!payload) return;
    const key = keyOf(payload.identity);
    return withRecord(key, async () => {
    const existing = await repo.get(key);
    // 改动前的快照：心跳在暂停时每 10 秒会重复同样的值，比对之后就不必写库。
    const previous = existing
      ? { ...existing, watched: { ...existing.watched }, history: existing.history ? { ...existing.history } : undefined }
      : undefined;
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
    if (payload.position !== undefined) base.history = { ...base.history, watchedAt: payload.at, position: payload.position, finished: Boolean((video?.duration || base.duration) && payload.position / (video?.duration || base.duration || 1) >= 0.9) };
    if (video) {
      base.title = video.title || base.title;
      base.owner = video.owner || base.owner;
      base.cover = video.cover || base.cover;
      base.category = video.category || base.category;
      base.duration = video.duration || base.duration;
    }
    // 暂停 / 后台标签页的重复心跳不写库：否则界面轮询的归档版本号每 10 秒被顶一次，
    // 打开管理页时就会跟着重读整份归档。元数据还没补齐时照旧走下面的补全。
    if (previous && hasMetadata(base) && !watchChanged(previous, base)) return;
    const saved = await repo.upsert(base);
    if (!hasMetadata(saved)) void refreshRecordLater(saved.key, 'metadata');
    });
    return;
  }

  // action
  const signal = sanitizeActionSignal(message.payload);
  if (!signal) return;
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
    current.library = { saved: true };
    await repo.upsert(current);
    await refreshActions(current, { force: true });
    // Acting on a video is the capture trigger; the pipeline decides what still needs doing.
    await repo.enqueue(current.key);
    // 不在记录锁内等待队列，否则流水线申请同一把锁会死锁。
    void processQueue(2);
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
        void refreshRecordLater(found.key, 'metadata');
        return { identity: { bvid: found.bvid, aid: found.aid, cid: found.cid, page: found.page }, record: found, loginState };
      }
    }
    return { identity: null, record: null, loginState };
  }
  const record = (await repo.get(keyOf(identity))) ?? null;
  if (record && !hasMetadata(record)) void refreshRecordLater(record.key, 'metadata');
  // Keep the action icons honest without blocking the popup.
  if (record && (!record.relation || Date.now() - record.relation.fetchedAt > 60_000)) void refreshRecordLater(record.key, 'actions');
  return { identity, record, loginState };
}

/**
 * 面板每 1.5 秒问一次统计，而统计要读整份归档（含字幕）—— 归档没变时直接回缓存，
 * 轮询只花一次版本号读取。见 lib/stats.ts。
 */
const readStats = createStatsReader(repo);

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
      return { ok: true, data: await readStats() };
    case 'save-notes': return withRecord(request.key, async () => {
      const record = await repo.get(request.key);
      if (!record) return { ok: false, error: '记录不存在' };
      record.userNotes = request.notes;
      record.library = { saved: true };
      await repo.upsert(record);
      // Saving a note is intent to keep this video, whether or not it was liked.
      const hasNotes = Boolean(
        record.userNotes.highlights.length || record.userNotes.questions.length || record.userNotes.freeform.trim(),
      );
      if (hasAnyAction(record.actions) || hasNotes) await repo.enqueue(record.key);
      return { ok: true, data: record };
    });
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
    case 'refresh-actions': return withRecord(request.key, async () => {
      const record = await repo.get(request.key);
      if (!record) return { ok: false, error: '记录不存在' };
      await refreshActions(record, { force: request.force ?? true });
      return { ok: true, data: record };
    });
    case 'sync-now': {
      const result = await runPipeline(request.key, { only: request.step });
      const firstError = result.steps.find((s) => s.state === 'error');
      return { ok: result.ok, data: result, error: firstError?.error };
    }
    case 'sync-all': {
      // Everything that still has an unfinished step, and nothing that is already done.
      for (const record of await repo.list()) {
        if (inLibrary(record) && plannedSteps(record, settings).length) await repo.enqueue(record.key);
      }
      void processQueue(3);
      return { ok: true, data: { queued: (await repo.queue()).length } };
    }
    case 'get-settings':
      return { ok: true, data: settings };
    case 'save-settings': {
      const saved = await repo.saveSettings(request.patch);
      // 开关自动更新后立刻对齐闹钟；打开时马上开一轮同步，不等下一个周期。
      void ensureHistoryTick();
      return { ok: true, data: saved };
    }
    case 'history-poll':
      return { ok: true, data: { status: await historySync.status(), revision: await repo.revision() } };
    case 'history-status':
      return { ok: true, data: await historySync.status() };
    case 'sync-bilibili': {
      if (request.force === false && !settings.general.autoUpdateHistory) return { ok: true, data: await historySync.status() };
      // 先注册定时器再入队，避免 SW 恰好在两者之间休眠而失去续传唤醒。
      await chrome.alarms.create(HISTORY_ALARM, { periodInMinutes: HISTORY_ALARM_PERIOD_MIN });
      const status = await historySync.start(request.force ?? true);
      void runHistoryBatches();
      return { ok: true, data: status };
    }
    case 'collect-record':
    case 'hide-history':
      return withRecord(request.key, async () => {
        const record = await repo.get(request.key);
        if (!record) return { ok: false, error: '记录不存在' };
        if (request.type === 'collect-record') record.library = { saved: true };
        else record.history = { watchedAt: record.history?.watchedAt ?? 0, position: record.history?.position ?? 0, finished: record.history?.finished ?? false, hidden: true };
        await repo.upsert(record);
        return { ok: true, data: record };
      });
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
        // 网络请求不占记录锁；回包后只在锁内更新最新对象，不能写回请求前的旧笔记。
        return withRecord(request.key, async () => {
        const record = await repo.get(request.key);
        if (!record) return { ok: false, error: '记录已删除' };
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
        });
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
    case 'test-webhook': {
      // 用户点了「授权并测试」：这里真的发一条，把静默失败变成看得见的 HTTP 状态 / 权限原因。
      const url = settings.webhook.url.trim();
      if (!url) return { ok: false, error: '未填写 Webhook URL' };
      if (!webhookUsable(url)) return { ok: false, error: 'Webhook URL 必须以 http:// 或 https:// 开头' };
      const newest = (await repo.list()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      try {
        const response = await browserFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'test',
            at: Date.now(),
            briefly: newest ? agentBrief(newest) : 'BiliRecall 测试消息：还没有记录时只发这一条',
          }),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (response.status >= 300) return { ok: false, error: `Webhook 返回 HTTP ${response.status}` };
        return { ok: true, data: { status: response.status } };
      } catch (error) {
        return { ok: false, error: webhookErrorHint(error, url) };
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
    case 'delete-record': return withRecord(request.key, async () => {
      // 等当前流水线写回结束再删除，避免后台把已移除的记录复活。
      await repo.remove(request.key);
      await repo.dequeue(request.key);
      return { ok: true };
    });
    case 'export-bundle':
      return { ok: true, data: buildBundle((await repo.list()).filter(inLibrary)) };
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
  if (alarm.name === HISTORY_ALARM) void ensureHistoryTick();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  // 安装/浏览器启动就开一轮同步：自动更新开着时，新历史不需要等用户打开插件页面。
  void ensureHistoryTick();
  log('installed');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  void ensureHistoryTick();
});

void processQueue(1);
void ensureHistoryTick();
