import { BiliVaultError, TrackUnavailable } from './errors';
import { parseSubtitleTracks, type ProtoSubtitleItem } from './protobuf';
import { sha256Hex } from './hash';
import type { SubtitleSegment, SubtitleTrackMeta } from './types';

export type TrackSource = 'page' | 'player-wbi' | 'proto';

export interface Track extends SubtitleTrackMeta {
  url: string;
  endpoint: string;
  isAI: boolean;
}

/** Only B站-owned hosts are accepted. Anything else is rejected before a request is made. */
const HOST_SUFFIXES = ['hdslb.com', 'bilibili.com', 'biliapi.net'];

export function normalizeSubtitleUrl(url: string): string {
  return url.startsWith('//') ? 'https:' + url : url;
}

/** Rejects obfuscated/placeholder URLs (they carry percent-encoded control bytes). */
export function isUsableSubtitleUrl(url: string): boolean {
  if (!url) return false;
  const normalized = normalizeSubtitleUrl(url);
  if (!/^https:\/\//.test(normalized)) return false;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix))) return false;
  for (const match of normalized.matchAll(/%([0-9a-fA-F]{2})/g)) {
    const byte = parseInt(match[1], 16);
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return true;
}

export function extractPlayerTracks(data: unknown, endpoint: string, source: TrackSource): Track[] {
  const container = data as Record<string, unknown> | null;
  if (!container || typeof container !== 'object') return [];
  const subtitle = container.subtitle as Record<string, unknown> | undefined;
  let list: unknown = subtitle?.subtitles;
  if (!Array.isArray(list)) list = (container as Record<string, unknown>).subtitles;
  if (!Array.isArray(list)) return [];
  const tracks: Track[] = [];
  for (const raw of list) {
    const item = raw as Record<string, unknown>;
    const url = typeof item.subtitle_url === 'string' ? item.subtitle_url : '';
    const language = typeof item.lan === 'string' ? item.lan : '';
    const id = String(item.id_str ?? item.id ?? '');
    if (!url || !language || !id) continue;
    tracks.push({
      id,
      language,
      label: typeof item.lan_doc === 'string' && item.lan_doc ? item.lan_doc : language,
      url: normalizeSubtitleUrl(url),
      endpoint,
      source,
      isAI: language.startsWith('ai-') || item.ai_type !== undefined,
    });
  }
  return tracks;
}

export function tracksFromProto(items: ProtoSubtitleItem[], endpoint: string, source: TrackSource = 'proto'): Track[] {
  const tracks: Track[] = [];
  for (const item of items) {
    const id = item.idStr || (item.id !== undefined ? item.id.toString() : '');
    if (!id || !item.lan || !item.subtitleUrl) continue;
    tracks.push({
      id,
      language: item.lan,
      label: item.lanDoc || item.lan,
      url: normalizeSubtitleUrl(item.subtitleUrl),
      endpoint,
      source,
      isAI: item.lan.startsWith('ai-'),
    });
  }
  return tracks;
}

export function parseProtoTracks(payload: Uint8Array, endpoint: string): Track[] {
  return tracksFromProto(parseSubtitleTracks(payload), endpoint);
}

const PRIORITY = ['zh-Hans', 'zh-CN', 'ai-zh', 'zh-Hant', 'zh-TW', 'ai-zh-Hans', 'en', 'ai-en'];

/**
 * Deterministic track selection. The old project used `subtitles[0]`, which returns a
 * different language whenever B站 reorders the array; selecting by (priority, language, id)
 * is stable across calls.
 */
export function chooseTrack(
  tracks: Track[],
  options: { language?: string; trackId?: string } = {},
): Track {
  const language = options.language ?? 'auto';
  const usable = tracks.filter((t) => isUsableSubtitleUrl(t.url));
  const byLanguage = usable.filter((t) => language === 'auto' || t.language === language);
  const filtered = byLanguage.filter((t) => options.trackId === undefined || t.id === options.trackId);
  if (!filtered.length) {
    throw new TrackUnavailable(
      `请求的字幕轨道不可用：language=${language}, id=${options.trackId ?? '-'}（可用：${usable.map((t) => t.language).join(', ') || '无'}）`,
    );
  }
  const rank = (t: Track) => {
    const index = PRIORITY.indexOf(t.language);
    return [index === -1 ? 99 : index, t.language, t.id] as const;
  };
  return [...filtered].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  })[0];
}

