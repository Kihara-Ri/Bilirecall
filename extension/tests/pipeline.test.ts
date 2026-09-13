import { describe, expect, it } from 'vitest';
import { STEP_LABEL, STEP_ORDER, analysisFresh, notionFresh, notionMissing, plannedSteps, shouldRunStep } from '../src/lib/pipeline';
import { newRecord } from '../src/lib/store';
import { DEFAULT_SETTINGS, type Settings, type VideoRecord } from '../src/lib/types';
import { validateSegments } from '../src/lib/subtitle';
import { subtitleBody } from './helpers';

function record(): VideoRecord {
  return newRecord({
    bvid: 'BV1xx411c7mD',
    aid: 1,
    cid: 2,
    title: '标题',
    owner: 'UP主',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  });
}

function withSubtitle(item: VideoRecord, digest = 'abc'): VideoRecord {
  const segments = validateSegments(subtitleBody('第一句'));
  item.subtitle = {
    track: { id: '1', language: 'ai-zh', label: '中文（自动生成）', source: 'page' },
    availableTracks: [],
    segments,
    plainText: '第一句',
    digest,
    fetchedAt: 1,
    observations: 2,
    warnings: [],
  };
  item.steps.subtitle = { state: 'ok', at: 1 };
  return item;
}

function settings(patch: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled: true, apiKey: 'k', ...(patch.ai ?? {}) },
    notion: { ...DEFAULT_SETTINGS.notion, enabled: true, token: 't', parentId: 'p', ...(patch.notion ?? {}) },
    ...patch,
  };
}

describe('step planning', () => {
  it('runs subtitle first when nothing is captured', () => {
    expect(plannedSteps(record(), settings())).toEqual(['subtitle', 'analysis', 'notion']);
  });

  it('skips the analysis when AI is not configured', () => {
    const item = withSubtitle(record());
    const plan = plannedSteps(item, settings({ ai: { ...DEFAULT_SETTINGS.ai, enabled: false } }));
    expect(plan).toEqual(['notion']);
  });

  it('skips Notion when it is not configured', () => {
    const item = withSubtitle(record());
    const plan = plannedSteps(item, settings({ notion: { ...DEFAULT_SETTINGS.notion, enabled: false } }));
    expect(plan).toEqual(['analysis']);
  });

  it('plans nothing when every step is already done and fresh', () => {
    const item = withSubtitle(record(), 'digest-1');
    item.analysis = { summary: 's', outline: [], keyPoints: [], provider: 'p', model: 'm', createdAt: 1, subtitleDigest: 'digest-1' };
    item.steps.analysis = { state: 'ok' };
    item.steps.notion = { state: 'ok', url: 'u', subtitleDigest: 'digest-1' };
    expect(plannedSteps(item, settings())).toEqual([]);
  });

  it('re-plans the analysis and Notion steps when the subtitle changed', () => {
    const item = withSubtitle(record(), 'digest-2');
    item.analysis = { summary: 's', outline: [], keyPoints: [], provider: 'p', model: 'm', createdAt: 1, subtitleDigest: 'digest-1' };
    item.steps.analysis = { state: 'ok' };
    item.steps.notion = { state: 'ok', url: 'u', subtitleDigest: 'digest-1' };
    expect(analysisFresh(item)).toBe(false);
    expect(notionFresh(item)).toBe(false);
    expect(plannedSteps(item, settings())).toEqual(['analysis', 'notion']);
  });

  it('keeps a failed step in the plan so it is retried', () => {
    const item = withSubtitle(record());
    item.steps.subtitle = { state: 'error', error: '未登录' };
    item.subtitle = undefined;
    expect(plannedSteps(item, settings())).toEqual(['subtitle', 'analysis', 'notion']);
  });

  it('treats a page the library check could not find as not written', () => {
    const item = withSubtitle(record(), 'digest-1');
    item.steps.notion = { state: 'ok', url: 'u', subtitleDigest: 'digest-1', library: { state: 'missing', checkedAt: 1 } };
    expect(notionFresh(item)).toBe(false);
    expect(plannedSteps(item, settings())).toContain('notion');
  });

  it('exposes the step order and labels used by the UI', () => {
    expect(STEP_ORDER).toEqual(['subtitle', 'analysis', 'notion']);
    expect(STEP_LABEL.subtitle).toBe('字幕');
    expect(shouldRunStep(withSubtitle(record()), settings(), 'subtitle')).toBe(false);
  });
});

describe('notion configuration gate', () => {
  const notion = (patch: Partial<Settings['notion']> = {}) => ({ ...DEFAULT_SETTINGS.notion, ...patch });

  it('is ready only when enabled, token and parent are all present', () => {
    expect(notionMissing(notion({ enabled: true, token: 'ntn_x', parentId: 'ds' }))).toBe('');
    expect(notionMissing(DEFAULT_SETTINGS.notion)).not.toBe('');
  });

  it('names the one missing piece so the panel can explain itself', () => {
    expect(notionMissing(notion({ enabled: false, token: 'ntn_x', parentId: 'ds' }))).toContain('未启用');
    expect(notionMissing(notion({ enabled: true, token: '', parentId: 'ds' }))).toContain('Token');
    expect(notionMissing(notion({ enabled: true, token: 'ntn_x', parentId: '' }))).toContain('Data Source');
  });

  it('treats a token without a parent as unusable, matching the panel', () => {
    const tokenOnly = settings({ notion: notion({ enabled: true, token: 'ntn_x', parentId: '' }) });
    expect(notionMissing(tokenOnly.notion)).not.toBe('');
    expect(shouldRunStep(withSubtitle(record()), tokenOnly, 'notion')).toBe(false);
  });
});
