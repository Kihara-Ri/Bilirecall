import { describeActions } from './events';
import { BiliVaultError, NotConfigured } from './errors';
import { normalizeCoverUrl } from './media';
import { outlineEntries, outlineStamp } from './outline';
import { segmentsToParagraphs } from './subtitle';
import type { Settings, UserNotes, VideoRecord } from './types';

export const NOTION_VERSION = '2025-09-03';
const API = 'https://api.notion.com/v1';
import { browserFetch, type FetchLike } from './http';
import { notionMissing } from './pipeline';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type RichText = { type: 'text'; text: { content: string } };
type Block = Record<string, unknown>;

function rich(content: string): RichText[] {
  return [{ type: 'text', text: { content } }];
}

export function paragraph(content: string): Block {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: rich(content) } };
}
export function heading2(content: string): Block {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: rich(content) } };
}
/** `stamp` is the `00:12–02:30` range, rendered bold in front of the text. */
export function bullet(content: string, stamp = ''): Block {
  const rich_text: Array<Record<string, unknown>> = stamp
    ? [{ type: 'text', text: { content: `[${stamp}] ` }, annotations: { bold: true } }, ...rich(content)]
    : rich(content);
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text } };
}
export function callout(content: string, emoji = '⭐'): Block {
  return { object: 'block', type: 'callout', callout: { rich_text: rich(content), icon: { type: 'emoji', emoji } } };
}
export function divider(): Block {
  return { object: 'block', type: 'divider', divider: {} };
}

/** Paragraphs are limited to 2000 UTF-16 units; 1500 code points stays safely below it. */
export function textBlocks(text: string, chunk = 1500): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < text.length; i += chunk) blocks.push(paragraph(text.slice(i, i + chunk)));
  return blocks.length ? blocks : [paragraph('')];
}

