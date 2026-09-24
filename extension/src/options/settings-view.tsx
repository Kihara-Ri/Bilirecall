import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DeepPartial, Settings } from '../lib/types';
import { sendToBackground } from '../lib/messages';
import type { SchemaReview } from '../lib/notion';
import { downloadText } from '../lib/download';

function Toggle({
  label,
  checked,
  change,
  children,
}: {
  label: string;
  checked: boolean;
  change: (value: boolean) => void;
  children?: ComponentChildren;
}) {
  return (
    <label class="setting-toggle">
      <span>
        <strong>{label}</strong>
        {children && <small>{children}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => change(event.currentTarget.checked)}
      />
    </label>
  );
}
function Field({
  label,
  value,
  change,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <label class="setting-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onInput={(event) => change(event.currentTarget.value)}
        autoComplete="off"
        spellcheck={false}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * 可选主机权限只声明了 https 通配、http://localhost 与 http://127.0.0.1 三种模式。
 * 请求一个没声明过的 origin 会直接返回 false（连弹窗都没有），所以这里先构造模式、
 * 再让用户确认 —— 本地模型（http://127.0.0.1:11434）也要走同一条路。
 */
async function ensureOrigin(url: string, purpose: string): Promise<string> {
  let origin = '';
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    throw new Error(`${purpose} 不是合法网址`);
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return origin;
  if (!(await chrome.permissions.request({ origins: [origin] }))) throw new Error(`需要授权才能访问 ${origin}`);
  return origin;
}

/** 服务关闭时保留配置但不铺开表单，协议解释只在需要时展开。 */
export function SettingsView({
  settings: s,
  patch,
  notify,
}: {
  settings: Settings;
  patch: (patch: DeepPartial<Settings>) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notionStatus, setNotionStatus] = useState('尚未测试连接');
  const [connectionDetails, setConnectionDetails] = useState<string[]>([]);
  const [diagnostic, setDiagnostic] = useState('');
  async function test(type: 'test-ai' | 'test-notion' | 'test-relation') {
    setBusy(true);
    try {
      if (type !== 'test-relation') {
        // Notion 与 B站 是 manifest 里的必需主机权限，contains 会直接放行，不再多弹一次窗。
        await ensureOrigin(type === 'test-notion' ? 'https://api.notion.com' : s.ai.baseUrl, type === 'test-notion' ? 'Notion' : 'AI 服务地址');
      }
      const result = await sendToBackground<{
        review?: SchemaReview | null;
        parentTitle?: string;
        like?: boolean;
        coin?: number;
        favorite?: boolean;
        via?: string;
      }>({ type });
      let text = result.ok ? '连接正常' : (result.error ?? '连接失败');
      if (type === 'test-relation' && result.ok && result.data) {
        text = `读取成功：点赞=${result.data.like} · 投币=${result.data.coin} · 收藏=${result.data.favorite}`;
        setDiagnostic(`${text} · ${result.data.via ?? ''}`);
      }
      if (type === 'test-notion') {
        const review = result.data?.review;
        setConnectionDetails(
          result.ok
            ? [
                result.data?.parentTitle ?? '',
                ...(review?.columns ?? []).map(
                  (column) =>
                    `${column.name}：${column.status === 'ok' ? '已匹配' : column.status === 'missing' ? '缺少此列' : '类型不匹配'}${column.matched ? `（${column.matched}）` : ''}`,
                ),
              ].filter(Boolean)
            : [],
        );
        if (review && !review.ok) text = '连接正常，列配置需要检查';
      }
      if (type === 'test-notion') setNotionStatus(text);
      notify(text, !result.ok);
    } catch (error) {
      notify(error instanceof Error ? error.message : '连接失败', true);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Webhook 以前既没有权限入口（域名拿不到主机权限 → fetch 必失败），失败也只写进
   * service worker 控制台。这个按钮把两件事一起解决：申请该域名权限，然后真的发一条。
   */
  async function testWebhook() {
    setBusy(true);
    try {
      if (!s.webhook.url.trim()) throw new Error('先填写 Webhook URL');
      await ensureOrigin(s.webhook.url, 'Webhook 地址');
      const result = await sendToBackground<{ status: number }>({ type: 'test-webhook' });
      notify(result.ok ? `Webhook 已收到测试消息（HTTP ${result.data?.status ?? 200}）` : (result.error ?? 'Webhook 测试失败'), !result.ok);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Webhook 测试失败', true);
    } finally {
      setBusy(false);
    }
  }

  async function exportData(markdown = false) {
    const result = await sendToBackground<Array<{ path: string; content: string }>>({ type: 'export-bundle' });
    if (!result.ok || !result.data) {
      notify(result.error ?? '导出失败', true);
      return;
    }
    if (markdown)
      downloadText(
        'bilirecall-videos.md',
        result.data
          .filter((file) => file.path.startsWith('videos/'))
          .map((file) => file.content)
          .join('\n\n---\n\n'),
        'text/markdown',
      );
    else
      for (const file of result.data.filter((file) => !file.path.startsWith('videos/')))
        downloadText(`bilirecall-${file.path}`, file.content, 'text/plain');
    notify('已导出知识库');
  }
  return (
    <section class="settings-view">
      <div class="page-heading">
        <h1>设置</h1>
      </div>
      <section class="settings-section">
        <h2>历史记录</h2>
        <Toggle
          label="记录观看历史"
          checked={s.general.captureWatched}
          change={(value) => patch({ general: { captureWatched: value } })}
        >
          在本机记录观看，不自动写入 Notion。
        </Toggle>
        <Toggle
          label="自动更新历史"
          checked={s.general.autoUpdateHistory}
          change={(value) => patch({ general: { autoUpdateHistory: value } })}
        >
          打开历史页时，超过 5 分钟未更新便检查最新记录。
        </Toggle>
      </section>
      <section class="settings-section">
        <h2>知识库</h2>
        <div class="setting-description">
          <strong>自动收录规则</strong>
          <p>在视频页点赞、投币、收藏或分享时收录；仅更新历史不触发收录。</p>
        </div>
        <label class="setting-field">
          <span>字幕语言</span>
          <select
            value={s.subtitle.language}
            onChange={(event) => patch({ subtitle: { language: event.currentTarget.value } })}
          >
            <option value="auto">自动选择</option>
            <option value="zh-Hans">人工简体中文</option>
            <option value="ai-zh">AI 中文</option>
            <option value="zh-Hant">繁体中文</option>
            <option value="en">英文</option>
          </select>
        </label>
        <details class="advanced">
          <summary>高级设置</summary>
          <p class="quiet">多次读取结果一致才保存字幕；指定语言缺失时不会偷偷换轨。</p>
          <label class="setting-field">
            <span>一致读取次数</span>
            <input
              type="number"
              min="2"
              max="5"
              value={s.subtitle.consensusReads}
              onChange={(event) =>
                patch({ subtitle: { consensusReads: Math.min(5, Math.max(2, Number(event.currentTarget.value))) } })
              }
            />
          </label>
          <label class="setting-field">
            <span>最大尝试次数</span>
            <input
              type="number"
              min="2"
              max="10"
              value={s.subtitle.maxAttempts}
              onChange={(event) =>
                patch({ subtitle: { maxAttempts: Math.min(10, Math.max(2, Number(event.currentTarget.value))) } })
              }
            />
          </label>
        </details>
      </section>
      <section class="settings-section">
        <h2>AI 摘要</h2>
        <Toggle label="自动生成摘要" checked={s.ai.enabled} change={(value) => patch({ ai: { enabled: value } })}>
          关闭时仍可保存字幕和笔记。
        </Toggle>
        {s.ai.enabled && (
          <div class="setting-fields">
            <Field
              label="服务地址"
              value={s.ai.baseUrl}
              change={(value) => patch({ ai: { baseUrl: value } })}
              hint="兼容 OpenAI API 的服务地址，以 /v1 结尾。"
            />
            <Field
              label="API 密钥"
              type="password"
              value={s.ai.apiKey}
              change={(value) => patch({ ai: { apiKey: value } })}
            />
            <Field label="模型" value={s.ai.model} change={(value) => patch({ ai: { model: value } })} />
            <Field label="输出语言" value={s.ai.language} change={(value) => patch({ ai: { language: value } })} />
            <details class="advanced">
              <summary>高级设置</summary>
              <label class="setting-field">
                <span>提示词</span>
                <textarea
                  rows={6}
                  value={s.ai.prompt}
                  onInput={(event) => patch({ ai: { prompt: event.currentTarget.value } })}
                />
                <small>返回 JSON，包含 summary、outline、keyPoints；{'{{language}}'} 替换为输出语言。</small>
              </label>
            </details>
            <button disabled={busy} onClick={() => void test('test-ai')}>
              测试 AI 连接
            </button>
          </div>
        )}
      </section>
      <section class="settings-section">
        <h2>Notion</h2>
        <Toggle
          label="自动写入 Notion"
          checked={s.notion.enabled}
          change={(value) => patch({ notion: { enabled: value } })}
        >
          仅处理知识库中收录的视频。
        </Toggle>
        {s.notion.enabled && (
          <div class="setting-fields">
            <p class="quiet" role="status">
              {notionStatus}
            </p>
            {connectionDetails.length > 0 && (
              <details class="advanced">
                <summary>连接详情</summary>
                {connectionDetails.map((line) => (
                  <p key={line} class="quiet">
                    {line}
                  </p>
                ))}
              </details>
            )}
            <Field
              label="Integration Token"
              value={s.notion.token}
              type="password"
              change={(value) => {
                setNotionStatus('配置已修改，请重新测试');
                patch({ notion: { token: value } });
              }}
            />
            <label class="setting-field">
              <span>写入目标类型</span>
              <select
                value={s.notion.parentType}
                onChange={(event) => {
                  setNotionStatus('配置已修改，请重新测试');
                  patch({ notion: { parentType: event.currentTarget.value as Settings['notion']['parentType'] } });
                }}
              >
                <option value="data_source_id">数据库 Data Source</option>
                <option value="page_id">页面 Page</option>
              </select>
            </label>
            <Field
              label="写入目标 ID"
              value={s.notion.parentId}
              change={(value) => {
                setNotionStatus('配置已修改，请重新测试');
                patch({ notion: { parentId: value } });
              }}
            />
            <details class="advanced">
              <summary>高级设置与连接帮助</summary>
              <Toggle
                label="自动补齐缺失的列"
                checked={s.notion.autoColumns}
                change={(value) => patch({ notion: { autoColumns: value } })}
              >
                只新增，不修改已有列。
              </Toggle>
              <Field
                label="标题属性"
                value={s.notion.titleProperty}
                change={(value) => patch({ notion: { titleProperty: value } })}
              />
              <p class="quiet">
                数据库需连接到你的 integration。Data Source ID 不是 Database ID，可从 GET /v1/databases/&lt;id&gt;
                返回的 data_sources 中获取。
              </p>
            </details>
            <button disabled={busy} onClick={() => void test('test-notion')}>
              测试 Notion 连接
            </button>
          </div>
        )}
      </section>
      <details class="settings-section more-settings">
        <summary>更多</summary>
        <Toggle
          label="写入成功时桌面通知"
          checked={s.general.notifyOnSync}
          change={(value) => patch({ general: { notifyOnSync: value } })}
        />
        <Toggle
          label="触发 Webhook"
          checked={s.webhook.enabled}
          change={(value) => patch({ webhook: { enabled: value } })}
        >
          写入完成后发送完整记录 JSON 至指定地址。
        </Toggle>
        {s.webhook.enabled && (
          <>
            <Field label="Webhook URL" value={s.webhook.url} change={(value) => patch({ webhook: { url: value } })} />
            <button disabled={busy} onClick={() => void testWebhook()}>
              授权并测试
            </button>
          </>
        )}
        <h3>数据导出</h3>
        <div class="settings-actions">
          <button onClick={() => void exportData()}>导出知识库包</button>
          <button onClick={() => void exportData(true)}>导出 Markdown</button>
        </div>
        <details class="advanced">
          <summary>诊断</summary>
          <button disabled={busy} onClick={() => void test('test-relation')}>
            测试 B站状态读取
          </button>
          {diagnostic && (
            <p role="status" class="quiet">
              {diagnostic}
            </p>
          )}
        </details>
        <h3>本地数据清理</h3>
        <p class="quiet">在历史记录或知识库的更多菜单中逐条移除；不影响 B站历史和已有 Notion 页面。</p>
      </details>
    </section>
  );
}
