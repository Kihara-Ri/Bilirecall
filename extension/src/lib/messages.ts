import type { DeepPartial, Settings, UserNotes, VideoRecord } from './types';
import type { ActionSignal } from './events';

export interface PageTrack {
  id: string;
  language: string;
  label: string;
  url: string;
  endpoint: string;
  source: 'page' | 'player-wbi' | 'proto';
  isAI: boolean;
}

export interface PageIdentity {
  bvid: string;
  aid: number;
  cid: number;
  page?: number;
}

export interface PageSnapshotPayload {
  identity: PageIdentity;
  tracks: PageTrack[];
  needLoginSubtitle: boolean;
  endpoint: string;
  title?: string;
  url: string;
  at: number;
}

export interface WatchPayload {
  identity: PageIdentity;
  url: string;
  secondsWatched: number;
  /** 当前播放位置，与累计/最大观看位置分开，允许回看时回退。 */
  position?: number;
  progressRatio: number;
  completed: boolean;
  at: number;
  /** 1 on the first heartbeat of a page load, otherwise omitted. */
  visits?: number;
}

export interface PageVideoPayload {
  identity: PageIdentity;
  title: string;
  owner: string;
  ownerMid?: number;
  cover?: string;
  category?: string;
  duration?: number;
  pubdate?: number;
  description?: string;
  url: string;
  at: number;
}

export type ContentMessage =
  | { type: 'page-snapshot'; payload: PageSnapshotPayload }
  | { type: 'page-video'; payload: PageVideoPayload }
  | { type: 'action'; payload: ActionSignal }
  | { type: 'watch'; payload: WatchPayload };

export type RuntimeRequest =
  | { type: 'get-current'; tabId?: number }
  | { type: 'get-record'; key: string }
  | { type: 'list-records'; query?: string }
  | { type: 'save-notes'; key: string; notes: UserNotes }
  | { type: 'sync-now'; key: string; step?: PipelineStep }
  | { type: 'refresh-actions'; key: string; force?: boolean }
  | { type: 'test-relation' }
  | { type: 'sync-all' }
  | { type: 'get-settings' }
  | { type: 'save-settings'; patch: DeepPartial<Settings> }
  | { type: 'test-notion' }
  | { type: 'test-webhook' }
  | { type: 'check-notion'; key: string }
  | { type: 'sync-bilibili'; force?: boolean }
  | { type: 'history-status' }
  /** 状态 + 归档版本号一次问完：轮询只搬这一小段，不再每 2 秒重读整份归档。 */
  | { type: 'history-poll' }
  | { type: 'collect-record'; key: string }
  | { type: 'hide-history'; key: string }
  | { type: 'test-ai' }
  | { type: 'probe-login' }
  | { type: 'delete-record'; key: string }
  | { type: 'export-bundle' }
  | { type: 'request-origin'; origin: string }
  | { type: 'open-options' }
  | { type: 'stats' };

export type PipelineStep = 'subtitle' | 'analysis' | 'notion';

export interface PipelineStepResult {
  step: PipelineStep;
  state: 'ok' | 'error' | 'skipped' | 'running';
  error?: string;
  reason?: string;
}

export interface PipelineResult {
  ok: boolean;
  steps: PipelineStepResult[];
}

export interface CurrentVideoState {
  identity: PageIdentity | null;
  record: VideoRecord | null;
  loginState?: { isLogin: boolean; checkedAt: number };
  error?: string;
}

export interface StatsResult {
  total: number;
  /** Videos whose stored B站 state says they were liked / coined / favourited / shared. */
  liked: number;
  coined: number;
  faved: number;
  shared: number;
  /** 本地归档里来自 B站 列表的记录数，以及其中 B站 已不再返回（本地保留）的条数。 */
  archived: number;
  dropped: number;
  withSubtitle: number;
  withAnalysis: number;
  synced: number;
  pending: number;
  needsReview: number;
  topTags: Array<{ tag: string; count: number }>;
}

export interface BackgroundResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * UI 等待后台的预算。单次外部请求（B站 / 字幕 CDN / AI / Notion / Webhook）都必须能在它之前失败，
 * 否则界面会先报「后台响应超时」，而请求其实还在跑 —— 用户重试就会重复触发一次。
 */
export const SYNC_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 15_000;

export async function sendToBackground<T = unknown>(message: RuntimeRequest): Promise<BackgroundResult<T>> {
  try {
    // 长任务只返回排队回执；通道超时后给 UI 可重试结果，避免 SW 休眠导致永久等待。
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: BackgroundResult<T> | undefined;
    try {
      result = await Promise.race([
        chrome.runtime.sendMessage(message) as Promise<BackgroundResult<T> | undefined>,
        new Promise<BackgroundResult<T>>(resolve => { timer = setTimeout(() => resolve({ ok: false, error: '后台响应超时，请重试' }), message.type === 'sync-now' ? SYNC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    return result ?? { ok: false, error: '后台没有响应' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