export function chunkBlocks(blocks: Block[], maxCount = 90, maxBytes = 280000): Block[][] {
  const batches: Block[][] = [];
  let batch: Block[] = [];
  for (const block of blocks) {
    const candidate = [...batch, block];
    if (candidate.length > maxCount || JSON.stringify({ children: candidate }).length > maxBytes) {
      if (batch.length) batches.push(batch);
      batch = [block];
    } else {
      batch = candidate;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function actionSummary(record: VideoRecord): string {
  const parts = describeActions(record.actions);
  return parts.length ? parts.join(' · ') : '仅浏览';
}

/** Columns the extension knows how to fill. `required` ones are what the page is useless without. */
export interface ColumnSpec {
  name: string;
  /** Other names people give the same column (compared case/space/punctuation-insensitively). */
  aliases: string[];
  /** Accepted Notion property types, most specific first. */
  types: string[];
  required?: boolean;
}

export const NOTION_COLUMNS: ColumnSpec[] = [
  // 视频ID is the identity a page can be looked up by, so it is required like the title.
  { name: '视频ID', aliases: ['BV号', 'bvid', '视频编号', '视频 id'], types: ['rich_text'], required: true },
  { name: 'URL', aliases: ['链接', '视频链接', 'link'], types: ['url', 'rich_text'] },
  {
    name: 'UP主',
    aliases: ['UP主名称', '作者', '上传者', '博主', 'owner', 'uploader', 'author'],
    types: ['rich_text', 'select', 'multi_select'],
    required: true,
  },
  { name: '日期', aliases: ['发布日期', '视频日期', '发布日', 'date'], types: ['date', 'rich_text'], required: true },
  {
    name: '摘要',
    aliases: ['Summary', '总结', '概要', '简介摘要', 'AI摘要', '内容摘要'],
    types: ['rich_text'],
    required: true,
  },
  { name: '我的记录', aliases: ['我的笔记', '笔记', '我的想法'], types: ['rich_text'] },
  { name: '标签', aliases: ['Tags', '关键词'], types: ['multi_select'] },
  { name: '分区', aliases: ['分类', '板块', 'category'], types: ['select', 'rich_text'] },
  { name: '字幕语言', aliases: ['语言', 'language'], types: ['select', 'rich_text'] },
  { name: '加入时间', aliases: ['记录时间', '收藏时间', '添加时间'], types: ['date'] },
  { name: '发布时间', aliases: ['发布', 'pubdate'], types: ['date'] },
];

export interface ColumnMatch {
  name: string;
  type: string;
}

/** `UP 主` / `UP主` / `up主` are the same column; so are `Summary` and `summary`. */
function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[\s_\-·:：()（）[\]【】]/g, '');
}

/**
 * Maps each canonical column to the column in this data source that should receive it. Exact names
 * win over aliases, aliases over substring matches, and no column is claimed twice — people call the
 * same column `UP主名称`, `Summary` or `发布日期`, and the write still has to land.
 */
export function matchColumns(props: Record<string, any>): Map<string, ColumnMatch> {
  const keys = Object.keys(props);
  const matches = new Map<string, ColumnMatch>();
  const used = new Set<string>();
  const take = (spec: ColumnSpec, key: string) => {
    matches.set(spec.name, { name: key, type: String(props[key]?.type ?? '') });
    used.add(key);
  };
  const find = (wanted: string[], fuzzy: boolean) =>
    keys.find((key) => {
      if (used.has(key)) return false;
      const normalized = normalizeColumnName(key);
      if (!normalized) return false;
      return wanted.some((candidate) => {
        const target = normalizeColumnName(candidate);
        if (!target) return false;
        if (normalized === target) return true;
        return fuzzy && target.length >= 2 && (normalized.includes(target) || target.includes(normalized));
      });
    });
  for (const spec of NOTION_COLUMNS) {
    const exact = find([spec.name], false);
    if (exact) take(spec, exact);
  }
  for (const spec of NOTION_COLUMNS) {
    if (matches.has(spec.name)) continue;
    const alias = find(spec.aliases, false);
    if (alias) take(spec, alias);
  }
  for (const spec of NOTION_COLUMNS) {
    if (matches.has(spec.name)) continue;
    const near = find([spec.name, ...spec.aliases], true);
    if (near) take(spec, near);
  }
  return matches;
}

export interface ColumnReview {
  /** The canonical column the writer fills. */
  name: string;
  /** The column that was matched in this data source; '' when nothing matched. */
  matched: string;
  expected: string[];
  found: string;
  status: 'ok' | 'type' | 'missing';
  required: boolean;
}

export interface SchemaReview {
  titleProperty: string;
  columns: ColumnReview[];
  /** Columns that exist in the data source but that the extension never writes. */
  extra: string[];
  ok: boolean;
}

/** The same matching the writer applies, so 测试连接 cannot disagree with a real write. */
export function reviewSchema(schema: any): SchemaReview {
  const props: Record<string, any> = schema?.properties ?? {};
  const titleProperty = Object.entries(props).find(([, value]) => value?.type === 'title')?.[0] ?? '';
  const matches = matchColumns(props);
  const columns: ColumnReview[] = NOTION_COLUMNS.map((spec) => {
    const match = matches.get(spec.name);
    const found = match?.type ?? '';
    const status: ColumnReview['status'] = !match ? 'missing' : spec.types.includes(found) ? 'ok' : 'type';
    return {
      name: spec.name,
      matched: match?.name ?? '',
      expected: spec.types,
      found: found || '缺失',
      status,
      required: Boolean(spec.required),
    };
  });
  const known = new Set([
    ...NOTION_COLUMNS.map((column) => column.name),
    ...[...matches.values()].map((match) => match.name),
    titleProperty,
  ]);
  return {
    titleProperty,
    columns,
    extra: Object.keys(props).filter((name) => !known.has(name)),
    ok: Boolean(titleProperty) && columns.every((column) => !column.required || column.status === 'ok'),
  };
}

type Candidate = [kind: string, value: unknown];

function notesText(notes: UserNotes): string {
  const lines: string[] = [];
  if (notes.highlights.length) lines.push(`印象深刻：${notes.highlights.join('；')}`);
  if (notes.questions.length) lines.push(`值得思考：${notes.questions.join('；')}`);
  if (notes.freeform.trim()) lines.push(notes.freeform.trim());
  return lines.join('\n');
}

/**
 * Property values per column, each with fallbacks for the types a user might have picked.
 * The writer takes the first candidate whose type matches the data source.
 */
export function columnValues(record: VideoRecord): Array<{ name: string; candidates: Candidate[] }> {
  const iso = (value: number) => new Date(value).toISOString().slice(0, 10);
  const created = iso(record.createdAt);
  const published = record.pubdate ? iso(record.pubdate * 1000) : created;
  const entries: Array<{ name: string; candidates: Candidate[] }> = [
    { name: '视频ID', candidates: [['rich_text', { rich_text: rich(record.bvid) }]] },
    { name: 'URL', candidates: [['url', { url: record.url }], ['rich_text', { rich_text: rich(record.url) }]] },
    {
      name: 'UP主',
      candidates: [
        ['rich_text', { rich_text: rich(record.owner.slice(0, 1000)) }],
        ['select', { select: { name: (record.owner || '未知').slice(0, 100) } }],
        ['multi_select', { multi_select: record.owner ? [{ name: record.owner.slice(0, 100) }] : [] }],
      ],
    },
    // 日期 is the publication date of the video, which is what a knowledge base is read by.
    { name: '日期', candidates: [['date', { date: { start: published } }], ['rich_text', { rich_text: rich(published) }]] },
    { name: '加入时间', candidates: [['date', { date: { start: created } }]] },
    { name: '发布时间', candidates: [['date', { date: { start: published } }]] },
    {
      name: '分区',
      candidates: [
        ['select', { select: { name: record.category || '未分区' } }],
        ['rich_text', { rich_text: rich(record.category || '未分区') }],
      ],
    },
    {
      name: '字幕语言',
      candidates: [
        ['select', { select: { name: record.subtitle?.track.language ?? 'none' } }],
        ['rich_text', { rich_text: rich(record.subtitle?.track.language ?? 'none') }],
      ],
    },
  ];
  if (record.analysis?.summary) {
    entries.push({ name: '摘要', candidates: [['rich_text', { rich_text: rich(record.analysis.summary.slice(0, 1900)) }]] });
  }
  const notes = notesText(record.userNotes);
  if (notes) entries.push({ name: '我的记录', candidates: [['rich_text', { rich_text: rich(notes.slice(0, 1900)) }]] });
  if (record.tags.length) {
    entries.push({ name: '标签', candidates: [['multi_select', { multi_select: record.tags.slice(0, 20).map((name) => ({ name })) }]] });
  }
  return entries;
}

/** External cover object: Notion fetches the URL itself, which only works if the CDN allows it. */
export function externalCover(record: VideoRecord): Record<string, unknown> | null {
  const url = normalizeCoverUrl(record.cover);
  return url ? { type: 'external', external: { url } } : null;
}

/** Notion's single-part upload limit; B站 covers are ~150 KB, anything huge stays a link. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

export function buildBlocks(record: VideoRecord): Block[] {
  const blocks: Block[] = [];
  blocks.push(callout(`B站操作：${actionSummary(record)}`, '⭐'));
  const meta = [
    `视频ID：${record.bvid}${record.page > 1 ? ` · P${record.page}` : ''}`,
    `来源：${record.url}`,
    `UP主：${record.owner || '未知'}`,
    `分区：${record.category || '未知'}`,
    record.duration ? `时长：${Math.round(record.duration)} 秒` : '',
    record.pubdate ? `发布：${new Date(record.pubdate * 1000).toISOString().slice(0, 10)}` : '',
    `记录时间：${new Date(record.createdAt).toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');
  blocks.push(...textBlocks(meta));

  if (record.analysis) {
    blocks.push(heading2('内容摘要'));
    blocks.push(...textBlocks(record.analysis.summary));
    if (record.analysis.outline.length) {
      blocks.push(heading2('分段提纲'));
      // Each item carries the transcript range it covers, so the outline doubles as an index.
      blocks.push(
        ...outlineEntries(record.analysis.outline, record.subtitle?.segments ?? []).map((entry) =>
          bullet(entry.text, outlineStamp(entry)),
        ),
      );
    }
    if (record.analysis.keyPoints.length) {
      blocks.push(heading2('关键点 / 可行动结论'));
      blocks.push(...record.analysis.keyPoints.map((point) => bullet(point)));
    }
    blocks.push(paragraph(`摘要来源：${record.analysis.provider} · ${record.analysis.model}`));
  } else {
    blocks.push(heading2('内容摘要'));
    blocks.push(paragraph('尚未生成 AI 摘要（可在扩展设置中启用）。'));
  }

  blocks.push(heading2('我的记录'));
  if (record.userNotes.highlights.length) {
    blocks.push(...record.userNotes.highlights.map((h) => bullet(`印象深刻：${h}`)));
  }
  if (record.userNotes.questions.length) {
    blocks.push(...record.userNotes.questions.map((q) => bullet(`值得思考：${q}`)));
  }
  if (record.userNotes.freeform.trim()) blocks.push(...textBlocks(record.userNotes.freeform));
  if (!record.userNotes.highlights.length && !record.userNotes.questions.length && !record.userNotes.freeform.trim()) {
    blocks.push(paragraph('（暂无手动笔记）'));
  }

  if (record.description) {
    blocks.push(heading2('视频简介'));
    blocks.push(...textBlocks(record.description));
  }

  if (record.subtitle) {
    const s = record.subtitle;
    blocks.push(heading2(`字幕（${s.track.label} · ${s.track.language}）`));
    blocks.push(
      paragraph(
        `轨道来源：${s.track.source} · 独立一致读取：${s.observations} 次 · SHA-256：${s.digest.slice(0, 16)}…${s.warnings.length ? '\n注意：' + s.warnings.join('；') : ''}`,
      ),
    );
    // Flowing paragraphs (punctuation added, timestamps dropped) instead of one line per cue:
    // readable in Notion, and far better context for retrieval than a wall of cue lines.
    blocks.push(...segmentsToParagraphs(s.segments).flatMap((text) => textBlocks(text)));
  } else {
    blocks.push(heading2('字幕'));
    blocks.push(paragraph('未获取到字幕（可能视频没有字幕或未登录）。'));
  }

  blocks.push(divider());
  blocks.push(paragraph('由 BiliVault 浏览器扩展自动生成 · 结构化数据可用于人和 AI 检索'));
  return blocks;
}

export interface NotionPlan {
  page: Record<string, unknown>;
  batches: Block[][];
  titleProperty: string;
  /** Column names written / skipped because the data source has no such column (or wrong type). */
  properties: { written: string[]; skipped: string[] };
}

