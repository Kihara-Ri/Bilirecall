import { useEffect, useMemo, useState } from 'preact/hooks';
import { agentBrief, recordToAgentJson, recordToMarkdown, sanitizeFilename } from '../lib/export';
import { downloadText } from '../lib/download';
import { sendToBackground } from '../lib/messages';
import { normalizeCoverUrl } from '../lib/media';
import { outlineEntries, outlineLabel } from '../lib/outline';
import { formatTimestamp, segmentsToSrt } from '../lib/subtitle';
import type { VideoRecord } from '../lib/types';

const stamp = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

const duration = (seconds?: number): string => {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

const CUES_PAGE = 300;

export function Viewer() {
  const key = useMemo(() => new URLSearchParams(location.search).get('key') ?? '', []);
  const [record, setRecord] = useState<VideoRecord | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(CUES_PAGE);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!key) {
      setError('地址里缺少 key 参数。请从扩展弹窗或记录页打开本页。');
      return;
    }
    const result = await sendToBackground<VideoRecord>({ type: 'get-record', key });
    if (!result.ok) {
      setError(result.error ?? '读取记录失败');
      return;
    }
    if (!result.data) {
      setError('找不到这条记录（可能已被删除）。');
      return;
    }
    setRecord(result.data);
  }

  useEffect(() => {
    void load();
  }, []);

  // Deep links from the popup: viewer.html?key=…#subtitle / #analysis
  useEffect(() => {
    if (!record || !location.hash) return;
    const target = document.querySelector(location.hash);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }, [record]);

  const segments = record?.subtitle?.segments ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return segments;
    return segments.filter((segment) => segment.content.toLowerCase().includes(needle));
  }, [segments, query]);

  async function fetchSubtitle() {
    if (!record) return;
    setBusy(true);
    const result = await sendToBackground({ type: 'sync-now', key: record.key, step: 'subtitle' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? '抓取字幕失败');
      return;
    }
    setError('');
    await load();
  }

  if (error && !record) {
    return (
      <div class="app">
        <header class="app-header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true" />
            <div>
              <div class="brand-name">BiliRecall</div>
              <div class="brand-sub">字幕与摘要</div>
            </div>
          </div>
          <div class="header-actions">
            <button onClick={() => void chrome.runtime.openOptionsPage()}>全部记录</button>
          </div>
        </header>
        <div class="content">
          <div class="empty">
            <div class="empty-icon">◎</div>
            <p class="empty-title">无法显示</p>
            <p class="empty-text">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!record) {
    return (
      <div class="app">
        <div class="content">
          <p class="hint">正在读取记录…</p>
        </div>
      </div>
    );
  }

  const subtitle = record.subtitle;
  const analysis = record.analysis;
  const notes = record.userNotes;

  return (
    <div class="app">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <div class="brand-name">BiliRecall</div>
            <div class="brand-sub">字幕与摘要</div>
          </div>
        </div>
        <div class="header-actions">
          <button class="ghost" onClick={() => void chrome.runtime.openOptionsPage()}>
            全部记录
          </button>
          <a class="button" href={record.url} target="_blank" rel="noreferrer">
            打开 B站
          </a>
        </div>
      </header>

      <main class="viewer">
        <section class="viewer-hero">
          <h1 class="viewer-title">{record.title || record.bvid}</h1>
          {normalizeCoverUrl(record.cover) && (
            <img class="viewer-cover" src={normalizeCoverUrl(record.cover)} alt="" referrerpolicy="no-referrer" loading="lazy" />
          )}
          <p class="viewer-meta">
            {[
              record.owner || '未知 UP主',
              record.category,
              duration(record.duration),
              record.pubdate ? new Date(record.pubdate * 1000).toLocaleDateString() : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div class="viewer-actions">
            <button
              class="primary"
              onClick={() => {
                void navigator.clipboard.writeText(agentBrief(record));
              }}
            >
              复制给 AI
            </button>
            {record.steps.notion.url && (
              <a class="button" href={record.steps.notion.url} target="_blank" rel="noreferrer">
                打开 Notion
              </a>
            )}
            <nav class="viewer-nav">
              <a href="#subtitle">字幕</a>
              <a href="#analysis">AI 摘要</a>
              <a href="#notes">我的笔记</a>
            </nav>
          </div>
        </section>

        {error && <div class="toast bad">{error}</div>}

        <section class="card viewer-section" id="subtitle">
          <div class="viewer-section-head">
            <h2 class="viewer-h2">字幕</h2>
            <div class="actions">
              <input
                class="viewer-search"
                placeholder="在字幕中搜索…"
                value={query}
                onInput={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setLimit(CUES_PAGE);
                }}
              />
              {subtitle ? (
                <>
                  <button
                    onClick={() => downloadText(`${record.bvid}.srt`, segmentsToSrt(subtitle.segments), 'application/x-subrip')}
                  >
                    下载 SRT
                  </button>
                  <button onClick={() => downloadText(`${record.bvid}.txt`, subtitle.plainText)}>下载 TXT</button>
                  <button
                    class="ghost"
                    onClick={() => downloadText(`${sanitizeFilename(record.title)}.md`, recordToMarkdown(record), 'text/markdown')}
                  >
                    Markdown
                  </button>
                  <button
                    class="ghost"
                    onClick={() => downloadText(`${record.bvid}.json`, JSON.stringify(recordToAgentJson(record), null, 2), 'application/json')}
                  >
                    JSON
                  </button>
                </>
              ) : (
                <button class="primary" disabled={busy} onClick={() => void fetchSubtitle()}>
                  {busy ? '抓取中…' : '抓取字幕'}
                </button>
              )}
            </div>
          </div>

          {subtitle ? (
            <>
              <p class="viewer-sub">
                {subtitle.track.label} · {subtitle.track.language} · 来源 {subtitle.track.source} · 独立一致读取{' '}
                {subtitle.observations} 次 · SHA-256 <code>{subtitle.digest.slice(0, 16)}…</code> ·{' '}
                {new Date(subtitle.fetchedAt).toLocaleString()}
              </p>
              {subtitle.warnings.length > 0 && <p class="viewer-warn">注意：{subtitle.warnings.join('；')}</p>}
              <ol class="cues">
                {filtered.slice(0, limit).map((segment, index) => (
                  <li key={index}>
                    <span class="cue-ts">{formatTimestamp(segment.from).slice(0, 8)}</span>
                    <span class="cue-text">{segment.content}</span>
                  </li>
                ))}
              </ol>
              {filtered.length > limit && (
                <button class="block" onClick={() => setLimit(limit + 1000)}>
                  显示更多（还有 {filtered.length - limit} 段）
                </button>
              )}
              {filtered.length === 0 && <p class="hint">没有匹配「{query}」的字幕。</p>}
              <p class="viewer-sub">共 {subtitle.segments.length} 段{query ? `，匹配 ${filtered.length} 段` : ''}。</p>
            </>
          ) : (
            <p class="hint">还没有字幕。点击上方「抓取字幕」获取。</p>
          )}
        </section>

        <section class="card viewer-section" id="analysis">
          <div class="viewer-section-head">
            <h2 class="viewer-h2">AI 摘要</h2>
            {analysis && (
              <div class="actions">
                <button
                  onClick={() =>
                    downloadText(
                      `${sanitizeFilename(record.title)}-摘要.md`,
                      [
                        `# ${record.title}`,
                        '',
                        analysis.summary,
                        '',
                        ...(analysis.outline.length
                          ? [
                              '## 分段提纲',
                              '',
                              ...outlineEntries(analysis.outline, record.subtitle?.segments ?? []).map((entry) => `- ${outlineLabel(entry)}`),
                              '',
                            ]
                          : []),
                        ...(analysis.keyPoints.length ? ['## 关键点', '', ...analysis.keyPoints.map((x) => `- ${x}`), ''] : []),
                      ].join('\n'),
                      'text/markdown',
                    )
                  }
                >
                  下载摘要
                </button>
              </div>
            )}
          </div>
          {analysis ? (
            <>
              <p class="viewer-summary">{analysis.summary}</p>
              {analysis.outline.length > 0 && (
                <>
                  <h3 class="viewer-h3">分段提纲</h3>
                  <ul class="viewer-list">
                    {outlineEntries(analysis.outline, record.subtitle?.segments ?? []).map((entry, index) => (
                      <li key={index}>{outlineLabel(entry)}</li>
                    ))}
                  </ul>
                </>
              )}
              {analysis.keyPoints.length > 0 && (
                <>
                  <h3 class="viewer-h3">关键点</h3>
                  <ul class="viewer-list">
                    {analysis.keyPoints.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              <p class="viewer-sub">
                {analysis.provider} · {analysis.model} · {new Date(analysis.createdAt).toLocaleString()}
                {record.subtitle && analysis.subtitleDigest && analysis.subtitleDigest !== record.subtitle.digest
                  ? ' · ⚠︎ 字幕已更新，摘要可能过期'
                  : ''}
              </p>
            </>
          ) : (
            <p class="hint">还没有摘要。在设置里启用 AI 摘要后，用弹窗的「执行未完成步骤」生成。</p>
          )}
        </section>

        <section class="card viewer-section" id="notes">
          <div class="viewer-section-head">
            <h2 class="viewer-h2">我的笔记</h2>
          </div>
          {notes.highlights.length || notes.questions.length || notes.freeform.trim() ? (
            <>
              {notes.highlights.length > 0 && (
                <>
                  <h3 class="viewer-h3">印象深刻</h3>
                  <ul class="viewer-list">
                    {notes.highlights.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {notes.questions.length > 0 && (
                <>
                  <h3 class="viewer-h3">待思考</h3>
                  <ul class="viewer-list">
                    {notes.questions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {notes.freeform.trim() && <p class="viewer-summary">{notes.freeform}</p>}
            </>
          ) : (
            <p class="hint">还没有笔记。可以在弹窗的「随手记」里写。</p>
          )}
        </section>
      </main>
    </div>
  );
}
