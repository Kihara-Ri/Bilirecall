import { BiliVaultError } from './errors';
import { clockLabel } from './outline';
import type { AnalysisResult, Settings, SubtitleSegment, VideoRecord } from './types';

import { browserFetch, type FetchLike } from './http';

const MAX_TRANSCRIPT_CHARS = 24000;

/** Evenly samples the transcript when it is too long, keeping beginning and end. */
export function condenseTranscript(text: string, limit = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.6));
  const tail = text.slice(-Math.floor(limit * 0.35));
  return `${head}\n\n...[中间省略 ${text.length - head.length - tail.length} 字]...\n\n${tail}`;
}

/** Timed lines, so the model can cite `[mm:ss-mm:ss]` ranges in the outline. */
export function timedTranscript(segments: readonly SubtitleSegment[]): string {
  return segments.map((segment) => `[${clockLabel(segment.from)}] ${segment.content}`).join('\n');
}

export function buildMessages(record: VideoRecord, settings: Settings): Array<{ role: string; content: string }> {
  const prompt = settings.ai.prompt.replace('{{language}}', settings.ai.language);
  const subtitle = record.subtitle;
  const transcript = subtitle
    ? condenseTranscript(subtitle.segments.length ? timedTranscript(subtitle.segments) : subtitle.plainText)
    : '（无字幕，请仅根据标题与简介给出谨慎的概述）';
  const user = [
    `标题：${record.title}`,
    `UP主：${record.owner}`,
    `分区：${record.category || '未知'}`,
    `简介：${(record.description ?? '').slice(0, 2000) || '（无）'}`,
    record.userNotes.highlights.length ? `用户印象深刻：${record.userNotes.highlights.join('；')}` : '',
    record.userNotes.questions.length ? `用户想进一步思考：${record.userNotes.questions.join('；')}` : '',
    `\n字幕正文（每行开头的 [分:秒] 是时间标记，写提纲时引用它）：\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: user },
  ];
}

/** Known OpenAI-compatible endpoints, so the panel can show whose API is being used. */
const PROVIDERS: Array<[RegExp, string]> = [
  [/openai\.com/i, 'OpenAI'],
  [/deepseek/i, 'DeepSeek'],
  [/moonshot|kimi/i, 'Moonshot'],
  [/bigmodel|zhipu/i, '智谱'],
  [/dashscope|aliyuncs/i, '通义千问'],
  [/openrouter/i, 'OpenRouter'],
  [/siliconflow/i, 'SiliconFlow'],
  [/groq/i, 'Groq'],
  [/anthropic/i, 'Anthropic'],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{4,5}$/i, '本地模型'],
];

export function providerLabel(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return '自定义端点';
  }
  for (const [pattern, label] of PROVIDERS) if (pattern.test(host)) return label;
  return host.replace(/^api\./, '') || '自定义端点';
}

export function parseAnalysis(content: string, provider: string, model: string): AnalysisResult {
  const match = content.match(/\{[\s\S]*\}/);
  let parsed: any = null;
  if (match) {
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      parsed = null;
    }
  }
  const asArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : typeof value === 'string' && value ? [value] : [];
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : content.trim().slice(0, 1200),
    outline: asArray(parsed?.outline),
    keyPoints: asArray(parsed?.keyPoints ?? parsed?.key_points),
    provider,
    model,
    createdAt: Date.now(),
  };
}

export async function pingAi(settings: Settings, http: FetchLike = browserFetch): Promise<string> {
  const base = settings.ai.baseUrl.replace(/\/+$/, '');
  const response = await http(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.ai.apiKey}` },
    body: JSON.stringify({ model: settings.ai.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new BiliVaultError(`AI 服务 HTTP ${response.status}：${text.slice(0, 200)}`);
  return settings.ai.model;
}

export async function summarize(
  record: VideoRecord,
  settings: Settings,
  http: FetchLike = browserFetch,
): Promise<AnalysisResult> {
  if (!settings.ai.enabled || !settings.ai.apiKey) throw new BiliVaultError('未启用 AI 摘要或未填写 API Key');
  const base = settings.ai.baseUrl.replace(/\/+$/, '');
  const response = await http(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.ai.apiKey}` },
    body: JSON.stringify({ model: settings.ai.model, messages: buildMessages(record, settings), temperature: 0.3 }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new BiliVaultError(`AI 服务 HTTP ${response.status}：${text.slice(0, 200)}`);
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BiliVaultError('AI 服务返回的不是 JSON');
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new BiliVaultError('AI 服务未返回内容');
  return parseAnalysis(content, base, settings.ai.model);
}