export function validateSegments(payload: unknown): SubtitleSegment[] {
  const body = (payload as { body?: unknown } | null)?.body;
  if (!Array.isArray(body) || body.length === 0) throw new BiliVaultError('字幕正文为空或格式不正确');
  const result: SubtitleSegment[] = [];
  let previousStart = -1;
  for (const raw of body) {
    const row = raw as Record<string, unknown>;
    const from = row.from;
    const to = row.to;
    const content = row.content;
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      typeof content !== 'string' ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < 0 ||
      to < from ||
      from < previousStart - 1e-6
    ) {
      throw new BiliVaultError('字幕正文存在无效文本或时间轴');
    }
    result.push({ from, to, content });
    previousStart = from;
  }
  return result;
}

export function canonicalizeSegments(segments: SubtitleSegment[]): string {
  return JSON.stringify(segments.map((s) => [Math.round(s.from * 1000), Math.round(s.to * 1000), s.content]));
}

export async function digestSegments(segments: SubtitleSegment[]): Promise<string> {
  return sha256Hex(canonicalizeSegments(segments));
}

/**
 * AI subtitles regularly overshoot the video duration (observed 35x in the wild).
 * Clamp when we know the duration, and warn instead of silently emitting bad timings.
 */
export function clampSegments(
  segments: SubtitleSegment[],
  durationSeconds?: number,
): { segments: SubtitleSegment[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!durationSeconds || durationSeconds <= 0) return { segments, warnings };
  const limit = durationSeconds + 5;
  const kept: SubtitleSegment[] = [];
  let dropped = 0;
  let clamped = 0;
  for (const segment of segments) {
    if (segment.from >= limit) {
      dropped += 1;
      continue;
    }
    if (segment.to > limit) {
      clamped += 1;
      kept.push({ ...segment, to: durationSeconds });
    } else {
      kept.push(segment);
    }
  }
  if (clamped) warnings.push(`${clamped} 条字幕结束时间超出视频时长，已裁剪`);
  if (dropped) warnings.push(`${dropped} 条字幕起点晚于视频结尾，已丢弃`);
  if (!kept.length) {
    warnings.push('裁剪后无剩余字幕，内容可能不属于该视频');
    return { segments, warnings };
  }
  return { segments: kept, warnings };
}

export function segmentsToText(segments: SubtitleSegment[]): string {
  return segments.map((s) => s.content).join('\n');
}

export function formatTimestamp(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms, 3)}`;
}

export function segmentsToSrt(segments: SubtitleSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${formatTimestamp(s.from).replace('.', ',')} --> ${formatTimestamp(s.to).replace('.', ',')}\n${s.content}`)
    .join('\n\n');
}

export function segmentsToTimedLines(segments: SubtitleSegment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.from)}] ${s.content}`).join('\n');
}

const SENTENCE_END = /[。！？!?…；;]["'”』」）)]*\s*$/;
const CLAUSE_END = /[。！？!?…，,；;：:、]["'”』」）)]*\s*$/;

function terminal(text: string): string {
  if (SENTENCE_END.test(text)) return text;
  if (CLAUSE_END.test(text)) return text.replace(/[，,、；;：:]\s*$/, '。');
  return text + '。';
}

/**
 * Caption chunks are not sentences: B站's AI track splits mid-clause and carries no ending
 * punctuation, which is why the raw track reads as one endless line. Merge them into
 * paragraphs (breaking on a real pause, a length cap, or a finished sentence) and add the
 * separator each boundary is missing. Timestamps are dropped: the outline carries those.
 */
export function segmentsToParagraphs(
  segments: readonly SubtitleSegment[],
  options: { maxChars?: number; gapSeconds?: number; minChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? 320;
  const gapSeconds = options.gapSeconds ?? 2.5;
  const minChars = options.minChars ?? 120;
  const paragraphs: string[] = [];
  let current = '';
  let previousEnd = 0;
  for (const segment of segments) {
    const text = segment.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!current) {
      current = text;
      previousEnd = segment.to;
      continue;
    }
    const gap = segment.from - previousEnd;
    const breakHere = gap > gapSeconds || current.length >= maxChars || (SENTENCE_END.test(current) && current.length >= minChars);
    if (breakHere) {
      paragraphs.push(terminal(current));
      current = text;
    } else if (!CLAUSE_END.test(current)) {
      // A real pause ends the sentence; a run-on fragment is joined with a comma.
      current += (gap >= 0.5 || current.length >= 15 ? '。' : '，') + text;
    } else {
      current += text;
    }
    previousEnd = segment.to;
  }
  if (current) paragraphs.push(terminal(current));
  return paragraphs;
}
