import type { PipelineStep, Settings, VideoRecord } from './types';

export const STEP_ORDER: PipelineStep[] = ['subtitle', 'analysis', 'notion'];

export const STEP_LABEL: Record<PipelineStep, string> = {
  subtitle: '字幕',
  analysis: 'AI 摘要',
  notion: 'Notion',
};

/** The analysis is stale once the subtitle body changed. */
export function analysisFresh(record: VideoRecord): boolean {
  if (!record.analysis) return false;
  if (!record.subtitle) return true;
  return record.analysis.subtitleDigest === record.subtitle.digest;
}

export function notionFresh(record: VideoRecord): boolean {
  // A page that the last library check could not find is not "written" any more.
  if (record.steps.notion.library?.state === 'missing') return false;
  return record.steps.notion.state === 'ok' && record.steps.notion.subtitleDigest === record.subtitle?.digest;
}

export function aiUsable(settings: Settings): boolean {
  return settings.ai.enabled && Boolean(settings.ai.apiKey);
}

/** Empty when the Notion step can run; otherwise the missing piece, phrased for the UI. */
export function notionMissing(notion: Settings['notion']): string {
  if (!notion.enabled) return '未启用「自动写入 Notion」';
  if (!notion.token) return '缺 Integration Token';
  if (!notion.parentId) return '缺 Data Source ID / Page ID';
  return '';
}

export function notionUsable(settings: Settings): boolean {
  return !notionMissing(settings.notion);
}

export function shouldRunStep(record: VideoRecord, settings: Settings, step: PipelineStep): boolean {
  if (step === 'subtitle') return !record.subtitle;
  if (step === 'analysis') return aiUsable(settings) && !analysisFresh(record);
  return notionUsable(settings) && !notionFresh(record);
}

/** Steps that still need work, in order. Empty means everything is already done. */
export function plannedSteps(record: VideoRecord, settings: Settings): PipelineStep[] {
  return STEP_ORDER.filter((step) => shouldRunStep(record, settings, step));
}

/** Human-readable reason a step cannot run (used for inline step errors). */
export function blockReason(record: VideoRecord, step: PipelineStep): string | undefined {
  if (step === 'analysis' || step === 'notion') {
    if (!record.subtitle) return '还没有字幕，请先完成第 1 步';
  }
  return undefined;
}
