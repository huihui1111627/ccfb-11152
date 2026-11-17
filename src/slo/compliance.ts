import type { DatabaseSync } from 'node:sqlite';
import { BUCKET_MS, DAY_MS } from '../shared/types.js';
import type { SloDef } from '../shared/types.js';
import { aggregateWindow } from './window.js';

export interface WeeklyCompliance {
  weekStart: number;
  weekEnd: number;
  total: number;
  good: number;
  bad: number;
  maintenanceExcluded: number;
  gapBuckets: number;
  ratio: number | null;
  target: number;
  met: boolean | null;
}

/** 按 UTC 自然周(周一 00:00 起)切分区间 */
function weekStartOf(ts: number): number {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=周日
  const diffToMonday = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - diffToMonday * DAY_MS;
}

/** 计算一个 SLO 在 [rangeStart, rangeEnd) 内逐周的达标情况 */
export function weeklyCompliance(
  db: DatabaseSync,
  slo: SloDef,
  rangeStart: number,
  rangeEnd: number,
): WeeklyCompliance[] {
  const out: WeeklyCompliance[] = [];
  let cursor = weekStartOf(rangeStart);
  while (cursor < rangeEnd) {
    const wStart = Math.max(cursor, rangeStart);
    const wEnd = Math.min(cursor + 7 * DAY_MS, rangeEnd);
    if (wEnd > wStart) {
      const agg = aggregateWindow(db, slo, wStart, wEnd);
      const ratio = agg.total > 0 ? agg.good / agg.total : null;
      out.push({
        weekStart: wStart,
        weekEnd: wEnd,
        total: agg.total,
        good: agg.good,
        bad: agg.bad,
        maintenanceExcluded: agg.maintenanceExcluded,
        gapBuckets: agg.gapBuckets,
        ratio,
        target: slo.target,
        met: ratio === null ? null : ratio >= slo.target,
      });
    }
    cursor += 7 * DAY_MS;
  }
  return out;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出单个 SLO 的周报 CSV */
export function exportWeeklyCsv(slo: SloDef, rows: WeeklyCompliance[]): string {
  const header = [
    '周开始(UTC)', '周结束(UTC)', '总请求', '达标请求', '错误请求',
    '维护排除请求', '缺口桶数', '达标率', 'SLO目标', '是否达标',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.weekStart).toISOString().slice(0, 10),
        new Date(r.weekEnd).toISOString().slice(0, 10),
        r.total,
        r.good,
        r.bad,
        r.maintenanceExcluded,
        r.gapBuckets,
        r.ratio === null ? '无数据' : (r.ratio * 100).toFixed(4) + '%',
        (r.target * 100).toFixed(2) + '%',
        r.met === null ? '无数据' : r.met ? '达标' : '未达标',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

export { BUCKET_MS };
