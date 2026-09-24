import { ApiError, BiliVaultError, HttpFailure, IdentityMismatch, LoginRequired, NoSubtitles, UnstableSubtitle } from './errors';
import { keyFromUrl, signWbi, wbiKeysFromNav } from './wbi';
import {
  chooseTrack,
  clampSegments,
  digestSegments,
  extractPlayerTracks,
  isUsableSubtitleUrl,
  normalizeSubtitleUrl,
  parseProtoTracks,
  segmentsToText,
  validateSegments,
  type Track,
} from './subtitle';
import type { SubtitleResult, SubtitleTrackMeta } from './types';

export const API = 'https://api.bilibili.com';
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

import { REQUEST_TIMEOUT_MS, browserFetch, type FetchLike } from './http';

export { REQUEST_TIMEOUT_MS };
export type { FetchLike };

export interface BiliIdentity {
  bvid: string;
  aid: number;
  cid: number;
  page?: number;
}

export interface VideoInfo extends BiliIdentity {
  page: number;
  title: string;
  part: string;
  owner: string;
  ownerMid?: number;
  cover: string;
  category: string;
  duration: number;
  pubdate: number;
  description: string;
  url: string;
  tags: string[];
}

export interface PlayerSnapshot {
  identity: BiliIdentity;
  tracks: Track[];
  needLoginSubtitle: boolean;
  endpoint: string;
}

export interface ResolveOptions {
  preferredLanguage?: string;
  trackId?: string;
  /** Authoritative tracks captured from the page's own player response. */
  pageTracks?: Track[];
  consensusReads?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ClientOptions {
  ua?: string;
  /** Only for tests / non-browser runtimes; the extension relies on credentialed fetch. */
  cookie?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BiliClient {
  private wbi?: { imgKey: string; subKey: string; at: number };

  constructor(
    private readonly http: FetchLike = browserFetch,
    private readonly options: ClientOptions = {},
  ) {}

  headers(referer = 'https://www.bilibili.com/'): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.options.ua ?? DEFAULT_UA,
      Referer: referer,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'no-cache',
    };
    if (this.options.cookie) headers.Cookie = this.options.cookie;
    return headers;
  }

