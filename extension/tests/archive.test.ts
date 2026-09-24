import { describe, expect, it } from 'vitest';
import {
  activityAt,
  activitySource,
  applyArchiveItem,
  hasPlayback,
  archiveSummary,
  byActivityDesc,
  markDroppedFromHistory,
  planArchiveSync,
} from '../src/lib/archive';
import type { BiliListVideo } from '../src/lib/bili';
import { newRecord } from '../src/lib/store';
import type { VideoRecord } from '../src/lib/types';

const DAY = 86_400_000;

function record(bvid = 'BV1xx411c7mD', cid = 2): VideoRecord {
  return newRecord({
    bvid,
    aid: 1,
    cid,
    title: '标题',
    owner: 'UP主',
    url: `https://www.bilibili.com/video/${bvid}/`,
  });
}

function historyItem(bvid: string, watchedAt = 1_700_000_000_000): BiliListVideo {
  return {
    bvid,
    aid: 1,
    cid: 2,
    title: 'B站 标题',
    owner: 'B站 UP主',
    cover: 'https://i0.hdslb.com/x.jpg',
    duration: 300,
    source: 'history',
    progress: 120,
    finished: false,
    watchedAt,
  };
}

describe('applyArchiveItem', () => {
  it('adds the origin and B站 metadata without touching my own work', () => {
    const mine = record();
    mine.subtitle = { track: { id: '1', language: 'ai-zh', label: '中文', source: 'page' }, availableTracks: [], segments: [], plainText: '字幕', digest: 'd', fetchedAt: 1, observations: 2, warnings: [] };
    mine.analysis = { summary: '摘要', outline: [], keyPoints: [], provider: 'p', model: 'm', createdAt: 1 };
    mine.userNotes = { highlights: ['我的印象'], questions: [], freeform: '随笔' };
    mine.steps.notion = { state: 'ok', url: 'https://notion.so/p' };

    const merged = applyArchiveItem(mine, { ...historyItem('BV1xx411c7mD'), title: 'B站 的新标题' }, 2 * DAY);

    expect(merged.archive?.origins).toEqual(['page', 'history']);
    expect(merged.archive?.seenAt.history).toBe(2 * DAY);
    expect(merged.title).toBe('B站 的新标题');
    // 我自己的东西一个字都不能少
    expect(merged.subtitle?.plainText).toBe('字幕');
    expect(merged.analysis?.summary).toBe('摘要');
    expect(merged.userNotes).toEqual(mine.userNotes);
    expect(merged.steps.notion.url).toBe('https://notion.so/p');
  });

  it('keeps a local value when B站 sends an empty one', () => {
    const merged = applyArchiveItem(record(), { ...historyItem('BV1xx411c7mD'), title: '', owner: '', cover: '' });
    expect(merged.title).toBe('标题');
    expect(merged.owner).toBe('UP主');
  });

  it('records a like / favorite from the list it came from, and history playback', () => {
    const liked = applyArchiveItem(record(), { ...historyItem('BV1xx411c7mD'), source: 'likes' });
    expect(liked.actions.like).toBe(true);
    expect(liked.archive?.origins).toContain('likes');
    const faved = applyArchiveItem(record(), { ...historyItem('BV1xx411c7mD'), source: 'favorites' });
    expect(faved.actions.favorite).toBe(true);

    const now = Date.now();
    const watchedRecord = record();
    watchedRecord.watched = { firstAt: now - 10 * DAY, lastAt: now - 10 * DAY, visits: 1, secondsWatched: 5, maxProgressRatio: 0, completed: false };
    const watched = applyArchiveItem(watchedRecord, historyItem('BV1xx411c7mD', now - DAY));
    expect(watched.watched.secondsWatched).toBe(120);
    expect(watched.watched.lastAt).toBe(now - DAY);
  });

  it('takes the real watch time from B站 history instead of the record creation time', () => {
    const watchedAt = Date.now() - 40 * DAY;
    const merged = applyArchiveItem(record(), historyItem('BV1xx411c7mD', watchedAt), Date.now());
    expect(merged.watched.lastAt).toBe(watchedAt);
    expect(merged.watched.firstAt).toBe(watchedAt);
    expect(activityAt(merged)).toBe(watchedAt);
    expect(activitySource(merged)).toBe('watched');
  });

  it('corrects the sync time an older build wrote into watched.lastAt', () => {
    const watchedAt = Date.now() - 12 * DAY;
    const syncAt = Date.now() - 3600_000;
    // 旧版本导入时把「同步那一刻」max 进了 lastAt，secondsWatched 又来自历史进度。
    const legacy = record();
    legacy.watched = { firstAt: syncAt, lastAt: syncAt, visits: 0, secondsWatched: 300, maxProgressRatio: 0, completed: false };
    legacy.archive = { origins: ['history'], seenAt: { history: syncAt }, archivedAt: syncAt };

    const merged = applyArchiveItem(legacy, historyItem('BV1xx411c7mD', watchedAt), Date.now());
    expect(merged.watched.lastAt).toBe(watchedAt);
    expect(merged.watched.firstAt).toBe(watchedAt);
    expect(merged.watched.secondsWatched).toBe(300);
    expect(activityAt(merged)).toBe(watchedAt);
  });

  it('keeps a real local playback time even when B站 的值更早', () => {
    const playedAt = Date.now() - DAY;
    const watchedAt = Date.now() - 20 * DAY;
    const played = record();
    played.watched = { firstAt: playedAt, lastAt: playedAt, visits: 3, secondsWatched: 600, maxProgressRatio: 0.5, completed: false };
    const merged = applyArchiveItem(played, historyItem('BV1xx411c7mD', watchedAt), Date.now());
    expect(merged.watched.lastAt).toBe(playedAt);
    expect(merged.watched.firstAt).toBe(watchedAt);
  });

  it('does not pretend a like / favourite import was watched just now', () => {
    const merged = applyArchiveItem(record(), { ...historyItem('BV1xx411c7mD'), source: 'likes' }, Date.now());
    expect(merged.watched.lastAt).toBe(0);
    expect(merged.watched.firstAt).toBe(0);
    // 点赞列表没有时间，就如实退回「我们同步到它的那一刻」。
    expect(activitySource(merged)).toBe('likes');
  });

  it('clears the "cleaned by B站" flag when the video shows up in history again', () => {
    const stale = record();
    stale.archive = { origins: ['history'], seenAt: { history: 1 }, archivedAt: 1, droppedFromHistory: true };
    expect(applyArchiveItem(stale, historyItem('BV1xx411c7mD')).archive?.droppedFromHistory).toBe(false);
  });
});