export interface NotionTarget {
  token: string;
  parentId: string;
  parentType: 'page_id' | 'data_source_id';
  titleProperty?: string;
  /** Add the columns the extension writes when the data source does not have them yet. */
  autoColumns?: boolean;
}

/** Result of looking the video up in the knowledge base itself. */
export interface LibraryCheck {
  state: 'present' | 'missing' | 'unsupported';
  pageId?: string;
  url?: string;
  /** Which column the page was matched on. */
  matchedBy?: string;
}

export class NotionClient {
  constructor(
    private readonly token: string,
    private readonly http: FetchLike = browserFetch,
    private readonly pause = sleep,
  ) {
    if (!token) throw new NotConfigured('请在扩展设置中填写 Notion Integration Token');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
  }

  async request(method: string, path: string, payload?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.http(API + path, {
          method,
          headers: this.headers(),
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
      } catch {
        throw new BiliVaultError('Notion 网络请求未确认完成；请先核对远端页面，避免重复写入');
      }
      if (response.status === 429 && attempt < 3) {
        const retry = Number(response.headers.get('retry-after') ?? '1');
        await this.pause(Math.min(5, Math.max(1, retry)) * 1000);
        continue;
      }
      const body = await response.text();
      if (response.status >= 300) {
        throw new BiliVaultError(`Notion HTTP ${response.status}：${body.slice(0, 200)}`);
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new BiliVaultError('Notion 返回无效 JSON；请先核对远端状态');
      }
    }
  }

