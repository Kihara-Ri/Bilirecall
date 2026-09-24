import type { BiliListSource, BiliListVideo } from './bili';
import type { VideoRecord } from './types';

/** 出现在本地归档里的来源。`page` 表示是你在 B站 页面上直接操作时被记录的。 */
export type ArchiveOrigin = BiliListSource | 'page';

export interface ArchiveState {
  origins: ArchiveOrigin[];
  /** 每个来源最后一次在 B站 列表里看到它的时间。 */
  seenAt: Partial<Record<BiliListSource, number>>;
  /** 本地归档入库时间。 */
  archivedAt: number;
  /** B站 的历史记录已经不再返回它（B站 会清理历史），本地归档仍然保留。 */
  droppedFromHistory?: boolean;
}

const LIST_SOURCES: BiliListSource[] = ['history', 'likes', 'favorites'];

export function emptyArchive(now = Date.now(), origins: ArchiveOrigin[] = []): ArchiveState {
  return { origins, seenAt: {}, archivedAt: now };
}

export function archiveOf(record: VideoRecord): ArchiveState {
  return record.archive ?? emptyArchive(record.createdAt);
}

function withOrigin(state: ArchiveState, origin: ArchiveOrigin): ArchiveOrigin[] {
  return state.origins.includes(origin) ? state.origins : [...state.origins, origin];
}

/** Keeps the local value unless the incoming one is empty — B站 列表有时缺字段。 */
function keep(current: string | number | undefined, incoming: string | number | undefined): any {
  if (incoming === undefined || incoming === null || incoming === '') return current;
  return incoming;
}

/**
 * 把一条 B站 列表项并进本地记录。**只做加法**：字幕、摘要、你的笔记、流程状态、Notion 回执
 * 一律不动，所以 B站 清掉历史之后，本地这份归档仍然是完整的。
 */
export function applyArchiveItem(record: VideoRecord, item: BiliListVideo, now = Date.now()): VideoRecord {
  const state = archiveOf(record);
  const actions =
    item.source === 'likes'
      ? { ...record.actions, like: true }
      : item.source === 'favorites'
        ? { ...record.actions, favorite: true }
        : record.actions;
  // 占位时间先清掉：没有播放证据的记录（包括旧版本把同步时间 max 进 lastAt 的那些）不能参与
  // min/max 合并，否则 B站 给的观看时间会被一个「同步时间」压住 —— 这正是「时间显示成入库时间」的原因。
  const played = hasPlayback(record.watched);
  const watchedAt = item.watchedAt ?? 0;
  const base = withoutPlaceholderWatch(record);
  const watched =
    item.source === 'history'
      ? {
          ...base,
          firstAt: played ? Math.min(base.firstAt || watchedAt || now, watchedAt || now) : watchedAt,
          lastAt: played ? Math.max(base.lastAt || 0, watchedAt) : watchedAt,
          secondsWatched: Math.max(base.secondsWatched, item.progress ?? 0),
          completed: base.completed || Boolean(item.finished),
        }
      : base;
  return {
    ...record,
    title: keep(record.title, item.title),
    owner: keep(record.owner, item.owner),
    ownerMid: record.ownerMid ?? item.ownerMid,
    cover: keep(record.cover, item.cover),
    duration: record.duration || item.duration || 0,
    aid: record.aid || item.aid || 0,
    cid: record.cid || item.cid || 0,
    page: item.page ?? record.page,
    actions,
    watched,
    history: item.source === 'history' && watchedAt >= (record.history?.watchedAt ?? 0)
      ? { ...record.history, watchedAt, position: Math.max(0, item.progress ?? 0), finished: Boolean(item.finished) }
      : record.history,
    archive: {
      ...state,
      origins: withOrigin(state, item.source),
      seenAt: { ...state.seenAt, [item.source]: now },
      droppedFromHistory: item.source === 'history' ? false : state.droppedFromHistory,
    },
  };
}

/**
 * Splits the incoming list against the local archive: `fresh` needs metadata fetched, `known`
 * already has a record (whose subtitle/analysis/notes must survive the merge).
 */
export function planArchiveSync(
  records: VideoRecord[],
  incoming: BiliListVideo[],
): { fresh: BiliListVideo[]; known: Array<{ record: VideoRecord; item: BiliListVideo }> } {
  const byBvid = new Map(records.map((record) => [record.bvid, record]));
  const fresh: BiliListVideo[] = [];
  const known: Array<{ record: VideoRecord; item: BiliListVideo }> = [];
  const seen = new Set<string>();
  for (const item of incoming) {
    // Only real videos become records; list responses also carry ads and live rooms.
    if (!item.bvid || !item.bvid.startsWith('BV') || seen.has(item.bvid)) continue;
    seen.add(item.bvid);
    const record = byBvid.get(item.bvid);
    if (record) known.push({ record, item });
    else fresh.push(item);
  }
  return { fresh, known };
}

