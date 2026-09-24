import { describe, expect, it } from 'vitest';
import { fetchActions, parseRelation } from '../src/lib/relation';
import { jsonResponse, mockFetch } from './helpers';

describe('parseRelation', () => {
  it.each([null, '', false])('does not turn an unknown coin value %s into zero', coin => {
    expect(parseRelation({ like: false, coin, multiply: coin, favorite: false })).toBeNull();
  });
  it('reads the player-style relation object', () => {
    expect(parseRelation({ like: true, coin: 2, favorite: false })).toEqual({ like: true, coin: 2, favorite: false });
  });

  it('accepts numeric flags and the multiply alias', () => {
    expect(parseRelation({ like: 1, multiply: 1, favorite: 0 })).toEqual({ like: true, coin: 1, favorite: false });
  });

  it('clamps coins to what B站 allows and rejects unknown shapes', () => {
    expect(parseRelation({ like: 0, coin: 9, favorite: 0 })?.coin).toBe(2);
    expect(parseRelation({ like: true })).toBeNull();
    expect(parseRelation(null)).toBeNull();
  });
});

describe('fetchActions', () => {
  it.each([null, '', false])('rejects an empty coin value %s from fallback', async multiply => {
    const http = mockFetch(url => jsonResponse(url.includes('archive/relation') ? { code: -400 } : { code: 0, data: url.includes('has/like') ? 0 : url.includes('coins') ? { multiply } : { favoured: false } }));
    await expect(fetchActions('BV1', 1, http)).rejects.toThrow(/未能确认/);
  });
  it.each(['has/like', 'archive/coins', 'fav/video/favoured'])('rejects default zero data carried by a failed %s response', async (failedPath) => {
    const http = mockFetch(url => {
      if (url.includes('archive/relation')) return jsonResponse({ code: -400 });
      const data = url.includes('has/like') ? 0 : url.includes('archive/coins') ? { multiply: 0 } : { favoured: false };
      return jsonResponse({ code: url.includes(failedPath) ? -412 : 0, data });
    });
    await expect(fetchActions('BV1', 1, http)).rejects.toThrow(/未能确认/);
  });

  it('answers from the combined endpoint in one request', async () => {
    const seen: string[] = [];
    const http = async (url: string) => {
      seen.push(url);
      return jsonResponse({ code: 0, data: { like: false, coin: 1, favorite: true } });
    };
    const snapshot = await fetchActions('BV1xx411c7mD', 123456, http);
    expect(snapshot).toMatchObject({ like: false, coin: 1, favorite: true, via: 'archive/relation' });
    expect(snapshot.warnings).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('archive/relation');
    expect(seen[0]).toContain('bvid=BV1xx411c7mD');
  });

  it('falls back to the three documented endpoints when the shape changes', async () => {
    const http = mockFetch((url) => {
      if (url.includes('archive/relation')) return jsonResponse({ code: 0, data: { unknown: true } });
      if (url.includes('has/like')) return jsonResponse({ code: 0, data: 1 });
      if (url.includes('archive/coins')) return jsonResponse({ code: 0, data: { multiply: 2 } });
      if (url.includes('fav/video/favoured')) return jsonResponse({ code: 0, data: { favoured: false } });
      return undefined;
    });
    const snapshot = await fetchActions('BV1', 1, http);
    expect(snapshot).toMatchObject({ like: true, coin: 2, favorite: false, via: 'single-endpoints' });
    expect(snapshot.warnings.join(' ')).toContain('has/like');
  });

  it('never invents a state when the account is not logged in', async () => {
    const http = async () => jsonResponse({ code: -101, message: '账号未登录' });
    await expect(fetchActions('BV1', 1, http)).rejects.toThrow(/未登录/);
  });

  it('names the endpoints that failed instead of guessing', async () => {
    const http = mockFetch((url) => (url.includes('relation') ? jsonResponse({ code: -400 }) : undefined));
    await expect(fetchActions('BV1', 1, http)).rejects.toThrow(/无法读取/);
  });

  it('refuses to report a state when the single endpoints answer oddly', async () => {
    const http = mockFetch((url) => (url.includes('relation') ? jsonResponse({ code: -400 }) : jsonResponse({ code: 0, data: null })));
    await expect(fetchActions('BV1', 1, http)).rejects.toThrow(/未知字段/);
  });
});
