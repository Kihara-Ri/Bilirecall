import { describe, expect, it } from 'vitest';
import { newRecord } from '../src/lib/store';
import type { VideoRecord } from '../src/lib/types';
import { COMPLETION_RATIO, computeProgress, watchChanged } from '../src/lib/watch';

function record(): VideoRecord {
  return newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 1,
    cid: 2,
    title: 'T',
    owner: 'U',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  });
}

describe('playback progress', () => {
  it('counts a video as finished only at 90% or more', () => {
    expect(COMPLETION_RATIO).toBe(0.9);
    expect(computeProgress(0, 89, 100).completed).toBe(false);
    expect(computeProgress(0, 89.9, 100).completed).toBe(false);
    expect(computeProgress(0, 90, 100).completed).toBe(true);
    expect(computeProgress(0, 100, 100).completed).toBe(true);
  });

  it('reports the ratio with two decimals of tolerance', () => {
    const half = computeProgress(0, 50, 100);
    expect(half.progressRatio).toBeCloseTo(0.5, 5);
    expect(half.secondsWatched).toBe(50);
  });

  it('never regresses when the player seeks backwards', () => {
    const jumped = computeProgress(300, 10, 600);
    expect(jumped.secondsWatched).toBe(300);
    expect(jumped.progressRatio).toBeCloseTo(0.5, 5);
  });

  it('does not mark complete when the duration is unknown', () => {
    const unknown = computeProgress(120, 120, 0);
    expect(unknown.progressRatio).toBe(0);
    expect(unknown.completed).toBe(false);
    const nan = computeProgress(0, Number.NaN, 100);
    expect(nan.secondsWatched).toBe(0);
    expect(nan.completed).toBe(false);
  });

  it('skips the write for a paused heartbeat that repeats itself', () => {
    // 回归：暂停的标签页以前每 10 秒写一次库，顺带把界面的归档版本号顶掉（每 10 秒重读整份归档）。
    const previous = record();
    previous.watched = { ...previous.watched, visits: 1, secondsWatched: 10, maxProgressRatio: 10 / 600 };
    previous.history = { watchedAt: 1000, position: 10, finished: false };
    const same = { ...previous, watched: { ...previous.watched, lastAt: 99999 }, history: { ...previous.history! } };
    expect(watchChanged(previous, same)).toBe(false);
    // lastAt 每次心跳都会变，但那不构成“有新信息”。
    expect(watchChanged(undefined, same)).toBe(true);
  });

  it('writes as soon as the position, the accumulated time or the metadata moves', () => {
    const previous = record();
    previous.watched = { ...previous.watched, visits: 1, secondsWatched: 10 };
    previous.history = { watchedAt: 1000, position: 10, finished: false };
    const seeked = { ...previous, history: { ...previous.history!, position: 42 } };
    expect(watchChanged(previous, seeked)).toBe(true);
    const further = { ...previous, watched: { ...previous.watched, secondsWatched: 30, maxProgressRatio: 0.05 } };
    expect(watchChanged(previous, further)).toBe(true);
    const completed = { ...previous, watched: { ...previous.watched, completed: true } };
    expect(watchChanged(previous, completed)).toBe(true);
    const filled = { ...previous, title: '真正的标题', owner: 'UP主' };
    expect(watchChanged(previous, filled)).toBe(true);
  });

  it('starts from zero for a new video (B站 SPA reset)', () => {
    const firstVideo = computeProgress(0, 600, 600);
    expect(firstVideo.completed).toBe(true);
    // Switching video resets the accumulator, so the next video starts at 0%.
    const secondVideo = computeProgress(0, 5, 600);
    expect(secondVideo.progressRatio).toBeCloseTo(5 / 600, 5);
    expect(secondVideo.completed).toBe(false);
  });
});