describe('planArchiveSync', () => {
  it('separates new videos from ones already archived', () => {
    const plan = planArchiveSync([record('BV1xx411c7mD')], [historyItem('BV1xx411c7mD'), historyItem('BV1yy411c7mD')]);
    expect(plan.known.map((entry) => entry.item.bvid)).toEqual(['BV1xx411c7mD']);
    expect(plan.fresh.map((item) => item.bvid)).toEqual(['BV1yy411c7mD']);
  });

  it('ignores junk and duplicates', () => {
    const plan = planArchiveSync([], [{ ...historyItem('not-a-bv') }, historyItem('BV1yy411c7mD'), historyItem('BV1yy411c7mD')]);
    expect(plan.fresh).toHaveLength(1);
  });
});

describe('markDroppedFromHistory', () => {
  const aged = (bvid: string, seenAt: number): VideoRecord => {
    const item = record(bvid);
    item.archive = { origins: ['history'], seenAt: { history: seenAt }, archivedAt: seenAt };
    return item;
  };

  const NOW = Date.now();

  it('flags history records older than the window that B站 no longer returns', () => {
    const records = [aged('BV1aa411c7mD', NOW - 5 * DAY), aged('BV1bb411c7mD', NOW - 80 * DAY)];
    const changed = markDroppedFromHistory(records, { seen: new Set(['BV1aa411c7mD']), windowStart: NOW - 30 * DAY, now: NOW });
    expect(changed.map((r) => r.bvid)).toEqual(['BV1bb411c7mD']);
    expect(changed[0].archive?.droppedFromHistory).toBe(true);
  });

  it('never touches records inside the window, or ones that are not from history', () => {
    const inside = aged('BV1cc411c7mD', NOW - 10 * DAY);
    const pageOnly = record('BV1dd411c7mD');
    pageOnly.archive = { origins: ['page'], seenAt: {}, archivedAt: 1 };
    expect(markDroppedFromHistory([inside, pageOnly], { seen: new Set(), windowStart: NOW - 30 * DAY, now: NOW })).toEqual([]);
  });

  it('drops the placeholder watch time of a record B站 已经不再返回', () => {
    const seenAt = NOW - 60 * DAY;
    const syncAt = NOW - DAY; // 旧版本写进去的「同步那一刻」
    const dropped = aged('BV1ee411c7mD', seenAt);
    dropped.watched = { firstAt: syncAt, lastAt: syncAt, visits: 0, secondsWatched: 42, maxProgressRatio: 0, completed: false };
    const [changed] = markDroppedFromHistory([dropped], { seen: new Set(), windowStart: NOW - 30 * DAY, now: NOW });
    expect(changed.archive?.droppedFromHistory).toBe(true);
    expect(changed.watched.lastAt).toBe(0);
    // 回退到「我们第一次在 B站 列表里看到它」的时间，而不是假装刚看过。
    expect(activityAt(changed)).toBe(seenAt);
    expect(activitySource(changed)).toBe('history');
  });

  it('clears the flag when the video is listed again', () => {
    const back = aged('BV1aa411c7mD', NOW - 80 * DAY);
    back.archive = { ...back.archive!, droppedFromHistory: true };
    const changed = markDroppedFromHistory([back], { seen: new Set(['BV1aa411c7mD']), windowStart: NOW - 30 * DAY, now: NOW });
    expect(changed[0].archive?.droppedFromHistory).toBe(false);
  });
});

