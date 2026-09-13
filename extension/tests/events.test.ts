import { describe, expect, it } from 'vitest';
import { actionSucceeded, applyAction, classifyAction, describeActions, emptyActions, hasAnyAction, mergeWatch } from '../src/lib/events';

describe('action classification', () => {
  it('recognises like / unlike', () => {
    expect(classifyAction('https://api.bilibili.com/x/web-interface/archive/like', 'bvid=BV1xx&like=1')).toMatchObject({ kind: 'like', bvid: 'BV1xx', active: true });
    expect(classifyAction('https://api.bilibili.com/x/web-interface/archive/like', 'bvid=BV1xx&like=0')).toMatchObject({ kind: 'unlike', active: false });
  });

  it('recognises coin with multiplier', () => {
    expect(classifyAction('https://api.bilibili.com/x/web-interface/coin/add', 'bvid=BV1xx&multiply=2')).toMatchObject({ kind: 'coin', multiply: 2 });
  });

  it('recognises share and favorite add/remove', () => {
    expect(classifyAction('https://api.bilibili.com/x/web-interface/share/add', 'bvid=BV1xx')).toMatchObject({ kind: 'share' });
    expect(classifyAction('https://api.bilibili.com/x/v3/fav/resource/deal', 'rid=1&add_media_ids=99')).toMatchObject({ kind: 'favorite', active: true });
    expect(classifyAction('https://api.bilibili.com/x/v3/fav/resource/deal', 'rid=1&del_media_ids=99')).toMatchObject({ kind: 'unfavorite', active: false });
  });

  it('ignores unrelated requests and failed responses', () => {
    expect(classifyAction('https://api.bilibili.com/x/web-interface/nav', '')).toBeNull();
    expect(classifyAction('https://api.bilibili.com/x/web-interface/archive/like', 'bvid=BV1xx&like=')).toBeNull();
    expect(actionSucceeded({ code: 0 })).toBe(true);
    expect(actionSucceeded({ code: -403 })).toBe(false);
    expect(actionSucceeded(null)).toBe(false);
  });
});

describe('action state', () => {
  it('tracks state transitions without any score', () => {
    let actions = emptyActions();
    actions = applyAction(actions, { kind: 'like', endpoint: 'like', at: 1 });
    actions = applyAction(actions, { kind: 'coin', endpoint: 'coin', at: 2, multiply: 2 });
    expect(actions).toEqual({ like: true, coin: 2, favorite: false, share: false });
    actions = applyAction(actions, { kind: 'unlike', endpoint: 'like', at: 3 });
    expect(actions.like).toBe(false);
    // a lower repeat coin call never lowers the recorded amount
    actions = applyAction(actions, { kind: 'coin', endpoint: 'coin', at: 4, multiply: 1 });
    expect(actions.coin).toBe(2);
  });

  it('caps coins at 2 like B站 does', () => {
    const actions = applyAction(emptyActions(), { kind: 'coin', endpoint: 'coin', at: 1, multiply: 5 });
    expect(actions.coin).toBe(2);
  });

  it('reports the capture trigger and a readable summary', () => {
    expect(hasAnyAction(emptyActions())).toBe(false);
    expect(hasAnyAction(emptyActions())).toBe(false);
    const liked = applyAction(emptyActions(), { kind: 'like', endpoint: 'like', at: 1 });
    expect(hasAnyAction(liked)).toBe(true);
    expect(hasAnyAction(applyAction(emptyActions(), { kind: 'share', endpoint: 'share', at: 1 }))).toBe(true);
    expect(describeActions({ like: true, coin: 2, favorite: false, share: true })).toEqual(['点赞', '投币×2', '分享']);
    expect(describeActions(emptyActions())).toEqual([]);
  });
});

describe('watch stats', () => {
  it('merges progress monotonically', () => {
    const first = mergeWatch(undefined, { visits: 1, secondsWatched: 60, maxProgressRatio: 0.2, lastAt: 100 });
    const second = mergeWatch(first, { visits: 1, secondsWatched: 120, maxProgressRatio: 0.4, lastAt: 200, completed: false });
    expect(second.visits).toBe(2);
    expect(second.secondsWatched).toBe(120);
    expect(second.maxProgressRatio).toBe(0.4);
    expect(second.firstAt).toBe(100);
    expect(second.lastAt).toBe(200);
    const third = mergeWatch(second, { completed: true });
    expect(third.completed).toBe(true);
  });
});
