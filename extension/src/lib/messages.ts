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
  | { type: 'check-notion'; key: string }
  | { type: 'sync-bilibili' }
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

export async function sendToBackground<T = unknown>(message: RuntimeRequest): Promise<BackgroundResult<T>> {
  try {
    const result = (await chrome.runtime.sendMessage(message)) as BackgroundResult<T> | undefined;
    return result ?? { ok: false, error: '后台没有响应' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
