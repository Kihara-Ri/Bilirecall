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
  const watched =
    item.source === 'history'
      ? {
          ...record.watched,
          firstAt: Math.min(record.watched.firstAt || now, item.watchedAt ?? now),
          lastAt: Math.max(record.watched.lastAt || 0, item.watchedAt ?? 0),
          secondsWatched: Math.max(record.watched.secondsWatched, item.progress ?? 0),
          completed: record.watched.completed || Boolean(item.finished),
        }
      : record.watched;
  return {
    ...record,
    title: keep(record.title, item.title),
    owner: keep(record.owner, item.owner),
    ownerMid: record.ownerMid ?? item.ownerMid,
    cover: keep(record.cover, item.cover),
    duration: record.duration || item.duration || 0,
    aid: record.aid || item.aid || 0,
    cid: record.cid || item.cid || 0,
    actions,
    watched,
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
      changed.push({ ...record, archive: { ...state, droppedFromHistory: true, seenAt: { ...state.seenAt } }, updatedAt: now });
    }
  }
  return changed;
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
