import { describe, expect, it } from 'vitest';
import { brandPath } from '../src/lib/brand-icons';

describe('brandPath', () => {
  it('recognises the endpoints the panel names', () => {
    const deepseek = brandPath('https://api.deepseek.com/v1');
    expect(deepseek).toBeTruthy();
    expect(deepseek).toMatch(/^M/);
    expect(brandPath('DeepSeek https://api.deepseek.com/v1')).toBe(deepseek);
  });

  it('gives every provider its own mark', () => {
    const seen = new Map<string, string>();
    for (const endpoint of [
      'https://api.deepseek.com/v1',
      'https://api.moonshot.cn/v1',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://api.siliconflow.cn/v1',
      'https://api.groq.com/openai/v1',
      'https://api.anthropic.com/v1',
      'https://openrouter.ai/api/v1',
      'https://api.openai.com/v1',
    ]) {
      const path = brandPath(endpoint);
      expect(path, endpoint).toBeTruthy();
      expect(seen.has(path!), endpoint + ' shares a mark with ' + seen.get(path!)).toBe(false);
      seen.set(path!, endpoint);
    }
    expect(seen.size).toBe(9);
  });

  it('falls back to null for an endpoint we have no logo for', () => {
    expect(brandPath('https://api.example.com/v1')).toBeNull();
    expect(brandPath('自定义端点')).toBeNull();
  });
});
