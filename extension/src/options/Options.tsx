import { useEffect, useMemo, useState } from 'preact/hooks';
import { agentBrief, recordToMarkdown } from '../lib/export';
import { describeActions } from '../lib/events';
import { downloadText } from '../lib/download';
import { STEP_LABEL } from '../lib/pipeline';
import { sendToBackground } from '../lib/messages';
import type { StatsResult } from '../lib/messages';
import type { SchemaReview } from '../lib/notion';
import { deepMerge } from '../lib/store';
import { DEFAULT_SETTINGS, type DeepPartial, type Settings, type VideoRecord } from '../lib/types';

type Tab = 'records' | 'notion' | 'ai' | 'capture' | 'export';
type Filter = 'all' | 'synced' | 'pending' | 'review' | 'liked' | 'coined' | 'faved' | 'shared' | 'dropped';

/** 记录来自 B站 的哪个列表（本地归档的来源标记）。 */
const ORIGIN_LABEL: Record<string, string> = {
  history: 'B站历史',
  likes: 'B站点赞',
  favorites: 'B站收藏',
  page: '页面记录',
};

interface ArchiveSyncSummary {
  created: number;
  updated: number;
  dropped: number;
  inspected: number;
  sources: Array<{ name: string; count: number; error?: string }>;
}

interface NotionTestPayload {
  bot: string;
  parentType: string;
  parentTitle: string;
  review: SchemaReview | null;
}

interface NotionReport {
  ok: boolean;
  headline: string;
  rows: Array<{ name: string; status: 'ok' | 'warn' | 'danger'; label: string }>;
  hints: string[];
}

/** Turns the worker's schema review into rows the settings page can show without jargon. */
function reportOf(payload: NotionTestPayload, autoColumns: boolean): NotionReport {
  const { bot, parentType, parentTitle, review } = payload;
  const headline = `Token 有效（${bot}）· ${parentType}：${parentTitle}`;
  if (!review) {
    return { ok: true, headline, rows: [], hints: ['父级是页面：属性列不参与写入，标题与正文仍会完整写入该页面。'] };
  }
  const rows = review.columns.map((column) => ({
    name: column.name,
    status: (column.status === 'ok' ? 'ok' : column.required ? 'danger' : 'warn') as 'ok' | 'warn' | 'danger',
    label:
      column.status === 'ok'
        ? `${column.matched}（${column.found}）`
        : column.status === 'missing'
          ? column.required
            ? '没有匹配到列（建议补上）'
            : '没有匹配到列（写入时跳过）'
          : `${column.matched} 是 ${column.found}，需要 ${column.expected.join(' / ')}`,
  }));
  const absent = review.columns.filter((column) => column.status === 'missing').map((column) => column.name);
  const missing = review.columns.filter((column) => column.required && column.status !== 'ok').map((column) => column.name);
  const absentHint = absent.length
    ? autoColumns
      ? `缺失的列会在写入时自动添加：${absent.join('、')}`
      : `缺失的列会被跳过（设置里已关闭「自动补齐缺失的列」）：${absent.join('、')}`
    : '';
  return {
    ok: review.ok,
    headline,
    rows,
    hints: [
      `标题属性：${review.titleProperty || '未找到（数据源必须有 title 属性）'}`,
      missing.length ? `必填列还没就位：${missing.join('、')}` : '必填列齐全，可以直接写入。',
      absentHint,
    ].filter(Boolean),
  };
}

