import { DEFAULT_SETTINGS, SCHEMA_VERSION, type ActionState, type Settings, type VideoRecord } from './types';
import { emptyActions, emptyWatch } from './events';
import { byActivityDesc } from './archive';
import { safeTime } from './time';

// 全部持久写入由 SW 接管。逐记录锁保护内容，但跨记录共享的索引/队列仍需全局串行读改写。
// 这里只包住短暂 storage 操作，不在锁内等待外部网络；失败也必须释放，避免后续写入饿死。
let mutationTail: Promise<unknown> = Promise.resolve();
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(work, work);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}
export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value));
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }
}

export class ChromeStorageStore implements KeyValueStore {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}

  async get(keys: string[]): Promise<Record<string, unknown>> {
    return (await this.area.get(keys)) as Record<string, unknown>;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await this.area.set(items);
  }

  async remove(keys: string[]): Promise<void> {
    await this.area.remove(keys);
  }
}

const SETTINGS_KEY = 'settings';
const INDEX_KEY = 'record-index';
const QUEUE_KEY = 'sync-queue';
/** 归档每被改动一次就写一个新的时间戳：界面靠它判断「要不要重读记录」，而不是每 2 秒搬一次整份归档。 */
const REVISION_KEY = 'records-revision';

/** 单调递增：同一毫秒里的两次写入也必须让界面看出来，否则会漏掉一次刷新。 */
function nextRevision(previous: unknown): number {
  return Math.max(Date.now(), Number(previous ?? 0) + 1);
}

/**
 * 存储里的时间可能来自旧版本、手工改过或溢出计算。坏值在这里就清成 0，绝不让它活到界面里：
 * `new Date(1e300).toISOString()` 会抛 RangeError，而渲染期一次抛错就会冻住整个视图。
 */
/**
 * 老记录可能只写了部分步骤（notion 是后加的，早期版本也没有 analysis）。三个步骤一律补齐，
 * 否则界面读 `steps.notion.pageId` 会直接抛错 —— 渲染期抛错会让整页停止更新。
 */
function withSafeSteps(steps: any): VideoRecord['steps'] {
  const part = (value: any) => ({ state: 'idle' as const, ...(value && typeof value === 'object' ? value : {}) });
  return { subtitle: part(steps?.subtitle), analysis: part(steps?.analysis), notion: part(steps?.notion) };
}

function withSafeTimes(raw: any): any {
  const out = { ...raw };
  if ('createdAt' in out) out.createdAt = safeTime(out.createdAt);
  if ('updatedAt' in out) out.updatedAt = safeTime(out.updatedAt);
  if (out.watched && typeof out.watched === 'object') {
    out.watched = { ...out.watched, firstAt: safeTime(out.watched.firstAt), lastAt: safeTime(out.watched.lastAt) };
  }
  if (out.history && typeof out.history === 'object') {
    out.history = { ...out.history, watchedAt: safeTime(out.history.watchedAt) };
  }
  if (out.archive && typeof out.archive === 'object') {
    const archive = { ...out.archive, archivedAt: safeTime(out.archive.archivedAt) };
    if (archive.seenAt && typeof archive.seenAt === 'object') {
      archive.seenAt = Object.fromEntries(Object.entries(archive.seenAt).map(([key, value]) => [key, safeTime(value)]));
    }
    out.archive = archive;
  }
  if (out.relation && typeof out.relation === 'object') {
    out.relation = { ...out.relation, checkedAt: safeTime(out.relation.checkedAt) };
  }
  return out;
}
const recordKey = (key: string) => `rec:${key}`;

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * Action state across schema versions: schema 1/2 stored a scored `value` object
 * (`{like, coins, favorite, share, score, reasons}`). The score was a misunderstanding and is
 * dropped; only the four flags B站 itself exposes are kept.
 */
export function normalizeActions(raw: any): ActionState {
  const legacy = raw?.actions ?? raw?.value ?? {};
  const coin = Number(legacy.coin ?? legacy.coins ?? 0);
  return {
    like: Boolean(legacy.like),
    coin: Number.isFinite(coin) ? Math.min(2, Math.max(0, Math.trunc(coin))) : 0,
    favorite: Boolean(legacy.favorite),
    share: Boolean(legacy.share),
  };
}

