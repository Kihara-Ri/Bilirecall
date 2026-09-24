/**
 * Playback accounting. A video only counts as finished once 90% of its duration has
 * actually been played, and progress is always measured per video (B站 is an SPA, so a
 * single page session can cover several videos).
 */
import type { VideoRecord } from './types';

export const COMPLETION_RATIO = 0.9;

export interface WatchProgress {
  secondsWatched: number;
  progressRatio: number;
  completed: boolean;
}

/**
 * 一次心跳是否值得写库：位置与累计观看都没变（视频暂停、标签页在后台）时不写。
 * 以前每 10 秒无条件 upsert 一次，既唤醒 service worker，又把界面轮询用的归档版本号
 * 一直顶掉 —— 打开管理页时每 10 秒重读整份归档。暂停不是新信息，没必要记。
 *
 * lastAt 不参与比较：心跳每次都带新的 `at`，比它等于永远都“变了”。
 * 真正驱动写入的是播放位置与累计秒数；位置不变说明这一段时间没有新内容。
 */
export function watchChanged(previous: VideoRecord | undefined, next: VideoRecord): boolean {
  if (!previous) return true;
  const before = previous.watched;
  const after = next.watched;
  if (!before) return true;
  return (
    before.visits !== after.visits ||
    before.secondsWatched !== after.secondsWatched ||
    before.maxProgressRatio !== after.maxProgressRatio ||
    before.completed !== after.completed ||
    (previous.history?.position ?? 0) !== (next.history?.position ?? 0) ||
    previous.title !== next.title ||
    previous.owner !== next.owner ||
    previous.duration !== next.duration
  );
}

export function computeProgress(previousMaxSeconds: number, currentTime: number, duration: number): WatchProgress {
  const secondsWatched = Math.max(previousMaxSeconds, Number.isFinite(currentTime) ? Math.max(0, Math.floor(currentTime)) : 0);
  const usable = Number.isFinite(duration) && duration > 0;
  const progressRatio = usable ? Math.min(1, secondsWatched / duration) : 0;
  return { secondsWatched, progressRatio, completed: usable && progressRatio >= COMPLETION_RATIO };
}
