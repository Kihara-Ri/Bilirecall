import type { Track } from '../src/lib/subtitle';
import type { VideoInfo } from '../src/lib/bili';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function binaryResponse(bytes: Uint8Array | number[], status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': 'application/octet-stream' } });
}

export type Route = (url: string, init?: RequestInit) => Response | undefined;

export function mockFetch(routes: Route): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const response = routes(input, init);
    if (!response) throw new Error(`unexpected fetch: ${input}`);
    return response;
  };
}

export function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

export function fieldVarint(no: number, value: number | bigint): number[] {
  return [...varint((no << 3) | 0), ...varint(value)];
}

export function fieldBytes(no: number, bytes: number[] | Uint8Array): number[] {
  const arr = Array.from(bytes);
  return [...varint((no << 3) | 2), ...varint(arr.length), ...arr];
}

export function fieldString(no: number, value: string): number[] {
  return fieldBytes(no, Array.from(new TextEncoder().encode(value)));
}

export function encodeSubtitleProto(
  items: Array<{ id: number; idStr: string; lan: string; lanDoc: string; url: string }>,
): Uint8Array {
  const data: number[] = [];
  for (const item of items) {
    const track = [
      ...fieldVarint(1, item.id),
      ...fieldString(2, item.idStr),
      ...fieldString(3, item.lan),
      ...fieldString(4, item.lanDoc),
      ...fieldString(5, item.url),
    ];
    data.push(...fieldBytes(3, track));
  }
  return new Uint8Array(fieldBytes(1, data));
}

export function makeInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    bvid: 'BV1xx411c7mD',
    aid: 123456,
    cid: 789,
    page: 1,
    title: '测试视频',
    part: 'P1',
    owner: '测试UP',
    cover: '',
    category: '科技',
    duration: 600,
    pubdate: 1700000000,
    description: '简介',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    tags: [],
    ...overrides,
  };
}

export function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: '1',
    language: 'ai-zh',
    label: '中文（自动生成）',
    url: 'https://aisubtitle.hdslb.com/bfs/subtitle/a.json',
    endpoint: '/x/player/wbi/v2',
    source: 'page',
    isAI: true,
    ...overrides,
  };
}

export function subtitleBody(...contents: string[]): unknown {
  return { body: contents.map((content, i) => ({ from: i, to: i + 0.9, content })) };
}