/** Legacy (schema 1) records stored `notion` instead of `steps`; migrate on read. */
export function normalizeRecord(raw: any): VideoRecord | undefined {
  if (!raw || typeof raw !== 'object' || !raw.key) return undefined;
  const safe = withSafeTimes(raw);
  const { value: _dropValue, ...rest } = safe;
  const actions = normalizeActions(safe);
  if (safe.steps && typeof safe.steps === 'object') {
    return { ...rest, schemaVersion: SCHEMA_VERSION, actions, steps: withSafeSteps(safe.steps) } as VideoRecord;
  }
  const legacyNotion = (safe.notion ?? {}) as Record<string, unknown>;
  const legacyState = String(legacyNotion.state ?? 'pending');
  const mapped = legacyState === 'synced' ? 'ok' : legacyState === 'syncing' ? 'running' : legacyState === 'pending' ? 'idle' : 'error';
  return {
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    actions,
    steps: {
      subtitle: { state: safe.subtitle ? 'ok' : 'idle', at: safe.subtitle?.fetchedAt },
      analysis: { state: safe.analysis ? 'ok' : 'idle', at: safe.analysis?.createdAt },
      notion: {
        state: mapped,
        error: legacyNotion.error as string | undefined,
        at: legacyNotion.syncedAt as number | undefined,
        pageId: legacyNotion.pageId as string | undefined,
        url: legacyNotion.url as string | undefined,
        completedBatches: legacyNotion.completedBatches as number | undefined,
      },
    },
  } as VideoRecord;
}

export class Repository {
  constructor(private readonly store: KeyValueStore) {}

  async getSettings(): Promise<Settings> {
    const raw = await this.store.get([SETTINGS_KEY]);
    return deepMerge(DEFAULT_SETTINGS, raw[SETTINGS_KEY]);
  }

  async saveSettings(patch: unknown): Promise<Settings> {
    const current = await this.getSettings();
    const next = deepMerge(current, patch);
    await this.store.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async list(): Promise<VideoRecord[]> {
    const { [INDEX_KEY]: index } = await this.store.get([INDEX_KEY]);
    const keys = Array.isArray(index) ? (index as string[]) : [];
    if (!keys.length) return [];
    const stored = await this.store.get(keys.map(recordKey));
    return keys.map((key) => normalizeRecord(stored[recordKey(key)])).filter(Boolean) as VideoRecord[];
  }

  async get(key: string): Promise<VideoRecord | undefined> {
    const stored = await this.store.get([recordKey(key)]);
    return normalizeRecord(stored[recordKey(key)]);
  }

  async upsert(record: VideoRecord): Promise<VideoRecord> {
    return mutate(() => this.upsertLocked(record));
  }

  private async upsertLocked(record: VideoRecord): Promise<VideoRecord> {
    const now = Date.now();
    const existing = await this.get(record.key);
    const merged: VideoRecord = {
      ...record,
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      updatedAt: now,
    };
    const { [INDEX_KEY]: index, [REVISION_KEY]: revision } = await this.store.get([INDEX_KEY, REVISION_KEY]);
    const keys: string[] = Array.isArray(index) ? (index as string[]) : [];
    if (!keys.includes(record.key)) keys.push(record.key);
    await this.store.set({ [recordKey(record.key)]: merged, [INDEX_KEY]: keys, [REVISION_KEY]: nextRevision(revision) });
    return merged;
  }

  /** 删除标记跨 SW 重启保留，禁止迟到的历史分页重新导入；主动页面收录仍可新建记录。 */
  async wasRemoved(key: string): Promise<boolean> {
    const marker = `removed:${key}`;
    return Boolean((await this.store.get([marker]))[marker]);
  }

  async remove(key: string): Promise<void> {
    return mutate(() => this.removeLocked(key));
  }

  private async removeLocked(key: string): Promise<void> {
    await this.store.set({ [`removed:${key}`]: true });
    const { [INDEX_KEY]: index, [REVISION_KEY]: revision } = await this.store.get([INDEX_KEY, REVISION_KEY]);
    const keys: string[] = Array.isArray(index) ? (index as string[]) : [];
    await this.store.set({ [INDEX_KEY]: keys.filter((k) => k !== key), [REVISION_KEY]: nextRevision(revision) });
    await this.store.remove([recordKey(key)]);
  }

  /**
   * 归档的版本号：只读一个数字，给界面轮询用。以前每 2 秒重读整份归档（含字幕、摘要），
   * 归档越大越卡，手指点下去也像没反应。
   */
  async revision(): Promise<number> {
    const { [REVISION_KEY]: value } = await this.store.get([REVISION_KEY]);
    return Number(value ?? 0) || 0;
  }

  /** 列表按「用户什么时候看过它」由近到远排，而不是按插件最后一次改动的时间。 */
  async search(query: string): Promise<VideoRecord[]> {
    const needle = query.trim().toLowerCase();
    const records = await this.list();
    if (!needle) return records.sort(byActivityDesc);
    return records
      .map((record) => ({ record, haystack: haystackFor(record) }))
      .filter(({ haystack }) => haystack.includes(needle))
      .sort((a, b) => byActivityDesc(a.record, b.record))
      .map(({ record }) => record);
  }

  async enqueue(key: string): Promise<void> {
    return mutate(() => this.enqueueLocked(key));
  }

  private async enqueueLocked(key: string): Promise<void> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    const keys: string[] = Array.isArray(queue) ? (queue as string[]) : [];
    if (!keys.includes(key)) keys.push(key);
    await this.store.set({ [QUEUE_KEY]: keys });
  }