  async resolveTitleProperty(target: NotionTarget): Promise<{ titleProperty: string; schema: any | null }> {
    if (target.parentType !== 'data_source_id') return { titleProperty: target.titleProperty ?? 'title', schema: null };
    const schema = await this.request('GET', `/data_sources/${target.parentId}`);
    const titleProperty = Object.entries(schema?.properties ?? {}).find(([, v]: any) => v?.type === 'title')?.[0];
    if (!titleProperty) throw new BiliVaultError('Notion 数据源缺少标题属性');
    return { titleProperty, schema };
  }

  async plan(
    record: VideoRecord,
    target: NotionTarget,
    titleProperty: string,
    schema: any | null,
    cover?: Record<string, unknown> | null,
  ): Promise<NotionPlan> {
    const page: Record<string, unknown> = {
      parent: { type: target.parentType, [target.parentType]: target.parentId },
      properties: { [titleProperty]: { title: [{ type: 'text', text: { content: record.title.slice(0, 1000) } }] } },
    };
    const pageCover = cover === undefined ? externalCover(record) : cover;
    if (pageCover) page.cover = pageCover;
    const properties: Record<string, unknown> = { ...(page.properties as Record<string, unknown>) };
    const written: string[] = [];
    const skipped: string[] = [];
    // A page parent has no columns at all: sending anything but the title is rejected by the API.
    if (schema) {
      const matches = matchColumns(schema.properties ?? {});
      for (const { name, candidates } of columnValues(record)) {
        const match = matches.get(name);
        if (!match) {
          skipped.push(name);
          continue;
        }
        const pick = candidates.find(([kind]) => kind === match.type);
        if (!pick) {
          skipped.push(`${name}（${match.name} 是 ${match.type}）`);
          continue;
        }
        properties[match.name] = pick[1];
        written.push(match.name);
      }
    }
    page.properties = properties;
    return { page, batches: chunkBlocks(buildBlocks(record)), titleProperty, properties: { written, skipped } };
  }

