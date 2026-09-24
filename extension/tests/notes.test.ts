import { describe, expect, it } from 'vitest';
import { draftCount, draftToNotes, emptyDraft, emptyNotes, noteLines, notesToDraft, sameNotes } from '../src/lib/notes';

/**
 * 回归：笔记栏里敲不出空格。
 * 原因是 textarea 的值直接来自落库数组，每次按键都 split+trim+join 转一遍，
 * 刚敲下的空格在这一次往返里被 trim 掉。编辑器必须持原文，规范化只发生在写入前。
 */
describe('note editor draft', () => {
  it('keeps the spaces the user typed inside a line', () => {
    expect(noteLines('关键词 空格')).toEqual(['关键词 空格']);
    expect(draftToNotes({ highlights: '关键词 空格', questions: '', freeform: '' }).highlights).toEqual(['关键词 空格']);
  });

  it('never rewrites the draft while typing', () => {
    // 直接模拟受控组件：每个字符进来都要原样存进原文。
    let draft = emptyDraft();
    for (const text of ['关', '关键词', '关键词 ', '关键词 空', '关键词 空格']) {
      draft = { ...draft, highlights: text };
      expect(draft.highlights).toBe(text);
    }
    // 只剩一个空格的空行也要留下，否则回车之后没法起新行。
    draft = { ...draft, highlights: '关键词\n ' };
    expect(draft.highlights).toBe('关键词\n ');
  });

  it('trims only the line edges when writing to storage', () => {
    expect(draftToNotes({ highlights: '  一条  ', questions: '', freeform: '' }).highlights).toEqual(['一条']);
    expect(draftToNotes({ highlights: 'a b\n\n  c d  ', questions: '', freeform: '' }).highlights).toEqual(['a b', 'c d']);
    // 随笔保留原始排版，写入端自己 trim。
    expect(draftToNotes({ highlights: '', questions: '', freeform: '第一行\n\n第三行 ' }).freeform).toBe('第一行\n\n第三行 ');
  });

  it('round-trips list notes without losing inner spaces', () => {
    const stored = draftToNotes({ highlights: 'a  b\nc', questions: '问 题', freeform: '随 笔' });
    const back = notesToDraft(stored);
    expect(back.highlights).toBe('a  b\nc');
    expect(back.questions).toBe('问 题');
    expect(back.freeform).toBe('随 笔');
    expect(draftToNotes(notesToDraft(stored))).toEqual(stored);
  });

  it('counts rows the same way the storage does', () => {
    const draft = { highlights: '一\n二\n ', questions: '', freeform: '   ' };
    expect(draftCount(draft, 'highlights')).toBe(2);
    expect(draftCount(draft, 'questions')).toBe(0);
    // 随笔按「有没有内容」算一条，纯空格不算。
    expect(draftCount(draft, 'freeform')).toBe(0);
    expect(draftCount({ ...draft, freeform: '随笔' }, 'freeform')).toBe(1);
  });

  it('tells equivalent responses from real changes', () => {
    const stored = { highlights: ['关键词 空格'], questions: [], freeform: '' };
    // 原文里多出的行尾空格不该被当成变化（否则自动保存后的轮询会抹掉它）。
    expect(sameNotes(draftToNotes({ highlights: '关键词 空格 ', questions: '', freeform: '' }), stored)).toBe(true);
    expect(sameNotes(draftToNotes({ highlights: '关键词 空格', questions: '', freeform: '' }), stored)).toBe(true);
    expect(sameNotes(draftToNotes({ highlights: '关键词空格', questions: '', freeform: '' }), stored)).toBe(false);
    expect(sameNotes(draftToNotes({ highlights: '关键词 空格', questions: '多一条', freeform: '' }), stored)).toBe(false);
  });

  it('tolerates records that never had notes (old schema)', () => {
    const legacy = {} as { highlights?: string[]; questions?: string[]; freeform?: string };
    expect(notesToDraft(legacy as never)).toEqual(emptyDraft());
    expect(sameNotes(legacy as never, emptyNotes())).toBe(true);
  });
});
