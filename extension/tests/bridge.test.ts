import { describe, expect, it } from 'vitest';
import {
  MAX_TRACKS,
  actionFromBridge,
  positiveInt,
  sanitizeActionSignal,
  sanitizeSnapshot,
  sanitizeTracks,
  sanitizeVideo,
  sanitizeWatch,
  validIdentity,
} from '../src/lib/bridge';

/**
 * 「同源任意脚本都能伪造 window.postMessage」的防线。
 * 这些用例就是攻击面清单：伪造身份、伪造动作、灌爆文本、刷观看次数都必须被挡下。
 */
const identity = { bvid: 'BV1xx411c7mD', aid: 123456, cid: 789, page: 1 };

describe('bridge identity validation', () => {
  it('accepts a well-formed identity', () => {
    expect(validIdentity(identity)).toEqual(identity);
  });

  it('rejects anything that is not a real BV id', () => {
    for (const bvid of ['', 'BV', 'bv1xx411c7mD', 'BV1xx411c7m', 'AV123', 'BV1xx411c7mD;rm -rf /']) {
      expect(validIdentity({ ...identity, bvid })).toBeNull();
    }
    expect(validIdentity({ ...identity, bvid: 'BV1xx411c7mD' })).not.toBeNull();
  });

  it('requires positive integer aid/cid and never coerces strings', () => {
    expect(validIdentity({ ...identity, aid: 0 })).toBeNull();
    expect(validIdentity({ ...identity, cid: -1 })).toBeNull();
    expect(validIdentity({ ...identity, cid: 1.5 })).toBeNull();
    expect(validIdentity({ ...identity, aid: '123' })).toBeNull();
    expect(validIdentity({ ...identity, aid: Number.NaN })).toBeNull();
    expect(positiveInt(5, 10)).toBe(5);
    expect(positiveInt(11, 10)).toBeNull();
  });

  it('drops PGC pages that have no BV id instead of creating a keyless record', () => {
    // 以前会写成 key=`:cid` 的记录：列表匹配不上、Notion 视频ID 是空的。
    expect(validIdentity({ bvid: '', aid: 1, cid: 2 })).toBeNull();
    expect(sanitizeSnapshot({ identity: { bvid: '', aid: 1, cid: 2 }, tracks: [], at: 1 })).toBeNull();
    expect(sanitizeVideo({ identity: { bvid: '', aid: 1, cid: 2 }, title: 'T', owner: 'U' })).toBeNull();
    expect(sanitizeWatch({ identity: { bvid: '', aid: 1, cid: 2 }, secondsWatched: 1 })).toBeNull();
  });

  it('survives junk in place of the payload', () => {
    for (const junk of [null, undefined, 0, 'snapshot', [], { identity: null }]) {
      expect(sanitizeSnapshot(junk)).toBeNull();
      expect(sanitizeVideo(junk)).toBeNull();
      expect(sanitizeWatch(junk)).toBeNull();
    }
  });
});

describe('bridge payload limits', () => {
  it('caps the track list and its fields', () => {
    const many = Array.from({ length: 99 }, (_, i) => ({
      id: 'i' + i,
      language: 'ai-zh',
      label: 'L'.repeat(5000),
      url: 'https://aisubtitle.hdslb.com/x.json',
      endpoint: 'e',
      source: 'page',
      isAI: true,
    }));
    const tracks = sanitizeTracks(many);
    expect(tracks).toHaveLength(MAX_TRACKS);
    expect(tracks[0].label.length).toBe(300);
    // 缺字段的轨道直接丢掉，不给 chooseTrack 送半成品。
    expect(sanitizeTracks([{ id: '1', language: 'zh' }])).toEqual([]);
    expect(sanitizeTracks('not-an-array')).toEqual([]);
  });

  it('truncates forged text instead of storing it whole', () => {
    const video = sanitizeVideo({ identity, title: 'T'.repeat(9000), owner: 'U', description: 'D'.repeat(9000), category: 'C' });
    expect(video?.title.length).toBe(300);
    expect(video?.description?.length).toBe(5000);
    expect(video?.category).toBe('C');
    // 标题与 UP主 都没有的“视频”没有信息量，不建记录。
    expect(sanitizeVideo({ identity, title: '', owner: '' })).toBeNull();
  });

  it('clamps playback numbers and visit counts', () => {
    const watch = sanitizeWatch({
      identity,
      secondsWatched: 9e9,
      progressRatio: 42,
      position: -5,
      completed: 1,
      visits: 999,
      at: 1,
      url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    });
    expect(watch).toMatchObject({ secondsWatched: 172_800, progressRatio: 1, completed: true, visits: 1 });
    expect(watch?.position).toBeUndefined();
    expect(sanitizeWatch({ identity, secondsWatched: Number.NaN, progressRatio: Number.NaN })?.secondsWatched).toBe(0);
  });
});

describe('bridge action filter', () => {
  it('accepts the four known endpoints only', () => {
    const like = actionFromBridge({ url: 'https://api.bilibili.com/x/web-interface/archive/like', body: 'bvid=BV1xx411c7mD&like=1' });
    expect(like).toMatchObject({ kind: 'like', active: true, bvid: 'BV1xx411c7mD' });
    expect(actionFromBridge({ url: 'https://api.bilibili.com/x/web-interface/archive/like', body: 'bvid=BV1xx411c7mD&like=2' })).toBeNull();
    expect(actionFromBridge({ url: 'https://evil.example.com/x/web-interface/archive/like', body: 'like=1' })).toBeNull();
    expect(actionFromBridge({ url: 'https://api.bilibili.com/x/web-interface/archive/like' })).toBeNull();
    expect(actionFromBridge('like')).toBeNull();
  });

  it('drops a forged bvid instead of letting it match another record', () => {
    const signal = actionFromBridge({ url: 'https://api.bilibili.com/x/web-interface/share/add', body: 'bvid=x' });
    expect(signal?.kind).toBe('share');
    expect(signal?.bvid).toBeUndefined();
  });

  it('re-validates what the content script sends to the worker', () => {
    expect(sanitizeActionSignal({ kind: 'coin', endpoint: 'coin', at: 1, multiply: 9, bvid: 'nope' })).toEqual({
      kind: 'coin',
      endpoint: 'coin',
      at: 1,
      active: false,
      multiply: 2,
    });
    expect(sanitizeActionSignal({ kind: 'drop-table' })).toBeNull();
    expect(sanitizeActionSignal(null)).toBeNull();
  });
});
