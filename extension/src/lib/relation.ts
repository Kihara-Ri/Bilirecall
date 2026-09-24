import { BiliVaultError, LoginRequired } from './errors';
import { REQUEST_TIMEOUT_MS, browserFetch, type FetchLike } from './http';

/**
 * Reads the like / coin / favorite state straight from B站's own API.
 *
 * Rationale: watching the page's requests only tells us what this browser did. Reading the
 * server state means a like given on the phone (or in another browser) shows up here too,
 * without maintaining any sync logic of our own.
 *
 * B站 has no per-user "share" state (sharing is not persisted server-side), so the share
 * icon stays a local observation — the UI labels it as such.
 */
const API = 'https://api.bilibili.com';

export interface ActionSnapshot {
  like: boolean;
  coin: number;
  favorite: boolean;
  fetchedAt: number;
  /** Which endpoint answered; kept for diagnostics and tests. */
  via: string;
  warnings: string[];
}

interface Json {
  code?: number;
  message?: string;
  data?: unknown;
}

async function get(http: FetchLike, path: string, params: Record<string, string | number>): Promise<Json> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const response = await http(`${API}${path}?${query}`, {
    headers: { Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
    credentials: 'include',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new BiliVaultError(`${path}: HTTP ${response.status}`);
  try {
    return (await response.json()) as Json;
  } catch {
    throw new BiliVaultError(`${path}: 返回的不是 JSON（可能触发风控）`);
  }
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

function asCoin(value: unknown): number | undefined {
  // Number(null/false/'') 都是零，但空字段不代表用户没有投币。
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}
/** The player's own "一键三连" state object. Returns null when the shape is unfamiliar. */
export function parseRelation(data: unknown): { like: boolean; coin: number; favorite: boolean } | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const like = asBool(record.like);
  const favorite = asBool(record.favorite);
  const coin = asCoin(record.coin ?? record.multiply);
  if (like === undefined || favorite === undefined || coin === undefined) return null;
  return { like, coin: Math.min(2, Math.max(0, Math.trunc(coin))), favorite };
}

/**
 * One request for all three states. If B站 ever changes the combined endpoint's shape we fall
 * back to the three documented single-purpose endpoints instead of reporting a wrong state.
 */
export async function fetchActions(
  bvid: string,
  aid: number,
  http: FetchLike = browserFetch,
): Promise<ActionSnapshot> {
  const warnings: string[] = [];
  const relation = await get(http, '/x/web-interface/archive/relation', { bvid, aid });
  if (relation.code === -101) throw new LoginRequired('未登录，无法从 B站 读取点赞 / 投币 / 收藏 状态');
  if (relation.code === 0) {
    const parsed = parseRelation(relation.data);
    if (parsed) return { ...parsed, fetchedAt: Date.now(), via: 'archive/relation', warnings };
    warnings.push('relation 接口字段有变化，已改用单项接口核对');
  } else {
    warnings.push(`relation 接口返回 code=${relation.code ?? '未知'}，已改用单项接口核对`);
  }

  const failures: string[] = [];
  const [like, coins, favoured] = await Promise.all([
    get(http, '/x/web-interface/archive/has/like', { bvid, aid }).catch((error) => {
      failures.push(`点赞：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    get(http, '/x/web-interface/archive/coins', { bvid, aid }).catch((error) => {
      failures.push(`投币：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    get(http, '/x/v2/fav/video/favoured', { bvid, aid }).catch((error) => {
      failures.push(`收藏：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
  ]);

  if (failures.length) throw new BiliVaultError(`无法读取 B站 操作状态（${failures.join('；')}）`);
  if (like?.code === -101 || coins?.code === -101 || favoured?.code === -101) {
    throw new LoginRequired('未登录，无法从 B站 读取点赞 / 投币 / 收藏 状态');
  }
  // 单项接口失败（风控 / 参数错误）时 data 里是默认的 0 / false，看起来像「没点过」。
  // 那不是确认过的否定，绝不能写进归档 —— 只信 code=0 的响应。
  const unconfirmed = [
    ['点赞', like],
    ['投币', coins],
    ['收藏', favoured],
  ].filter(([, item]) => (item as Json | null)?.code !== 0);
  if (unconfirmed.length) {
    const detail = unconfirmed.map(([name, item]) => `${name}接口 code=${(item as Json | null)?.code ?? '未知'}`).join('；');
    throw new BiliVaultError(`未能确认 B站 操作状态（${detail}）`);
  }
  const likeValue = asBool(like?.data);
  const coinValue = asCoin((coins?.data as { multiply?: unknown } | undefined)?.multiply);
  const favoriteValue = asBool((favoured?.data as { favoured?: unknown } | undefined)?.favoured);
  if (likeValue === undefined || favoriteValue === undefined || coinValue === undefined) {
    throw new BiliVaultError('单项接口返回了未知字段，未能确认 B站 操作状态');
  }
  warnings.push('使用单项接口读取：B站 的 has/like 对很久以前的点赞可能返回未点赞');
  return {
    like: likeValue,
    coin: Math.min(2, Math.max(0, Math.trunc(coinValue))),
    favorite: favoriteValue,
    fetchedAt: Date.now(),
    via: 'single-endpoints',
    warnings,
  };
}
