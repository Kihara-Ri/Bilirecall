import { describe, expect, it } from 'vitest';
import { TrackUnavailable } from '../src/lib/errors';
import {
  chooseTrack,
  clampSegments,
  digestSegments,
  extractPlayerTracks,
  formatTimestamp,
  isUsableSubtitleUrl,
  normalizeSubtitleUrl,
  segmentsToSrt,
  validateSegments,
  segmentsToParagraphs,
} from '../src/lib/subtitle';
import { makeTrack } from './helpers';

describe('deterministic track selection (the reported bug)', () => {
  const zhHans = makeTrack({
    id: '100',
    language: 'zh-Hans',
    label: '中文（简体）',
    url: 'https://aisubtitle.hdslb.com/bfs/subtitle/zh.json',
    isAI: false,
  });
  const aiZh = makeTrack({
    id: '200',
    language: 'ai-zh',
    label: '中文（自动生成）',
    url: 'https://aisubtitle.hdslb.com/bfs/subtitle/ai.json',
  });

  it('would break with the old subtitles[0] approach', () => {
    const orderA = [zhHans, aiZh];
    const orderB = [aiZh, zhHans];
    expect(orderA[0].id).not.toBe(orderB[0].id);
    expect(orderA[0].language).not.toBe(orderB[0].language);
  });

  it('returns the same track for the same bvid/cid regardless of order', () => {
    expect(chooseTrack([zhHans, aiZh]).id).toBe('100');
    expect(chooseTrack([aiZh, zhHans]).id).toBe('100');
    expect(chooseTrack([zhHans, aiZh]).id).toBe(chooseTrack([aiZh, zhHans]).id);
  });

  it('is stable when track ids arrive as numbers vs strings', () => {
    const numeric = makeTrack({ id: '200', language: 'ai-zh' });
    expect(chooseTrack([numeric]).id).toBe('200');
  });

  it('honours an explicit language instead of falling back', () => {
    expect(chooseTrack([zhHans, aiZh], { language: 'ai-zh' }).id).toBe('200');
    expect(() => chooseTrack([zhHans, aiZh], { language: 'en' })).toThrow(TrackUnavailable);
  });

  it('honours an explicit track id', () => {
    expect(chooseTrack([zhHans, aiZh], { trackId: '200' }).id).toBe('200');
    expect(() => chooseTrack([zhHans, aiZh], { trackId: '999' })).toThrow(TrackUnavailable);
  });

  it('ignores tracks whose URL is unusable', () => {
    const broken = makeTrack({ id: '300', language: 'zh-Hans', url: '//subtitle.bilibili.com/%01%1B%5C=_%04%12%12%049f' });
    expect(() => chooseTrack([broken], { language: 'zh-Hans' })).toThrow(TrackUnavailable);
  });
});

