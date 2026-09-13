/**
 * MAIN-world hook. Runs inside the page before the player boots and records:
 *   1. the exact `/x/player/wbi/v2` response the player used (authoritative subtitle tracks);
 *   2. video metadata from `__INITIAL_STATE__` and `/x/web-interface/(wbi/)view`
 *      (B站 通常把标题/UP主 服务端渲染进页面，不一定会再发一次 view 请求);
 *   3. like / coin / favorite / share requests.
 *
 * It removes the "same bvid/cid, different subtitles" problem at the source instead of
 * trusting a separate API call, and gives reliable title/uploader names.
 */
(() => {
  const SOURCE = 'bilivault-main';

  const PLAYER_PATHS = ['/x/player/wbi/v2', '/x/player/v2'];
  const VIEW_PATHS = ['/x/web-interface/wbi/view', '/x/web-interface/view/detail', '/x/web-interface/view'];
  const ACTION_PATHS = [
    '/x/web-interface/archive/like',
    '/x/web-interface/coin/add',
    '/x/web-interface/share/add',
    '/x/v3/fav/resource/deal',
  ];

  function match(url: string, paths: string[]): boolean {
    return paths.some((p) => url.includes(p));
  }

  function post(type: string, payload: unknown): void {
    try {
      window.postMessage({ source: SOURCE, type, payload }, '*');
    } catch {
      /* ignore */
    }
  }

  function tracksFromPlayer(data: any, endpoint: string) {
    const list = data?.subtitle?.subtitles;
    if (!Array.isArray(list)) return [];
    return list
      .map((item: any) => ({
        id: String(item?.id_str ?? item?.id ?? ''),
        language: typeof item?.lan === 'string' ? item.lan : '',
        label: typeof item?.lan_doc === 'string' && item.lan_doc ? item.lan_doc : String(item?.lan ?? ''),
        url: typeof item?.subtitle_url === 'string' ? item.subtitle_url : '',
        endpoint,
        source: 'page' as const,
        isAI: String(item?.lan ?? '').startsWith('ai-') || item?.ai_type !== undefined,
      }))
      .filter((t: any) => t.id && t.language && t.url);
  }

  function inspectPlayerText(text: string, endpoint: string): void {
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const data = payload?.data;
    if (!data?.cid || !data?.aid) return;
    post('page-snapshot', {
      identity: {
        bvid: String(data.bvid ?? ''),
        aid: Number(data.aid),
        cid: Number(data.cid),
        page: Number(data.page_no ?? 1) || 1,
      },
      tracks: tracksFromPlayer(data, endpoint),
      needLoginSubtitle: Boolean(data.need_login_subtitle),
      endpoint,
      url: location.href,
      at: Date.now(),
    });
  }

  /** `/x/web-interface/view/detail` wraps the payload in `View`. */
  function unwrapView(data: any): any {
    if (data && typeof data === 'object' && data.View) return data.View;
    return data;
  }

  function inspectViewText(text: string): void {
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const data = unwrapView(payload?.data);
    if (!data?.bvid || !data?.aid) return;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const first = pages[0] ?? { cid: data.cid, part: '', duration: data.duration };
    if (!first?.cid) return;
    emitVideo({
      identity: { bvid: String(data.bvid), aid: Number(data.aid), cid: Number(first.cid), page: 1 },
      title: String(data.title ?? ''),
      owner: String(data.owner?.name ?? ''),
      ownerMid: Number(data.owner?.mid) || undefined,
      cover: String(data.pic ?? ''),
      category: String(data.tname ?? ''),
      duration: Number(first.duration ?? data.duration ?? 0),
      pubdate: Number(data.pubdate ?? 0),
      description: String(data.desc ?? ''),
      url: location.href,
      at: Date.now(),
    });
  }

  /** B站 服务端渲染的视频数据；标题与 UP主 几乎总是来自这里。 */
  function fromInitialState(): any | null {
    const state = (window as any).__INITIAL_STATE__;
    const v = state?.videoData;
    if (!v?.bvid || !v?.aid) return null;
    const pages = Array.isArray(v.pages) ? v.pages : [];
    const cid = Number(v.cid ?? pages[0]?.cid ?? 0);
    if (!cid) return null;
    return {
      identity: { bvid: String(v.bvid), aid: Number(v.aid), cid, page: 1 },
      title: String(v.title ?? ''),
      owner: String(v.owner?.name ?? ''),
      ownerMid: Number(v.owner?.mid) || undefined,
      cover: String(v.pic ?? ''),
      category: String(v.tname ?? ''),
      duration: Number(v.duration ?? pages[0]?.duration ?? 0),
      pubdate: Number(v.pubdate ?? 0),
      description: String(v.desc ?? ''),
      url: location.href,
      at: Date.now(),
    };
  }

  let lastEmitted = '';

  /** Emit only when the video changes, or when we learn a title/UP主 we did not have. */
  function emitVideo(video: any): void {
    if (!video?.identity?.bvid) return;
    const fingerprint = [video.identity.bvid, video.identity.cid, video.title, video.owner, video.cover].join('|');
    if (fingerprint === lastEmitted) return;
    lastEmitted = fingerprint;
    post('page-video', video);
  }

  function inspectAction(url: string, body: string | undefined, responseText: string | undefined): void {
    let payload: any = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = null;
      }
    }
    if (!payload || payload.code !== 0) return;
    post('action', { url, body: body ?? '', at: Date.now() });
  }

  // ---- fetch ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      const result = originalFetch.call(window, input as RequestInfo, init);
      void result
        .then((response) => {
          const handled = match(url, PLAYER_PATHS) || match(url, VIEW_PATHS) || match(url, ACTION_PATHS);
          if (!handled) return;
          void response
            .clone()
            .text()
            .then((text) => {
              if (match(url, PLAYER_PATHS)) inspectPlayerText(text, url);
              else if (match(url, VIEW_PATHS)) inspectViewText(text);
              else inspectAction(url, bodyText, text);
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
      return result;
    };
  }

  // ---- XMLHttpRequest ----
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest & { __bvUrl?: string }, method: string, url: string | URL, ...rest: any[]) {
    this.__bvUrl = typeof url === 'string' ? url : url.href;
    // @ts-expect-error forwarding the original overload
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest & { __bvUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__bvUrl ?? '';
    if (match(url, PLAYER_PATHS) || match(url, VIEW_PATHS) || match(url, ACTION_PATHS)) {
      this.addEventListener('load', () => {
        const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        if (match(url, PLAYER_PATHS)) inspectPlayerText(text, url);
        else if (match(url, VIEW_PATHS)) inspectViewText(text);
        else inspectAction(url, typeof body === 'string' ? body : undefined, text);
      });
    }
    return originalSend.call(this, body as XMLHttpRequestBodyInit | null);
  };

  // ---- server-rendered state (and SPA navigations) ----
  let attempts = 0;
  const tick = () => {
    const video = fromInitialState();
    if (video) emitVideo(video);
    attempts += 1;
    const delay = attempts < 20 ? 500 : 2500;
    setTimeout(tick, delay);
  };
  tick();
})();
