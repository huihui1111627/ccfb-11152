import { BUCKET_MS, DAY_MS } from './types.js';

/** 对齐到 5 分钟桶边界(向下取整) */
export function bucketFloor(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

export function addDays(ts: number, days: number): number {
  return ts + days * DAY_MS;
}

export function addHours(ts: number, hours: number): number {
  return ts + hours * 3_600_000;
}

/** 自然月窗口:返回 ts 所在 UTC 自然月的 [start, end) */
export function calendarMonthBounds(ts: number): { start: number; end: number } {
  const d = new Date(ts);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

export function rolling28Bounds(ts: number): { start: number; end: number } {
  const end = bucketFloor(ts);
  return { start: end - 28 * DAY_MS, end };
}

/** 两个区间是否重叠(半开区间) */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 重叠长度(ms),不重叠为 0 */
export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

export function formatDate(ts: number): string {
  return formatDateTime(ts).slice(0, 10);
}

export function pct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** 百分比展示,允许负值与超 100% */
export function pctSigned(x: number, digits = 2): string {
  const sign = x > 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(digits)}%`;
}