describe('activityAt / activitySource', () => {
  const NOW = Date.now();

  it('prefers the B站 watch time over everything else', () => {
    const item = record();
    item.createdAt = NOW - 10 * DAY;
    item.watched = { firstAt: NOW - 3 * DAY, lastAt: NOW - 2 * DAY, visits: 1, secondsWatched: 10, maxProgressRatio: 0.1, completed: false };
    item.archive = { origins: ['history'], seenAt: { history: NOW - DAY }, archivedAt: NOW };
    expect(activityAt(item)).toBe(NOW - 2 * DAY);
    expect(activitySource(item)).toBe('watched');
  });

  it('falls back through the B站 lists to the local record time', () => {
    const liked = record();
    liked.createdAt = NOW - 10 * DAY;
    liked.watched = { firstAt: 0, lastAt: 0, visits: 0, secondsWatched: 0, maxProgressRatio: 0, completed: false };
    liked.archive = { origins: ['likes'], seenAt: { likes: NOW - 1000 }, archivedAt: NOW };
    expect(activityAt(liked)).toBe(NOW - 1000);
    expect(activitySource(liked)).toBe('likes');

    const plain = record();
    plain.createdAt = NOW - 5 * DAY;
    plain.watched = { firstAt: 0, lastAt: 0, visits: 0, secondsWatched: 0, maxProgressRatio: 0, completed: false };
    expect(activityAt(plain)).toBe(NOW - 5 * DAY);
    expect(activitySource(plain)).toBe('recorded');
  });

  it('sorts newest first', () => {
    const older = record('BV1aa411c7mD');
    older.watched = { firstAt: NOW - 5 * DAY, lastAt: NOW - 5 * DAY, visits: 1, secondsWatched: 1, maxProgressRatio: 0, completed: false };
    const newer = record('BV1bb411c7mD');
    newer.watched = { firstAt: NOW - DAY, lastAt: NOW - DAY, visits: 1, secondsWatched: 1, maxProgressRatio: 0, completed: false };
    expect([older, newer].sort(byActivityDesc).map((r) => r.bvid)).toEqual(['BV1bb411c7mD', 'BV1aa411c7mD']);
  });
});

describe('archiveSummary', () => {
  it('counts archived records, cleaned ones and per-action totals', () => {
    const history = record('BV1aa411c7mD');
    history.archive = { origins: ['history'], seenAt: { history: 1 }, archivedAt: 1, droppedFromHistory: true };
    history.actions = { like: true, coin: 2, favorite: true, share: false };
    const page = record('BV1bb411c7mD');
    page.archive = { origins: ['page'], seenAt: {}, archivedAt: 1 };
    const summary = archiveSummary([history, page]);
    expect(summary.archived).toBe(1);
    expect(summary.dropped).toBe(1);
    expect(summary.byAction).toEqual({ liked: 1, coined: 1, faved: 1, shared: 0 });
  });
});
