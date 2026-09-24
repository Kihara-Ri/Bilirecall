/**
 * 时间戳只有在 Date 能表示时才安全：`new Date(1e300).toISOString()` 抛 RangeError，
 * 而在 Preact 里渲染期抛一次错就会让整棵树停止更新 —— 界面看起来就是「点不动了」。
 * 所以所有把存储 / 接口里的数字交给 Date 的地方都先过这里，坏值一律当「未知」。
 */
export const MAX_TIME = 8.64e15;

/** 合法（有限、非负、在 Date 范围内）就返回它，否则返回 0。 */
export function safeTime(value: unknown): number {
  const time = Number(value ?? 0);
  if (!Number.isFinite(time) || time < 0 || time > MAX_TIME) return 0;
  return time;
}

/** 给 <time dateTime> 用；未知时返回 undefined（不写属性）。 */
export function safeIso(value: unknown): string | undefined {
  const time = safeTime(value);
  return time ? new Date(time).toISOString() : undefined;
}

/** 列表里的时刻；未知时显示 —。 */
export function safeClock(value: unknown): string {
  const time = safeTime(value);
  return time ? new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
}

/** 完整时间（状态行 / 诊断）；未知时如实说不知道。 */
export function safeStamp(value: unknown): string {
  const time = safeTime(value);
  return time ? new Date(time).toLocaleString('zh-CN') : '未知时间';
}
