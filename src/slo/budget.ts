import type { DatabaseSync } from 'node:sqlite';
import type { ErrorBudget, SloDef } from '../shared/types.js';
import { rows } from '../db/index.js';
import { aggregateWindow, windowBounds } from './window.js';

interface SmallWindow {
  total: number;
  bad: number;
  gapBuckets: number;
  expectedBuckets: number;
}

function aggregateSmallWindow(
  db: DatabaseSync,
  slo: SloDef,
  start: number,
  end: number,
): SmallWindow {
  const rowsOut = rows<{
    total: number; good: number; reported: number; bucket_ts: number;
  }>(
    db
      .prepare(
        `SELECT total, good, reported, bucket_ts
       FROM metric_buckets
       WHERE service_id = ? AND bucket_ts >= ? AND bucket_ts < ?
       ORDER BY bucket_ts`,
      ),
    slo.serviceId, start, end,
  );

  const maintRows = rows<{ start_ts: number; end_ts: number }>(
    db
      .prepare(
        `SELECT start_ts, end_ts FROM maintenance_windows
       WHERE service_id = ? AND start_ts < ? AND end_ts > ?`,
      ),
    slo.serviceId, end, start,
  );

  let total = 0;
  let bad = 0;
  let gapBuckets = 0;
  const BUCKET = 5 * 60 * 1000;

  for (const r of rowsOut) {
    if (!r.reported) {
      gapBuckets += 1;
      continue;
    }
    let keep = 1;
    for (const m of maintRows) {
      const lo = Math.max(r.bucket_ts, m.start_ts);
      const hi = Math.min(r.bucket_ts + BUCKET, m.end_ts);
      if (hi > lo) keep = Math.min(keep, 1 - (hi - lo) / BUCKET);
    }
    if (keep <= 0.001) continue;
    total += Math.round(r.total * keep);
    bad += Math.round((r.total - r.good) * keep);
  }

  return {
    total,
    bad,
    gapBuckets,
    expectedBuckets: Math.floor((end - start) / BUCKET),
  };
}

/**
 * 计算 SLO 在当前窗口的错误预算状态。
 * ETA:用近 1h / 近 24h 的错误产生速度线性外推剩余预算耗尽时间。
 */
export function computeBudget(db: DatabaseSync, slo: SloDef, at: number): ErrorBudget {
  const { start, end } = windowBounds(slo, at);
  const agg = aggregateWindow(db, slo, start, end);

  const budget = agg.total * (1 - slo.target);
  const remaining = budget - agg.bad;
  const remainingFraction = budget > 0 ? remaining / budget : 1;
  const burnRate = budget > 0 ? agg.bad / budget : null;

  const etaForWindow = (hours: number): number | null => {
    const wStart = Math.max(start, at - hours * 3_600_000);
    const w = aggregateSmallWindow(db, slo, wStart, at);
    if (w.total < 30 || w.bad <= 0) return null;
    const windowMs = at - wStart;
    // 近期错误产生速度(个/毫秒)
    const ratePerMs = w.bad / windowMs;
    if (remaining <= 0) return at;
    const msToBurnout = remaining / ratePerMs;
    return at + msToBurnout;
  };

  return {
    sloId: slo.id,
    windowStart: start,
    windowEnd: end,
    target: slo.target,
    total: agg.total,
    good: agg.good,
    bad: agg.bad,
    maintenanceExcluded: agg.maintenanceExcluded,
    budget,
    remaining,
    remainingFraction,
    burnRate,
    etaBurnout: etaForWindow(24),
    etaBurnout1h: etaForWindow(1),
    updatedAt: at,
  };
}

export interface BudgetTrendPoint {
  ts: number;
  remainingFraction: number;
  burnRate: number | null;
  ratio: number | null;
}

/**
 * 预算消耗趋势:按步长重放历史窗口,供前端画燃烧曲线。
 * 仅取 reported 桶,步长默认 6 小时。
 */
export function budgetTrend(
  db: DatabaseSync,
  slo: SloDef,
  at: number,
  points = 56,
): BudgetTrendPoint[] {
  const { start } = windowBounds(slo, at);
  const span = at - start;
  const step = Math.max(5 * 60 * 1000, Math.floor(span / points));
  const out: BudgetTrendPoint[] = [];
  for (let t = start + step; t <= at; t += step) {
    const b = computeBudget(db, slo, t);
    out.push({
      ts: t,
      remainingFraction: b.remainingFraction,
      burnRate: b.burnRate,
      ratio: b.total > 0 ? b.good / b.total : null,
    });
  }
  return out;
}
