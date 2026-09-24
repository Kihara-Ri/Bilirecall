import { archiveSummary } from './archive';
import type { StatsResult } from './messages';
import type { VideoRecord } from './types';

/** 统计口径集中在这里：界面上的徽标、知识库计数都用它，避免两处算法走偏。 */
export function computeStats(records: VideoRecord[]): StatsResult {
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
    withSubtitle: records.filter((record) => record.subtitle).length,
    withAnalysis: records.filter((record) => record.analysis).length,
    synced: records.filter((record) => record.steps.notion.state === 'ok').length,
    pending: records.filter((record) => record.steps.notion.state === 'idle' || record.steps.notion.state === 'running').length,
    needsReview: records.filter((record) => record.steps.notion.state === 'error' || record.steps.subtitle.state === 'error').length,
    topTags: [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
  };
}

export interface StatsSource {
  list(): Promise<VideoRecord[]>;
  /** 归档每次被写入都会递增的版本号；只读一个数字，比重读整份归档便宜得多。 */
  revision(): Promise<number>;
}

/**
 * 按归档版本号缓存统计。
 *
 * 面板每 1.5 秒问一次 `stats`，而统计以前每次都 `repo.list()`：等于每 1.5 秒把全部记录
 * （含字幕正文）从 chrome.storage 读出来解析一遍，记录越多越卡。归档没变就直接回上次的结果。
 * 缓存在 service worker 内存里，SW 被回收后重算一次即可，不影响正确性。
 */
export function createStatsReader(source: StatsSource): () => Promise<StatsResult> {
  let cached: { revision: number; value: StatsResult } | undefined;
  return async function readStats(): Promise<StatsResult> {
    const revision = await source.revision();
    if (cached && cached.revision === revision) return cached.value;
    const value = computeStats(await source.list());
    cached = { revision, value };
    return value;
  };
}
