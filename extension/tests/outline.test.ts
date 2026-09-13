import { describe, expect, it } from 'vitest';
import { clockLabel, outlineEntries, outlineLabel, outlineStamp, parseTimeMark, topicTokens } from '../src/lib/outline';
import type { SubtitleSegment } from '../src/lib/types';

const seg = (from: number, to: number, content: string): SubtitleSegment => ({ from, to, content });

const transcript: SubtitleSegment[] = [
  seg(0, 2, '大家好，今天我们来聊聊向量数据库'),
  seg(2.5, 4, '它解决了什么问题'),
  seg(10, 12, '向量数据库的核心是索引'),
  seg(60, 62, '向量数据库的索引结构'),
];

describe('clockLabel / parseTimeMark', () => {
  it('formats mm:ss and h:mm:ss', () => {
    expect(clockLabel(12)).toBe('00:12');
    expect(clockLabel(150)).toBe('02:30');
    expect(clockLabel(3720)).toBe('1:02:00');
  });

  it('parses the range and single marks a model may write', () => {
    expect(parseTimeMark('[00:12-02:30] 讲向量数据库')).toEqual({ from: 12, to: 150, text: '讲向量数据库' });
    expect(parseTimeMark('[00:12–02:30] 讲向量数据库')).toEqual({ from: 12, to: 150, text: '讲向量数据库' });
    expect(parseTimeMark('[1:01:20] 开头')).toEqual({ from: 3680, to: 3680, text: '开头' });
    expect(parseTimeMark('没有时间标记')).toBeNull();
  });
});

describe('outlineEntries', () => {
  it('keeps a mark the model already wrote', () => {
    const [entry] = outlineEntries(['[00:05-00:09] 引言'], transcript);
    expect(entry).toEqual({ from: 5, to: 9, text: '引言' });
  });

  it('locates the range itself, stopping at a distant mention', () => {
    const [entry] = outlineEntries(['向量数据库解决了什么问题'], transcript);
    // Anchor is the 2.5s cue; the neighbouring cues join, the 60s one is too far away.
    expect(entry.from).toBe(0);
    expect(entry.to).toBe(12);
    expect(outlineLabel(entry)).toBe('[00:00–00:12] 向量数据库解决了什么问题');
  });

  it('leaves the label bare when the topic is not in the transcript', () => {
    const [entry] = outlineEntries(['完全无关的外星话题'], transcript);
    expect(entry.from).toBeUndefined();
    expect(outlineStamp(entry)).toBe('');
    expect(outlineLabel(entry)).toBe('完全无关的外星话题');
  });

  it('collapses a single-cue range to one stamp', () => {
    expect(outlineStamp({ from: 12, to: 12, text: 'x' })).toBe('00:12');
    expect(outlineLabel({ from: 12, to: 12, text: 'x' })).toBe('[00:12] x');
  });

  it('tokenizes CJK into bigrams so overlap is meaningful', () => {
    expect(topicTokens('向量数据库')).toEqual(new Set(['向量', '量数', '数据', '据库']));
  });
});