function NotionReportCard({ report }: { report: NotionReport }) {
  return (
    <div class={`test-report ${report.ok ? '' : 'bad'}`}>
      <p class="test-headline">{report.headline}</p>
      {report.rows.length > 0 && (
        <ul class="test-rows">
          {report.rows.map((row) => (
            <li key={row.name}>
              <span class={`badge ${row.status}`}>{row.name}</span>
              <span>{row.label}</span>
            </li>
          ))}
        </ul>
      )}
      {report.hints.map((hint) => (
        <p class="field-hint" key={hint}>
          {hint}
        </p>
      ))}
    </div>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  records: '记录',
  notion: 'Notion',
  ai: 'AI 摘要',
  capture: '抓取规则',
  export: '导出 / 检索',
};

const NOTION_LABEL: Record<string, { text: string; cls: string }> = {
  ok: { text: '已写入', cls: 'ok' },
  running: { text: '写入中', cls: 'warn' },
  idle: { text: '待同步', cls: 'mute' },
  error: { text: '写入失败', cls: 'danger' },
};

/** The first step that failed, so the reason is shown against the right step. */
function firstFailure(record: VideoRecord): { step: string; error: string } | null {
  for (const step of ['subtitle', 'analysis', 'notion'] as const) {
    const state = record.steps?.[step];
    if (state?.state === 'error' && state.error) return { step: STEP_LABEL[step], error: state.error };
  }
  return null;
}

/** Host permissions must be requested from a page during a user gesture, not from the worker. */
async function ensureOrigin(origin: string): Promise<void> {
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`需要授权访问 ${origin} 才能调用该服务`);
}

function signalText(record: VideoRecord): string {
  return describeActions(record.actions).join(' · ') || '仅浏览';
}

