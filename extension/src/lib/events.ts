import type { ActionState, WatchStats } from './types';

export type ActionKind = 'like' | 'unlike' | 'coin' | 'favorite' | 'unfavorite' | 'share';

export interface ActionSignal {
  kind: ActionKind;
  endpoint: string;
  at: number;
  bvid?: string;
  active?: boolean;
  multiply?: number;
}

const ROUTES: Array<{ path: string; match: (url: URL, body: URLSearchParams) => ActionSignal | null }> = [
  {
    path: '/x/web-interface/archive/like',
    match: (_url, body) => {
      const like = body.get('like');
      if (like !== '0' && like !== '1') return null;
      return { kind: like === '1' ? 'like' : 'unlike', endpoint: 'like', at: Date.now(), active: like === '1' };
    },
  },
  {
    path: '/x/web-interface/coin/add',
    match: (_url, body) => {
      const multiply = Number(body.get('multiply') ?? '1');
      if (!Number.isFinite(multiply) || multiply <= 0) return null;
      return { kind: 'coin', endpoint: 'coin', at: Date.now(), multiply, active: true };
    },
  },
  {
    path: '/x/web-interface/share/add',
    match: () => ({ kind: 'share', endpoint: 'share', at: Date.now(), active: true }),
  },
  {
    path: '/x/v3/fav/resource/deal',
    match: (_url, body) => {
      const add = body.get('add_media_ids');
      const del = body.get('del_media_ids');
      const active = Boolean(add && add.length);
      if (!active && !del) return null;
      return { kind: active ? 'favorite' : 'unfavorite', endpoint: 'favorite', at: Date.now(), active };
    },
  },
];

export function classifyAction(rawUrl: string, rawBody?: string): ActionSignal | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'https://api.bilibili.com');
  } catch {
    return null;
  }
  const route = ROUTES.find((r) => url.pathname === r.path);
  if (!route) return null;
  const body = new URLSearchParams(rawBody ?? '');
  const signal = route.match(url, body);
  if (!signal) return null;
  const bvid = body.get('bvid') ?? url.searchParams.get('bvid') ?? undefined;
  if (bvid) signal.bvid = bvid;
  return signal;
}

/** Only successful responses count; a failed like must not mark the video as liked. */
export function actionSucceeded(payload: unknown): boolean {
  return Boolean(payload && typeof payload === 'object' && (payload as { code?: number }).code === 0);
}

export function emptyActions(): ActionState {
  return { like: false, coin: 0, favorite: false, share: false };
}

export function emptyWatch(now = Date.now()): WatchStats {
  return { firstAt: now, lastAt: now, visits: 0, secondsWatched: 0, maxProgressRatio: 0, completed: false };
}

/** Local echo of an observed request. The API read that follows is the source of truth. */
export function applyAction(actions: ActionState, signal: ActionSignal): ActionState {
  const next: ActionState = { ...actions };
  switch (signal.kind) {
    case 'like':
      next.like = true;
      break;
    case 'unlike':
      next.like = false;
      break;
    case 'coin':
      // B站 allows at most 2 coins per video.
      next.coin = Math.min(2, Math.max(next.coin, signal.multiply ?? 1));
      break;
    case 'favorite':
      next.favorite = true;
      break;
    case 'unfavorite':
      next.favorite = false;
      break;
    case 'share':
      next.share = true;
      break;
  }
  return next;
}

/** True once the user acted on the video at least once (this is the capture trigger). */
export function hasAnyAction(actions: ActionState | undefined): boolean {
  if (!actions) return false;
  return actions.like || actions.coin > 0 || actions.favorite || actions.share;
}

export function describeActions(actions: ActionState): string[] {
  const parts: string[] = [];
  if (actions.like) parts.push('点赞');
  if (actions.coin) parts.push(`投币×${actions.coin}`);
  if (actions.favorite) parts.push('收藏');
  if (actions.share) parts.push('分享');
  return parts;
}

export function mergeWatch(current: WatchStats | undefined, update: Partial<WatchStats>): WatchStats {
  const base = current ?? emptyWatch(update.firstAt ?? update.lastAt ?? Date.now());
  return {
    firstAt: Math.min(base.firstAt, update.firstAt ?? base.firstAt),
    lastAt: Math.max(base.lastAt, update.lastAt ?? base.lastAt),
    visits: base.visits + (update.visits ?? 0),
    secondsWatched: Math.max(base.secondsWatched, update.secondsWatched ?? 0),
    maxProgressRatio: Math.max(base.maxProgressRatio, update.maxProgressRatio ?? 0),
    completed: base.completed || Boolean(update.completed),
  };
}
