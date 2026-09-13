import type { SubtitleSegment } from './types';

export interface OutlineEntry {
  /** Seconds; undefined when the topic could not be located in the transcript. */
  from?: number;
  to?: number;
  text: string;
}

/** `[01:20]`, `[01:20-03:05]`, `[1:01:20–1:03:05]` — the model may or may not provide one. */
const TIME_MARK = /^\s*\[\s*(?:(\d{1,2})[:：])?(\d{1,2})[:：](\d{2})\s*(?:[-–~—至到]\s*(?:(\d{1,2})[:：])?(\d{1,2})[:：](\d{2}))?\s*\]\s*/;

export function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function secondsOf(hours: string | undefined, minutes: string, secs: string): number {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(secs);
}

/** Splits a leading `[mm:ss-mm:ss]` mark off an outline line. */
export function parseTimeMark(line: string): { from: number; to: number; text: string } | null {
  const match = TIME_MARK.exec(line);
  if (!match) return null;
  const from = secondsOf(match[1], match[2], match[3]);
  const ranged = Boolean(match[4] || match[5] || match[6]);
  const to = ranged ? secondsOf(match[4], match[5], match[6]) : from;
  return { from, to: Math.max(from, to), text: line.slice(match[0].length).trim() };
}

const STOP = new Set(['的', '了', '是', '在', '和', '与', '就', '都', '也', '这', '那', '有', '会', '把', '被', '对', '从', '并', '而', '你', '我', '他', '它', '们']);

/** CJK bigrams plus latin words: enough overlap to find where a topic was discussed. */
export function topicTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) out.add(match[0]);
  for (const run of lower.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const stop of STOP) out.delete(stop);
  return out;
}

/** Captions further apart than this belong to a different pass over the topic. */
const MAX_WINDOW_GAP = 20;

function locate(
  text: string,
  segmentTokens: ReadonlyArray<Set<string>>,
  segments: readonly SubtitleSegment[],
): { from: number; to: number } | null {
  const wanted = topicTokens(text);
  if (wanted.size < 2) return null;
  const scores = segmentTokens.map((set) => {
    let hits = 0;
    for (const token of wanted) if (set.has(token)) hits += 1;
    return hits;
  });
  let anchor = -1;
  for (let i = 0; i < scores.length; i += 1) if (anchor === -1 || scores[i] > scores[anchor]) anchor = i;
  if (anchor === -1 || scores[anchor] < Math.max(2, Math.ceil(wanted.size * 0.2))) return null;
  let start = anchor;
  let end = anchor;
  while (start > 0 && scores[start - 1] > 0 && segments[start].from - segments[start - 1].to <= MAX_WINDOW_GAP) start -= 1;
  while (end < scores.length - 1 && scores[end + 1] > 0 && segments[end + 1].from - segments[end].to <= MAX_WINDOW_GAP) end += 1;
  return { from: segments[start].from, to: segments[end].to };
}

/**
 * Every outline item with the transcript range it came from. A time mark written by the model
 * wins; otherwise the range is located deterministically so an older analysis still gets one.
 */
export function outlineEntries(outline: readonly string[], segments: readonly SubtitleSegment[] = []): OutlineEntry[] {
  const segmentTokens = segments.map((segment) => topicTokens(segment.content));
  return outline.map((line) => {
    const marked = parseTimeMark(line);
    if (marked) return { from: marked.from, to: marked.to, text: marked.text };
    const located = locate(line, segmentTokens, segments);
    const text = line.trim();
    return located ? { from: located.from, to: located.to, text } : { text };
  });
}

/** `00:12–02:30`, or `00:12` for a single-caption topic; '' when unknown. */
export function outlineStamp(entry: OutlineEntry): string {
  if (entry.from === undefined) return '';
  const to = entry.to ?? entry.from;
  return to - entry.from >= 1 ? `${clockLabel(entry.from)}–${clockLabel(to)}` : clockLabel(entry.from);
}

/** `[00:12–02:30] 文本`, falling back to the bare text when the range is unknown. */
export function outlineLabel(entry: OutlineEntry): string {
  const stamp = outlineStamp(entry);
  return stamp ? `[${stamp}] ${entry.text}` : entry.text;
}