function RecordRow({
  record,
  onChanged,
  onStatus,
}: {
  record: VideoRecord;
  onChanged: () => void;
  onStatus: (text: string) => void;
}) {
  const notion = NOTION_LABEL[record.steps.notion.state] ?? { text: record.steps.notion.state, cls: 'mute' };
  const failure = firstFailure(record);
  return (
    <li class="record">
      <div class="record-main">
        <a class="record-title" href={record.url} target="_blank" rel="noreferrer" title={record.title || record.bvid}>
          {record.title || record.bvid}
        </a>
        <p class="record-meta">
          {[
            record.owner || '未知 UP主',
            record.category,
            record.subtitle ? `字幕 ${record.subtitle.segments.length} 段` : '无字幕',
            new Date(record.updatedAt).toLocaleString(),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div class="record-tags">
          <span class="pill">{signalText(record)}</span>
          {(record.archive?.origins ?? [])
            .filter((origin) => origin !== 'page')
            .map((origin) => (
              <span class="badge info" key={origin}>
                {ORIGIN_LABEL[origin] ?? origin}
              </span>
            ))}
          {record.archive?.droppedFromHistory && (
            <span class="badge warn" title="B站 的历史记录已经不再返回它；本地这份归档仍然保留，可以继续检索 / 写入">
              B站已清理 · 本地保留
            </span>
          )}
          <span class={`badge ${notion.cls}`}>{notion.text}</span>
          {failure && <span class="badge danger">{failure.step}失败</span>}
        </div>
        {failure && (
          <p class="record-error" title={failure.error}>
            {failure.step}：{failure.error.replace(/（摘要：[^）]*）/g, '')}
          </p>
        )}
      </div>
      <div class="record-actions">
        <button
          class="sm"
          onClick={() =>
            void (async () => {
              const result = await sendToBackground({ type: 'sync-now', key: record.key });
              onStatus(result.ok ? '同步完成' : result.error ?? '同步失败');
              onChanged();
            })()
          }
        >
          同步
        </button>
        <button
          class="sm"
          onClick={() =>
            void (async () => {
              await navigator.clipboard.writeText(agentBrief(record));
              onStatus('已复制给 AI Agent');
            })()
          }
        >
          复制给 AI
        </button>
        <button
          class="sm"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?key=${encodeURIComponent(record.key)}`) })}
        >
          字幕 / 摘要
        </button>
        <button class="sm" onClick={() => downloadText(`${record.bvid}.md`, recordToMarkdown(record), 'text/markdown')}>
          Markdown
        </button>
        <button
          class="sm danger"
          onClick={() =>
            void (async () => {
              await sendToBackground({ type: 'delete-record', key: record.key });
              onStatus('记录已删除');
              onChanged();
            })()
          }
        >
          删除
        </button>
      </div>
    </li>
  );
}

export function Options() {
  const [tab, setTab] = useState<Tab>('records');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [records, setRecords] = useState<VideoRecord[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'bad' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [notionReport, setNotionReport] = useState<NotionReport | null>(null);

  async function load() {
    const [s, st] = await Promise.all([
      sendToBackground<Settings>({ type: 'get-settings' }),
      sendToBackground<StatsResult>({ type: 'stats' }),
    ]);
    if (s.ok && s.data) setSettings(s.data);
    if (st.ok && st.data) setStats(st.data);
  }

  async function loadRecords(q = query) {
    const r = await sendToBackground<VideoRecord[]>({ type: 'list-records', query: q });
    if (r.ok && Array.isArray(r.data)) setRecords(r.data);
  }

  useEffect(() => {
    void load();
    void loadRecords('');
  }, []);

  // Only the edited leaf is sent. Sending a full copy of the section would let an in-flight
  // save overwrite a neighbouring field with the stale value it was rendered with.
  const patch = async (next: DeepPartial<Settings>) => {
    // A different target invalidates the previous connection report.
    if (next.notion) setNotionReport(null);
    const merged = deepMerge(settings ?? DEFAULT_SETTINGS, next);
    setSettings(merged);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
    const saved = await sendToBackground<Settings>({ type: 'save-settings', patch: next });
    if (saved.ok && saved.data) setSettings(saved.data);
  };

  const visibleRecords = useMemo(() => {
    return records.filter((record) => {
      if (filter === 'liked') return record.actions.like;
      if (filter === 'coined') return record.actions.coin > 0;
      if (filter === 'faved') return record.actions.favorite;
      if (filter === 'shared') return record.actions.share;
      if (filter === 'dropped') return Boolean(record.archive?.droppedFromHistory);
      if (filter === 'synced') return record.steps.notion.state === 'ok';
      if (filter === 'pending') return record.steps.notion.state === 'idle' || record.steps.notion.state === 'running';
      if (filter === 'review') {
        return (['subtitle', 'analysis', 'notion'] as const).some((step) => record.steps[step]?.state === 'error');
      }
      return true;
    });
  }, [records, filter]);

  const refreshAll = async () => {
    await load();
    await loadRecords();
  };

  if (!settings) return <div class="app"><div class="content">正在加载设置…</div></div>;

  return (
    <div class="app">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <div class="brand-name">BiliVault</div>
            <div class="brand-sub">B站 → Notion 知识库</div>
          </div>
        </div>
        <div class="header-actions">
          <span class={`saved-flag ${savedFlash ? 'show' : ''}`}>设置已保存</span>
          <button
            disabled={busy !== null}
            title="把 B站 的观看历史 / 点赞 / 收藏并进本地归档；B站 清掉的历史不会从本地消失"
            onClick={() =>
              void (async () => {
                setBusy('archive');
                const r = await sendToBackground<ArchiveSyncSummary>({ type: 'sync-bilibili' });
                if (!r.ok || !r.data) {
                  setToast({ text: r.error ?? '同步失败', tone: 'bad' });
                } else {
                  const { created, updated, dropped, sources } = r.data;
                  const failed = sources.filter((source) => source.error).map((source) => `${source.name}：${source.error}`);
                  setToast({
                    text: [
                      `B站 归档：新增 ${created} · 更新 ${updated} · 保留已清理 ${dropped}`,
                      failed.length ? failed.join('；') : '',
                    ]
                      .filter(Boolean)
                      .join('；'),
                    tone: failed.length ? 'warn' : 'ok',
                  });
                }
                setBusy(null);
                await refreshAll();
              })()
            }
          >
            {busy === 'archive' ? '同步中…' : '同步 B站 记录'}
          </button>
          <button
            class="primary"
            disabled={busy !== null}
            onClick={() =>
              void (async () => {
                setBusy('sync');
                const r = await sendToBackground({ type: 'sync-all' });
                setToast(r.ok ? { text: `已加入同步队列（${(r.data as any)?.queued ?? 0} 条待处理）`, tone: 'ok' } : { text: r.error ?? '失败', tone: 'bad' });
                setBusy(null);
                await refreshAll();
              })()
            }
          >
            {busy === 'sync' ? '同步中…' : '全部同步'}
          </button>
        </div>
      </header>

      <div class="stat-grid">
        {[
          { label: '总记录', value: stats?.total ?? 0 },
          { label: '本地归档', value: stats?.archived ?? 0 },
          { label: '点赞', value: stats?.liked ?? 0 },
          { label: '投币', value: stats?.coined ?? 0 },
          { label: '收藏', value: stats?.faved ?? 0 },
          { label: '有字幕', value: stats?.withSubtitle ?? 0 },
          { label: '有摘要', value: stats?.withAnalysis ?? 0 },
          { label: '已同步', value: stats?.synced ?? 0, cls: 'ok' },
          { label: 'B站已清理', value: stats?.dropped ?? 0, cls: stats?.dropped ? 'warn' : '' },
        ].map((item) => (
          <div class="stat" key={item.label}>
            <div class="stat-label">{item.label}</div>
            <div class={`stat-value ${item.cls ?? ''}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <nav class="tabs">
        {(['records', 'notion', 'ai', 'capture', 'export'] as Tab[]).map((t) => (
          <button class={`tab ${tab === t ? 'active' : ''}`} key={t} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
            {t === 'records' && stats ? <span class="tab-count">{stats.total}</span> : null}
          </button>
        ))}
      </nav>

      <div class="content">
        {toast && (
          <div class={`toast ${toast.tone}`} role="status">
            {toast.text}
          </div>
        )}

        {tab === 'records' && (
          <>
            <div class="toolbar">
              <div class="search">
                <input
                  placeholder="搜索标题 / UP主 / 字幕 / 摘要 / 笔记…"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if ((e as KeyboardEvent).key === 'Enter') void loadRecords();
                  }}
                />
              </div>
              <select value={filter} onChange={(e) => setFilter((e.target as HTMLSelectElement).value as Filter)}>
                <option value="all">全部状态</option>
                <option value="liked">我点过赞的</option>
                <option value="coined">我投过币的</option>
                <option value="faved">我收藏过的</option>
                <option value="shared">我分享过的</option>
                <option value="dropped">B站历史已清理（本地保留）</option>
                <option value="synced">已写入 Notion</option>
                <option value="pending">待同步</option>
                <option value="review">待复核 / 失败</option>
              </select>
              <button onClick={() => void loadRecords()}>搜索</button>
              <button class="ghost" onClick={() => { setQuery(''); setFilter('all'); void loadRecords(''); }}>
                重置
              </button>
            </div>

            {visibleRecords.length ? (
              <ul class="records">
                {visibleRecords.map((record) => (
                  <RecordRow
                    key={record.key}
                    record={record}
                    onChanged={() => void refreshAll()}
                    onStatus={(text) => setToast({ text, tone: 'ok' })}
                  />
                ))}
              </ul>
            ) : (
              <div class="empty">
                <div class="empty-icon">◎</div>
                <p class="empty-title">{records.length ? '没有符合筛选条件的记录' : '还没有任何记录'}</p>
                <p class="empty-text">
                  {records.length
                    ? '换个筛选条件，或清空搜索框。'
                    : '浏览 B站视频并点赞 / 投币 / 收藏 / 分享，就会自动出现在这里。'}
                </p>
              </div>
            )}
          </>
        )}

        {tab === 'notion' && (
          <div class="form">
            <section class="form-card">
              <div class="card-head">
                <span class="card-title">写入目标</span>
                <span class="card-sub">凭据只保存在本机</span>
              </div>
              <div class="form-grid">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.notion.enabled}
                    onChange={(e) => void patch({ notion: { enabled: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">启用自动同步到 Notion</span>
                    <span class="check-desc">
                      开启：流程里出现 Notion 步骤，抓完字幕、生成摘要后自动建页。关闭：流程里不出现 Notion，摘要整理好后点「复制给 AI 管理」交给 Agent
                    </span>
                  </span>
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.notion.autoColumns}
                    onChange={(e) => void patch({ notion: { autoColumns: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">自动补齐缺失的列</span>
                    <span class="check-desc">
                      写入前把缺的列（视频ID / UP主 / 日期 / 摘要 / 我的记录…）以正确类型加进数据库；只新增，不改动已有列
                    </span>
                  </span>
                </label>
                <label class="field">
                  <span class="field-label">Integration Token</span>
                  <input
                    type="password"
                    value={settings.notion.token}
                    placeholder="secret_xxx / ntn_xxx"
                    onInput={(e) => void patch({ notion: { token: (e.target as HTMLInputElement).value } })}
                  />
                </label>
                <div class="field-row">
                  <label class="field">
                    <span class="field-label">父级类型</span>
                    <select
                      value={settings.notion.parentType}
                      onChange={(e) => void patch({ notion: { parentType: (e.target as HTMLSelectElement).value as Settings['notion']['parentType'] } })}
                    >
                      <option value="data_source_id">数据库 Data Source（推荐）</option>
                      <option value="page_id">页面 Page</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">Data Source ID / Page ID</span>
                    <input
                      value={settings.notion.parentId}
                      onInput={(e) => void patch({ notion: { parentId: (e.target as HTMLInputElement).value } })}
                    />
                  </label>
                </div>
                <p class="field-hint">
                  Data Source ID 不是 Database ID：用 <code>GET /v1/databases/&lt;id&gt;</code> 返回的 <code>data_sources</code> 获取。
                  数据库需先连接到你的 integration；扩展只写已存在且类型匹配的属性（URL / UP主 / 分区 / 字幕语言 / 摘要 / 标签 / 加入时间），缺列也能导入，正文照常完整。
                </p>
              </div>
              <div class="actions" style="margin-top:14px">
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void (async () => {
                      setBusy('notion');
                      try {
                        await ensureOrigin('https://api.notion.com/*');
                        const r = await sendToBackground<NotionTestPayload>({ type: 'test-notion' });
                        if (!r.ok || !r.data) {
                          setNotionReport({ ok: false, headline: r.error ?? '测试失败', rows: [], hints: [] });
                          return;
                        }
                        setNotionReport(reportOf(r.data, settings.notion.autoColumns));
                      } catch (error) {
                        setNotionReport({ ok: false, headline: error instanceof Error ? error.message : String(error), rows: [], hints: [] });
                      } finally {
                        setBusy(null);
                      }
                    })()
                  }
                >
                  {busy === 'notion' ? '测试中…' : '测试连接'}
                </button>
              </div>
              {notionReport && <NotionReportCard report={notionReport} />}
            </section>
          </div>
        )}

        {tab === 'ai' && (
          <div class="form">
            <section class="form-card">
              <div class="card-head">
                <span class="card-title">摘要与分析</span>
                <span class="card-sub">任意 OpenAI 兼容端点</span>
              </div>
              <div class="form-grid">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.ai.enabled}
                    onChange={(e) => void patch({ ai: { enabled: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">自动生成摘要、提纲与关键点</span>
                    <span class="check-desc">用字幕正文调用模型；未配置时只保存字幕与你的笔记</span>
                  </span>
                </label>
                <label class="field">
                  <span class="field-label">API Base URL</span>
                  <input
                    value={settings.ai.baseUrl}
                    onInput={(e) => void patch({ ai: { baseUrl: (e.target as HTMLInputElement).value } })}
                  />
                  <span class="field-hint">形如 <code>https://api.openai.com/v1</code>；DeepSeek / Moonshot / 本地 Ollama 同样可用</span>
                </label>
                <div class="field-row">
                  <label class="field">
                    <span class="field-label">API Key</span>
                    <input
                      type="password"
                      value={settings.ai.apiKey}
                      onInput={(e) => void patch({ ai: { apiKey: (e.target as HTMLInputElement).value } })}
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">模型</span>
                    <input
                      value={settings.ai.model}
                      onInput={(e) => void patch({ ai: { model: (e.target as HTMLInputElement).value } })}
                    />
                  </label>
                </div>
                <label class="field">
                  <span class="field-label">提示词</span>
                  <textarea
                    rows={4}
                    value={settings.ai.prompt}
                    onInput={(e) => void patch({ ai: { prompt: (e.target as HTMLTextAreaElement).value } })}
                  />
                  <span class="field-hint">
                    必须要求返回 JSON：<code>{'{'}"summary","outline","keyPoints"{'}'}</code>。<code>{'{{language}}'}</code> 会替换为下面的语言。
                    提纲每条建议以 <code>[分:秒-分:秒]</code> 开头（字幕里带时间标记）；模型没写时扩展会按字幕自动定位时间段。
                  </span>
                </label>
                <label class="field" style="max-width:220px">
                  <span class="field-label">输出语言</span>
                  <input value={settings.ai.language} onInput={(e) => void patch({ ai: { language: (e.target as HTMLInputElement).value } })} />
                </label>
              </div>
              <div class="actions" style="margin-top:14px">
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void (async () => {
                      setBusy('ai');
                      try {
                        await ensureOrigin(new URL(settings.ai.baseUrl).origin + '/*');
                        const r = await sendToBackground<{ model: string }>({ type: 'test-ai' });
                        setToast(r.ok ? { text: `AI 可用：${r.data?.model}`, tone: 'ok' } : { text: r.error ?? '失败', tone: 'bad' });
                      } catch (error) {
                        setToast({ text: error instanceof Error ? error.message : String(error), tone: 'bad' });
                      } finally {
                        setBusy(null);
                      }
                    })()
                  }
                >
                  {busy === 'ai' ? '测试中…' : '测试 AI'}
                </button>
              </div>
            </section>
          </div>
        )}

        {tab === 'capture' && (
          <div class="form">
            <section class="form-card">
              <div class="card-head">
                <span class="card-title">字幕获取</span>
                <span class="card-sub">一致读取是防止「同一 CID 拿到不同字幕」的关键</span>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">字幕语言偏好</span>
                  <select
                    value={settings.subtitle.language}
                    onChange={(e) => void patch({ subtitle: { language: (e.target as HTMLSelectElement).value } })}
                  >
                    <option value="auto">自动（简体 → AI 中文 → 繁体 → 英文）</option>
                    <option value="zh-Hans">zh-Hans 人工简体</option>
                    <option value="ai-zh">ai-zh AI 中文</option>
                    <option value="zh-Hant">zh-Hant 繁体</option>
                    <option value="en">en 英文</option>
                  </select>
                  <span class="field-hint">明确指定后，找不到该轨道会报错，不会静默换成别的语言</span>
                </label>
                <div class="field-row">
                  <label class="field">
                    <span class="field-label">一致读取次数</span>
                    <input
                      type="number"
                      min={2}
                      max={5}
                      value={settings.subtitle.consensusReads}
                      onInput={(e) => void patch({ subtitle: { consensusReads: Number((e.target as HTMLInputElement).value) } })}
                    />
                    <span class="field-hint">默认 2。多次读取正文 SHA-256 完全一致才采信</span>
                  </label>
                  <label class="field">
                    <span class="field-label">最大尝试次数</span>
                    <input
                      type="number"
                      min={2}
                      max={10}
                      value={settings.subtitle.maxAttempts}
                      onInput={(e) => void patch({ subtitle: { maxAttempts: Number((e.target as HTMLInputElement).value) } })}
                    />
                    <span class="field-hint">超过仍不一致 → 标记待复核，不写入 Notion</span>
                  </label>
                </div>
              </div>
            </section>

            <section class="form-card">
              <div class="card-head">
                <span class="card-title">记录范围与通知</span>
              </div>
              <div class="form-grid">
                <div class="actions">
                  <button
                    disabled={busy !== null}
                    onClick={() =>
                      void (async () => {
                        setBusy('relation');
                        const r = await sendToBackground<{ bvid: string; via: string; like: boolean; coin: number; favorite: boolean; warnings: string[] }>({
                          type: 'test-relation',
                        });
                        setToast(
                          r.ok && r.data
                            ? {
                                text: `B站 状态读取成功（${r.data.via}）：${r.data.bvid} 点赞=${r.data.like} 投币=${r.data.coin} 收藏=${r.data.favorite}${r.data.warnings.length ? ' · ' + r.data.warnings.join('；') : ''}`,
                                tone: 'ok',
                              }
                            : { text: r.error ?? '读取失败', tone: 'bad' },
                        );
                        setBusy(null);
                      })()
                    }
                  >
                    {busy === 'relation' ? '读取中…' : '测试 B站 状态读取'}
                  </button>
                  <span class="field-hint">用当前登录态读取最近一条记录的点赞 / 投币 / 收藏状态，确认 API 可用</span>
                </div>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.general.captureWatched}
                    onChange={(e) => void patch({ general: { captureWatched: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">记录浏览历史</span>
                    <span class="check-desc">只存在本地用于检索，不会写入 Notion</span>
                  </span>
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.general.notifyOnSync}
                    onChange={(e) => void patch({ general: { notifyOnSync: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">同步成功时桌面通知</span>
                  </span>
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={settings.webhook.enabled}
                    onChange={(e) => void patch({ webhook: { enabled: (e.target as HTMLInputElement).checked } })}
                  />
                  <span class="check-text">
                    <span class="check-title">触发 Webhook</span>
                    <span class="check-desc">写入完成后再 POST 一次完整记录 JSON</span>
                  </span>
                </label>
                <label class="field">
                  <span class="field-label">Webhook URL</span>
                  <input
                    value={settings.webhook.url}
                    placeholder="https://example.com/hook"
                    onInput={(e) => void patch({ webhook: { url: (e.target as HTMLInputElement).value } })}
                  />
                </label>
              </div>
            </section>
          </div>
        )}

        {tab === 'export' && (
          <div class="form">
            <section class="form-card">
              <div class="card-head">
                <span class="card-title">导出与检索</span>
                <span class="card-sub">同时面向人和 AI Agent</span>
              </div>
              <div class="export-grid">
                <div class="export-card">
                  <h3>知识库包</h3>
                  <p>
                    <code>index.md</code> 索引、<code>knowledge.jsonl</code>（可直接 embedding / RAG）、<code>records.json</code> 完整结构化数据。
                  </p>
                  <button
                    class="primary"
                    onClick={() =>
                      void (async () => {
                        const r = await sendToBackground<{ path: string; content: string }[]>({ type: 'export-bundle' });
                        if (!r.ok || !r.data) {
                          setToast({ text: r.error ?? '导出失败', tone: 'bad' });
                          return;
                        }
                        for (const file of r.data) {
                          if (file.path === 'index.md') downloadText('bilivault-index.md', file.content, 'text/markdown');
                          if (file.path === 'knowledge.jsonl') downloadText('bilivault-knowledge.jsonl', file.content, 'application/x-ndjson');
                          if (file.path === 'records.json') downloadText('bilivault-records.json', file.content, 'application/json');
                        }
                        setToast({ text: '已导出 index.md / knowledge.jsonl / records.json', tone: 'ok' });
                      })()
                    }
                  >
                    导出知识库
                  </button>
                </div>
                <div class="export-card">
                  <h3>全部视频 Markdown</h3>
                  <p>每条记录一个带 YAML frontmatter 的章节（含字幕全文、摘要、你的笔记），适合放进 Obsidian / 笔记仓库。</p>
                  <button
                    onClick={() =>
                      void (async () => {
                        const r = await sendToBackground<{ path: string; content: string }[]>({ type: 'export-bundle' });
                        const md = (r.data ?? []).filter((f) => f.path.startsWith('videos/')).map((f) => f.content).join('\n\n---\n\n');
                        downloadText('bilivault-videos.md', md, 'text/markdown');
                        setToast({ text: '已导出全部视频 Markdown', tone: 'ok' });
                      })()
                    }
                  >
                    导出 Markdown
                  </button>
                </div>
                <div class="export-card">
                  <h3>复制给 AI</h3>
                  <p>把全部记录压成紧凑上下文，直接粘进对话即可让 agent 基于你的知识库回答。</p>
                  <button
                    onClick={() =>
                      void (async () => {
                        await navigator.clipboard.writeText(records.map(agentBrief).join('\n\n---\n\n'));
                        setToast({ text: `已复制 ${records.length} 条记录`, tone: 'ok' });
                      })()
                    }
                  >
                    复制全部
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
