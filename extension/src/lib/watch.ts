/**
 * Playback accounting. A video only counts as finished once 90% of its duration has
 * actually been played, and progress is always measured per video (B站 is an SPA, so a
 * single page session can cover several videos).
 */
export const COMPLETION_RATIO = 0.9;

export interface WatchProgress {
  secondsWatched: number;
  progressRatio: number;
  completed: boolean;
}

export function computeProgress(previousMaxSeconds: number, currentTime: number, duration: number): WatchProgress {
  const secondsWatched = Math.max(previousMaxSeconds, Number.isFinite(currentTime) ? Math.max(0, Math.floor(currentTime)) : 0);
  const usable = Number.isFinite(duration) && duration > 0;
  const progressRatio = usable ? Math.min(1, secondsWatched / duration) : 0;
  return { secondsWatched, progressRatio, completed: usable && progressRatio >= COMPLETION_RATIO };
}