  async dequeue(key: string): Promise<void> {
    return mutate(() => this.dequeueLocked(key));
  }

  private async dequeueLocked(key: string): Promise<void> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    const keys: string[] = Array.isArray(queue) ? (queue as string[]) : [];
    await this.store.set({ [QUEUE_KEY]: keys.filter((k) => k !== key) });
  }

  async queue(): Promise<string[]> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    return Array.isArray(queue) ? (queue as string[]) : [];
  }

  async rotate(key: string): Promise<void> {
    return mutate(() => this.rotateLocked(key));
  }

  private async rotateLocked(key: string): Promise<void> {
    await this.dequeueLocked(key);
    const queue = await this.queue();
    await this.store.set({ [QUEUE_KEY]: [...queue, key] });
  }
}

export function haystackFor(record: VideoRecord): string {
  return [
    record.title,
    record.owner,
    record.bvid,
    record.category ?? '',
    record.description ?? '',
    record.subtitle?.plainText ?? '',
    record.subtitle?.track.label ?? '',
    record.analysis?.summary ?? '',
    (record.analysis?.outline ?? []).join(' '),
    (record.analysis?.keyPoints ?? []).join(' '),
    record.userNotes.highlights.join(' '),
    record.userNotes.questions.join(' '),
    record.userNotes.freeform,
    record.tags.join(' '),
  ]
    .join('\n')
    .toLowerCase();
}

export function emptySteps() {
  return {
    subtitle: { state: 'idle' as const },
    analysis: { state: 'idle' as const },
    notion: { state: 'idle' as const },
  };
}

export function newRecord(input: {
  bvid: string;
  aid: number;
  cid: number;
  page?: number;
  title: string;
  owner: string;
  ownerMid?: number;
  cover?: string;
  category?: string;
  duration?: number;
  pubdate?: number;
  description?: string;
  url: string;
  tags?: string[];
}): VideoRecord {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    key: `${input.bvid}:${input.cid}`,
    bvid: input.bvid,
    aid: input.aid,
    cid: input.cid,
    page: input.page ?? 1,
    title: input.title,
    owner: input.owner,
    ownerMid: input.ownerMid,
    cover: input.cover,
    category: input.category,
    duration: input.duration,
    pubdate: input.pubdate,
    description: input.description,
    url: input.url,
    tags: input.tags ?? [],
    actions: emptyActions(),
    watched: emptyWatch(now),
    steps: emptySteps(),
    userNotes: { highlights: [], questions: [], freeform: '' },
    archive: { origins: ['page'], seenAt: {}, archivedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

/** A record has usable metadata once we know the real title and the uploader. */
export function hasMetadata(record: VideoRecord): boolean {
  return Boolean(record.title && record.title !== record.bvid && record.owner);
}
