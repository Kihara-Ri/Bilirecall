import { describe, expect, it } from 'vitest';
import { normalizeCoverUrl } from '../src/lib/media';

describe('normalizeCoverUrl', () => {
  it('upgrades the http and protocol-relative covers B站 returns', () => {
    expect(normalizeCoverUrl('http://i0.hdslb.com/bfs/archive/a.jpg')).toBe('https://i0.hdslb.com/bfs/archive/a.jpg');
    expect(normalizeCoverUrl('//i2.hdslb.com/bfs/archive/b.jpg')).toBe('https://i2.hdslb.com/bfs/archive/b.jpg');
    expect(normalizeCoverUrl('https://i1.hdslb.com/bfs/archive/c.jpg')).toBe('https://i1.hdslb.com/bfs/archive/c.jpg');
  });

  it('rejects anything that is not a B站 image URL', () => {
    expect(normalizeCoverUrl('')).toBe('');
    expect(normalizeCoverUrl(undefined)).toBe('');
    expect(normalizeCoverUrl('不是网址')).toBe('');
    expect(normalizeCoverUrl('javascript:alert(1)')).toBe('');
    expect(normalizeCoverUrl('https://evil.example.com/a.jpg')).toBe('');
    expect(normalizeCoverUrl('https://i0.hdslb.com.evil.com/a.jpg')).toBe('');
  });
});
