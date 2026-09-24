import { describe, expect, it } from 'vitest';
import { MemoryStore, Repository, deepMerge, hasMetadata, haystackFor, newRecord, normalizeRecord } from '../src/lib/store';
import { DEFAULT_SETTINGS } from '../src/lib/types';
import { applyAction, emptyActions } from '../src/lib/events';

function repo() {
  return new Repository(new MemoryStore());
}

function record(bvid = 'BV1xx411c7mD', cid = 1) {
  return newRecord({ bvid, aid: 1, cid, title: `视频${cid}`, owner: 'UP', url: `https://www.bilibili.com/video/${bvid}/` });
}

describe('deepMerge', () => {
  it('merges nested settings without dropping defaults', () => {
    const merged = deepMerge(DEFAULT_SETTINGS, { ai: { enabled: true } });
    expect(merged.ai.enabled).toBe(true);
    expect(merged.ai.model).toBe(DEFAULT_SETTINGS.ai.model);
    expect(merged.notion.enabled).toBe(false);
  });
});

describe('Repository', () => {
  it('keeps the shared index complete across concurrent writers and removals', async () => {
    const store = new MemoryStore();
    const a = new Repository(store), b = new Repository(store);
    await Promise.all([a.upsert(record('BVone', 1)), b.upsert(record('BVtwo', 2))]);
    expect((await a.list()).map(r => r.key).sort()).toEqual(['BVone:1', 'BVtwo:2']);
    await Promise.all([a.remove('BVone:1'), b.upsert(record('BVthree', 3))]);
    expect((await a.list()).map(r => r.key).sort()).toEqual(['BVthree:3', 'BVtwo:2']);
  });
  it('upserts, lists and preserves createdAt', async () => {
    const repository = repo();
    const first = await repository.upsert(record());
    const again = await repository.upsert({ ...first, title: '改名' });
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.title).toBe('改名');
    const all = await repository.list();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('改名');
  });

  it('lists records newest-watched first, not newest-touched', async () => {
    const repository = repo();
    const now = Date.now();
    const longAgo = { ...record('BV1aa411c7mD', 1), watched: { firstAt: now - 30 * 86400000, lastAt: now - 30 * 86400000, visits: 1, secondsWatched: 10, maxProgressRatio: 0.1, completed: false } };
    const yesterday = { ...record('BV1bb411c7mD', 2), watched: { firstAt: now - 86400000, lastAt: now - 86400000, visits: 1, secondsWatched: 10, maxProgressRatio: 0.1, completed: false } };
    const justNow = { ...record('BV1cc411c7mD', 3), watched: { firstAt: now - 60000, lastAt: now - 60000, visits: 1, secondsWatched: 10, maxProgressRatio: 0.1, completed: false } };

    // 插件最近才碰过「很久以前看的」那条，它仍然必须排在最后。
    await repository.upsert(longAgo);
    await repository.upsert(yesterday);
    await repository.upsert(justNow);
    await repository.upsert({ ...longAgo, title: '插件刚同步过' });

    const listed = await repository.search('');
    expect(listed.map((item) => item.bvid)).toEqual(['BV1cc411c7mD', 'BV1bb411c7mD', 'BV1aa411c7mD']);
  });

  it('falls back to when B站 first listed it, then to local creation time', async () => {
    const repository = repo();
    const now = Date.now();
    const fromLikes = { ...record('BV1dd411c7mD', 4), watched: { firstAt: 0, lastAt: 0, visits: 0, secondsWatched: 0, maxProgressRatio: 0, completed: false }, archive: { origins: ['likes' as const], seenAt: { likes: now - 5000 }, archivedAt: now - 5000 } };
    const plain = { ...record('BV1ee411c7mD', 5), watched: { firstAt: 0, lastAt: 0, visits: 0, secondsWatched: 0, maxProgressRatio: 0, completed: false }, createdAt: now - 90000 };
    await repository.upsert(plain);
    await repository.upsert(fromLikes);
    const listed = await repository.search('');
    expect(listed.map((item) => item.bvid)).toEqual(['BV1dd411c7mD', 'BV1ee411c7mD']);
  });

  it('searches across title, subtitle and notes', async () => {
    const repository = repo();
    const item = record();
    item.subtitle = {
      track: { id: '1', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
      availableTracks: [],
      segments: [],
      plainText: '这里提到了向量数据库',
      digest: 'x',
      fetchedAt: 1,
      observations: 2,
      warnings: [],
    };
    item.userNotes = { highlights: ['印象'], questions: ['为什么'], freeform: '自由' };
    await repository.upsert(item);
    await repository.upsert(record('BV1yy411c7mD', 2));
    expect(await repository.search('向量数据库')).toHaveLength(1);
    expect(await repository.search('视频1')).toHaveLength(1);
    expect(await repository.search('')).toHaveLength(2);
    expect(haystackFor(item)).toContain('向量数据库');
  });

  // The options page saves one leaf at a time now; independent partial saves must accumulate
  // instead of overwriting each other's section with a stale copy.
  it('merges partial settings patches leaf by leaf', async () => {
    const repository = repo();
    await repository.saveSettings({ notion: { enabled: true } });
    await repository.saveSettings({ notion: { token: 'ntn_x' } });
    const settings = await repository.saveSettings({ notion: { parentId: 'ds-1' }, ai: { apiKey: 'k' } });
    expect(settings.notion).toMatchObject({ enabled: true, token: 'ntn_x', parentId: 'ds-1', parentType: 'data_source_id' });
    expect(settings.ai.apiKey).toBe('k');
    expect(settings.ai.baseUrl).toBe(DEFAULT_SETTINGS.ai.baseUrl);
  });

  it('deduplicates the sync queue and supports removal', async () => {
    const repository = repo();
    await repository.enqueue('a');
    await repository.enqueue('a');
    await repository.enqueue('b');
    expect(await repository.queue()).toEqual(['a', 'b']);
    await repository.dequeue('a');
    expect(await repository.queue()).toEqual(['b']);
    await repository.remove('a');
    expect(await repository.list()).toHaveLength(0);
  });

  it('persists settings patches', async () => {
    const repository = repo();
    await repository.saveSettings({ notion: { enabled: true, token: 't' } });
    await repository.saveSettings({ subtitle: { consensusReads: 3 } });
    const settings = await repository.getSettings();
    expect(settings.notion.enabled).toBe(true);
    expect(settings.notion.token).toBe('t');
    expect(settings.subtitle.consensusReads).toBe(3);
    expect(settings.ai.model).toBe(DEFAULT_SETTINGS.ai.model);
  });

  it('migrates schema-1 records that stored notion instead of steps', () => {
    const legacy = {
      key: 'BV1:2',
      bvid: 'BV1',
      aid: 1,
      cid: 2,
      title: 'T',
      owner: 'U',
      url: 'https://www.bilibili.com/video/BV1/',
      watched: { firstAt: 1, lastAt: 1, visits: 1, secondsWatched: 0, maxProgressRatio: 0, completed: false },
      value: { like: true, coins: 0, favorite: false, share: false, score: 25, reasons: [] },
      userNotes: { highlights: [], questions: [], freeform: '' },
      subtitle: { digest: 'd', segments: [], plainText: 'x' },
      analysis: { summary: 's', outline: [], keyPoints: [], provider: 'p', model: 'm', createdAt: 1 },
      notion: { state: 'synced', pageId: 'p1', url: 'https://notion.so/p1', syncedAt: 9, completedBatches: 2 },
      createdAt: 1,
      updatedAt: 2,
    };
    const migrated = normalizeRecord(legacy)!;
    expect(migrated.actions).toEqual({ like: true, coin: 0, favorite: false, share: false });
    expect(migrated.steps.subtitle.state).toBe('ok');
    expect(migrated.steps.analysis.state).toBe('ok');
    expect(migrated.steps.notion).toMatchObject({ state: 'ok', pageId: 'p1', url: 'https://notion.so/p1', completedBatches: 2 });
    expect(normalizeRecord({ ...legacy, notion: { state: 'needs_review', error: 'x' } })!.steps.notion).toMatchObject({ state: 'error', error: 'x' });
    expect(normalizeRecord({} as any)).toBeUndefined();
  });

  it('knows when metadata is still missing', () => {
    const item = record();
    expect(hasMetadata({ ...item, title: '', owner: '' })).toBe(false);
    expect(hasMetadata({ ...item, title: item.bvid, owner: 'UP' })).toBe(false);
    expect(hasMetadata({ ...item, title: '真标题', owner: 'UP' })).toBe(true);
  });

  it('newRecord carries action + notes defaults', () => {
    const item = record();
    expect(item.actions).toEqual(emptyActions());
    expect(item.steps.notion.state).toBe('idle');
    item.actions = applyAction(item.actions, { kind: 'like', endpoint: 'like', at: 1 });
    expect(item.actions.like).toBe(true);
  });

  it('bumps the archive revision on every record write, so the UI can poll cheaply', async () => {
    const repository = repo();
    const first = await repository.revision();
    const item = record();
    await repository.upsert(item);
    const afterUpsert = await repository.revision();
    expect(afterUpsert).not.toBe(first);
    await repository.remove(item.key);
    expect(await repository.revision()).not.toBe(afterUpsert);
  });

  it('sanitises timestamps that Date cannot render', async () => {
    const repository = repo();
    const stored = { ...record(), createdAt: 1e300, updatedAt: Infinity, history: { watchedAt: 1e300, position: 5, finished: false } };
    const normalized = normalizeRecord(stored)!;
    expect(normalized.createdAt).toBe(0);
    expect(normalized.updatedAt).toBe(0);
    expect(normalized.history?.watchedAt).toBe(0);
    expect(() => new Date(normalized.history!.watchedAt).toISOString()).not.toThrow();

    // 存一份坏数据进去，再读出来也必须是安全的。
    const store = new MemoryStore();
    await store.set({ 'rec:BVbad:1': stored, 'record-index': ['BVbad:1'] });
    const readBack = await new Repository(store).get('BVbad:1');
    expect(readBack?.history?.watchedAt).toBe(0);
    expect(readBack?.createdAt).toBe(0);
    void repository;
  });

  it('fills step objects an old record never wrote (notion came later)', () => {
    const partial = normalizeRecord({
      ...record(),
      steps: { subtitle: { state: 'ok', at: 5 }, analysis: { state: 'idle' } },
    })!;
    expect(partial.steps.subtitle.state).toBe('ok');
    expect(partial.steps.subtitle.at).toBe(5);
    expect(partial.steps.notion.state).toBe('idle');
    expect(partial.steps.analysis.state).toBe('idle');
  });

  it('migrates the legacy scored value object and drops the score', () => {
    const migrated = normalizeRecord({
      key: 'BV1xx:1',
      bvid: 'BV1xx',
      aid: 1,
      cid: 1,
      title: 'T',
      owner: 'U',
      url: 'https://www.bilibili.com/video/BV1xx/',
      userNotes: { highlights: [], questions: [], freeform: '' },
      value: { like: true, coins: 3, favorite: true, share: false, score: 80, reasons: ['点赞'] },
    })!;
    expect(migrated.actions).toEqual({ like: true, coin: 2, favorite: true, share: false });
    expect('value' in migrated).toBe(false);
    expect(JSON.stringify(migrated)).not.toContain('score');
    expect(migrated.steps.subtitle.state).toBe('idle');
  });
});
