import { describe, expect, it } from 'vitest';
import { agentBrief, buildBundle, indexMarkdown, recordToAgentJson, recordToMarkdown, recordsToJsonl, sanitizeFilename } from '../src/lib/export';
import { newRecord } from '../src/lib/store';
import { validateSegments } from '../src/lib/subtitle';
import type { VideoRecord } from '../src/lib/types';
import { subtitleBody } from './helpers';

function makeRecord(): VideoRecord {
  const record = newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 1,
    cid: 2,
    title: '标题 / 带斜杠',
    owner: 'UP主',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    category: '科技',
    duration: 100,
  });
  record.actions = { like: true, coin: 1, favorite: false, share: true };
  record.analysis = { summary: '这是摘要', outline: ['第一节'], keyPoints: ['要点'], provider: 'p', model: 'm', createdAt: 1 };
  record.userNotes = { highlights: ['亮点'], questions: ['问题'], freeform: '自由笔记' };
  const segments = validateSegments(subtitleBody('第一句', '第二句'));
  record.subtitle = {
    track: { id: '1', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
    availableTracks: [],
    segments,
    plainText: '第一句\n第二句',
    digest: 'a'.repeat(64),
    fetchedAt: 1,
    observations: 2,
    warnings: [],
  };
  return record;
}

describe('export', () => {
  it('writes YAML frontmatter with retrieval metadata', () => {
    const markdown = recordToMarkdown(makeRecord());
    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('bvid: "BV1xx411c7mD"');
    expect(markdown).toContain('subtitle_sha256:');
    expect(markdown).not.toContain('score');
    expect(markdown).toContain('actions: { like: true, coin: 1, favorite: false, share: true }');
    expect(markdown).toContain('点赞 · 投币×1 · 分享');
    expect(markdown).toContain('# 标题 / 带斜杠');
    expect(markdown).toContain('第一句');
  });

  it('produces a compact agent brief', () => {
    const brief = agentBrief(makeRecord());
    expect(brief).toContain('这是摘要');
    expect(brief).toContain('## 我的印象');
    expect(brief).toContain('- 亮点');
    expect(brief).toContain('B站操作: 点赞 / 投币×1 / 分享');
  });

  it('emits valid JSONL and a matching index', () => {
    const record = makeRecord();
    const lines = recordsToJsonl([record]).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.bvid).toBe('BV1xx411c7mD');
    expect(parsed.subtitle.text).toContain('第一句');
    expect(indexMarkdown([record])).toContain('BiliRecall 知识库索引');
    expect(recordToAgentJson(record).analysis).toMatchObject({ summary: '这是摘要' });
  });

  it('bundles files for humans and agents', () => {
    const files = buildBundle([makeRecord()]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('index.md');
    expect(paths).toContain('knowledge.jsonl');
    expect(paths).toContain('records.json');
    expect(paths.some((p) => p.startsWith('videos/'))).toBe(true);
    expect(sanitizeFilename('a/b:c')).toBe('a_b_c');
  });

  it('exports the cover, a timed outline and subtitle paragraphs', () => {
    const record = makeRecord();
    record.cover = '//i2.hdslb.com/bfs/archive/x.jpg';
    record.analysis = { ...record.analysis!, outline: ['[00:01-00:02] 第一节'] };
    const markdown = recordToMarkdown(record);
    expect(markdown).toContain('cover: "https://i2.hdslb.com/bfs/archive/x.jpg"');
    expect(markdown).toContain('- [00:01–00:02] 第一节');
    expect(markdown).not.toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
  });
});
