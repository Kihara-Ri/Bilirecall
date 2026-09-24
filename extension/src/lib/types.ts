export const SCHEMA_VERSION = 2;

export interface WatchStats {
  firstAt: number;
  lastAt: number;
  visits: number;
  secondsWatched: number;
  maxProgressRatio: number;
  completed: boolean;
}

/**
 * The four B站 actions this extension mirrors. Deliberately not a "score": it is a copy of
 * the state B站 itself shows on the video page, read back from B站's own API.
 */
export interface ActionState {
  like: boolean;
  /** Coins from the current account (0-2). */
  coin: number;
  favorite: boolean;
  /** B站 has no per-user share-state API; this one is observed in the page and never inferred. */
  share: boolean;
}

/** Provenance of {@link ActionState}, so the UI can say where the state came from. */
export interface RelationState {
  fetchedAt: number;
  source: 'api' | 'local';
  error?: string;
  warnings?: string[];
}

export interface SubtitleTrackMeta {
  id: string;
  language: string;
  label: string;
  /** Where the track list came from. 'page' is the player's own response. */
  source: 'page' | 'player-wbi' | 'proto';
}

export interface SubtitleSegment {
  from: number;
  to: number;
  content: string;
}

export interface SubtitleResult {
  track: SubtitleTrackMeta;
  availableTracks: SubtitleTrackMeta[];
  segments: SubtitleSegment[];
  plainText: string;
  digest: string;
  fetchedAt: number;
  /** 1 = single observation, 2+ = independent observations agreed. */
  observations: number;
  warnings: string[];
}

export interface AnalysisResult {
  summary: string;
  outline: string[];
  keyPoints: string[];
  provider: string;
  model: string;
  createdAt: number;
  /** Subtitle digest this analysis was generated from; used to detect staleness. */
  subtitleDigest?: string;
}

export interface UserNotes {
  highlights: string[];
  questions: string[];
  freeform: string;
}

/** Per-step pipeline state, so a failure is reported on the step that failed. */
export type StepPhase = 'idle' | 'running' | 'ok' | 'error';

/** The three ordered steps of the pipeline: subtitle -> analysis -> notion. */
export type PipelineStep = 'subtitle' | 'analysis' | 'notion';

export interface StepState {
  state: StepPhase;
  error?: string;
  at?: number;
}

export interface NotionStepState extends StepState {
  pageId?: string;
  url?: string;
  completedBatches?: number;
  /** Subtitle digest that was uploaded; used to detect a stale page. */
  subtitleDigest?: string;
  /** Column names the data source had, in the order they were written. */
  written?: string[];
  /** Canonical columns with no matching column in the data source (content still goes in the body). */
  skipped?: string[];
  /** Columns this run added to the data source. */
  created?: string[];
  /** Last look at the knowledge base itself: is this video still a page in there? */
  library?: { state: 'present' | 'missing'; checkedAt: number; matchedBy?: string };
}

export interface PipelineSteps {
  subtitle: StepState;
  analysis: StepState;
  notion: NotionStepState;
}

export interface VideoRecord {
  schemaVersion: number;
  key: string;
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  title: string;
  owner: string;
  ownerMid?: number;
  cover?: string;
  category?: string;
  duration?: number;
  pubdate?: number;
  description?: string;
  url: string;
  tags: string[];
  actions: ActionState;
  relation?: RelationState;
  watched: WatchStats;
  /** B站 返回的最近观看位置，不是累计观看秒数；独立保存以免其他来源合并时清掉。 */
  history?: { watchedAt: number; position: number; finished: boolean; hidden?: boolean };
  /** 导入只做本地归档；主动收录与原页面自动收录规则另行处理。 */
  library?: { saved: boolean };
  steps: PipelineSteps;
  subtitle?: SubtitleResult;
  analysis?: AnalysisResult;
  userNotes: UserNotes;
  /**
   * 本地归档信息：这条记录出现在哪些 B站 列表里、最后一次看到的时间。B站 的历史记录会过期，
   * 本地这份记录不会因此消失（只会被标记）。
   */
  archive?: {
    origins: Array<'history' | 'likes' | 'favorites' | 'page'>;
    seenAt: Partial<Record<'history' | 'likes' | 'favorites', number>>;
    archivedAt: number;
    droppedFromHistory?: boolean;
  };
  /** Metadata enrichment failed (used to avoid hammering the API). */
  metadataError?: string;
  createdAt: number;
  updatedAt: number;
}

/** A patch that touches only the listed leaves, leaving the rest of the section untouched. */
export type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

export interface Settings {
  notion: {
    enabled: boolean;
    token: string;
    parentType: 'page_id' | 'data_source_id';
    parentId: string;
    titleProperty: string;
    /** Add the columns the extension writes when the data source does not have them yet. */
    autoColumns: boolean;
  };
  ai: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    language: string;
    prompt: string;
  };
  subtitle: {
    language: string;
    /** Independent reads required to agree before a subtitle is trusted. */
    consensusReads: number;
    maxAttempts: number;
  };
  webhook: {
    enabled: boolean;
    url: string;
  };
  general: {
    captureWatched: boolean;
    autoUpdateHistory: boolean;
    notifyOnSync: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  notion: { enabled: false, token: '', parentType: 'data_source_id', parentId: '', titleProperty: 'title', autoColumns: true },
  ai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    language: '中文',
    prompt:
      '你是一个知识管理助手。请用简洁的{{language}}输出 JSON：{"summary": "3-5句摘要", "outline": ["[00:00-00:30] 这一段讲了什么"], "keyPoints": ["值得记住的结论或方法"]}。outline 每一条都要以字幕里的 [分:秒] 时间标记开头（如 [00:12-02:30]），标明该内容出现在哪一段，只能引用字幕中出现过的时间。只输出 JSON。',
  },
  subtitle: { language: 'auto', consensusReads: 2, maxAttempts: 4 },
  webhook: { enabled: false, url: '' },
  general: { captureWatched: true, autoUpdateHistory: true, notifyOnSync: true },
};
