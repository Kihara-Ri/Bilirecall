import { describe, expect, it } from 'vitest';
import { NotionClient, buildBlocks, chunkBlocks, paragraph, reviewSchema } from '../src/lib/notion';
import { validateSegments } from '../src/lib/subtitle';
import { newRecord } from '../src/lib/store';
import type { VideoRecord } from '../src/lib/types';
import { jsonResponse, mockFetch, subtitleBody } from './helpers';

function makeRecord(): VideoRecord {
  const record = newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 123456,
    cid: 789,
    title: 'T',
    owner: 'U',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    category: '科技',
    duration: 600,
    pubdate: 1700000000,
    description: 'D',
  });
  record.actions = { like: true, coin: 2, favorite: true, share: false };
  record.analysis = { summary: 'S', outline: ['a', 'b'], keyPoints: ['k'], provider: 'p', model: 'm', createdAt: 1 };
  const segments = validateSegments(subtitleBody('one', 'two', 'three'));
  record.subtitle = {
    track: { id: '1', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
    availableTracks: [],
    segments,
    plainText: segments.map((s) => s.content).join('\n'),
    digest: '0'.repeat(64),
    fetchedAt: 1,
    observations: 2,
    warnings: [],
  };
  record.userNotes = { highlights: ['h'], questions: ['q'], freeform: 'f' };
  return record;
}

describe('Notion blocks', () => {
  it('builds a readable page body', () => {
    const blocks = buildBlocks(makeRecord());
    const types = blocks.map((b) => b.type);
    expect(types).toContain('callout');
    expect(types).toContain('heading_2');
    const json = JSON.stringify(blocks);
    expect(json).toContain('内容摘要');
    expect(json).toContain('我的记录');
    expect(json).toContain('印象深刻：h');
    expect(json).toContain('值得思考：q');
    expect(json).toContain('SHA-256');
    expect(json).toContain('视频ID：BV1xx411c7mD');
  });

  it('stamps outline items with their transcript range and writes subtitle paragraphs', () => {
    const record = makeRecord();
    record.analysis = { ...record.analysis!, outline: ['[00:01-00:02] 这一段讲了 one 和 two'] };
    const json = JSON.stringify(buildBlocks(record));
    expect(json).toContain('[00:01–00:02] ');
    expect(json).toContain('这一段讲了 one 和 two');
    expect(json).toContain('one，two，three。');
    expect(json).not.toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
  });

  it('splits blocks under the Notion request limits', () => {
    const batches = chunkBlocks(Array.from({ length: 250 }, () => paragraph('x')));
    expect(batches.length).toBe(3);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(90);
    expect(batches.flat()).toHaveLength(250);
  });
});

describe('NotionClient upload', () => {
  it('creates a page in a data source and only fills existing properties', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const schema = { properties: { Name: { type: 'title' }, URL: { type: 'url' }, 摘要: { type: 'rich_text' } } };
    const http = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/data_sources/ds1') return jsonResponse(schema);
      if (path === '/v1/pages') return jsonResponse({ id: 'page-1', url: 'https://notion.so/page-1' });
      if (path.startsWith('/v1/blocks/')) return jsonResponse({});
      return undefined;
    });
    const client = new NotionClient('token', http, async () => undefined);
    const result = await client.upload(makeRecord(), { token: 'token', parentId: 'ds1', parentType: 'data_source_id' });
    expect(result.pageId).toBe('page-1');
    const create = calls.find((c) => c.path === '/v1/pages')!;
    expect(create.body.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds1' });
    expect(create.body.properties.Name.title[0].text.content).toBe('T');
    expect(create.body.properties.URL.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD/');
    expect(create.body.properties.摘要.rich_text[0].text.content).toBe('S');
    // the old "价值分" property is gone from the writer entirely
    expect(create.body.properties.价值分).toBeUndefined();
    expect(JSON.stringify(create.body)).not.toContain('价值分');
    expect(create.body.properties['加入时间']).toBeUndefined();
    expect(create.body.properties['UP主']).toBeUndefined();
    expect(calls.filter((c) => c.path.startsWith('/v1/blocks/')).length).toBe(1);
  });

  it('writes the title property it discovers, not a hard-coded one', async () => {
    const calls: any[] = [];
    const http = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/data_sources/ds2') return jsonResponse({ properties: { 标题: { type: 'title' } } });
      if (path === '/v1/pages') return jsonResponse({ id: 'p', url: 'u' });
      return jsonResponse({});
    });
    const client = new NotionClient('token', http, async () => undefined);
    await client.upload(makeRecord(), { token: 'token', parentId: 'ds2', parentType: 'data_source_id' });
    expect(calls.find((c) => c.path === '/v1/pages')!.body.properties['标题']).toBeDefined();
  });

  it('requires a token', () => {
    expect(() => new NotionClient('')).toThrow();
  });
});