  private async raw(path: string, params: Record<string, string | number>, referer?: string): Promise<Response> {
    const url = API + path + '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.http(url, {
          headers: this.headers(referer),
          credentials: 'include',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt >= 2) throw new BiliVaultError(`${path}: 网络连接失败`) as BiliVaultError;
        attempt += 1;
        await defaultSleep(attempt * 400);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 2) throw new HttpFailure(path, response.status);
        attempt += 1;
        await defaultSleep(attempt * 600);
        continue;
      }
      if (response.status !== 200) throw new HttpFailure(path, response.status);
      return response;
    }
  }

  private async json<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string | number> = {},
    referer?: string,
  ): Promise<T> {
    const response = await this.raw(path, params, referer);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BiliVaultError(`${path}: 返回的不是 JSON（可能触发风控）`);
    }
    return this.check<T>(path, payload);
  }

  private check<T>(path: string, payload: unknown): T {
    const record = payload as { code?: number; message?: string; data?: unknown } | null;
    if (!record || typeof record !== 'object') throw new BiliVaultError(`${path}: 数据格式不正确`);
    if (record.code === -101) throw new LoginRequired('B站要求有效登录态（API -101）');
    if (record.code !== 0) throw new ApiError(path, record.code ?? 'invalid', `${path}: API 错误 ${record.code ?? 'invalid'}${record.message ? ' ' + record.message : ''}`);
    if (record.data === undefined || record.data === null) throw new BiliVaultError(`${path}: 缺少 data`);
    return record.data as T;
  }

  /**
   * `/x/web-interface/nav` returns code -101 ("账号未登录") *together with* the WBI keys
   * when the user is anonymous. Treating -101 as fatal here would make WBI signing
   * impossible before login, so this endpoint is parsed without the generic code check.
   */
  async nav(): Promise<{ isLogin: boolean; mid: number; imgUrl: string; subUrl: string }> {
    const response = await this.raw('/x/web-interface/nav', {});
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new BiliVaultError('/x/web-interface/nav: 返回的不是 JSON（可能触发风控）');
    }
    const data = payload?.data;
    if (!data || typeof data !== 'object') {
      if (payload?.code === -101) return { isLogin: false, mid: 0, imgUrl: '', subUrl: '' };
      throw new ApiError('/x/web-interface/nav', payload?.code ?? 'invalid', payload?.message);
    }
    return {
      isLogin: Boolean(data.isLogin),
      mid: Number(data.mid ?? 0),
      imgUrl: data.wbi_img?.img_url ?? '',
      subUrl: data.wbi_img?.sub_url ?? '',
    };
  }

  private async wbiKeys(): Promise<{ imgKey: string; subKey: string }> {
    if (this.wbi && Date.now() - this.wbi.at < 10 * 60 * 1000) return this.wbi;
    const nav = await this.nav();
    const keys = wbiKeysFromNav({ wbi_img: { img_url: nav.imgUrl, sub_url: nav.subUrl } });
    this.wbi = { ...keys, at: Date.now() };
    return keys;
  }

  /**
   * B站 页面实际调用的是 WBI 签名的 `/x/web-interface/wbi/view`；不带签名可能被风控
   * 返回错误页，导致标题/UP主 拿不到（表现为“未知UP主”）。
   */
  private async viewData(bvid: string): Promise<Record<string, any>> {
    try {
      const keys = await this.wbiKeys();
      const signed = signWbi({ bvid, web_location: '1315873' }, keys.imgKey, keys.subKey);
      const response = await this.raw('/x/web-interface/wbi/view', signed);
      const payload = await response.json().catch(() => null);
      if (payload?.code === 0 && payload.data) return payload.data as Record<string, any>;
    } catch {
      /* fall through to the unsigned endpoint */
    }
    return this.json<Record<string, any>>('/x/web-interface/view', { bvid });
  }

  async view(bvid: string): Promise<VideoInfo> {
    const data = await this.viewData(bvid);
    if (data.bvid !== bvid) throw new IdentityMismatch('视频信息返回了不同的 BV 号');
    const pages: any[] = Array.isArray(data.pages) ? data.pages : [];
    const first = pages[0] ?? { cid: data.cid, part: '', duration: data.duration };
    if (!first?.cid || !data.aid) throw new BiliVaultError('视频信息缺少 aid/cid');
    return {
      bvid,
      aid: Number(data.aid),
      cid: Number(first.cid),
      page: 1,
      title: String(data.title ?? bvid),
      part: String(first.part ?? ''),
      owner: String(data.owner?.name ?? ''),
      ownerMid: data.owner?.mid,
      cover: String(data.pic ?? ''),
      category: String(data.tname ?? ''),
      duration: Number(first.duration ?? data.duration ?? 0),
      pubdate: Number(data.pubdate ?? 0),
      description: String(data.desc ?? ''),
      url: `https://www.bilibili.com/video/${bvid}/`,
      tags: [],
    };
  }

  /**
   * The account's own B站 lists. 观看历史 和 收藏 有官方接口；**投币没有列表接口**，所以币的状态
   * 不在这里，而是按视频读 `/x/web-interface/archive/relation`（见 background 的同步逻辑）。
   */
  /**
   * 观看历史，按游标翻页。B站 只留最近一段，所以第一次同步多取几页、之后每次取一页即可；
   * 本地归档才是长期保存的地方。
   */
  /** 游标必须原样沿用服务端返回值，max 是条目 ID，不能用观看时间代替。 */
  async historyPage(cursor: HistoryCursor = { max: 0, view_at: 0, business: '' }): Promise<ListPage> {
    const data = await this.json<{ list?: unknown[]; cursor?: HistoryCursor }>('/x/web-interface/history/cursor', { ps: 30, ...cursor });
    if (!Array.isArray(data.list)) throw new BiliVaultError('历史接口缺少 list，未推进同步游标');
    const next = data.cursor;
    if (data.list.length >= 30 && !next) throw new BiliVaultError('历史接口缺少分页游标，请稍后重试');
    const hasNext = Boolean(data.list?.length && next && (next.max !== cursor.max || next.view_at !== cursor.view_at));
    return { items: historyVideos(data), cursor: hasNext ? next : undefined, more: hasNext };
  }

  /** 点赞按页读取，不能只取首页后宣称全部同步完成。 */
  async likedPage(mid: number, page: number): Promise<ListPage> {
    const data = await this.json<{ list?: unknown[]; total?: number }>('/x/space/like/video', { vmid: mid, ps: 20, pn: page }, 'https://space.bilibili.com/');
    return { items: likedVideos(data), more: (data.list?.length ?? 0) === 20 && (data.total === undefined || page * 20 < data.total) };
  }

  async favoriteFolders(mid: number): Promise<number[]> {
    const data = await this.json<{ list?: Array<{ id: number }> }>('/x/v3/fav/folder/created/list-all', { up_mid: mid });
    return (data.list ?? []).map(folder => folder.id).filter(id => id > 0);
  }

  async favoritePage(folder: number, page: number): Promise<ListPage> {
    const data = await this.json<{ medias?: unknown[]; has_more?: boolean }>('/x/v3/fav/resource/list', { media_id: folder, pn: page, ps: 20, order: 'mtime', type: 0, platform: 'web' });
    return { items: favoriteVideos(data), more: data.has_more ?? (data.medias?.length === 20) };
  }

  async history(pages = 3): Promise<BiliListVideo[]> {
    const out: BiliListVideo[] = [];
    let cursor: HistoryCursor | undefined;
    for (let page = 0; page < Math.max(1, pages); page += 1) {
      const result = await this.historyPage(cursor);
      out.push(...result.items);
      if (!result.more || !result.cursor) break;
      cursor = result.cursor;
    }
    return out;
  }

  async liked(mid: number): Promise<BiliListVideo[]> {
    if (!mid) throw new BiliVaultError('缺少账号 mid，无法读取点赞列表');
    return likedVideos(await this.json('/x/space/like/video', { vmid: mid, ps: 20, pn: 1 }, 'https://space.bilibili.com/'));
  }

  async favorites(mid: number, folders = 5): Promise<BiliListVideo[]> {
    if (!mid) throw new BiliVaultError('缺少账号 mid，无法读取收藏夹');
    const listing = await this.json<{ list?: Array<{ id?: number }> }>(
      '/x/v3/fav/folder/created/list-all',
      { up_mid: mid },
      'https://space.bilibili.com/',
    );
    const ids = (listing?.list ?? []).map((folder) => folder?.id).filter(Boolean).slice(0, folders);
    const out: BiliListVideo[] = [];
    for (const mediaId of ids) {
      const page = await this.json('/x/v3/fav/resource/list', { media_id: mediaId as number, pn: 1, ps: 20, order: 'mtime', type: 0, platform: 'web' });
      out.push(...favoriteVideos(page));
    }
    return out;
  }

  /** WBI-signed player metadata. Falls back to a fresh key when the signature is stale. */
  async player(identity: BiliIdentity, options: ClientOptions = {}): Promise<PlayerSnapshot> {
    const path = '/x/player/wbi/v2';
    const base: Record<string, string | number> = {
      bvid: identity.bvid,
      aid: identity.aid,
      cid: identity.cid,
      isGaiaAvoided: 'false',
      web_location: '1315873',
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = await this.wbiKeys();
      const signed = signWbi(base, keys.imgKey, keys.subKey);
      const response = await this.raw(path, signed);
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        throw new BiliVaultError(`${path}: 返回的不是 JSON`);
      }
      if (payload?.code === 0 && payload.data) {
        return this.buildSnapshot(payload.data, identity, path);
      }
      lastError = new ApiError(path, payload?.code ?? 'invalid', payload?.message);
      if (![-352, -403, -400].includes(payload?.code)) throw lastError;
      this.wbi = undefined;
    }
    throw lastError instanceof Error ? lastError : new BiliVaultError(`${path}: 请求失败`);
  }

  private buildSnapshot(data: Record<string, any>, identity: BiliIdentity, endpoint: string): PlayerSnapshot {
    for (const key of ['aid', 'cid', 'bvid'] as const) {
      if (data[key] !== undefined && String(data[key]) !== String(identity[key])) {
        throw new IdentityMismatch(`播放器返回的 ${key} 与请求不一致（防止拿到其他视频的字幕）`);
      }
    }
    const needLoginSubtitle = Boolean(data.need_login_subtitle);
    const tracks = extractPlayerTracks(data, endpoint, 'player-wbi');
    return {
      identity: { bvid: identity.bvid, aid: identity.aid, cid: identity.cid, page: identity.page },
      tracks,
      needLoginSubtitle,
      endpoint,
    };
  }

  /** New binary metadata endpoint, used only when the JSON player response has no tracks. */
  async subtitleProto(identity: BiliIdentity, durationSeconds?: number): Promise<Track[]> {
    const path = '/x/v2/subtitle/web/view';
    const params: Record<string, string | number> = {
      oid: identity.cid,
      pid: identity.aid,
      type: 1,
      context_ext: '{"video_type":1}',
      cur_production_type: 0,
      preferred_language: 'ai-zh',
      playlist_switch: 0,
    };
    if (durationSeconds) params.duration = Math.round(durationSeconds * 1000);
    const response = await this.raw(path, params);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer[0] === 0x7b) {
      let payload: any = null;
      try {
        payload = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        throw new BiliVaultError('新版字幕接口返回无效 JSON');
      }
      throw new ApiError(path, payload?.code ?? 'unexpected-json', payload?.message);
    }
    return parseProtoTracks(buffer, path);
  }

  async fetchSubtitleBody(url: string): Promise<unknown> {
    const response = await this.http(normalizeSubtitleUrl(url), {
      headers: { 'User-Agent': this.options.ua ?? DEFAULT_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new HttpFailure('subtitle-cdn', response.status);
    try {
      return await response.json();
    } catch {
      throw new BiliVaultError('字幕下载响应不是有效 JSON');
    }
  }

  private async collectTracks(info: VideoInfo, pageTracks?: Track[]): Promise<{ tracks: Track[]; needLoginSubtitle: boolean; endpoint: string }> {
    if (pageTracks?.length) {
      return { tracks: pageTracks, needLoginSubtitle: false, endpoint: 'page' };
    }
    let snapshot: PlayerSnapshot | null = null;
    try {
      snapshot = await this.player(info);
    } catch (error) {
      if (!(error instanceof LoginRequired)) throw error;
    }
    if (snapshot?.tracks.length) {
      return { tracks: snapshot.tracks, needLoginSubtitle: snapshot.needLoginSubtitle, endpoint: snapshot.endpoint };
    }
    if (snapshot?.needLoginSubtitle) {
      throw new LoginRequired('B站要求登录后才能读取该视频的字幕（need_login_subtitle）');
    }
    const protoTracks = await this.subtitleProto(info, info.duration);
    if (protoTracks.length) return { tracks: protoTracks, needLoginSubtitle: false, endpoint: '/x/v2/subtitle/web/view' };
    const nav = await this.nav();
    if (!nav.isLogin) throw new LoginRequired('未取得字幕；当前不是有效登录态，不能据此判断视频没有字幕');
    throw new NoSubtitles('登录有效，但播放器与新版接口均未返回字幕');
  }

  private async refreshTracks(info: VideoInfo, pageTracks?: Track[]): Promise<Track[]> {
    try {
      const snapshot = await this.player(info);
      if (snapshot.tracks.length) return snapshot.tracks;
    } catch {
      /* fall through to the original list */
    }
    return pageTracks ?? [];
  }

  /**
   * Resolve a subtitle with the fix for "same bvid/cid but different result":
   *  1. never index tracks[0] — select deterministically by language + id;
   *  2. verify the response identity matches the requested video;
   *  3. require N independent reads to agree before trusting the body;
   *  4. re-resolve a fresh signed URL between attempts (CDN nodes can serve stale bodies).
   */
  async resolveSubtitle(info: VideoInfo, options: ResolveOptions = {}): Promise<SubtitleResult> {
    const consensusReads = Math.max(2, options.consensusReads ?? 2);
    const maxAttempts = Math.max(consensusReads, options.maxAttempts ?? 4);
    const sleep = options.sleep ?? defaultSleep;
    const first = await this.collectTracks(info, options.pageTracks);
    let chosen = chooseTrack(first.tracks, { language: options.preferredLanguage, trackId: options.trackId });
    const observations = new Map<string, { count: number; segments: Awaited<ReturnType<typeof validateSegments>> }>();
    const history: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let payload: unknown;
      try {
        payload = await this.fetchSubtitleBody(chosen.url);
      } catch (error) {
        const expired = error instanceof HttpFailure && (error.status === 401 || error.status === 403);
        if (!expired) throw error;
        // Signed URL expired: refresh the SAME track from the API (the page-captured URL is the
        // one that just expired, so ask the API for a fresh signature), never switch language.
        const refreshed = await this.refreshTracks(info, options.pageTracks);
        const next = chooseTrack(refreshed, { language: chosen.language, trackId: chosen.id });
        if (next.url === chosen.url) throw new BiliVaultError('字幕地址已失效且无法刷新，请稍后重试');
        chosen = next;
        continue;
      }
      let segments;
      try {
        segments = validateSegments(payload);
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await sleep(300 * attempt);
        continue;
      }
      const { segments: clamped, warnings } = clampSegments(segments, info.duration);
      const digest = await digestSegments(clamped);
      history.push(digest.slice(0, 12));
      const record = observations.get(digest);
      if (record) {
        record.count += 1;
      } else {
        observations.set(digest, { count: 1, segments: clamped });
        continue;
      }
      if ((record?.count ?? 0) >= consensusReads) {
        return {
          track: trackMeta(chosen),
          availableTracks: first.tracks.map(trackMeta),
          segments: clamped,
          plainText: segmentsToText(clamped),
          digest,
          fetchedAt: Date.now(),
          observations: record?.count ?? 1,
          warnings,
        };
      }
      if (attempt < maxAttempts) await sleep(400 * attempt);
    }

    throw new UnstableSubtitle(
      `连续 ${maxAttempts} 次读取未取得一致的字幕正文（摘要：${history.join(', ')}）。可能是 B站返回了其他视频的内容或 CDN 缓存错乱；本次不写入 Notion，稍后重试。`,
    );
  }
}

export function trackMeta(track: Track): SubtitleTrackMeta {
  return { id: track.id, language: track.language, label: track.label, source: track.source };
}

/** Where a video was discovered when syncing the account's own B站 lists. */
export type BiliListSource = 'history' | 'likes' | 'favorites';

export interface HistoryCursor { max: number; view_at: number; business: string }
export interface ListPage { items: BiliListVideo[]; more: boolean; cursor?: HistoryCursor }

export interface BiliListVideo {
  page?: number;
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  owner: string;
  ownerMid?: number;
  cover: string;
  duration: number;
  source: BiliListSource;
  /** History only: playback progress in seconds and whether it was finished. */
  progress?: number;
  finished?: boolean;
  watchedAt?: number;
}

/** 观看时间：B站 给的是秒级时间戳，但字段位置 / 单位在不同接口里并不统一，两种都认。 */
function toEpochMs(value: unknown): number | undefined {
  const time = Number(value ?? 0);
  if (!time) return undefined;
  return time > 1e11 ? time : time * 1000;
}

function listVideo(raw: any, source: BiliListSource): BiliListVideo | null {
  const history = raw?.history ?? {};
  const bvid = String(history.bvid ?? raw?.bvid ?? '');
  if (!bvid || !bvid.startsWith('BV')) return null;
  const owner = raw?.owner ?? raw?.upper ?? {};
  const duration = Number(raw?.duration ?? 0);
  const progress = Number(raw?.progress ?? 0);
  return {
    bvid,
    aid: Number(history.oid ?? raw?.aid ?? raw?.id ?? 0),
    cid: Number(history.cid ?? raw?.cid ?? 0),
    page: source === 'history' ? Math.max(1, Number(history.page ?? raw?.page ?? 1) || 1) : undefined,
    title: String(raw?.title ?? raw?.show_title ?? ''),
    owner: String(owner?.name ?? raw?.author_name ?? ''),
    ownerMid: Number(owner?.mid ?? raw?.author_mid ?? 0) || undefined,
    cover: String(raw?.cover ?? raw?.pic ?? ''),
    duration,
    source,
    progress: source === 'history' ? progress : undefined,
    finished: source === 'history' ? progress === -1 || Number(raw?.is_finish ?? 0) === 1 : undefined,
    watchedAt: source === 'history' ? toEpochMs(raw?.view_at ?? raw?.history?.view_at ?? raw?.view_at_ms) : undefined,
  };
}

/** `/x/web-interface/history/cursor`: the account's watch history (login required). */
export function historyVideos(payload: unknown): BiliListVideo[] {
  const list = (payload as any)?.data?.list ?? (payload as any)?.list;
  return Array.isArray(list) ? list.map((raw) => listVideo(raw, 'history')).filter(Boolean) as BiliListVideo[] : [];
}

/** `/x/space/like/video`: videos this account has liked. */
export function likedVideos(payload: unknown): BiliListVideo[] {
  const list = (payload as any)?.data?.list ?? (payload as any)?.list;
  return Array.isArray(list) ? list.map((raw) => listVideo(raw, 'likes')).filter(Boolean) as BiliListVideo[] : [];
}

/** `/x/v3/fav/resource/list`: one page of a favourites folder. */
export function favoriteVideos(payload: unknown): BiliListVideo[] {
  const medias = (payload as any)?.data?.medias ?? (payload as any)?.data?.list ?? (payload as any)?.medias;
  return Array.isArray(medias) ? medias.map((raw) => listVideo(raw, 'favorites')).filter(Boolean) as BiliListVideo[] : [];
}

/** Little helpers on the client, kept next to the parser so both stay in sync. */
export interface BiliListClient {
  history(): Promise<BiliListVideo[]>;
  liked(mid: number): Promise<BiliListVideo[]>;
  favorites(mid: number): Promise<BiliListVideo[]>;
}
