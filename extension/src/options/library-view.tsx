import { useState } from 'preact/hooks';
import type { VideoRecord, Settings } from '../lib/types';
import { inLibrary } from '../lib/history';
import { sendToBackground } from '../lib/messages';
import { agentBrief, recordToMarkdown } from '../lib/export';
import { downloadText } from '../lib/download';

/** 只有收录的视频进入知识库，历史来源和同步技术标签不出现在这里。 */
export function LibraryView({
  records,
  settings,
  refresh,
  notify,
}: {
  records: VideoRecord[];
  settings: Settings;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);
  const [busy, setBusy] = useState(false);
  const visible = records
    .filter(inLibrary)
    .filter((record) =>
      `${record.title} ${record.owner} ${record.subtitle?.plainText ?? ''} ${record.analysis?.summary ?? ''} ${record.userNotes.freeform}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  async function run(key?: string) {
    setBusy(true);
    const result = await sendToBackground(key ? { type: 'sync-now', key } : { type: 'sync-all' });
    setBusy(false);
    notify(result.ok ? (key ? '处理完成' : '已加入处理队列') : (result.error ?? '处理失败'), !result.ok);
    await refresh();
  }
  return (
    <section>
      <div class="page-heading">
        <h1>
          知识库 <span class="heading-count">{records.filter(inLibrary).length}</span>
        </h1>
        {settings.notion.enabled && (
          <button disabled={busy} class="primary" onClick={() => void run()}>
            写入 Notion
          </button>
        )}
      </div>
      <p class="quiet">收录值得留下的视频，整理字幕、摘要与自己的笔记。</p>
      <input
        class="library-search"
        type="search"
        aria-label="搜索知识库"
        placeholder="搜索标题、字幕、摘要、笔记"
        value={query}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setLimit(40);
        }}
      />
      <ul class="library-list">
        {visible.slice(0, limit).map((record) => (
          <li key={record.key}>
            <div>
              <a
                class="video-title"
                href={`viewer.html?key=${encodeURIComponent(record.key)}`}
                target="_blank"
                rel="noreferrer"
              >
                {record.title || record.bvid}
              </a>
              <p class="quiet">
                {record.owner} · {record.subtitle ? '已有字幕' : '尚未获取字幕'}
                {record.analysis ? ' · 已有摘要' : ''}
                {record.steps.notion.state === 'ok' ? ' · 已写入 Notion' : ''}
              </p>
              {record.analysis && <p class="library-summary">{record.analysis.summary}</p>}
              {(['subtitle', 'analysis', 'notion'] as const)
                .filter((step) => record.steps[step].state === 'error')
                .map((step) => (
                  <p class="inline-error" key={step}>
                    {record.steps[step].error}
                  </p>
                ))}
            </div>
            <div class="library-actions">
              <a
                class="button-link"
                href={`viewer.html?key=${encodeURIComponent(record.key)}`}
                target="_blank"
                rel="noreferrer"
              >
                字幕 / 摘要 / 笔记
              </a>
              <details class="row-menu">
                <summary aria-label={`知识库操作：${record.title}`}>⋯</summary>
                <div>
                  <button disabled={busy} onClick={() => void run(record.key)}>
                    整理视频{settings.notion.enabled ? '并写入 Notion' : ''}
                  </button>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(agentBrief(record)).then(
                        () => notify('已复制给 AI'),
                        () => notify('复制失败，请重试', true),
                      )
                    }
                  >
                    复制给 AI
                  </button>
                  <button onClick={() => downloadText(`${record.bvid}.md`, recordToMarkdown(record), 'text/markdown')}>
                    导出 Markdown
                  </button>
                  <button
                    onClick={() =>
                      void (async () => {
                        if (!confirm('删除本地记录及其字幕、摘要和笔记？不会删除 B站历史或 Notion 页面。')) return;
                        const result = await sendToBackground({ type: 'delete-record', key: record.key });
                        notify(result.ok ? '本地记录已删除' : (result.error ?? '删除失败'), !result.ok);
                        await refresh();
                      })()
                    }
                  >
                    删除本地记录
                  </button>
                </div>
              </details>
            </div>
          </li>
        ))}
      </ul>
      {!visible.length && (
        <div class="empty">
          <h2>{query ? '没有找到相关内容' : '留住值得再看的内容'}</h2>
          <p>从历史记录的更多菜单收录视频，或在 B站点赞、投币、收藏、分享时按原规则自动收录。</p>
        </div>
      )}
      {visible.length > limit && (
        <button class="load-more" onClick={() => setLimit(limit + 40)}>
          加载更多
        </button>
      )}
    </section>
  );
}
