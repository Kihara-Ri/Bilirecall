import { describe, expect, it } from 'vitest';
import { BiliClient } from '../src/lib/bili';
import { IdentityMismatch, LoginRequired, UnstableSubtitle } from '../src/lib/errors';
import { binaryResponse, encodeSubtitleProto, jsonResponse, makeInfo, makeTrack, mockFetch, subtitleBody } from './helpers';

const noopSleep = async () => undefined;

const NAV = () =>
  jsonResponse({
    code: 0,
    data: {
      isLogin: true,
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  });

function playerData(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    code: 0,
    data: {
      aid: 123456,
      cid: 789,
      bvid: 'BV1xx411c7mD',
      need_login_subtitle: false,
      subtitle: { subtitles: [] },
      ...overrides,
    },
  });
}

describe('BiliClient subtitle resolution', () => {
  it('requires independent reads to agree before returning a subtitle', async () => {
    let reads = 0;
    const http = mockFetch((url) => {
      if (url.includes('/bfs/subtitle/a.json')) {
        reads += 1;
        return jsonResponse(subtitleBody('hello', 'world'));
      }
      return undefined;
    });
    const result = await new BiliClient(http).resolveSubtitle(makeInfo(), { pageTracks: [makeTrack()], sleep: noopSleep });
    expect(reads).toBe(2);
    expect(result.observations).toBe(2);
    expect(result.plainText).toBe('hello\nworld');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to trust a subtitle when the server keeps returning different bodies', async () => {
    let reads = 0;
    const http = mockFetch((url) => {
      if (url.includes('/bfs/subtitle/a.json')) {
        reads += 1;
        return jsonResponse(subtitleBody(`random-${reads}`));
      }
      return undefined;
    });
    await expect(
      new BiliClient(http).resolveSubtitle(makeInfo(), { pageTracks: [makeTrack()], sleep: noopSleep, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(UnstableSubtitle);
    expect(reads).toBe(3);
  });

  it('accepts a majority when two of three reads agree', async () => {
    const bodies = ['A', 'B', 'A'];
    let index = 0;
    const http = mockFetch(() => jsonResponse(subtitleBody(bodies[Math.min(index++, bodies.length - 1)])));
    const result = await new BiliClient(http).resolveSubtitle(makeInfo(), { pageTracks: [makeTrack()], sleep: noopSleep, maxAttempts: 4 });
    expect(result.observations).toBe(2);
    expect(result.plainText).toBe('A');
  });

  it('signs the player request with WBI', async () => {
    let seen = '';
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) return NAV();
      if (url.includes('/x/player/wbi/v2')) {
        seen = url;
        return jsonResponse({
          code: 0,
          data: {
            aid: 123456,
            cid: 789,
            bvid: 'BV1xx411c7mD',
            subtitle: { subtitles: [{ id: 1, id_str: '1', lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/a.json' }] },
          },
        });
      }
      return undefined;
    });
    const snapshot = await new BiliClient(http).player(makeInfo());
    expect(seen).toContain('w_rid=');
    expect(seen).toContain('wts=');
    expect(seen).toContain('isGaiaAvoided=false');
    expect(seen).toContain('web_location=1315873');
    expect(snapshot.tracks).toHaveLength(1);
  });

  it('still reads WBI keys when nav answers -101 (anonymous)', async () => {
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: -101,
          message: '账号未登录',
          data: {
            isLogin: false,
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        });
      }
      if (url.includes('/x/player/wbi/v2')) return playerData({ need_login_subtitle: true });
      return undefined;
    });
    const client = new BiliClient(http);
    const nav = await client.nav();
    expect(nav.isLogin).toBe(false);
    expect(nav.imgUrl).toContain('7cd08494');
    const snapshot = await client.player(makeInfo());
    expect(snapshot.needLoginSubtitle).toBe(true);
  });

  it('rejects player data whose cid/aid does not match the request', async () => {
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) return NAV();
      if (url.includes('/x/player/wbi/v2')) return playerData({ cid: 999 });
      return undefined;
    });
    await expect(new BiliClient(http).player(makeInfo())).rejects.toBeInstanceOf(IdentityMismatch);
  });

  it('reports login required instead of "no subtitles"', async () => {
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) return NAV();
      if (url.includes('/x/player/wbi/v2')) return playerData({ need_login_subtitle: true });
      return undefined;
    });
    await expect(new BiliClient(http).resolveSubtitle(makeInfo(), { sleep: noopSleep })).rejects.toBeInstanceOf(LoginRequired);
  });

  it('refreshes the same track when the signed URL expires', async () => {
    const pageTracks = [makeTrack({ url: 'https://aisubtitle.hdslb.com/bfs/subtitle/old.json' })];
    let playerCalls = 0;
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) return NAV();
      if (url.includes('/x/player/wbi/v2')) {
        playerCalls += 1;
        return jsonResponse({
          code: 0,
          data: {
            aid: 123456,
            cid: 789,
            bvid: 'BV1xx411c7mD',
            subtitle: { subtitles: [{ id: 1, id_str: '1', lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/new.json' }] },
          },
        });
      }
      if (url.includes('old.json')) return jsonResponse({}, 403);
      if (url.includes('new.json')) return jsonResponse(subtitleBody('fresh'));
      return undefined;
    });
    const result = await new BiliClient(http).resolveSubtitle(makeInfo(), { pageTracks, sleep: noopSleep });
    expect(playerCalls).toBe(1);
    expect(result.track.id).toBe('1');
    expect(result.track.language).toBe('ai-zh');
    expect(result.plainText).toBe('fresh');
  });

  it('falls back to the binary endpoint when the player has no tracks', async () => {
    const proto = encodeSubtitleProto([
      { id: 1, idStr: '1', lan: 'ai-zh', lanDoc: '中文（自动生成）', url: '//aisubtitle.hdslb.com/bfs/subtitle/proto.json' },
    ]);
    const http = mockFetch((url) => {
      if (url.includes('/x/web-interface/nav')) return NAV();
      if (url.includes('/x/player/wbi/v2')) return playerData();
      if (url.includes('/x/v2/subtitle/web/view')) return binaryResponse(proto);
      if (url.includes('proto.json')) return jsonResponse(subtitleBody('proto text'));
      return undefined;
    });
    const result = await new BiliClient(http).resolveSubtitle(makeInfo(), { sleep: noopSleep });
    expect(result.track.source).toBe('proto');
    expect(result.plainText).toBe('proto text');
  });

  it('clamps overshooting cues while reporting the subtitle', async () => {
    const http = mockFetch(() =>
      jsonResponse({ body: [{ from: 0, to: 1, content: 'ok' }, { from: 500, to: 99999, content: 'overshoot' }] }),
    );
    const result = await new BiliClient(http).resolveSubtitle(makeInfo({ duration: 600 }), { pageTracks: [makeTrack()], sleep: noopSleep });
    expect(result.segments[1].to).toBe(600);
    expect(result.warnings.join(' ')).toContain('裁剪');
  });
});