describe('Notion property mapping', () => {
  const schema = {
    properties: {
      Name: { type: 'title' },
      URL: { type: 'url' },
      UP主: { type: 'rich_text' },
      日期: { type: 'date' },
      摘要: { type: 'rich_text' },
      我的记录: { type: 'rich_text' },
    },
  };
  const target = { token: 'token', parentId: 'ds', parentType: 'data_source_id' as const };

  async function plan(schemaValue: any, mutate: (record: VideoRecord) => void = () => {}) {
    const record = makeRecord();
    mutate(record);
    const client = new NotionClient('token', mockFetch(() => undefined), async () => undefined);
    return { record, plan: await client.plan(record, target, 'Name', schemaValue) };
  }

  it('fills 名称 / UP主 / 日期 / 摘要 / 我的记录 and skips columns that do not exist', async () => {
    const { plan: planned } = await plan(schema);
    const properties = planned.page.properties as Record<string, any>;
    expect(properties.Name.title[0].text.content).toBe('T');
    expect(properties['UP主'].rich_text[0].text.content).toBe('U');
    expect(properties['日期'].date.start).toBe('2023-11-14');
    expect(properties['摘要'].rich_text[0].text.content).toBe('S');
    const notes = properties['我的记录'].rich_text[0].text.content;
    expect(notes).toContain('印象深刻：h');
    expect(notes).toContain('值得思考：q');
    expect(notes).toContain('f');
    expect(planned.properties.written).toEqual(expect.arrayContaining(['URL', 'UP主', '日期', '摘要', '我的记录']));
    // 分区 is produced for every record but absent from this data source, so it is skipped.
    expect(planned.properties.skipped).toContain('分区');
  });

  it('sets the page cover from an http cover URL', async () => {
    const { plan: planned } = await plan(schema, (record) => {
      record.cover = 'http://i0.hdslb.com/bfs/archive/abc.jpg';
    });
    expect((planned.page as any).cover).toEqual({
      type: 'external',
      external: { url: 'https://i0.hdslb.com/bfs/archive/abc.jpg' },
    });
  });

  it('uses a select column when the user made UP主 one', async () => {
    const { plan: planned } = await plan({ properties: { Name: { type: 'title' }, UP主: { type: 'select' } } });
    expect((planned.page.properties as any)['UP主'].select.name).toBe('U');
  });
});

describe('schema review (测试连接)', () => {
  it('reports required columns, wrong types and unknown columns', () => {
    const review = reviewSchema({
      properties: {
        Name: { type: 'title' },
        UP主: { type: 'rich_text' },
        日期: { type: 'date' },
        摘要: { type: 'select' },
        我的记录: { type: 'rich_text' },
        备注: { type: 'rich_text' },
      },
    });
    const byName = Object.fromEntries(review.columns.map((column) => [column.name, column]));
    expect(review.titleProperty).toBe('Name');
    expect(review.ok).toBe(false);
    expect(byName['UP主'].status).toBe('ok');
    expect(byName['摘要'].status).toBe('type');
    expect(byName['标签'].status).toBe('missing');
    expect(byName['标签'].required).toBe(false);
    expect(review.extra).toEqual(['备注']);
  });

  it('accepts the alternative types for the required columns', () => {
    const review = reviewSchema({
      properties: {
        Name: { type: 'title' },
        视频ID: { type: 'rich_text' },
        UP主: { type: 'select' },
        日期: { type: 'rich_text' },
        摘要: { type: 'rich_text' },
      },
    });
    expect(review.ok).toBe(true);
  });

  it('fails when there is no title property', () => {
    expect(reviewSchema({ properties: { 摘要: { type: 'rich_text' } } }).ok).toBe(false);
  });
});

/** The names people actually type: 标题 / UP主名称 / Summary / 发布日期. */
const aliasSchema = {
  properties: {
    标题: { type: 'title' },
    视频ID: { type: 'rich_text' },
    UP主名称: { type: 'rich_text' },
    Summary: { type: 'rich_text' },
    发布日期: { type: 'date' },
    我的记录: { type: 'rich_text' },
  },
};

