import type { UserNotes } from './types';

/** 三个「我的记录」分类，也是编辑器上的三个分页。 */
export type NoteField = keyof UserNotes;

/**
 * 编辑器里每个分类的**原文**（textarea 的 value）。
 *
 * 这里存的是用户敲下的字符，不是落库后的数组。以前 popup 把 textarea 直接绑在 `UserNotes`
 * 的数组上，每敲一个键都要 `split('\n').map(trim)` 再 `join('\n')` 转回去，于是刚敲下的空格
 * （尤其行首、行尾，以及只敲了一个空格的空行）会在这一次往返里被 trim 掉——表现就是
 * 「笔记栏里打不出空格」。原文与规范化数据分开后，编辑器不再改写用户输入，trim 只发生在写入存储之前。
 */
export interface NoteDraft {
  highlights: string;
  questions: string;
  freeform: string;
}

export function emptyNotes(): UserNotes {
  return { highlights: [], questions: [], freeform: '' };
}

export function emptyDraft(): NoteDraft {
  return { highlights: '', questions: '', freeform: '' };
}

/** 一行一条：去掉整行的首尾空白与空行，词与词之间的空格必须保留。 */
export function noteLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** 原文 → 落库数据。规范化只在这里发生；随笔保留原始排版（写入端会 trim）。 */
export function draftToNotes(draft: NoteDraft): UserNotes {
  return {
    highlights: noteLines(draft.highlights),
    questions: noteLines(draft.questions),
    freeform: draft.freeform ?? '',
  };
}

/** 落库数据 → 编辑器原文（打开面板、切换视频、回包补全时用）。 */
export function notesToDraft(notes: UserNotes): NoteDraft {
  return {
    highlights: (notes.highlights ?? []).join('\n'),
    questions: (notes.questions ?? []).join('\n'),
    freeform: notes.freeform ?? '',
  };
}

/** 与落库后的计数保持一致：随笔按「有没有内容」算 1 条。 */
export function draftCount(draft: NoteDraft, field: NoteField): number {
  return field === 'freeform' ? (draft.freeform.trim() ? 1 : 0) : noteLines(draft[field]).length;
}

/**
 * 后台回包与当前原文是否等价。等价时保留原文，避免自动保存后的下一次轮询把用户刚敲下的
 * 行尾空格 / 空行抹掉（那会让光标跳动，看起来仍然像「空格打不进去」）。
 */
export function sameNotes(a: UserNotes, b: UserNotes): boolean {
  const sameList = (x: string[] | undefined, y: string[] | undefined): boolean => {
    const left = x ?? [];
    const right = y ?? [];
    return left.length === right.length && left.every((value, index) => value === right[index]);
  };
  return (a.freeform ?? '') === (b.freeform ?? '') && sameList(a.highlights, b.highlights) && sameList(a.questions, b.questions);
}
