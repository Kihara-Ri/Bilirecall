import { describe, expect, it } from 'vitest';
import { MAX_TIME, safeClock, safeIso, safeStamp, safeTime } from '../src/lib/time';

describe('safeTime', () => {
  it('keeps a legit timestamp', () => {
    expect(safeTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('turns everything Date cannot render into 0', () => {
    for (const value of [undefined, null, '', 'abc', NaN, Infinity, -Infinity, -1, 1e300, MAX_TIME + 1, {}, []]) {
      expect(safeTime(value)).toBe(0);
    }
  });

  it('accepts the boundary values Date still renders', () => {
    expect(safeTime(0)).toBe(0);
    expect(safeTime(MAX_TIME)).toBe(MAX_TIME);
    expect(() => new Date(MAX_TIME).toISOString()).not.toThrow();
  });

  // 这条就是用户报的「点几次就卡住」：渲染期抛 RangeError 会让整个视图停止更新。
  it('never produces an ISO string that throws', () => {
    for (const value of [1e300, NaN, Infinity, 'abc', undefined]) {
      expect(() => safeIso(value)).not.toThrow();
      expect(() => safeClock(value)).not.toThrow();
      expect(() => safeStamp(value)).not.toThrow();
    }
    expect(safeIso(1e300)).toBeUndefined();
    expect(safeClock(1e300)).toBe('—');
    expect(safeStamp(NaN)).toBe('未知时间');
  });
});