describe('column aliases', () => {
  const target = { token: 'token', parentId: 'ds', parentType: 'data_source_id' as const };

  async function planned(schema: any) {
    const record = makeRecord();
    const client = new NotionClient('token', mockFetch(() => undefined), async () => undefined);
    return client.plan(record, target, Object.keys(schema.properties)[0], schema);
  }

  it('writes a column named UP主名称 / Summary / 发布日期', async () => {
    const plan = await planned(aliasSchema);
    const properties = plan.page.properties as Record<string, any>;
    expect(properties['UP主名称'].rich_text[0].text.content).toBe('U');
    expect(properties.Summary.rich_text[0].text.content).toBe('S');
    expect(properties['发布日期'].date.start).toBe('2023-11-14');
    expect(properties['我的记录'].rich_text[0].text.content).toContain('印象深刻：h');
    expect(properties['视频ID'].rich_text[0].text.content).toBe('BV1xx411c7mD');
    expect(plan.properties.written).toEqual(expect.arrayContaining(['视频ID', 'UP主名称', 'Summary', '发布日期', '我的记录']));
  });

  it('prefers an exact name over an alias of another column', async () => {
    const plan = await planned({
      properties: {
        Name: { type: 'title' },
        日期: { type: 'date' },
        发布时间: { type: 'date' },
        加入时间: { type: 'date' },
      },
    });
    const properties = plan.page.properties as Record<string, any>;
    expect(properties['日期'].date.start).toBe('2023-11-14');
    expect(properties['发布时间'].date.start).toBe('2023-11-14');
    expect(properties['加入时间']).toBeDefined();
  });

  it('reports the matched column name, so 测试连接 can explain a write', () => {
    const review = reviewSchema(aliasSchema);
    const byName = Object.fromEntries(review.columns.map((column) => [column.name, column]));
    expect(review.ok).toBe(true);
    expect(byName['UP主'].matched).toBe('UP主名称');
    expect(byName['摘要'].matched).toBe('Summary');
    expect(byName['日期'].matched).toBe('发布日期');
    expect(byName['标签'].status).toBe('missing');
  });

  it('adds the columns the writer needs and re-reads the schema', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const initial = { properties: { Name: { type: 'title' } } };
    const after = {
      properties: {
        Name: { type: 'title' },
        视频ID: { type: 'rich_text' },
        UP主: { type: 'rich_text' },
        日期: { type: 'date' },
        摘要: { type: 'rich_text' },
        我的记录: { type: 'rich_text' },
      },
    };
    let schemaReads = 0;
    const http = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/data_sources/ds') {
        schemaReads += 1;
        return jsonResponse(schemaReads === 1 ? initial : after);
      }
      if (path === '/v1/pages') return jsonResponse({ id: 'page-1', url: 'u' });
      return jsonResponse({});
    });
    const client = new NotionClient('token', http, async () => undefined);
    const result = await client.upload(makeRecord(), {
      token: 'token',
      parentId: 'ds',
      parentType: 'data_source_id',
      autoColumns: true,
    });
    const patch = calls.find((call) => call.method === 'PATCH' && call.path === '/v1/data_sources/ds')!;
    expect(Object.keys(patch.body.properties)).toEqual(expect.arrayContaining(['视频ID', 'UP主', '日期', '摘要', '我的记录']));
    expect(patch.body.properties['日期']).toEqual({ date: {} });
    expect(patch.body.properties['我的记录']).toEqual({ rich_text: {} });
    // Never touch a column that already exists.
    expect(patch.body.properties.Name).toBeUndefined();
    expect(result.created).toEqual(expect.arrayContaining(['视频ID', '摘要']));
    const create = calls.find((call) => call.path === '/v1/pages')!;
    expect(create.body.properties['视频ID'].rich_text[0].text.content).toBe('BV1xx411c7mD');
    expect(create.body.properties['摘要'].rich_text[0].text.content).toBe('S');
  });

  it('leaves the schema alone unless autoColumns is on', async () => {
    const calls: any[] = [];
    const http = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      calls.push({ method: init?.method ?? 'GET', path });
      if (path === '/v1/data_sources/ds') return jsonResponse({ properties: { Name: { type: 'title' } } });
      if (path === '/v1/pages') return jsonResponse({ id: 'p', url: 'u' });
      return jsonResponse({});
    });
    await new NotionClient('token', http, async () => undefined).upload(makeRecord(), {
      token: 'token',
      parentId: 'ds',
      parentType: 'data_source_id',
    });
    expect(calls.some((call) => call.method === 'PATCH' && call.path === '/v1/data_sources/ds')).toBe(false);
  });

  it('sends only the title when the parent is a page', async () => {
    const record = makeRecord();
    const client = new NotionClient('token', mockFetch(() => undefined), async () => undefined);
    const plan = await client.plan(record, { token: 'token', parentId: 'page-1', parentType: 'page_id' }, 'title', null);
    expect(Object.keys(plan.page.properties as Record<string, unknown>)).toEqual(['title']);
    expect(plan.properties.written).toEqual([]);
  });
});

