import { describe, expect, it } from 'vitest';
import { COMPLETION_RATIO, computeProgress } from '../src/lib/watch';

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

  it('starts from zero for a new video (B站 SPA reset)', () => {
    const firstVideo = computeProgress(0, 600, 600);
    expect(firstVideo.completed).toBe(true);
    // Switching video resets the accumulator, so the next video starts at 0%.
    const secondVideo = computeProgress(0, 5, 600);
    expect(secondVideo.progressRatio).toBeCloseTo(5 / 600, 5);
    expect(secondVideo.completed).toBe(false);
  });
});
