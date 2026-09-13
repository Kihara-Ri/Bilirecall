import { describe, expect, it } from 'vitest';
import { providerLabel } from '../src/lib/ai';

describe('providerLabel', () => {
  it('names the common OpenAI-compatible endpoints', () => {
    expect(providerLabel('https://api.openai.com/v1')).toBe('OpenAI');
    expect(providerLabel('https://api.deepseek.com/v1')).toBe('DeepSeek');
    expect(providerLabel('https://api.moonshot.cn/v1')).toBe('Moonshot');
    expect(providerLabel('https://open.bigmodel.cn/api/paas/v4')).toBe('智谱');
    expect(providerLabel('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('通义千问');
    expect(providerLabel('https://api.siliconflow.cn/v1')).toBe('SiliconFlow');
    expect(providerLabel('https://openrouter.ai/api/v1')).toBe('OpenRouter');
  });

  it('recognises a local runtime', () => {
    expect(providerLabel('http://localhost:11434/v1')).toBe('本地模型');
    expect(providerLabel('http://127.0.0.1:8000/v1')).toBe('本地模型');
  });

  it('falls back to the host, and never throws on junk', () => {
    expect(providerLabel('https://api.example.com/v1')).toBe('example.com');
    expect(providerLabel('不是网址')).toBe('自定义端点');
    expect(providerLabel('')).toBe('自定义端点');
  });
});
