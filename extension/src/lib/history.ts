import type { VideoRecord } from './types';
import { hasPlayback } from './archive';
import { hasAnyAction } from './events';
import { safeTime } from './time';

export type HistoryFilter = 'all' | 'liked' | 'coined' | 'faved';

/** 返回真实观看时间；旧导入占位时间不能用作观看证据，坏时间戳一律当 0。 */
export function historyTime(record: VideoRecord): number {
  return Math.max(safeTime(record.history?.watchedAt), hasPlayback(record.watched) ? safeTime(record.watched.lastAt) : 0);
}

/** false 只用于经过 API 确认的否定状态；页面或列表观察到的正值仍有效。 */
export function interaction(record: VideoRecord, kind: 'like' | 'coin' | 'favorite'): boolean | null {
  if (record.actions[kind]) return true;
  return record.relation?.source === 'api' && !record.relation.error ? false : null;
}

/** 兼容旧知识数据，但新导入显式 saved=false，不因互动补全自动触发处理。 */
export function inLibrary(record: VideoRecord): boolean {
  const notes = record.userNotes;
  return (
    record.library?.saved ??
    Boolean(
      hasAnyAction(record.actions) ||
        record.subtitle ||
        record.analysis ||
        record.steps?.notion?.pageId ||
        notes?.freeform ||
        notes?.highlights?.length ||
        notes?.questions?.length,
    )
  );
}

/** 按本地日历日分组，避免夏令时用固定24小时减法跨错日期。 */
export function historyGroups(
  records: VideoRecord[],
  filter: HistoryFilter,
  query = '',
  now = Date.now(),
): Array<{ label: string; records: VideoRecord[] }> {
  const day = (value: number) => {
    const time = safeTime(value);
    return time ? new Date(time).toLocaleDateString('zh-CN') : '无观看时间';
  };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, VideoRecord[]>();
  const needle = query.trim().toLowerCase();
  for (const record of [...records].sort((a, b) => historyTime(b) - historyTime(a))) {
    if (record.history?.hidden) continue;
    if (needle && !`${record.title}\n${record.owner}`.toLowerCase().includes(needle)) continue;
    const time = historyTime(record);
    if (filter === 'all' && !time && !record.archive?.origins?.includes('history')) continue;
    if (
      filter !== 'all' &&
      interaction(record, filter === 'liked' ? 'like' : filter === 'coined' ? 'coin' : 'favorite') !== true
    )
      continue;
    const date = day(time);
    const label = !time ? '无观看时间' : date === day(now) ? '今天' : date === day(yesterday.getTime()) ? '昨天' : date;
    groups.set(label, [...(groups.get(label) ?? []), record]);
  }
  return [...groups].map(([label, records]) => ({ label, records }));
}

/** 只使用确切位置恢复播放；累计观看时长不能作为当前位置。 */
export function playbackUrl(record: VideoRecord): string {
  const url = new URL(`https://www.bilibili.com/video/${encodeURIComponent(record.bvid)}/`);
  if (record.page > 1) url.searchParams.set('p', String(record.page));
  if (record.history?.position && !record.history.finished)
    url.searchParams.set('t', String(Math.floor(record.history.position)));
  return url.href;
}

/** 紧凑时长格式。 */
export function durationLabel(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
