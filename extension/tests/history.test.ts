import { describe, it, expect } from 'vitest';
import { newRecord } from '../src/lib/store';
import { makeInfo } from './helpers';
import { historyTime, historyGroups, interaction, inLibrary, playbackUrl } from '../src/lib/history';
import { applyArchiveItem } from '../src/lib/archive';

describe('history presentation contract', () => {
  it('does not present import timestamps as watch dates', () => {
    const r = newRecord(makeInfo());
    r.archive = { origins: ['likes'], seenAt: { likes: Date.now() }, archivedAt: Date.now() };
    expect(historyTime(r)).toBe(0);
    expect(historyGroups([r], 'liked')).toEqual([]);
    r.actions.like = true;
    expect(historyGroups([r], 'liked')[0].label).toBe('无观看时间');
  });
  it('ignores timestamps that Date cannot render instead of throwing', () => {
    const r = newRecord(makeInfo());
    r.history = { watchedAt: 1e300, position: 5, finished: false };
    r.watched.lastAt = Number.POSITIVE_INFINITY;
    expect(historyTime(r)).toBe(0);
    // 没有观看时间的记录只在「来自 B站 历史」时才进「全部」，关键是分组不能因此抛错。
    expect(() => historyGroups([r], 'all')).not.toThrow();
    expect(historyGroups([r], 'all')).toEqual([]);
    r.archive = { origins: ['history'], seenAt: {}, archivedAt: 0 };
    expect(historyGroups([r], 'all')[0].label).toBe('无观看时间');
  });

  it('tolerates a record whose nested objects are missing', () => {
    const broken = { ...newRecord(makeInfo()), userNotes: undefined, archive: { seenAt: {}, archivedAt: 0 } } as never;
    expect(() => inLibrary(broken)).not.toThrow();
    expect(inLibrary(broken)).toBe(false);
    expect(() => historyGroups([broken], 'all')).not.toThrow();
  });

  it('unknown interaction differs from confirmed false', () => {
    const r = newRecord(makeInfo());
    expect(interaction(r, 'coin')).toBe(null);
    r.relation = { source: 'api', fetchedAt: 1 };
    expect(interaction(r, 'coin')).toBe(false);
    r.actions.coin = 2;
    expect(interaction(r, 'coin')).toBe(true);
  });
  it('import preserves latest position rather than greatest position and never enrolls a video', () => {
    const r = newRecord(makeInfo());
    const item = {
      bvid: r.bvid,
      aid: r.aid,
      cid: r.cid,
      title: r.title,
      owner: r.owner,
      source: 'history' as const,
      cover: '',
      duration: 600,
      watchedAt: 1000,
      progress: 500,
    };
    const first = applyArchiveItem(r, item, 2000);
    const next = applyArchiveItem(first, { ...item, watchedAt: 3000, progress: 30 }, 4000);
    expect(historyTime(next)).toBe(3000);
    expect(playbackUrl(next)).toContain('t=30');
    next.page = 3;
    expect(playbackUrl(next)).toContain('p=3');
    expect(inLibrary(next)).toBe(false);
    expect(historyTime(applyArchiveItem(next, { ...item, source: 'likes' }, 5000))).toBe(3000);
  });
  it('retains legacy knowledge and explicit collection', () => {
    const r = newRecord(makeInfo());
    r.actions.like = true;
    expect(inLibrary(r)).toBe(true);
    r.library = { saved: false };
    expect(inLibrary(r)).toBe(false);
    r.library.saved = true;
    expect(inLibrary(r)).toBe(true);
  });
});
