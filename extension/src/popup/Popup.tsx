import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { agentBrief } from '../lib/export';
import { analysisFresh, notionFresh, notionMissing } from '../lib/pipeline';
import { sendToBackground } from '../lib/messages';
import { downloadText } from '../lib/download';
import { providerLabel } from '../lib/ai';
import {
  CoinIcon,
  FavoriteIcon,
  GearIcon,
  InfoIcon,
  LikeIcon,
  NotesIcon,
  NotionIcon,
  ProviderMark,
  RefreshIcon,
  ShareIcon,
  SrtIcon,
  WriteIcon,
} from '../lib/icons';
import { draftCount, draftToNotes, emptyDraft, emptyNotes, notesToDraft, sameNotes, type NoteDraft, type NoteField } from '../lib/notes';
import { segmentsToSrt } from '../lib/subtitle';
import type { CurrentVideoState, PipelineStep, StatsResult } from '../lib/messages';
import type { Settings, UserNotes, VideoRecord } from '../lib/types';

/** 每种记录在空框里显示的那句提示（也是输入框的无障碍名字）。 */
const NOTE_PROMPT: Record<'highlights' | 'questions' | 'freeform', string> = {
  highlights: '一行一条：哪里让你印象深刻',
  questions: '一行一条：哪些问题值得进一步思考',
  freeform: '任何上下文、出处、待办…',
};