describe('library check', () => {
  const record = () => makeRecord();
  const query = (results: any[]) =>
    mockFetch((url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/data_sources/ds') {
        return jsonResponse({ properties: { Name: { type: 'title' }, 视频ID: { type: 'rich_text' } } });
      }
      if (path === '/v1/data_sources/ds/query') {
        expect(JSON.parse(String(init?.body)).filter).toEqual({
          property: '视频ID',
          rich_text: { equals: 'BV1xx411c7mD' },
        });
        return jsonResponse({ results });
      }
      return jsonResponse({});
    });
  const target = { token: 'token', parentId: 'ds', parentType: 'data_source_id' as const };

  it('finds the page by 视频ID', async () => {
    const check = await new NotionClient('token', query([{ id: 'p1', url: 'https://notion.so/p1' }]), async () => undefined).checkLibrary(
      record(),
      target,
    );
    expect(check).toEqual({ state: 'present', pageId: 'p1', url: 'https://notion.so/p1', matchedBy: '视频ID' });
  });

  it('reports a video whose page is gone', async () => {
    const check = await new NotionClient('token', query([]), async () => undefined).checkLibrary(record(), target);
    expect(check).toEqual({ state: 'missing', matchedBy: '视频ID' });
  });

  it('cannot search under a page parent', async () => {
    const client = new NotionClient('token', mockFetch(() => undefined), async () => undefined);
    expect((await client.checkLibrary(record(), { token: 't', parentId: 'p', parentType: 'page_id' })).state).toBe('unsupported');
  });
});

describe('cover handling', () => {
  const target = { token: 'token', parentId: 'ds', parentType: 'data_source_id' as const };
  const coverUrl = 'https://i0.hdslb.com/bfs/archive/abc.jpg';
  const schema = { properties: { Name: { type: 'title' } } };

  it('uploads the cover through the File Upload API and attaches it by id', async () => {
    const record = makeRecord();
    record.cover = 'http://i0.hdslb.com/bfs/archive/abc.jpg';
    const calls: Array<{ path: string; method: string; body: any; headers: any }> = [];
    const http = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body instanceof FormData ? 'form' : init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: init?.headers,
      });
      if (url === coverUrl) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (path === '/v1/data_sources/ds') return jsonResponse(schema);
      if (path === '/v1/file_uploads') return jsonResponse({ id: 'fu-1', upload_url: 'https://api.notion.com/v1/file_uploads/fu-1/send' });
      if (path === '/v1/file_uploads/fu-1/send') return jsonResponse({ id: 'fu-1', status: 'uploaded' });
      if (path === '/v1/pages') return jsonResponse({ id: 'page-1', url: 'https://notion.so/page-1' });
      return jsonResponse({});
    });
    const client = new NotionClient('token', http, async () => undefined);
    await client.upload(record, target);
    const create = calls.find((call) => call.path === '/v1/pages')!;
    expect(create.body.cover).toEqual({ type: 'file_upload', file_upload: { id: 'fu-1' } });
    const created = calls.find((call) => call.path === '/v1/file_uploads')!;
    expect(created.body).toMatchObject({ mode: 'single_part', content_type: 'image/jpeg' });
    const sent = calls.find((call) => call.path === '/v1/file_uploads/fu-1/send')!;
    expect(sent.body).toBe('form');
    expect(JSON.stringify(sent.headers)).not.toContain('Content-Type');
  });

  it('falls back to the external URL when the CDN refuses the image', async () => {
    const record = makeRecord();
    record.cover = coverUrl;
    const calls: Array<{ path: string; body: any }> = [];
    const http = mockFetch((url, init) => {
      if (url === coverUrl) return new Response('nope', { status: 403 });
      const path = new URL(url).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/data_sources/ds') return jsonResponse(schema);
      if (path === '/v1/pages') return jsonResponse({ id: 'page-1', url: 'u' });
      return jsonResponse({});
    });
    const client = new NotionClient('token', http, async () => undefined);
    await client.upload(record, target);
    expect(calls.find((call) => call.path === '/v1/pages')!.body.cover).toEqual({ type: 'external', external: { url: coverUrl } });
    expect(calls.some((call) => call.path === '/v1/file_uploads')).toBe(false);
  });
});
