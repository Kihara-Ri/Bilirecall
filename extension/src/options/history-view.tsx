import { Component, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  durationLabel,
  historyGroups,
  historyTime,
  inLibrary,
  interaction,
  playbackUrl,
  type HistoryFilter,
} from '../lib/history';
import type { VideoRecord } from '../lib/types';
import type { HistorySyncStatus } from '../lib/history-sync';
import { sendToBackground } from '../lib/messages';
import { normalizeCoverUrl } from '../lib/media';
import { safeClock, safeIso, safeStamp } from '../lib/time';
import { LikeIcon, CoinIcon, FavoriteIcon } from '../lib/icons';

/**
 * 一条记录的数据坏了，也只牺牲这一行。以前渲染期抛一次错会让整棵视图停止更新 ——
 * 表现就是筛选按钮「点不动」，而且再也恢复不了。
 */
class RowGuard extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  componentDidCatch(error: unknown) {
    console.warn('记录渲染失败，已跳过这一行', error);
    this.setState({ failed: true });
  }
  render() {
    if (this.state.failed) return <p class="quiet">这条记录的数据有问题，已跳过渲染。</p>;
    return this.props.children;
  }
}

interface Props {
  records: VideoRecord[];
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}

/** 历史浏览与知识处理分离；更新状态轮询不会清空已经显示的本地列表。 */
export function HistoryView({ records, refresh, notify }: Props) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);
  const [status, setStatus] = useState<HistorySyncStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const seenRevision = useRef<number | null>(null);
  async function update(force: boolean) {
    setRequesting(true);
    const result = await sendToBackground<HistorySyncStatus>({ type: 'sync-bilibili', force });
    setRequesting(false);
    if (result.ok && result.data) setStatus(result.data);
    else notify(result.error ?? '更新失败，请重试', true);
    // 手动点「更新历史」时立刻重读一次，不用等下一次轮询的版本号比较。
    if (force) await refresh();
  }
  useEffect(() => {
    let active = true;
    void update(false);
    const timer = setInterval(
      () =>
        void (async () => {
          const result = await sendToBackground<{ status: HistorySyncStatus; revision: number }>({ type: 'history-poll' });
          if (!active || !result.ok || !result.data) return;
          setStatus(result.data.status);
          // 只有归档真的变了才重读记录：轮询本身必须便宜，否则越用越卡。
          if (seenRevision.current === result.data.revision) return;
          seenRevision.current = result.data.revision;
          await refresh();
        })(),
      2000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => setLimit(40), [filter, query]);
  const groups = useMemo(() => historyGroups(records, filter, query), [records, filter, query]);
  const total = groups.reduce((n, group) => n + group.records.length, 0);
  let remaining = limit;
  const shown = groups
    .map((group) => {
      const rows = group.records.slice(0, Math.max(0, remaining));
      remaining -= rows.length;
      return { ...group, records: rows };
    })
    .filter((group) => group.records.length);
  const running = requesting || status?.state === 'running';
  const text =
    status?.state === 'error'
      ? status.error?.includes('登录') ? '请先登录 B站，再重试' : '历史更新失败，请重试'
      : status?.state === 'running'
        ? `${status.phase === 'history' ? '正在更新历史' : '历史已获取，正在补全互动'} · 已获取 ${status.count} 条`
        : status?.warnings.length
          ? '历史已更新，部分互动数据未更新'
          : status?.lastCompletedAt
            ? `上次更新于 ${safeStamp(status.lastCompletedAt)}`
            : '本地记录长期保留';
  async function action(type: 'collect-record' | 'hide-history', record: VideoRecord) {
    if (type === 'hide-history' && !confirm('从本地历史移除这条记录？不会删除 B站历史或知识库内容。')) return;
    const result = await sendToBackground({ type, key: record.key });
    notify(
      result.ok ? (type === 'collect-record' ? '已收录到知识库' : '已从本地历史移除') : (result.error ?? '操作失败'),
      !result.ok,
    );
    if (result.ok) await refresh();
  }
  return (
    <section aria-labelledby="history-title">
      <div class="page-heading">
        <h1 id="history-title">历史记录</h1>
        <button class="primary" disabled={running} onClick={() => void update(true)}>
          {running ? '更新中…' : '更新历史'}
        </button>
      </div>
      <div class="history-status" role="status">
        <span>{text}</span>
        {(status?.state === 'error' || Boolean(status?.warnings.length)) && (
          <button class="text-button" disabled={running} onClick={() => void update(true)}>
            重试
          </button>
        )}
        {status?.error?.includes('登录') && (
          <a href="https://www.bilibili.com/" target="_blank" rel="noreferrer">
            去登录
          </a>
        )}
      </div>
      {(Boolean(status?.warnings.length) || status?.state === 'error') && (
        <details class="sync-details">
          <summary>详情</summary>
          {status?.error && <p>{status.error}</p>}
          {status?.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
      <div class="history-tools">
        <div class="history-filters" aria-label="互动筛选">
          {(
            [
              ['all', '全部'],
              ['liked', '点赞过'],
              ['coined', '投币过'],
              ['faved', '收藏过'],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={filter === value}
              class={filter === value ? 'selected' : ''}
              onClick={() => setFilter(value)}
              key={value}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="搜索历史"
          placeholder="搜索标题、UP主"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {filter !== 'all' && (
        <p class="quiet filter-note">
          显示最近确认的状态；未检查的记录不计入结果。{filter === 'coined' ? '投币状态仅覆盖本地已发现的视频。' : ''}
        </p>
      )}
      {shown.map((group) => (
        <section class="history-group" key={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {group.records.map((record) => {
              const time = historyTime(record);
              const cover = normalizeCoverUrl(record.cover ?? '');
              const watched = record.history;
              const progress = watched?.finished
                ? '已看完'
                : watched?.position
                  ? `已看到 ${durationLabel(watched.position)}`
                  : record.watched.completed
                    ? '已看完'
                    : '观看进度未知';
              return (
                <li class="history-row" key={record.key}>
                  <RowGuard>
                  <time class="history-time" dateTime={safeIso(time)}>
                    {safeClock(time)}
                  </time>
                  <a
                    class="video-cover"
                    href={playbackUrl(record)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`播放 ${record.title}`}
                  >
                    <span class="cover-placeholder" aria-hidden="true">
                      ▶
                    </span>
                    {cover && (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                        }}
                      />
                    )}
                    <span class="video-duration">{record.duration ? durationLabel(record.duration) : '时长未知'}</span>
                  </a>
                  <div class="history-info">
                    <a class="video-title" href={playbackUrl(record)} target="_blank" rel="noreferrer">
                      {record.title || record.bvid}
                    </a>
                    <p>
                      {record.owner || '未知 UP主'}
                      <span class="meta-dot">·</span>
                      {progress}
                    </p>
                    <div class="interaction-marks">
                      {interaction(record, 'like') === true && (
                        <span title="已点赞" aria-label="已点赞">
                          <LikeIcon on size={16} />
                        </span>
                      )}
                      {interaction(record, 'coin') === true && (
                        <span
                          title={`已投币 ${record.actions.coin} 枚`}
                          aria-label={`已投币 ${record.actions.coin} 枚`}
                        >
                          <CoinIcon on size={16} /> {record.actions.coin}
                        </span>
                      )}
                      {interaction(record, 'favorite') === true && (
                        <span title="已收藏" aria-label="已收藏">
                          <FavoriteIcon on size={16} />
                        </span>
                      )}
                    </div>
                  </div>
                  <details class="row-menu">
                    <summary aria-label={`更多操作：${record.title}`}>⋯</summary>
                    <div>
                      <button disabled={inLibrary(record)} onClick={() => void action('collect-record', record)}>
                        {inLibrary(record) ? '已收录到知识库' : '收录到知识库'}
                      </button>
                      <button onClick={() => void action('hide-history', record)}>从本地历史移除</button>
                    </div>
                  </details>
                  </RowGuard>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {!total && (
        <div class="empty">
          <h2>{query ? '没有找到相关视频' : filter === 'all' ? '还没有观看记录' : '暂无已确认的记录'}</h2>
          <p>
            {query
              ? '换个标题或 UP主试试。'
              : running
                ? '正在获取记录，稍后会自动显示。'
                : '更新历史后，能获取到的记录会显示在这里。'}
          </p>
        </div>
      )}
      {total > limit && (
        <button class="load-more" onClick={() => setLimit(limit + 40)}>
          加载更多 · 还有 {total - limit} 条
        </button>
      )}
    </section>
  );
}
