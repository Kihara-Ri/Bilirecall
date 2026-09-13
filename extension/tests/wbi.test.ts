import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIXIN_KEY_ENC_TAB, encodeWbiParams, getMixinKey, keyFromUrl, signWbi } from '../src/lib/wbi';

const REAL_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const REAL_SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

/** Independent re-implementation (node:crypto MD5) to cross-check the shipped one. */
function referenceSign(params: Record<string, string | number>, imgKey: string, subKey: string, wts: number): string {
  const orig = imgKey + subKey;
  const mixin = MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32);
  const values: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(wts) };
  const query = Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(values[key].replace(/[!'()*]/g, ''))}`)
    .join('&');
  return createHash('md5').update(query + mixin).digest('hex');
}

describe('WBI signing', () => {
  it('derives the mixin key the real API derives', () => {
    // Captured from a live api.bilibili.com/x/web-interface/nav call during development.
    const mixin = getMixinKey(keyFromUrl(REAL_IMG), keyFromUrl(REAL_SUB));
    expect(mixin).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('produces the same w_rid as an independent implementation', () => {
    const params = { bvid: 'BV139bD6gEa8', aid: 117104095268420, cid: 40960721402, isGaiaAvoided: 'false', web_location: '1315873' };
    const imgKey = keyFromUrl(REAL_IMG);
    const subKey = keyFromUrl(REAL_SUB);
    const now = 1_700_000_000;
    const signed = signWbi(params, imgKey, subKey, now);
    expect(signed.wts).toBe(String(now));
    expect(signed.w_rid).toBe(referenceSign(params, imgKey, subKey, now));
    expect(signed.w_rid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sorts keys and strips forbidden characters', () => {
    const query = encodeWbiParams({ b: '2', a: "1!'()*", c: 3 });
    expect(query).toBe('a=1&b=2&c=3');
  });

  it('rejects malformed keys', () => {
    expect(() => getMixinKey('short', 'short')).toThrow();
  });
});
