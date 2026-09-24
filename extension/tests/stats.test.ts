import { describe, expect, it } from 'vitest';
import { computeStats, createStatsReader } from '../src/lib/stats';
import { newRecord } from '../src/lib/store';
import type { VideoRecord } from '../src/lib/types';

function record(overrides: Partial<VideoRecord> = {}): VideoRecord {
  const base = newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 1,
    cid: 2,
    title: 'T',
    owner: 'U',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  });
  return { ...base, ...overrides };
}

describe('archive statistics', () => {
  it('counts actions, steps and tags', () => {
    const records = [
      record({ tags: ['a', 'b'], actions: { like: true, coin: 2, favorite: false, share: false } }),
      record({ tags: ['a'], actions: { like: false, coin: 0, favorite: true, share: true } }),
    ];
    records[0].steps.notion.state = 'ok';
    records[1].steps.subtitle.state = 'error';
    const stats = computeStats(records);
    expect(stats).toMatchObject({
      total: 2,
      liked: 1,
      coined: 1,
      faved: 1,
      shared: 1,
      synced: 1,
      needsReview: 1,
      topTags: [
        { tag: 'a', count: 2 },
        { tag: 'b', count: 1 },
      ],
    });
  });

  it('reads the archive once while the revision is unchanged', async () => {
    // 面板每 1.5 秒问一次统计：归档没变时必须回缓存，否则每次都要把全部字幕读出来。
    let reads = 0;
    let revision = 1;
    const source = {
      async list() {
        reads += 1;
        return [record()];
      },
      async revision() {
        return revision;
      },
    };
    const readStats = createStatsReader(source);
    expect((await readStats()).total).toBe(1);
    expect((await readStats()).total).toBe(1);
    expect((await readStats()).total).toBe(1);
    expect(reads).toBe(1);
    revision = 2;
    expect((await readStats()).total).toBe(1);
    expect(reads).toBe(2);
  });
});
