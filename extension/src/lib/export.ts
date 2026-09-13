import { describeActions } from './events';
import { normalizeCoverUrl } from './media';
import { outlineEntries, outlineLabel } from './outline';
import { segmentsToParagraphs } from './subtitle';
import type { VideoRecord } from './types';

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\n\r\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled';
}

function yaml(record: VideoRecord): string {
  const tags = record.tags.length ? `[${record.tags.map((t) => JSON.stringify(t)).join(', ')}]` : '[]';
  return [
    '---',
    `key: ${JSON.stringify(record.key)}`,
    `bvid: ${JSON.stringify(record.bvid)}`,
    `cid: ${record.cid}`,
    `aid: ${record.aid}`,
    `title: ${JSON.stringify(record.title)}`,
    `owner: ${JSON.stringify(record.owner)}`,
    `url: ${JSON.stringify(record.url)}`,
    `cover: ${JSON.stringify(normalizeCoverUrl(record.cover))}`,
    `category: ${JSON.stringify(record.category ?? '')}`,
    `duration_seconds: ${record.duration ?? 0}`,
    `actions: { like: ${record.actions.like}, coin: ${record.actions.coin}, favorite: ${record.actions.favorite}, share: ${record.actions.share} }`,
    `watched_at: ${new Date(record.watched.firstAt).toISOString()}`,
    `updated_at: ${new Date(record.updatedAt).toISOString()}`,
    `subtitle_language: ${JSON.stringify(record.subtitle?.track.language ?? '')}`,
    `subtitle_sha256: ${JSON.stringify(record.subtitle?.digest ?? '')}`,
    `notion_url: ${JSON.stringify(record.steps.notion.url ?? '')}`,
    `tags: ${tags}`,
    `schema_version: ${record.schemaVersion}`,
    '---',
    '',
  ].join('\n');
}

export function recordToMarkdown(record: VideoRecord): string {
  const lines: string[] = [yaml(record), `# ${record.title}`, ''];
  const acted = describeActions(record.actions);
  lines.push(`> [${record.url}](${record.url}) · UP主 ${record.owner || '未知'}${acted.length ? ' · ' + acted.join(' · ') : ''}`, '');
  if (record.analysis) {
    lines.push('## 内容摘要', '', record.analysis.summary, '');
    if (record.analysis.outline.length) {
      const outline = outlineEntries(record.analysis.outline, record.subtitle?.segments ?? []);
      lines.push('## 分段提纲', '', ...outline.map((entry) => `- ${outlineLabel(entry)}`), '');
    }
    if (record.analysis.keyPoints.length) {
      lines.push('## 关键点', '', ...record.analysis.keyPoints.map((x) => `- ${x}`), '');
    }
  }
  lines.push('## 我的记录', '');
  for (const h of record.userNotes.highlights) lines.push(`- 印象深刻：${h}`);
  for (const q of record.userNotes.questions) lines.push(`- 值得思考：${q}`);
  if (record.userNotes.freeform.trim()) lines.push('', record.userNotes.freeform);
  lines.push('');
  if (record.description) lines.push('## 视频简介', '', record.description, '');
  if (record.subtitle) {
    lines.push(
      `## 字幕（${record.subtitle.track.label} · ${record.subtitle.track.language}）`,
      '',
      `> 独立一致读取 ${record.subtitle.observations} 次 · SHA-256 \`${record.subtitle.digest}\``,
      '',
    );
    // Same flowing paragraphs as the Notion page: no cue timestamps, punctuation filled in.
    for (const text of segmentsToParagraphs(record.subtitle.segments)) lines.push(text, '');
  }
  return lines.join('\n') + '\n';
}