const duration = (seconds?: number): string => {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
/** Short timestamp for the inline subtitle preview. */
const stamp = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const openViewer = (key: string, hash = ''): void => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?key=${encodeURIComponent(key)}${hash}`) });
};

type Tone = 'ok' | 'warn' | 'bad' | 'mute';
interface StepView {
  text: string;
  tone: Tone;
  error?: string;
}

function subtitleView(record: VideoRecord): StepView {
  const step = record.steps?.subtitle;
  if (step?.state === 'running') return { text: '抓取中…', tone: 'warn' };
  if (record.subtitle) return { text: `${record.subtitle.track.label} · ${record.subtitle.observations} 次读取一致`, tone: 'ok' };
  if (step?.state === 'error') return { text: '抓取失败', tone: 'bad', error: step.error };
  return { text: '未抓取', tone: 'mute' };
}

function analysisView(record: VideoRecord, aiEnabled: boolean): StepView {
  const step = record.steps?.analysis;
  if (step?.state === 'running') return { text: '生成中…', tone: 'warn' };
  if (step?.state === 'error') return { text: '生成失败', tone: 'bad', error: step.error };
  if (record.analysis) {
    const stale = Boolean(record.subtitle && record.analysis.subtitleDigest !== record.subtitle.digest);
    return stale ? { text: '已过期（字幕已更新）', tone: 'warn' } : { text: '已生成', tone: 'ok' };
  }
  return aiEnabled ? { text: '未生成', tone: 'mute' } : { text: '未启用', tone: 'mute' };
}

function notionView(record: VideoRecord, configured: boolean, missing: string): StepView {
  const step = record.steps?.notion;
  if (step?.state === 'running') return { text: '写入中…', tone: 'warn' };
  if (step?.state === 'error') return { text: '写入失败', tone: 'bad', error: step.error };
  if (step?.state === 'ok') {
    const stale = Boolean(record.subtitle && step.subtitleDigest !== record.subtitle.digest);
    return stale ? { text: '字幕已更新，需重新写入', tone: 'warn' } : { text: '已写入', tone: 'ok' };
  }
  // Naming the missing field turns "未配置" into something the user can act on.
  return configured ? { text: '待同步', tone: 'mute' } : { text: missing ? `未配置（${missing}）` : '未配置', tone: 'mute' };
}

function StepRow({
  label,
  icon,
  extra,
  view,
  disabled,
  onRetry,
  children,
  extraSide = 'label',
}: {
  label: string;
  /** Icon-only label; the text stays as the accessible name and the tooltip. */
  icon?: preact.ComponentChildren;
  /** Small affordances (SRT download, provider badge, details toggle) shown before the retry. */
  extra?: preact.ComponentChildren;
  /**
   * Where `extra` sits. `label` (default) keeps the mark right after the step name — that is where a
   * badge like SRT or the provider logo belongs. `end` pushes it to the right edge instead, which is
   * what an action like the Notion write-details toggle wants.
   */
  extraSide?: 'label' | 'end';
  view: StepView;
  disabled: boolean;
  onRetry: () => void;
  children?: preact.ComponentChildren;
}) {
  return (
    <li class="step">
      <div class="step-row">
        <span class="k" title={label}>
          {icon ?? label}
          {icon ? <span class="sr-only">{label}</span> : null}
        </span>
        {extraSide === 'label' ? extra : null}
        <span class={`v ${view.tone}`}>
          <span>{view.text}</span>
        </span>
        {extraSide === 'end' ? extra : null}
        <button class="icon" title={`重新执行：${label}`} aria-label={`重新执行${label}`} disabled={disabled} onClick={onRetry}>
          ↻
        </button>
      </div>
      {view.error && <p class="step-error">{view.error}</p>}
      {children}
    </li>
  );
}

/**
 * One B站-style action icon: same silhouette filled when the account has acted, outlined when
 * it has not (so state is not conveyed by colour alone), with the coin count like B站 shows it.
 */
function ActionIcon({
  kind,
  on,
  label,
  count,
  title,
  icon,
}: {
  kind: string;
  on: boolean;
  label: string;
  count?: number;
  title: string;
  icon: preact.ComponentChildren;
}) {
  return (
    <span class={`action ${kind} ${on ? 'on' : 'off'}`} title={title} role="img" aria-label={label}>
      {icon}
      {count ? <span class="action-count">{count}</span> : null}
    </span>
  );
}

export function Popup() {
  const [state, setState] = useState<CurrentVideoState | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [settings, setSettings] = useState<{
    ai: boolean;
    aiProvider: string;
    aiModel: string;
    aiEndpoint: string;
    notion: boolean;
    notionEnabled: boolean;
    notionMissing: string;
  }>({
    ai: false,
    aiProvider: '',
    aiModel: '',
    aiEndpoint: '',
    notion: false,
    notionEnabled: false,
    notionMissing: '',
  });
  const [field, setField] = useState<NoteField>('highlights');
  /** 编辑器原文，不是落库数组：见 lib/notes.ts（原文与规范化数据分开才不会吞掉空格）。 */
  const [noteDraft, setNoteDraft] = useState<NoteDraft>(emptyDraft());
  const [notesStatus, setNotesStatus] = useState<'saved' | 'typing' | 'saving'>('saved');
  /**
   * The popup polls the worker every 1.5s for step progress. That poll used to re-set the notes
   * from the stored record, which wiped whatever was being typed — so a draft lives in `draft`
   * and the poll may only replace the editor when nothing has been typed yet.
   */
  const notesDirty = useRef(false);
  /** 待写入的（规范化后的）笔记；key 说明它属于哪个视频，切换视频时按它落库。 */
  const draft = useRef<{ key: string; notes: UserNotes }>({ key: '', notes: emptyNotes() });
  const saveTimer = useRef<number | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'bad' } | null>(null);

  // 通知现在是浮层：自动收掉，也可以点一下关掉。
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === 'bad' ? 8000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const [loading, setLoading] = useState(true);
  const [actionsSyncedFor, setActionsSyncedFor] = useState('');
  const [showNotionDetails, setShowNotionDetails] = useState(false);

  async function refresh() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [current, s, conf] = await Promise.all([
      sendToBackground<CurrentVideoState>({ type: 'get-current', tabId: tab?.id }),
      sendToBackground<StatsResult>({ type: 'stats' }),
      sendToBackground<{ ai: { enabled: boolean; apiKey: string; baseUrl: string; model: string }; notion: Settings['notion'] }>({
        type: 'get-settings',
      }),
    ]);
    if (current.ok && current.data) {
      setState(current.data);
      const incoming = current.data.record;
      if (incoming) {
        if (draft.current.key && draft.current.key !== incoming.key && notesDirty.current) {
          // The popup switched videos: persist the draft against the video it was written for.
          void sendToBackground({ type: 'save-notes', key: draft.current.key, notes: draft.current.notes });
          notesDirty.current = false;
          setNotesStatus('saved');
        }
        if (!notesDirty.current) {
          const stored = incoming.userNotes ?? emptyNotes();
          draft.current = { key: incoming.key, notes: stored };
          // 内容等价时保留原文：自动保存后的下一次轮询不该抹掉刚敲的行尾空白或空行。
          setNoteDraft((current) => (sameNotes(draftToNotes(current), stored) ? current : notesToDraft(stored)));
        }
      }
    }
    if (s.ok && s.data) setStats(s.data);
    if (conf.ok && conf.data) {
      const missing = notionMissing(conf.data.notion);
      setSettings({
        ai: conf.data.ai.enabled && Boolean(conf.data.ai.apiKey),
        aiProvider: providerLabel(conf.data.ai.baseUrl),
        aiModel: conf.data.ai.model,
        aiEndpoint: conf.data.ai.baseUrl,
        notion: !missing,
        notionEnabled: conf.data.notion.enabled,
        notionMissing: missing,
      });
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // Live progress: the worker writes per-step state as it goes.
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, []);

  const record = state?.record ?? null;
  const brief = useMemo(() => (record ? agentBrief(record) : ''), [record]);

  // Ask B站 once per video as soon as the popup opens, so the icons show server state.
  useEffect(() => {
    if (!record || actionsSyncedFor === record.key) return;
    setActionsSyncedFor(record.key);
    void sendToBackground({ type: 'refresh-actions', key: record.key, force: true }).then(() => refresh());
  }, [record?.key, actionsSyncedFor]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setToast(null);
    try {
      await fn();
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : String(error), tone: 'bad' });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  /** Fresh look at the knowledge base: a deleted page must not stay "已写入" locally. */
  async function checkLibrary() {
    if (!record) return;
    await act('check', async () => {
      const result = await sendToBackground<{ state: 'present' | 'missing'; matchedBy?: string }>({
        type: 'check-notion',
        key: record.key,
      });
      if (!result.ok || !result.data) throw new Error(result.error ?? '检查失败');
      const matched = result.data.matchedBy ? ` · 按「${result.data.matchedBy}」匹配` : '';
      setToast({
        text: (result.data.state === 'present' ? '已在库中' : '不在库中（已删除或还没写入）') + matched,
        tone: result.data.state === 'present' ? 'ok' : 'warn',
      });
    });
  }

  /** 顶部状态就是入口：把 B站 的历史 / 点赞 / 收藏并进本地归档（B站 的历史会过期，本地这份不会）。 */
  async function syncArchive() {
    await act('archive', async () => {
      const result = await sendToBackground({ type: 'sync-bilibili', force: true });
      if (!result.ok) throw new Error(result.error ?? '更新失败');
      setToast({ text: '正在后台更新历史，可在历史记录页查看进度', tone: 'ok' });
    });
  }

  async function runStep(step?: PipelineStep) {
    if (!record) return;
    await act(step ?? 'all', async () => {
      const result = await sendToBackground<{ steps: Array<{ step: string; state: string; error?: string; reason?: string }> }>({
        type: 'sync-now',
        key: record.key,
        step,
      });
      const failure = result.data?.steps?.find((s) => s.state === 'error');
      if (failure) throw new Error(failure.error ?? '执行失败');
      // A skipped step still has something to say (e.g. "already in the library, push refused").
      const skipped = result.data?.steps?.find((s) => s.state === 'skipped' && (s.error || s.reason));
      if (skipped) {
        setToast({ text: skipped.error ?? skipped.reason ?? '已跳过', tone: 'warn' });
        return;
      }
      if (!result.ok && result.error) throw new Error(result.error);
      setToast({ text: result.ok ? '已完成' : '部分完成', tone: result.ok ? 'ok' : 'warn' });
    });
  }

  const login = state?.loginState;
  const conn = !login
    ? { cls: 'idle', text: '检测中' }
    : login.isLogin
      ? { cls: 'ok', text: 'B站已登录' }
      : { cls: 'warn', text: '未登录' };

  const subtitle = record ? subtitleView(record) : null;
  const analysis = record ? analysisView(record, settings.ai) : null;
  const notion = record ? notionView(record, settings.notion, settings.notionMissing) : null;
  // Same predicates the worker uses, so the button never lies about what is left.
  const allDone = Boolean(
    record && record.subtitle && (!settings.ai || analysisFresh(record)) && (!settings.notion || notionFresh(record)),
  );
  const noteValue = noteDraft[field];
  const noteCount = (key: NoteField) => draftCount(noteDraft, key);
  const noteTotal = noteCount('highlights') + noteCount('questions') + noteCount('freeform');
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  /** The 我的记录 row sits right under the AI 摘要 step and jumps to the editor. */
  const focusNotes = () => {
    notesRef.current?.scrollIntoView({ block: 'center' });
    notesRef.current?.focus();
  };

  /** Every keystroke updates the draft, marks it dirty and arms a debounced save. */
  function editNotes(next: NoteDraft) {
    setNoteDraft(next);
    notesDirty.current = true;
    setNotesStatus('typing');
    if (record) draft.current = { key: record.key, notes: draftToNotes(next) };
    window.clearTimeout(saveTimer.current);
    // Deliberately longer than the 1.5s poll: the dirty guard, not a lucky race, protects the draft.
    saveTimer.current = window.setTimeout(() => void flushNotes({ quiet: true }), 2000);
  }

  /** Writes the draft through; the 保存 button, the debounce, blur and closing all use it. */
  async function flushNotes(options: { quiet?: boolean } = {}): Promise<void> {
    window.clearTimeout(saveTimer.current);
    if (!notesDirty.current) return;
    const { key, notes: value } = draft.current;
    if (!key) return;
    setNotesStatus('saving');
    const saved = await sendToBackground({ type: 'save-notes', key, notes: value });
    if (saved.ok) {
      notesDirty.current = false;
      setNotesStatus('saved');
      if (!options.quiet) setToast({ text: '笔记已保存，会一起进知识库', tone: 'ok' });
      return;
    }
    setNotesStatus('typing');
    setToast({ text: saved.error ?? '笔记保存失败', tone: 'bad' });
  }

  // Closing the popup must not drop the last keystrokes; the worker outlives this page.
  useEffect(() => {
    const flush = () => void flushNotes({ quiet: true });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, []);
  /** Everything the Notion row can explain; the row keeps a small info button for it. */
  const notionDetails = record
    ? [
        record.steps.notion.library
          ? `${record.steps.notion.library.state === 'present' ? '已在库中' : '在 Notion 里已找不到这个页面（已删除或换库），重新执行第 3 步会再建一次'}（${new Date(
              record.steps.notion.library.checkedAt,
            ).toLocaleString()} 检查${record.steps.notion.library.matchedBy ? ` · 按「${record.steps.notion.library.matchedBy}」匹配` : ''}）`
          : '',
        record.steps.notion.created?.length ? `本次自动添加了列：${record.steps.notion.created.join('、')}` : '',
        record.steps.notion.skipped?.length ? `没匹配到的列：${record.steps.notion.skipped.join('、')}（内容仍在正文里）` : '',
      ].filter(Boolean)
    : [];
  const relationLocal = record?.relation?.source === 'local';
  const relationTitle = record?.relation?.fetchedAt
    ? `${new Date(record.relation.fetchedAt).toLocaleString()} 读取自 ${record.relation.source === 'api' ? 'B站 API' : '本机记录'}`
    : '';

  return (
    <div class="popup">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <div class="brand-name">BiliRecall</div>
            <div class="brand-sub">
              {stats
                ? `${stats.total} 条 · ${stats.synced} 已同步${stats.needsReview ? ` · ${stats.needsReview} 需处理` : ''}`
                : 'B站 → Notion 知识库'}
            </div>
          </div>
        </div>
        <div class="header-actions">
          <button
            class="conn"
            title={
              login
                ? `B站 ${login.isLogin ? '已登录' : '未登录'}（${new Date(login.checkedAt).toLocaleString()} 检查）· 点击把 B站 的历史 / 点赞 / 收藏同步到本地归档`
                : '正在检测 B站 登录状态…'
            }
            disabled={busy !== null}
            onClick={() => void syncArchive()}
          >
            <i class={`dot ${conn.cls}`} />
            {conn.text}
            {login?.isLogin ? <RefreshIcon size={13} /> : null}
          </button>
          <button
            class="icon icon-lg"
            title="设置与全部记录"
            aria-label="设置与全部记录"
            onClick={() => void chrome.runtime.openOptionsPage()}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <div class="stack">
        {loading && !state ? (
          <div class="empty">
            <p class="empty-text">正在读取当前视频…</p>
          </div>
        ) : !record ? (
          <div class="empty">
            <div class="empty-icon">◎</div>
            <p class="empty-title">还没有捕获到视频</p>
            <p class="empty-text">在 B站 视频页做出点赞 / 投币 / 收藏 / 分享，就会自动记录。</p>
            <ol class="steps">
              <li>打开一个 B站视频</li>
              <li>点一下 点赞 / 投币 / 收藏 / 分享</li>
              <li>回到这里抓取字幕、写笔记</li>
            </ol>
            <button onClick={() => void chrome.tabs.create({ url: 'https://www.bilibili.com' })}>打开 B站</button>
          </div>
        ) : (
          <>
            <section class="card">
              <h1 class="video-title" title={record.title || record.bvid}>
                {record.title || record.bvid}
              </h1>
              <div class="video-bar">
                <p class="video-meta">
                  {[record.owner || '未知 UP主', record.category, duration(record.duration)].filter(Boolean).join(' · ')}
                </p>
                <div class="signals" title={relationTitle}>
                  <ActionIcon
                    kind="like"
                    on={record.actions.like}
                    label={`点赞：${record.actions.like ? '已点赞' : '未点赞'}`}
                    title={`点赞：${record.actions.like ? '已点赞' : '未点赞'}（读取自 B站）`}
                    icon={<LikeIcon on={record.actions.like} />}
                  />
                  <ActionIcon
                    kind="coin"
                    on={record.actions.coin > 0}
                    label={`投币 ${record.actions.coin} 枚`}
                    count={record.actions.coin || undefined}
                    title={`投币：${record.actions.coin} 枚（读取自 B站）`}
                    icon={<CoinIcon on={record.actions.coin > 0} />}
                  />
                  <ActionIcon
                    kind="favorite"
                    on={record.actions.favorite}
                    label={`收藏：${record.actions.favorite ? '已收藏' : '未收藏'}`}
                    title={`收藏：${record.actions.favorite ? '已收藏' : '未收藏'}（读取自 B站）`}
                    icon={<FavoriteIcon on={record.actions.favorite} />}
                  />
                  <ActionIcon
                    kind="share"
                    on={record.actions.share}
                    label={`分享：${record.actions.share ? '已分享' : '未分享'}`}
                    title={`分享：${record.actions.share ? '已分享' : '未分享'}（B站 不保存分享状态，此为本机记录）`}
                    icon={<ShareIcon on={record.actions.share} />}
                  />
                </div>
              </div>
              {relationLocal && (
                <p class="signals-note">未能从 B站 读取操作状态，当前显示的是本机记录{record.relation?.error ? `（${record.relation.error}）` : ''}</p>
              )}
              {record.metadataError && !record.owner && <p class="step-error">未能读取标题/UP主：{record.metadataError}</p>}
            </section>

            <section class="card">
              <div class="card-head">
                <span class="card-title">处理流程</span>
                <span class="card-sub">
                  {record.watched.completed
                    ? '已看完'
                    : record.watched.maxProgressRatio > 0
                      ? `观看 ${Math.round(record.watched.maxProgressRatio * 100)}%`
                      : '未观看'}
                  <button
                    class="icon icon-lg"
                    title="刷新：检查这条视频在 Notion 知识库里的状态"
                    aria-label="刷新 Notion 状态"
                    disabled={busy !== null}
                    onClick={() => void checkLibrary()}
                  >
                    <RefreshIcon />
                  </button>
                </span>
              </div>
              <ul class="step-list">
                <StepRow
                  label="1. 字幕"
                  extra={
                    <button
                      class="icon srt"
                      title={record.subtitle ? '下载 SRT 字幕' : '还没有字幕'}
                      aria-label="下载 SRT 字幕"
                      disabled={!record.subtitle}
                      onClick={() =>
                        record.subtitle && downloadText(`${record.bvid}.srt`, segmentsToSrt(record.subtitle.segments), 'application/x-subrip')
                      }
                    >
                      <SrtIcon />
                    </button>
                  }
                  view={subtitle!}
                  disabled={busy !== null}
                  onRetry={() => void runStep('subtitle')}
                >
                  {record.subtitle && record.subtitle.segments.length > 0 && (
                    <div class="preview">
                      <ul class="preview-list">
                        {record.subtitle.segments.slice(0, 2).map((segment, index) => (
                          <li key={index}>
                            <span class="preview-ts">{stamp(segment.from)}</span>
                            <span class="preview-text">{segment.content}</span>
                          </li>
                        ))}
                      </ul>
                      <div class="preview-foot">
                        <button class="link" onClick={() => openViewer(record.key, '#subtitle')}>
                          查看全部 {record.subtitle.segments.length} 段字幕
                        </button>
                        <button
                          class="link"
                          onClick={() =>
                            downloadText(
                              `${record.bvid}.srt`,
                              segmentsToSrt(record.subtitle!.segments),
                              'application/x-subrip',
                            )
                          }
                        >
                          下载 SRT
                        </button>
                      </div>
                    </div>
                  )}
                </StepRow>
                <StepRow
                  label="2. AI 摘要"
                  extra={
                    settings.ai ? (
                      <span
                        class="provider-badge"
                        title={`${settings.aiProvider} · ${settings.aiModel} · ${settings.aiEndpoint}`}
                      >
                        <ProviderMark provider={`${settings.aiProvider} ${settings.aiEndpoint}`} />
                        {settings.aiProvider}
                      </span>
                    ) : null
                  }
                  view={analysis!}
                  disabled={busy !== null}
                  onRetry={() => void runStep('analysis')}
                >
                  {record.analysis && (
                    <div class="preview">
                      <p class="preview-text analysis-text">{record.analysis.summary}</p>
                      <div class="preview-foot">
                        <button class="link" onClick={() => openViewer(record.key, '#analysis')}>
                          查看完整摘要{record.analysis.keyPoints.length ? ` · ${record.analysis.keyPoints.length} 个关键点` : ''}
                        </button>
                      </div>
                    </div>
                  )}
                </StepRow>
                <li class="step">
                  <div class="step-row">
                    <span class="k">我的记录</span>
                    <span class={`v ${noteTotal ? 'ok' : 'mute'}`}>
                      {notesStatus === 'saving'
                        ? '保存中…'
                        : notesStatus === 'typing'
                          ? '编辑中 · 会自动保存'
                          : noteTotal
                            ? '已保存 · 会跟摘要一起进知识库'
                            : ''}
                    </span>
                    {/* 空的时候右侧什么都不放：提示已经在框里，重复的「还没有记录」只会更吵。 */}
                    {noteTotal > 0 && (
                      <button class="icon" title="补充我的记录" aria-label="编辑我的记录" onClick={focusNotes}>
                        <WriteIcon />
                      </button>
                    )}
                  </div>
                  {/* The editor lives in this row: no separate card below the flow. */}
                  <div class={`note-editor ${noteTotal ? 'filled' : 'empty'}`}>
                    <div class="chip-tabs">
                      {(
                        [
                          ['highlights', '印象深刻'],
                          ['questions', '待思考'],
                          ['freeform', '随笔'],
                        ] as const
                      ).map(([key, label]) => (
                        <button class={`chip-tab ${field === key ? 'active' : ''}`} key={key} onClick={() => setField(key)}>
                          {label}
                          {noteCount(key) ? ` ${noteCount(key)}` : ''}
                        </button>
                      ))}
                    </div>
                    {/* 占位提示覆盖在输入首行，不占独立空间；按当前分类判断，不能用笔记总数。 */}
                    <div class="note-input">
                    {!noteValue && (
                      <p class="note-hint" aria-hidden="true">
                        <NotesIcon size={13} />
                        {NOTE_PROMPT[field]}
                      </p>
                    )}
                    <textarea
                      ref={notesRef}
                      rows={2}
                      aria-label={NOTE_PROMPT[field]}
                      value={noteValue}
                      onInput={(e) => {
                        const value = (e.target as HTMLTextAreaElement).value;
                        editNotes({ ...noteDraft, [field]: value });
                      }}
                      onBlur={() => void flushNotes({ quiet: true })}
                    />
                    </div>
                  </div>
                </li>
                {settings.notionEnabled && (
                  <StepRow
                    label="3. Notion"
                    icon={<NotionIcon />}
                    extraSide="end"
                    extra={
                      notionDetails.length ? (
                        <button
                          class="icon"
                          title={showNotionDetails ? '收起写入详情' : '查看写入详情'}
                          aria-label="写入详情"
                          aria-expanded={showNotionDetails}
                          onClick={() => setShowNotionDetails((open) => !open)}
                        >
                          <InfoIcon />
                        </button>
                      ) : null
                    }
                    view={notion!}
                    disabled={busy !== null}
                    onRetry={() => void runStep('notion')}
                  >
                    {showNotionDetails && (
                      <ul class="step-details">
                        {notionDetails.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </StepRow>
                )}
              </ul>
              <div class="actions" style="margin-top:8px">
                <button class="primary grow" disabled={busy !== null || allDone} onClick={() => void runStep()}>
                  {busy === 'all' ? '执行中…' : allDone ? '全部已完成' : '执行'}
                </button>
                {record.steps.notion.url && (
                  <button disabled={busy !== null} onClick={() => void chrome.tabs.create({ url: record.steps.notion.url! })}>
                    打开 Notion
                  </button>
                )}
                <button
                  class={settings.notionEnabled ? 'ghost' : 'primary'}
                  title={
                    settings.notionEnabled
                      ? '把这条记录压成紧凑上下文，粘进对话即可'
                      : 'Notion 同步已关闭：字幕与摘要整理好后复制给 AI，让 Agent 负责入库'
                  }
                  disabled={busy !== null}
                  onClick={() =>
                    act('copy', async () => {
                      await navigator.clipboard.writeText(brief);
                      setToast({ text: '已复制给 AI Agent', tone: 'ok' });
                    })
                  }
                >
                  {settings.notionEnabled ? '复制给 AI' : '复制给 AI 管理'}
                </button>
              </div>
            </section>

          </>
        )}

      </div>

      {toast && (
        <div class={`toast ${toast.tone}`} role="status" title="点一下关闭" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
