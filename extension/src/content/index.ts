import type { ActionSignal } from '../lib/events';
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
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; payload?: any };
  if (!data || data.source !== 'bilivault-main') return;
  if (data.type === 'page-snapshot') {
    const payload = data.payload as PageSnapshotPayload;
    lastSnapshot = payload;
    if (payload.identity?.cid) resetProgressFor(identityKey(payload.identity));
    send({ type: 'page-snapshot', payload });
  } else if (data.type === 'page-video') {
    const payload = data.payload as PageVideoPayload;
    lastVideo = payload;
    send({ type: 'page-video', payload });
  } else if (data.type === 'action') {
    const parsed = classifyAction(data.payload?.url ?? '', data.payload?.body ?? '');
    if (parsed) send({ type: 'action', payload: parsed });
  }
});

// Kept local (a copy of the small classifier) so the content script has no build-time dependency cycle.
function classifyAction(rawUrl: string, rawBody: string): ActionSignal | null {
  const path = (() => {
    try {
      return new URL(rawUrl, 'https://api.bilibili.com').pathname;
    } catch {
      return '';
    }
  })();
  const body = new URLSearchParams(rawBody ?? '');
  const bvid = body.get('bvid') ?? undefined;
  const now = Date.now();
  switch (path) {
    case '/x/web-interface/archive/like': {
      const like = body.get('like');
      if (like !== '0' && like !== '1') return null;
      return { kind: like === '1' ? 'like' : 'unlike', endpoint: 'like', at: now, active: like === '1', bvid };
    }
    case '/x/web-interface/coin/add': {
      const multiply = Number(body.get('multiply') ?? '1');
      return { kind: 'coin', endpoint: 'coin', at: now, multiply, active: true, bvid };
    }
    case '/x/web-interface/share/add':
      return { kind: 'share', endpoint: 'share', at: now, active: true, bvid };
    case '/x/v3/fav/resource/deal': {
      const active = Boolean(body.get('add_media_ids')?.length);
      if (!active && !body.get('del_media_ids')) return null;
      return { kind: active ? 'favorite' : 'unfavorite', endpoint: 'favorite', at: now, active, bvid };
    }
    default:
      return null;
  }
}

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

  const needsMetadata = !lastVideo || lastVideo.identity.bvid !== identity.bvid || !lastVideo.owner || !lastVideo.title;
  if (needsMetadata && currentKey !== domReportedFor) {
    const meta = domMetadata(identity);
    if (meta && (meta.title || meta.owner)) {
      domReportedFor = currentKey;
      send({ type: 'page-video', payload: meta });
    }
  }

  const video = document.querySelector('video');
  if (!video) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : lastVideo?.duration ?? 0;
  const progress = computeProgress(maxSeconds, video.currentTime, duration);
  maxSeconds = progress.secondsWatched;
  send({
    type: 'watch',
    payload: {
      identity,
      url: location.href,
      secondsWatched: progress.secondsWatched,
      progressRatio: progress.progressRatio,
      completed: progress.completed,
      at: Date.now(),
      visits: sentVisit ? 0 : 1,
    },
  });
  sentVisit = true;
}

setInterval(heartbeat, 10000);
window.addEventListener('load', heartbeat);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) heartbeat();
});
heartbeat();