describe('subtitle URL safety', () => {
  it('rejects the obfuscated placeholder URLs returned without login', () => {
    const obfuscated = '//subtitle.bilibili.com/%01%1B%5C=_%04%12%12%049f%2F%07H%08%29~%16$5%0D?auth_key=abc';
    expect(isUsableSubtitleUrl(obfuscated)).toBe(false);
  });

  it('accepts real B站 subtitle hosts and normalizes protocol-relative URLs', () => {
    expect(isUsableSubtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/x.json?auth_key=1')).toBe(true);
    expect(isUsableSubtitleUrl('https://aisubtitle.hdslb.com/bfs/subtitle/x.json')).toBe(true);
    expect(normalizeSubtitleUrl('//aisubtitle.hdslb.com/x.json')).toBe('https://aisubtitle.hdslb.com/x.json');
  });

  it('rejects foreign hosts and non-https schemes', () => {
    expect(isUsableSubtitleUrl('https://evil.com/x.json')).toBe(false);
    expect(isUsableSubtitleUrl('http://aisubtitle.hdslb.com/x.json')).toBe(false);
    expect(isUsableSubtitleUrl('https://user:pass@aisubtitle.hdslb.com/x.json')).toBe(false);
  });
});

describe('subtitle body validation and clamping', () => {
  it('accepts a well-formed body', () => {
    const segments = validateSegments({ body: [{ from: 0, to: 1, content: '你好' }, { from: 1, to: 2, content: '世界' }] });
    expect(segments).toHaveLength(2);
    expect(segments[0].content).toBe('你好');
  });

  it('rejects empty or malformed bodies', () => {
    expect(() => validateSegments({ body: [] })).toThrow();
    expect(() => validateSegments({ body: [{ from: -1, to: 1, content: 'x' }] })).toThrow();
    expect(() => validateSegments({ body: [{ from: 2, to: 1, content: 'x' }] })).toThrow();
    expect(() => validateSegments({ body: [{ from: 0, to: 1, content: 5 }] })).toThrow();
    expect(() => validateSegments(null)).toThrow();
  });

  it('clamps AI cues that overshoot the video duration (observed in the wild)', () => {
    const segments = validateSegments({
      body: [
        { from: 0, to: 2, content: 'ok' },
        { from: 590, to: 3000, content: 'overshoot' },
        { from: 99999, to: 100000, content: 'after end' },
      ],
    });
    const { segments: clamped, warnings } = clampSegments(segments, 600);
    expect(clamped).toHaveLength(2);
    expect(clamped[1].to).toBe(600);
    expect(warnings.join(' ')).toContain('裁剪');
    expect(warnings.join(' ')).toContain('丢弃');
  });

  it('digests canonical content, not timestamps formatting', async () => {
    const a = validateSegments({ body: [{ from: 0, to: 1.2, content: 'x' }] });
    const b = validateSegments({ body: [{ from: 0, to: 1.3, content: 'x' }] });
    expect(await digestSegments(a)).not.toBe(await digestSegments(b));
    const c = validateSegments({ body: [{ from: 0, to: 1, content: 'y' }] });
    expect(await digestSegments(a)).not.toBe(await digestSegments(c));
  });

  it('formats SRT and timestamps without carrying milliseconds over', () => {
    expect(formatTimestamp(3661.5)).toBe('01:01:01.500');
    const srt = segmentsToSrt([{ from: 0, to: 1.2, content: 'hi' }]);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,200');
  });
});

describe('player response parsing', () => {
  it('extracts tracks and keeps language + id', () => {
    const tracks = extractPlayerTracks(
      {
        aid: 1,
        cid: 2,
        subtitle: {
          subtitles: [
            { id: 11, id_str: '11', lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/a.json' },
            { id: 22, id_str: '22', lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/b.json', ai_type: 1 },
          ],
        },
      },
      '/x/player/wbi/v2',
      'page',
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ id: '11', language: 'zh-Hans', isAI: false, source: 'page' });
    expect(tracks[1]).toMatchObject({ id: '22', isAI: true });
    expect(tracks[1].url).toBe('https://aisubtitle.hdslb.com/b.json');
  });

  it('returns [] for missing or empty subtitle lists', () => {
    expect(extractPlayerTracks({ subtitle: { subtitles: [] } }, 'x', 'page')).toEqual([]);
    expect(extractPlayerTracks({}, 'x', 'page')).toEqual([]);
    expect(extractPlayerTracks(null, 'x', 'page')).toEqual([]);
  });
});

describe('segmentsToParagraphs', () => {
  const seg = (from: number, to: number, content: string) => ({ from, to, content });

  it('merges cue chunks into one punctuated paragraph without timestamps', () => {
    const paragraphs = segmentsToParagraphs([
      seg(0, 1, '大家好'),
      seg(1.1, 2, '今天我们聊向量数据库'),
      seg(2.1, 3, '先看它解决什么问题'),
    ]);
    expect(paragraphs).toEqual(['大家好，今天我们聊向量数据库，先看它解决什么问题。']);
    expect(paragraphs[0]).not.toMatch(/\[\d/);
  });

  it('builds a sentence boundary from a real pause, and starts a new paragraph on a long one', () => {
    const paragraphs = segmentsToParagraphs([
      seg(0, 1, '第一句已经说完'),
      seg(1.2, 2, '第二句开始'),
      seg(5, 6, '第三句在停顿之后'),
    ]);
    expect(paragraphs).toEqual(['第一句已经说完，第二句开始。', '第三句在停顿之后。']);
  });

  it('does not double the punctuation a human track already has', () => {
    const [paragraph] = segmentsToParagraphs([seg(0, 1, '这是完整的一句话。'), seg(1.1, 2, '下一句')]);
    expect(paragraph).toBe('这是完整的一句话。下一句。');
    expect(paragraph).not.toContain('。。');
  });

  it('caps paragraph length for a long run of cues', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i * 3, i * 3 + 2.9, '字'.repeat(30)));
    const paragraphs = segmentsToParagraphs(segments, { maxChars: 100 });
    expect(paragraphs.length).toBeGreaterThan(2);
    for (const paragraph of paragraphs) expect(paragraph.length).toBeLessThanOrEqual(130);
  });
});
