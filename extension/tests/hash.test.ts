import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Hex, sha256Hex, stableDigest } from '../src/lib/hash';

describe('hash', () => {
  it('matches RFC 1321 MD5 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('handles multi-block and unicode input like node:crypto', () => {
    for (const sample of ['中文测试字符串', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(1000)]) {
      const expected = createHash('md5').update(sample, 'utf8').digest('hex');
      expect(md5Hex(sample)).toBe(expected);
    }
  });

  it('computes SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('stableDigest changes with content and length', () => {
    expect(stableDigest('abc')).not.toBe(stableDigest('abd'));
    expect(stableDigest('abc')).not.toBe(stableDigest('abcd'));
    expect(stableDigest('abc')).toBe(stableDigest('abc'));
  });
});
