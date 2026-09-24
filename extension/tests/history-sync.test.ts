import { describe, it, expect, vi } from 'vitest';
import { HistorySync, HISTORY_JOB_KEY, RELATION_STALE_MS, SYNC_INTERVAL_MS } from '../src/lib/history-sync';
import { BiliClient, type BiliListVideo, type HistoryCursor } from '../src/lib/bili';
import { MemoryStore, Repository, newRecord } from '../src/lib/store';
import { inLibrary, historyTime } from '../src/lib/history';
import { makeInfo, jsonResponse } from './helpers';

const item = (i: number): BiliListVideo => ({
  bvid: `BVtest${i}`,
  aid: i,
  cid: i + 1,
  title: `视频${i}`,
  owner: 'UP',
  cover: '',
  duration: 600,
  source: 'history',
  watchedAt: 1000 + i,
  progress: 10,
});
function fixture() {
  const store = new MemoryStore();
  const repo = new Repository(store);
  const client = {
    nav: vi.fn(async () => ({ isLogin: true, mid: 1, imgUrl: '', subUrl: '' })),
    historyPage: vi.fn(async (cursor?: HistoryCursor) => ({
      items: Array.from({ length: 30 }, (_, i) => item((cursor?.max ?? 0) + i)),
      more: !cursor,
      cursor: cursor ? undefined : { max: 30, view_at: 100, business: 'archive' },
    })),
    likedPage: vi.fn(async () => ({ items: [{ ...item(0), source: 'likes' as const }], more: false })),
    favoriteFolders: vi.fn(async () => [1]),
    favoritePage: vi.fn(async () => ({ items: [{ ...item(0), source: 'favorites' as const }], more: false })),
    view: vi.fn(async () => makeInfo()),
  };
  const relation = vi.fn(async (_bvid: string, _aid: number) => ({ like: true, coin: 2, favorite: true, fetchedAt: Date.now(), warnings: [] }));
  const create = () => new HistorySync(store, repo, client, relation);
  return { store, repo, client, relation, create };
}
async function finish(job: HistorySync) {
  for (let i = 0; i < 50; i++) {
    const status = await job.tick();
    if (status.state !== 'running') return status;
  }
  throw new Error('job did not finish');
}
describe('persistent history jobs', () => {
  it('freezes legacy collection eligibility before list and relation enrichment', async () => {
    const f = fixture();
    const listed = newRecord({ ...makeInfo(), bvid: 'BVtest0', cid: 1 });
    const onlyRelation = newRecord({ ...makeInfo(), bvid: 'BVoutside', cid: 2 });
    const collected = newRecord({ ...makeInfo(), bvid: 'BVcollected', cid: 3 });
    collected.userNotes.freeform = '已有知识';
    for (const record of [listed, onlyRelation, collected]) await f.repo.upsert(record);
    expect(inLibrary(listed)).toBe(false);
    expect(inLibrary(onlyRelation)).toBe(false);
    const job = f.create();
    await job.start();
    await finish(job);
    for (const record of [listed, onlyRelation]) {
      const saved = (await f.repo.get(record.key))!;
      expect(saved.actions.like).toBe(true);
      expect(saved.library?.saved).toBe(false);
      expect(inLibrary(saved)).toBe(false);
    }
    expect(inLibrary((await f.repo.get(collected.key))!)).toBe(true);
    expect((await f.repo.list()).filter(inLibrary).map(r => r.key)).toEqual([collected.key]);
    expect(await f.repo.queue()).toEqual([]);
  });
  it('does not resurrect a deleted record from a delayed or resumed import', async () => {
    const f = fixture();
    const job = f.create();
    await job.start();
    await job.tick();
    await f.repo.remove('BVtest0:1');
    await finish(f.create());
    expect(await f.repo.get('BVtest0:1')).toBeUndefined();
    await job.start(true);
    await finish(job);
    expect(await f.repo.get('BVtest0:1')).toBeUndefined();
  });
  it('imports more than 40, resumes cursor after worker recreation, preserves notes and never queues processing', async () => {
    const f = fixture();
    const job = f.create();
    await job.start();
    await job.tick();
    const first = (await f.repo.list())[0];
    first.userNotes.freeform = '我的笔记';
    await f.repo.upsert(first);
    const resumed = f.create();
    expect((await resumed.status()).state).toBe('running');
    const status = await finish(resumed);
    expect(status.state).toBe('done');
    expect(status.count).toBe(60);
    expect(f.client.historyPage.mock.calls[1][0]).toEqual({ max: 30, view_at: 100, business: 'archive' });
    expect((await f.repo.list()).length).toBe(60);
    expect(f.relation).toHaveBeenCalledTimes(60);
    const saved = await f.repo.get(first.key);
    expect(saved?.archive?.origins).toEqual(expect.arrayContaining(['history', 'likes', 'favorites']));
    expect(saved?.userNotes.freeform).toBe('我的笔记');
    expect(historyTime(saved!)).toBe(1000);
    expect((await f.repo.list()).some(inLibrary)).toBe(false);
    expect(await f.repo.queue()).toEqual([]);
    expect((await resumed.start(false)).state).toBe('done');
  });
  it('retains local data on login failure and resumes on explicit retry', async () => {
    const f = fixture();
    const job = f.create();
    await job.start();
    await job.tick();
    f.client.nav.mockResolvedValueOnce({ isLogin: false, mid: 0, imgUrl: '', subUrl: '' });
    expect((await job.tick()).state).toBe('error');
    expect((await f.repo.list()).length).toBe(30);
    expect((await job.start(false)).state).toBe('error');
    await job.start(true);
    expect((await finish(job)).state).toBe('done');
  });
  it('auto-resumes a failed job once the backoff window has passed', async () => {
    const f = fixture();
    const job = f.create();
    await job.start();
    f.client.nav.mockRejectedValueOnce(new Error('网络错误'));
    expect((await job.tick()).state).toBe('error');
    // 窗口内不重试：周期唤醒保持无操作，避免对着风控连续撞。
    expect((await job.start(false)).state).toBe('error');
    const saved = (await f.store.get([HISTORY_JOB_KEY]))[HISTORY_JOB_KEY] as Record<string, unknown>;
    await f.store.set({ [HISTORY_JOB_KEY]: { ...saved, failedAt: Date.now() - SYNC_INTERVAL_MS - 1_000 } });
    // 到期自动续跑，不需要人工点重试。
    const resumed = await job.start(false);
    expect(resumed.state).toBe('running');
    expect(resumed.phase).toBe('history');
    expect(resumed.error).toBeUndefined();
    expect((await finish(job)).state).toBe('done');
  });
  it('refreshes interactions only for records not checked within the staleness window', async () => {
    const f = fixture();
    const fresh = newRecord({ ...makeInfo(), bvid: 'BVfresh', cid: 101 });
    fresh.relation = { source: 'api', fetchedAt: Date.now() - 60_000 };
    const stale = newRecord({ ...makeInfo(), bvid: 'BVstale', cid: 102 });
    stale.relation = { source: 'api', fetchedAt: Date.now() - RELATION_STALE_MS - 60_000 };
    await f.repo.upsert(fresh);
    await f.repo.upsert(stale);
    const job = f.create();
    await job.start();
    await finish(job);
    const checked = f.relation.mock.calls.map((call) => call[0]);
    expect(checked).toContain('BVstale');
    expect(checked).not.toContain('BVfresh');
  });
  it('does not infer deletion or negative interaction from partial failure', async () => {
    const f = fixture();
    f.client.likedPage.mockRejectedValue(new Error('网络错误'));
    f.relation.mockRejectedValue(new Error('风控'));
    const job = f.create();
    await job.start();
    const result = await finish(job);
    expect(result.state).toBe('done');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect((await f.repo.list()).every((record) => !record.relation && !record.archive?.droppedFromHistory)).toBe(true);
  });
  it('serializes concurrent start/tick and repeated pages are idempotent', async () => {
    const f = fixture();
    const job = f.create();
    await Promise.all([job.start(), job.start()]);
    await Promise.all([job.tick(), job.tick()]);
    expect((await f.repo.list()).length).toBe(60);
    await finish(job);
    await job.start(true);
    await finish(job);
    expect((await f.repo.list()).length).toBe(60);
  });
});

describe('B站 cursor protocol', () => {
  it('uses server cursor ID and time separately and treats progress=-1 as finished', async () => {
    const urls: URL[] = [];
    const client = new BiliClient(async (url) => {
      urls.push(new URL(url));
      return jsonResponse({
        code: 0,
        data: {
          list: [{ history: { bvid: 'BVtest', oid: 12, cid: 34 }, view_at: 123, progress: -1 }],
          cursor: { max: 12, view_at: 123, business: 'archive' },
        },
      });
    });
    const first = await client.historyPage();
    expect(first.items[0].finished).toBe(true);
    await client.historyPage(first.cursor);
    expect(urls[1].searchParams.get('max')).toBe('12');
    expect(urls[1].searchParams.get('view_at')).toBe('123');
  });
});