/**
 * B站 只保留最近一段历史，被清掉的视频不该从本地消失：给它们打一个标记，界面照旧可以检索，
 * 也能看出「B站 已经不再返回，但本地留着」。**从不删除记录。**
 *
 * `windowStart` 是本次拉到的最早一条历史的时间：只有比它还旧、这次又没出现的记录才算被清理，
 * 免得因为只拉了前几页就把更老的记录误标成"已清理"。
 */
export function markDroppedFromHistory(
  records: VideoRecord[],
  options: { seen: Set<string>; windowStart: number; now?: number },
): VideoRecord[] {
  const now = options.now ?? Date.now();
  const changed: VideoRecord[] = [];
  for (const record of records) {
    const state = archiveOf(record);
    if (!state.origins.includes('history')) continue;
    if (options.seen.has(record.bvid)) {
      if (state.droppedFromHistory) changed.push({ ...record, archive: { ...state, droppedFromHistory: false } });
      continue;
    }
    const lastSeen = state.seenAt.history ?? 0;
    if (!state.droppedFromHistory && lastSeen && lastSeen < options.windowStart) {
      changed.push({
        ...record,
        watched: withoutPlaceholderWatch(record),
        archive: { ...state, droppedFromHistory: true, seenAt: { ...state.seenAt } },
        updatedAt: now,
      });
    }
  }
  return changed;
}

/**
 * 「这台机器上真的播放过」的证据：`visits` 和 `maxProgressRatio` 只有 content script 的播放上报会写。
 * `secondsWatched` **不能**作为证据 —— 从 B站 历史导入时也会把 `progress` 合进这一项。
 */
export function hasPlayback(watch: VideoRecord['watched']): boolean {
  return Boolean(watch && (watch.visits > 0 || watch.maxProgressRatio > 0));
}

/**
 * 去掉「导入留下的占位时间」。新建记录时 `watched` 是 `emptyWatch(now)`，早期版本还把同步那一刻
 * `max` 进了 `lastAt` —— 那些都不是观看时间。没有播放证据时把两个时间戳清成 0，让界面回退到
 * 「我们第一次在 B站 列表里看到它的时间」，而不是假装你刚看过。
 */
export function withoutPlaceholderWatch(record: VideoRecord): VideoRecord['watched'] {
  if (hasPlayback(record.watched) || record.history?.watchedAt) return record.watched;
  if (!record.watched.firstAt && !record.watched.lastAt) return record.watched;
  return { ...record.watched, firstAt: 0, lastAt: 0 };
}

/** 这个时间是从哪来的，界面要如实写清楚（B站 不返回点赞 / 投币时间）。 */
export type ActivitySource = 'watched' | 'history' | 'likes' | 'favorites' | 'recorded';

/**
 * 用户最近一次跟这条视频发生关系的时间。
 *
 * 列表和界面显示的时间都要用这个，而不是 `updatedAt` —— `updatedAt` 是插件自己碰这条记录的時間
 * （抓字幕、同步、写 Notion 都会刷新它），跟用户什么时候看的没关系。优先级：B站 历史里的观看时间
 * （`view_at`，最准）→ 我们第一次在 B站 列表里看到它的时间 → 本地首次记录时间。
 */
export function activityAt(record: VideoRecord): number {
  const seen = record.archive?.seenAt ?? {};
  return (
    record.watched?.lastAt ||
    record.watched?.firstAt ||
    seen.history ||
    seen.likes ||
    seen.favorites ||
    record.createdAt ||
    record.updatedAt
  );
}

export function activitySource(record: VideoRecord): ActivitySource {
  const seen = record.archive?.seenAt ?? {};
  if (record.watched?.lastAt || record.watched?.firstAt) return 'watched';
  if (seen.history) return 'history';
  if (seen.likes) return 'likes';
  if (seen.favorites) return 'favorites';
  return 'recorded';
}

/** 由近到远的排序键。 */
export function byActivityDesc(a: VideoRecord, b: VideoRecord): number {
  return activityAt(b) - activityAt(a);
}

/** 归档里有多少条来自 B站 历史、其中多少条 B站 已经不再返回。 */
export function archiveSummary(records: VideoRecord[]): { archived: number; dropped: number; byAction: Record<string, number> } {
  let archived = 0;
  let droppedCount = 0;
  const byAction = { liked: 0, coined: 0, faved: 0, shared: 0 };
  for (const record of records) {
    const state = archiveOf(record);
    if (state.origins.some((origin) => LIST_SOURCES.includes(origin as BiliListSource))) archived += 1;
    if (state.droppedFromHistory) droppedCount += 1;
    if (record.actions.like) byAction.liked += 1;
    if (record.actions.coin > 0) byAction.coined += 1;
    if (record.actions.favorite) byAction.faved += 1;
    if (record.actions.share) byAction.shared += 1;
  }
  return { archived, dropped: droppedCount, byAction };
}