  /**
   * Files the cover through the File Upload API. An external cover only renders when Notion's own
   * fetcher may read the image, and B站's CDN answers 403 to a foreign Referer — which is exactly
   * why covers stayed empty. Falls back to the external URL when the upload cannot be made.
   */
  async prepareCover(record: VideoRecord): Promise<Record<string, unknown> | null> {
    const fallback = externalCover(record);
    if (!fallback) return null;
    const url = (fallback.external as { url: string }).url;
    try {
      const response = await this.http(url, { headers: { Accept: 'image/*' }, referrerPolicy: 'no-referrer' });
      if (response.status >= 300) return fallback;
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) return fallback;
      const type = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
      const filename = `cover.${extensionFor(type)}`;
      const created = await this.request('POST', '/file_uploads', { mode: 'single_part', filename, content_type: type });
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), filename);
      const uploaded = await this.sendFile(created?.upload_url ?? `${API}/file_uploads/${created?.id}/send`, form);
      const id = uploaded?.id ?? created?.id;
      return id ? { type: 'file_upload', file_upload: { id } } : fallback;
    } catch {
      return fallback;
    }
  }

  /** Multipart send: no Content-Type of our own, the boundary has to come from FormData. */
  private async sendFile(url: string, form: FormData): Promise<any> {
    const response = await this.http(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_VERSION },
      body: form,
    });
    const text = await response.text();
    if (response.status >= 300) throw new BiliVaultError(`Notion 封面上传失败 HTTP ${response.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new BiliVaultError('Notion 封面上传返回无效 JSON');
    }
  }

  /**
   * Adds the columns the writer fills that this data source does not have yet, so a fresh database
   * needs no manual setup. One PATCH carries every missing column; the schema is re-read after,
   * because the write is planned against real column names and types.
   */
  async ensureColumns(dataSourceId: string, schema: any): Promise<{ added: string[]; schema: any }> {
    const missing = reviewSchema(schema).columns.filter((column) => column.status === 'missing');
    if (!missing.length) return { added: [], schema };
    const properties: Record<string, unknown> = {};
    for (const column of missing) {
      const spec = NOTION_COLUMNS.find((entry) => entry.name === column.name);
      if (spec) properties[spec.name] = { [spec.types[0]]: {} };
    }
    if (!Object.keys(properties).length) return { added: [], schema };
    await this.request('PATCH', `/data_sources/${dataSourceId}`, { properties });
    const fresh = await this.request('GET', `/data_sources/${dataSourceId}`);
    return { added: missing.map((column) => column.name), schema: fresh ?? schema };
  }

  /** Looks the video up by 视频ID (falling back to the title) to see if it is still in the library. */
  async checkLibrary(record: VideoRecord, target: NotionTarget): Promise<LibraryCheck> {
    if (target.parentType !== 'data_source_id') return { state: 'unsupported' };
    const schema = await this.request('GET', `/data_sources/${target.parentId}`);
    const properties: Record<string, any> = schema?.properties ?? {};
    const idMatch = matchColumns(properties).get('视频ID');
    const titleColumn = Object.keys(properties).find((name) => properties[name]?.type === 'title');
    const filter = idMatch
      ? idMatch.type === 'select'
        ? { property: idMatch.name, select: { equals: record.bvid } }
        : { property: idMatch.name, rich_text: { equals: record.bvid } }
      : titleColumn
        ? { property: titleColumn, title: { equals: record.title.slice(0, 200) } }
        : null;
    if (!filter) return { state: 'unsupported' };
    const result = await this.request('POST', `/data_sources/${target.parentId}/query`, { filter, page_size: 1 });
    const page = result?.results?.[0];
    return page?.id
      ? { state: 'present', pageId: page.id, url: page.url ?? '', matchedBy: filter.property }
      : { state: 'missing', matchedBy: filter.property };
  }

  async upload(
    record: VideoRecord,
    target: NotionTarget,
  ): Promise<{
    pageId: string;
    url: string;
    completedBatches: number;
    written: string[];
    skipped: string[];
    created: string[];
  }> {
    let { titleProperty, schema } = await this.resolveTitleProperty(target);
    let created: string[] = [];
    if (target.autoColumns && schema) {
      const ensured = await this.ensureColumns(target.parentId, schema);
      created = ensured.added;
      schema = ensured.schema;
      titleProperty =
        Object.entries(schema?.properties ?? {}).find(([, value]: [string, any]) => value?.type === 'title')?.[0] ?? titleProperty;
    }
    const cover = await this.prepareCover(record);
    const plan = await this.plan(record, target, titleProperty, schema, cover);
    const page = await this.request('POST', '/pages', plan.page);
    let completed = 0;
    for (const batch of plan.batches) {
      await this.pause(350);
      await this.request('PATCH', `/blocks/${page.id}/children`, { children: batch });
      completed += 1;
    }
    return {
      pageId: page.id,
      url: page.url ?? '',
      completedBatches: completed,
      written: plan.properties.written,
      skipped: plan.properties.skipped,
      created,
    };
  }
}

export function notionConfigured(settings: Settings): boolean {
  return !notionMissing(settings.notion);
}
