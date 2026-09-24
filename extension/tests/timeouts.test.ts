import { afterEach, describe, expect, it, vi } from 'vitest';
import { PING_TIMEOUT_MS, SUMMARY_TIMEOUT_MS, pingAi, summarize } from '../src/lib/ai';
import { REQUEST_TIMEOUT_MS, type FetchLike } from '../src/lib/http';
import { DEFAULT_TIMEOUT_MS, SYNC_TIMEOUT_MS } from '../src/lib/messages';
import { COVER_TIMEOUT_MS, NOTION_TIMEOUT_MS, NOTION_VERSION, NotionClient, UPLOAD_TIMEOUT_MS } from '../src/lib/notion';
import { newRecord } from '../src/lib/store';
import { DEFAULT_SETTINGS, type Settings, type VideoRecord } from '../src/lib/types';

/**
 * 外部请求必须有超时，否则流水线（整条跑在按记录锁里）会被一个挂住的端点拖死，
 * 同一视频的笔记保存与互动刷新会先撞上 UI 的 15 秒预算，报出「后台响应超时」。
 */

function makeRecord(): VideoRecord {
  return newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 123456,
    cid: 789,
    title: 'T',
    owner: 'U',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  });
}

const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, enabled: true, apiKey: 'k', baseUrl: 'https://ai.example.com/v1' },
});

/** 记录每次请求拿到的 init，并像真实 fetch 一样在 signal 中止时 reject。 */
function hangingFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const http: FetchLike = (url, init) =>
    new Promise<Response>((_resolve, reject) => {
      calls.push({ url, init });
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  return { http, calls };
}

/** 把 AbortSignal.timeout 换成一个 10ms 的超时，同时记录调用方要求的上限。 */
function shrinkTimeouts() {
  const requested: number[] = [];
  // 先抓住真实现：mock 里再调 AbortSignal.timeout 会递归回自己。
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms?: number) => {
    requested.push(ms ?? 0);
    return real(10);
  });
  return requested;
}

afterEach(() => vi.restoreAllMocks());

describe('external request timeouts', () => {
  it('gives up on a silent AI endpoint and says so', async () => {
    const requested = shrinkTimeouts();
    const { http, calls } = hangingFetch();
    await expect(summarize(makeRecord(), settings(), http)).rejects.toThrow(/AI 端点 60 秒内没有响应/);
    expect(requested).toEqual([SUMMARY_TIMEOUT_MS]);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds the AI connectivity test too', async () => {
    const requested = shrinkTimeouts();
    const { http } = hangingFetch();
    await expect(pingAi(settings(), http)).rejects.toThrow(/没有响应/);
    expect(requested).toEqual([PING_TIMEOUT_MS]);
  });

  it('bounds Notion and keeps the "check the remote page" warning', async () => {
    const requested = shrinkTimeouts();
    const { http } = hangingFetch();
    const client = new NotionClient('token', http, async () => undefined);
    await expect(client.request('GET', '/users/me')).rejects.toThrow(/核对远端页面/);
    // 429 重试也要走同一个上限，不能一次请求等两次。
    expect(requested).toEqual([NOTION_TIMEOUT_MS]);
  });

  it('bounds the cover download as well', async () => {
    const requested = shrinkTimeouts();
    const { http } = hangingFetch();
    const record = makeRecord();
    record.cover = 'https://i0.hdslb.com/bfs/archive/cover.jpg';
    // 封面失败要退回外链封面，不能把整条写入拖住。
    await expect(new NotionClient('token', http, async () => undefined).prepareCover(record)).resolves.toEqual({
      type: 'external',
      external: { url: record.cover },
    });
    expect(requested).toEqual([COVER_TIMEOUT_MS]);
  });

  it('keeps every request below the UI budget', () => {
    // 单次请求必须能在界面放弃之前失败，否则用户会看到「后台响应超时」，而请求还在跑。
    for (const budget of [REQUEST_TIMEOUT_MS, PING_TIMEOUT_MS, SUMMARY_TIMEOUT_MS, NOTION_TIMEOUT_MS, COVER_TIMEOUT_MS, UPLOAD_TIMEOUT_MS]) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThan(SYNC_TIMEOUT_MS);
    }
    // 普通消息（笔记保存、设置、读记录）只等 15 秒，够简单请求用。
    expect(DEFAULT_TIMEOUT_MS).toBe(REQUEST_TIMEOUT_MS);
    expect(NOTION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
