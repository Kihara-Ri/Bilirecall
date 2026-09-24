import { classifyAction, type ActionSignal, type ActionKind } from './events';
import type { PageIdentity, PageSnapshotPayload, PageTrack, PageVideoPayload, WatchPayload } from './messages';

/**
 * 页面桥接的输入校验。
 *
 * MAIN world 的 hook 用 `window.postMessage` 把观察到的数据交给 ISOLATED world，而
 * `window.postMessage` **不区分发送者**：任何跑在 bilibili.com 上的脚本（第三方 SDK、
 * 被注入的广告脚本、一次站点 XSS）都能原样伪造 `{source:'bilivault-main'}` 的消息。
 * 所以两侧都必须当作不可信输入处理：
 *   - 身份必须是合法的 BV 号 + 正整数 aid/cid，否则直接丢弃（不建记录、不发请求）；
 *   - 文本与列表按上限截断，伪造的巨型 payload 不能把 chrome.storage 灌满；
 *   - 只接受已知的动作端点，其它 URL 一律忽略。
 */

/** 文本上限：标题/UP主/分区/语言这类短字段。 */
export const MAX_TEXT = 300;
/** 简介可以长一些，但仍然是截断而不是照收。 */
export const MAX_DESCRIPTION = 5000;
export const MAX_URL = 2048;
/** 一个视频最多带多少条字幕轨；B站 实际不超过十几条。 */
export const MAX_TRACKS = 32;
/** 单次上报的最大观看秒数（B站 最长的视频也远小于 48 小时）。 */
export const MAX_SECONDS = 172_800;

const BVID = /^BV[0-9A-Za-z]{10}$/;
const TRACK_SOURCES = ['page', 'player-wbi', 'proto'] as const;
const ACTION_KINDS: ActionKind[] = ['like', 'unlike', 'coin', 'favorite', 'unfavorite', 'share'];

/** 正整数（上限内）才认；'12' 这类字符串不认，避免把 `''` / `null` / `false` 当成 0。 */
export function positiveInt(value: unknown, max = 2_147_483_647): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 非负数字（上限内）才认，其余当“不知道”。 */
function optionalNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

/** 夹取到 [0, max]：伪造的巨值既不落库成天文数字，也不该把真实进度清成 0。 */
function clampNumber(value: unknown, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(max, Math.max(0, number));
}

/**
 * 视频身份。PGC（番剧 / 课程）页面的播放器响应可能没有 bvid —— 这种记录会得到一个
 * `:cid` 的 key，既匹配不上 B站 列表，也没法写进 Notion（视频ID 是空的），
 * 所以宁可这一条不要，也不落垃圾数据。
 */
export function validIdentity(raw: unknown): PageIdentity | null {
  const value = raw as Partial<PageIdentity> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  const bvid = typeof value.bvid === 'string' ? value.bvid.trim() : '';
  if (!BVID.test(bvid)) return null;
  const aid = positiveInt(value.aid);
  const cid = positiveInt(value.cid);
  if (aid === null || cid === null) return null;
  const page = value.page === undefined ? 1 : positiveInt(value.page, 100_000);
  return { bvid, aid, cid, page: page ?? 1 };
}

/** 字幕轨元数据：数量与字段都截断，URL 交给 chooseTrack 做主机白名单校验。 */
export function sanitizeTracks(raw: unknown): PageTrack[] {
  if (!Array.isArray(raw)) return [];
  const tracks: PageTrack[] = [];
  for (const item of raw.slice(0, MAX_TRACKS)) {
    const value = item as Partial<PageTrack> | null;
    if (!value || typeof value !== 'object') continue;
    const id = text(value.id, MAX_TEXT);
    const language = text(value.language, MAX_TEXT);
    const url = text(value.url, MAX_URL);
    if (!id || !language || !url) continue;
    const source = TRACK_SOURCES.includes(value.source as (typeof TRACK_SOURCES)[number]) ? value.source! : 'page';
    tracks.push({
      id,
      language,
      label: text(value.label, MAX_TEXT) || language,
      url,
      endpoint: text(value.endpoint, MAX_TEXT),
      source,
      isAI: Boolean(value.isAI),
    });
  }
  return tracks;
}