export function recordToAgentJson(record: VideoRecord): Record<string, unknown> {
  return {
    key: record.key,
    bvid: record.bvid,
    aid: record.aid,
    cid: record.cid,
    url: record.url,
    title: record.title,
    owner: record.owner,
    category: record.category,
    duration_seconds: record.duration,
    pubdate: record.pubdate,
    actions: record.actions,
    action_source: record.relation ?? null,
    watched: record.watched,
    my_notes: record.userNotes,
    analysis: record.analysis,
    subtitle: record.subtitle
      ? {
          language: record.subtitle.track.language,
          label: record.subtitle.track.label,
          digest: record.subtitle.digest,
          observations: record.subtitle.observations,
          text: record.subtitle.plainText,
        }
      : null,
    notion: record.steps.notion,
  };
}

/** Compact brief meant to be pasted into an AI agent chat. */
/**
 * Compact brief meant to be pasted into an AI agent chat. It carries the identity (视频ID), the
 * cover and the notes, because an agent asked to file this into a knowledge base needs all three.
 */
export function agentBrief(record: VideoRecord): string {
  const cover = normalizeCoverUrl(record.cover);
  const parts = [
    `# ${record.title}`,
    `- 视频ID: ${record.bvid}${record.page > 1 ? ` (P${record.page})` : ''}`,
    `- 链接: ${record.url}`,
    ...(cover ? [`- 封面: ${cover}`] : []),
    `- UP主: ${record.owner} | 分区: ${record.category ?? '未知'} | 时长: ${Math.round(record.duration ?? 0)}s`,
    ...(record.tags.length ? [`- 标签: ${record.tags.join(' / ')}`] : []),
    `- B站操作: ${describeActions(record.actions).join(' / ') || '无'}`,
  ];
  if (record.analysis) {
    parts.push('', '## 摘要', record.analysis.summary);
    if (record.analysis.outline.length) {
      const outline = outlineEntries(record.analysis.outline, record.subtitle?.segments ?? []);
      parts.push('', '## 分段提纲（含时间段）', ...outline.map((entry) => `- ${outlineLabel(entry)}`));
    }
    if (record.analysis.keyPoints.length) parts.push('', '## 关键点', ...record.analysis.keyPoints.map((x) => `- ${x}`));
  }
  if (record.userNotes.highlights.length) parts.push('', '## 我的印象', ...record.userNotes.highlights.map((x) => `- ${x}`));
  if (record.userNotes.questions.length) parts.push('', '## 待思考', ...record.userNotes.questions.map((x) => `- ${x}`));
  if (record.userNotes.freeform.trim()) parts.push('', '## 随笔', record.userNotes.freeform.trim());
  if (record.subtitle) {
    parts.push('', '## 字幕节选', segmentsToParagraphs(record.subtitle.segments).join('\n\n').slice(0, 1500));
  }
  return parts.join('\n');
}

export function recordsToJsonl(records: VideoRecord[]): string {
  return records.map((r) => JSON.stringify(recordToAgentJson(r))).join('\n') + '\n';
}

export function indexMarkdown(records: VideoRecord[]): string {
  const lines = ['# BiliVault 知识库索引', '', `共 ${records.length} 条记录。`, ''];
  for (const record of [...records].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const signals = [
      record.actions.like ? '👍' : '',
      record.actions.coin ? `🪙${record.actions.coin}` : '',
      record.actions.favorite ? '⭐' : '',
      record.actions.share ? '🔗' : '',
    ]
      .filter(Boolean)
      .join('');
    lines.push(`- [${record.title}](${record.url}) ${signals} — ${record.owner} · ${new Date(record.updatedAt).toISOString().slice(0, 10)}`);
  }
  return lines.join('\n') + '\n';
}

export interface BundleFile {
  path: string;
  content: string;
}

export function buildBundle(records: VideoRecord[]): BundleFile[] {
  const files: BundleFile[] = [
    { path: 'index.md', content: indexMarkdown(records) },
    { path: 'knowledge.jsonl', content: recordsToJsonl(records) },
    { path: 'records.json', content: JSON.stringify(records.map(recordToAgentJson), null, 2) },
  ];
  for (const record of records) {
    files.push({ path: `videos/${sanitizeFilename(`${record.bvid}_${record.title}`)}.md`, content: recordToMarkdown(record) });
  }
  return files;
}
