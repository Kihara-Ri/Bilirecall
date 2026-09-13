import { DEFAULT_SETTINGS, SCHEMA_VERSION, type ActionState, type Settings, type VideoRecord } from './types';
import { emptyActions, emptyWatch } from './events';

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
  const { value: _dropValue, ...rest } = raw;
  const actions = normalizeActions(raw);
  if (raw.steps && typeof raw.steps === 'object') {
    return { ...rest, schemaVersion: SCHEMA_VERSION, actions } as VideoRecord;
  }
  const legacyNotion = (raw.notion ?? {}) as Record<string, unknown>;
  const legacyState = String(legacyNotion.state ?? 'pending');
  const mapped = legacyState === 'synced' ? 'ok' : legacyState === 'syncing' ? 'running' : legacyState === 'pending' ? 'idle' : 'error';
  return {
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    actions,
    steps: {
      subtitle: { state: raw.subtitle ? 'ok' : 'idle', at: raw.subtitle?.fetchedAt },
      analysis: { state: raw.analysis ? 'ok' : 'idle', at: raw.analysis?.createdAt },
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
    const now = Date.now();
    const existing = await this.get(record.key);
    const merged: VideoRecord = {
      ...record,
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      updatedAt: now,
    };
    const { [INDEX_KEY]: index } = await this.store.get([INDEX_KEY]);
    const keys: string[] = Array.isArray(index) ? (index as string[]) : [];
    if (!keys.includes(record.key)) keys.push(record.key);
    await this.store.set({ [recordKey(record.key)]: merged, [INDEX_KEY]: keys });
    return merged;
  }

  async remove(key: string): Promise<void> {
    const { [INDEX_KEY]: index } = await this.store.get([INDEX_KEY]);
    const keys: string[] = Array.isArray(index) ? (index as string[]) : [];
    await this.store.set({ [INDEX_KEY]: keys.filter((k) => k !== key) });
    await this.store.remove([recordKey(key)]);
  }

  async search(query: string): Promise<VideoRecord[]> {
    const needle = query.trim().toLowerCase();
    const records = await this.list();
    if (!needle) return records.sort((a, b) => b.updatedAt - a.updatedAt);
    return records
      .map((record) => ({ record, haystack: haystackFor(record) }))
      .filter(({ haystack }) => haystack.includes(needle))
      .sort((a, b) => b.record.updatedAt - a.record.updatedAt)
      .map(({ record }) => record);
  }

  async enqueue(key: string): Promise<void> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    const keys: string[] = Array.isArray(queue) ? (queue as string[]) : [];
    if (!keys.includes(key)) keys.push(key);
    await this.store.set({ [QUEUE_KEY]: keys });
  }

  async dequeue(key: string): Promise<void> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    const keys: string[] = Array.isArray(queue) ? (queue as string[]) : [];
    await this.store.set({ [QUEUE_KEY]: keys.filter((k) => k !== key) });
  }

  async queue(): Promise<string[]> {
    const { [QUEUE_KEY]: queue } = await this.store.get([QUEUE_KEY]);
    return Array.isArray(queue) ? (queue as string[]) : [];
  }

  async rotate(key: string): Promise<void> {
    await this.dequeue(key);
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
