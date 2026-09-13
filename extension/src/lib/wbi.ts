import { md5Hex } from './hash';

/**
 * WBI signature (B站 风控签名).
 * Reference: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md
 * Cross-checked against yt-dlp's `_sign_wbi` and the fixed test vector in tests/wbi.test.ts.
 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/** imgKey + subKey are the file names (without extension) of `wbi_img.img_url` / `wbi_img.sub_url`. */
export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  if (orig.length < 64) throw new Error('WBI 密钥格式不正确');
  return MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32);
}

export function keyFromUrl(url: string): string {
  const path = url.split('/').pop() ?? '';
  return path.split('.')[0] ?? '';
}

export function wbiKeysFromNav(nav: { wbi_img?: { img_url?: string; sub_url?: string } }): { imgKey: string; subKey: string } {
  const imgKey = keyFromUrl(nav.wbi_img?.img_url ?? '');
  const subKey = keyFromUrl(nav.wbi_img?.sub_url ?? '');
  if (!imgKey || !subKey) throw new Error('nav 未返回 wbi 密钥');
  return { imgKey, subKey };
}

export function encodeWbiParams(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]).replace(/[!'()*]/g, ''))}`)
    .join('&');
}

/** Adds `wts` and `w_rid` to a copy of params. */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  nowSeconds?: number,
): Record<string, string> {
  const mixinKey = getMixinKey(imgKey, subKey);
  const withTs: Record<string, string | number> = { ...params, wts: Math.floor(nowSeconds ?? Date.now() / 1000) };
  const query = encodeWbiParams(withTs);
  return { ...Object.fromEntries(Object.entries(withTs).map(([k, v]) => [k, String(v)])), w_rid: md5Hex(query + mixinKey) };
}
