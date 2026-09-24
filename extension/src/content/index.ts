import { actionFromBridge, sanitizeSnapshot, sanitizeVideo } from '../lib/bridge';
import { computeProgress } from '../lib/watch';
import type { ContentMessage, PageIdentity, PageSnapshotPayload, PageVideoPayload } from '../lib/messages';

/**
 * ISOLATED-world bridge: forwards observations from the MAIN-world hook to the service
 * worker, and reports playback progress for the watched history.
 */

let lastSnapshot: PageSnapshotPayload | null = null;
let lastVideo: PageVideoPayload | null = null;
let currentKey = '';
let maxSeconds = 0;
let sentVisit = false;
let domReportedFor = '';
/**
 * 上一次真正发出去的心跳值。暂停时每 10 秒的值完全一样，重复上报只会唤醒 service worker
 * 并让它写一次存储（归档版本号被顶掉，界面跟着重读整份归档）。没有新信息就不发。
 */
let lastSent: { key: string; seconds: number; position: number; completed: boolean } | null = null;

function send(message: ContentMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

const identityKey = (identity: PageIdentity): string => `${identity.bvid}:${identity.cid}`;

function currentIdentity(): PageIdentity | null {
  if (lastSnapshot?.identity?.cid) return lastSnapshot.identity;
  if (lastVideo?.identity?.cid) return lastVideo.identity;
  return null;
}

/**
 * Progress is tracked per video: B站 是 SPA，切换视频不会重新加载脚本，所以上一支视频的
 * 观看时长必须清零，否则新视频会立刻显示“已看完”。
 */
function resetProgressFor(key: string): void {
  if (key === currentKey) return;
  currentKey = key;
  maxSeconds = 0;
  sentVisit = false;
  domReportedFor = '';
  lastSent = null;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (!data || data.source !== 'bilivault-main') return;
  // MAIN world 的 `source` 字段谁都能写：同一页面上的任何脚本都能伪造这些消息。
  // 所以每个 payload 先过 lib/bridge 校验与截断，形状不对就什么都不做。
  if (data.type === 'page-snapshot') {
    const payload = sanitizeSnapshot(data.payload);
    if (!payload) return;
    lastSnapshot = payload;
    resetProgressFor(identityKey(payload.identity));
    send({ type: 'page-snapshot', payload });
  } else if (data.type === 'page-video') {
    const payload = sanitizeVideo(data.payload);
    if (!payload) return;
    lastVideo = payload;
    send({ type: 'page-video', payload });
  } else if (data.type === 'action') {
    const payload = actionFromBridge(data.payload);
    if (payload) send({ type: 'action', payload });
  }
});

/** Last-resort metadata from the DOM, for pages where the state/API hook found nothing. */
function domMetadata(identity: PageIdentity): PageVideoPayload | null {
  const title = (document.querySelector('h1.video-title')?.textContent ?? document.title.replace(/_哔哩哔哩.*$/, '')).trim();
  const owner = (document.querySelector('.up-name')?.textContent ?? document.querySelector('.up-info--name')?.textContent ?? '').trim();
  const videoEl = document.querySelector('video');
  const duration = videoEl && Number.isFinite(videoEl.duration) ? Math.round(videoEl.duration) : 0;
  if (!title && !owner) return null;
  return { identity, title, owner, duration, url: location.href, at: Date.now() };
}

// Playback heartbeat. Visits are counted once per video.
function heartbeat(): void {
  const identity = currentIdentity();
  if (!identity) return;
  resetProgressFor(identityKey(identity));

  const video = document.querySelector('video');
  // 后台标签页里暂停（或还没开始）的视频不会产生新信息：既不唤醒 service worker，也不写归档。
  if (document.hidden && (!video || video.paused)) return;

  const needsMetadata = !lastVideo || lastVideo.identity.bvid !== identity.bvid || !lastVideo.owner || !lastVideo.title;
  if (needsMetadata && currentKey !== domReportedFor) {
    const meta = domMetadata(identity);
    if (meta && (meta.title || meta.owner)) {
      domReportedFor = currentKey;
      send({ type: 'page-video', payload: meta });
    }
  }

  if (!video) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : lastVideo?.duration ?? 0;
  const progress = computeProgress(maxSeconds, video.currentTime, duration);
  maxSeconds = progress.secondsWatched;
  const position = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
  const changed =
    !lastSent ||
    lastSent.key !== currentKey ||
    lastSent.seconds !== progress.secondsWatched ||
    lastSent.position !== position ||
    lastSent.completed !== progress.completed;
  // 首次（访问计数还没送出去）一定要发一次；之后只在真的变了才发。
  if (!changed && sentVisit) return;
  send({
    type: 'watch',
    payload: {
      identity,
      url: location.href,
      secondsWatched: progress.secondsWatched,
      position,
      progressRatio: progress.progressRatio,
      completed: progress.completed,
      at: Date.now(),
      visits: sentVisit ? 0 : 1,
    },
  });
  lastSent = { key: currentKey, seconds: progress.secondsWatched, position, completed: progress.completed };
  sentVisit = true;
}

setInterval(heartbeat, 10000);
window.addEventListener('load', heartbeat);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) heartbeat();
});
heartbeat();