export function sanitizeSnapshot(raw: unknown): PageSnapshotPayload | null {
  const value = raw as Partial<PageSnapshotPayload> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  const identity = validIdentity(value.identity);
  if (!identity) return null;
  return {
    identity,
    tracks: sanitizeTracks(value.tracks),
    needLoginSubtitle: Boolean(value.needLoginSubtitle),
    endpoint: text(value.endpoint, MAX_TEXT) || 'page',
    url: text(value.url, MAX_URL),
    at: optionalNumber(value.at, Number.MAX_SAFE_INTEGER) ?? Date.now(),
  };
}

export function sanitizeVideo(raw: unknown): PageVideoPayload | null {
  const value = raw as Partial<PageVideoPayload> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  const identity = validIdentity(value.identity);
  if (!identity) return null;
  const title = text(value.title, MAX_TEXT);
  const owner = text(value.owner, MAX_TEXT);
  if (!title && !owner) return null;
  return {
    identity,
    title,
    owner,
    ownerMid: optionalNumber(value.ownerMid, 2_147_483_647),
    cover: text(value.cover, MAX_URL),
    category: text(value.category, MAX_TEXT),
    duration: optionalNumber(value.duration, MAX_SECONDS),
    pubdate: optionalNumber(value.pubdate, 4_102_444_800),
    description: text(value.description, MAX_DESCRIPTION),
    url: text(value.url, MAX_URL),
    at: optionalNumber(value.at, Number.MAX_SAFE_INTEGER) ?? Date.now(),
  };
}

/** 播放进度：比例与秒数都夹到合理范围，坏值当 0，不写进归档。 */
export function sanitizeWatch(raw: unknown): WatchPayload | null {
  const value = raw as Partial<WatchPayload> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  const identity = validIdentity(value.identity);
  if (!identity) return null;
  const secondsWatched = clampNumber(value.secondsWatched, MAX_SECONDS);
  const progressRatio = clampNumber(value.progressRatio, 1);
  const position = optionalNumber(value.position, MAX_SECONDS);
  return {
    identity,
    url: text(value.url, MAX_URL),
    secondsWatched,
    ...(position === undefined ? {} : { position }),
    progressRatio,
    completed: Boolean(value.completed),
    at: optionalNumber(value.at, Number.MAX_SAFE_INTEGER) ?? Date.now(),
    // 访问次数只可能是 0 / 1：伪造的 visits 不该把观看次数刷爆。
    visits: value.visits ? 1 : 0,
  };
}

/**
 * 页面里观察到的写操作。只认四个已知端点的成功请求；URL 与 body 都按上限截断。
 * 这里是唯一实现（以前 content 里复制了一份，容易和后端解析漂移）。
 */
export function actionFromBridge(raw: unknown): ActionSignal | null {
  const value = raw as { url?: unknown; body?: unknown } | null | undefined;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.url !== 'string' || typeof value.body !== 'string') return null;
  if (value.url.length > MAX_URL || value.body.length > 4096) return null;
  const signal = classifyAction(value.url, value.body);
  if (!signal) return null;
  // bvid 要么是合法 BV 号，要么就没有：伪造的短串不能让后台去匹配别的记录。
  if (signal.bvid !== undefined && !BVID.test(signal.bvid)) delete signal.bvid;
  return signal;
}

/** 后台侧的二次校验：content script 送来的动作信号也要能对上已知端点与字段。 */
export function sanitizeActionSignal(raw: unknown): ActionSignal | null {
  const value = raw as Partial<ActionSignal> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  if (!ACTION_KINDS.includes(value.kind as ActionKind)) return null;
  const at = optionalNumber(value.at, Number.MAX_SAFE_INTEGER) ?? Date.now();
  const bvid = typeof value.bvid === 'string' && BVID.test(value.bvid) ? value.bvid : undefined;
  const signal: ActionSignal = {
    kind: value.kind as ActionKind,
    endpoint: text(value.endpoint, MAX_TEXT),
    at,
    active: Boolean(value.active),
  };
  if (bvid) signal.bvid = bvid;
  if (typeof value.multiply === 'number' && Number.isFinite(value.multiply)) {
    signal.multiply = Math.min(2, Math.max(1, Math.trunc(value.multiply)));
  }
  return signal;
}
