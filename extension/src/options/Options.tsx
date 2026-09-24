import { useEffect, useRef, useState } from 'preact/hooks';
import { sendToBackground } from '../lib/messages';
import { deepMerge } from '../lib/store';
import type { DeepPartial, Settings, VideoRecord } from '../lib/types';
import { HistoryView } from './history-view';
import { LibraryView } from './library-view';
import { SettingsView } from './settings-view';

type Tab = 'history' | 'library' | 'settings';
const labels: Record<Tab, string> = { history: '历史记录', library: '知识库', settings: '设置' };

/** 三个任务入口共享本地数据，设置反馈只在后台确认写入后显示成功。 */
export function Options() {
  const [tab, setTab] = useState<Tab>('history');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [records, setRecords] = useState<VideoRecord[]>([]);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const current = useRef<Settings | null>(null);
  function notify(text: string, error = false) {
    setToast({ text, error });
  }
  async function refresh() {
    const result = await sendToBackground<VideoRecord[]>({ type: 'list-records' });
    if (result.ok && Array.isArray(result.data)) setRecords(result.data);
    else setLoadError(result.error ?? '读取本地记录失败');
    setLocalLoaded(true);
  }
  async function load() {
    setLoadError('');
    const recordsReady = refresh();
    const result = await sendToBackground<Settings>({ type: 'get-settings' });
    if (result.ok && result.data) {
      current.current = result.data;
      setSettings(result.data);
    } else setLoadError(result.error ?? '读取设置失败');
    await recordsReady;
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  function patch(value: DeepPartial<Settings>) {
    if (!current.current) return;
    const next = deepMerge(current.current, value);
    current.current = next;
    setSettings(next);
    setSaveState('saving');
    const version = ++revision.current;
    // 按顺序保存当前快照，后续输入也能补救前一次失败；旧响应不会覆盖新输入。
    pending.current = pending.current.then(async () => {
      const result = await sendToBackground<Settings>({ type: 'save-settings', patch: next });
      if (version !== revision.current) return;
      setSaveState(result.ok && result.data ? 'saved' : 'error');
      if (!result.ok || !result.data) notify(result.error ?? '保存失败，修改仍保留在页面中', true);
      else setToast(null);
    });
  }
  return (
    <div class="workspace">
      <aside class="workspace-nav">
        <div class="workspace-brand">BiliRecall</div>
        <nav aria-label="主导航">
          {(['history', 'library', 'settings'] as const).map((value) => (
            <button
              key={value}
              aria-current={tab === value ? 'page' : undefined}
              class={tab === value ? 'active' : ''}
              onClick={() => {
                setTab(value);
                window.scrollTo(0, 0);
              }}
            >
              {labels[value]}
            </button>
          ))}
        </nav>
        <span class="nav-footnote">留住值得再看的内容</span>
      </aside>
      <main class="workspace-main">
        {loadError && (
          <div class="inline-error" role="alert">
            {loadError} <button onClick={() => void load()}>重试</button>
          </div>
        )}
        {tab === 'history' && !localLoaded && <p>正在读取本地历史…</p>}
        {tab === 'history' && localLoaded && <HistoryView records={records} refresh={refresh} notify={notify} />}
        {tab === 'library' && settings && (
          <LibraryView records={records} settings={settings} refresh={refresh} notify={notify} />
        )}
        {tab === 'settings' && settings && (
          <>
            <div class="save-status" role="status">
              {saveState === 'saving'
                ? '正在保存…'
                : saveState === 'saved'
                  ? '已保存'
                  : saveState === 'error'
                    ? '保存失败'
                    : '修改后自动保存'}
              {saveState === 'error' && (
                <button onClick={() => current.current && patch(current.current)}>重试保存</button>
              )}
            </div>
            <SettingsView settings={settings} patch={patch} notify={notify} />
          </>
        )}
        {tab !== 'history' && !settings && !loadError && <p>正在加载…</p>}
      </main>
      {toast && (
        <div class={`workspace-toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
