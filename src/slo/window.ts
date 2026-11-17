import type { DatabaseSync } from 'node:sqlite';
import type { SloDef, SloWindowResult } from '../shared/types.js';
import { BUCKET_MS, HIST_BINS } from '../shared/types.js';
import { calendarMonthBounds, rolling28Bounds } from '../shared/time.js';
import { rows } from '../db/index.js';
import { countBelow, decodeHist, mergeHist } from './histogram.js';

export interface WindowAggregate {
  total: number;
  good: number;
  bad: number;
  maintenanceExcluded: number;
  gapBuckets: number;
  expectedBuckets: number;
  reportedBuckets: number;
  /** 聚合延迟直方图(仅延迟 SLO 需要) */
  hist: Uint16Array | null;
}

interface MaintenanceRow {
  start_ts: number;
  end_ts: number;
}

interface BucketRow {
  bucket_ts: number;
  total: number;
  good: number;
  errors: number;
  reported: number;
}

/**
 * 取一个 SLO 在 [start,end) 内的聚合指标。
 * 规则:
 *  - reported=0 的桶视为上报缺口:不计入分母,单独统计 gapBuckets
 *  - 与维护窗口重叠的部分按时间比例从分母剔除(维护期请求不参与 SLO)
 *  - 延迟 SLO 的 good 由聚合直方图按阈值重算
 */
export function aggregateWindow(
  db: DatabaseSync,
  slo: SloDef,
  start: number,
  end: number,
): WindowAggregate {
  const buckets = rows<BucketRow>(
    db
      .prepare(
        `SELECT bucket_ts, total, good, errors, reported
       FROM metric_buckets
       WHERE service_id = ? AND bucket_ts >= ? AND bucket_ts < ?
       ORDER BY bucket_ts`,
      ),
    slo.serviceId, start, end,
  );

  const maintRows = rows<MaintenanceRow>(
    db
      .prepare(
        `SELECT start_ts, end_ts FROM maintenance_windows
       WHERE service_id = ? AND start_ts < ? AND end_ts > ?`,
      ),
    slo.serviceId, end, start,
  );

  const maintenanceFraction = (bucketTs: number): number => {
    let frac = 0;
    for (const m of maintRows) {
      const lo = Math.max(bucketTs, m.start_ts);
      const hi = Math.min(bucketTs + BUCKET_MS, m.end_ts);
      if (hi > lo) frac = Math.max(frac, (hi - lo) / BUCKET_MS);
    }
    return Math.min(1, frac);
  };

  let total = 0;
  let good = 0;
  let maintenanceExcluded = 0;
  let gapBuckets = 0;
  let reportedBuckets = 0;
  let hist: Uint16Array | null = slo.kind === 'latency' ? new Uint16Array(HIST_BINS) : null;

  const histRows =
    slo.kind === 'latency'
      ? rows<{ blob: Buffer }>(
          db
            .prepare(
              `SELECT h.hist AS blob FROM latency_hist h
             WHERE h.service_id = ? AND h.bucket_ts >= ? AND h.bucket_ts < ?
             ORDER BY h.bucket_ts`,
            ),
          slo.serviceId, start, end,
        )
      : [];
  let histIdx = 0;

  for (const b of buckets) {
    if (!b.reported) {
      gapBuckets += 1;
      histIdx += 1;
      continue;
    }
    reportedBuckets += 1;
    const frac = maintenanceFraction(b.bucket_ts);
    if (frac >= 0.999) {
      // 整桶维护:完全排除
      maintenanceExcluded += b.total;
      histIdx += 1;
      continue;
    }
    const keep = 1 - frac;
    const bTotal = Math.round(b.total * keep);
    const bGood = Math.round(b.good * keep);
    total += bTotal;
    good += bGood;
    if (frac > 0) maintenanceExcluded += b.total - bTotal;

    if (hist) {
      const decoded = decodeHist(histRows[histIdx]!.blob);
      // 维护部分按比例缩放直方图
      if (keep < 1) {
        for (let i = 0; i < decoded.length; i++) decoded[i] = Math.round(decoded[i] * keep);
      }
      hist = mergeHist(hist, decoded);
    }
    histIdx += 1;
  }

  if (slo.kind === 'latency' && hist) {
    // 延迟 SLO 口径:分母 = 成功请求数(good 字段累计的是可用性成功数)
    // 直方图按全量请求构建,其达标比例可直接迁移到成功请求口径(失败请求不改变延迟分布形状)
    const successTotal = good;
    const histTotal = hist.reduce((a, b) => a + b, 0);
    const latencyQualifiedRatio = histTotal > 0 ? countBelow(hist, slo.thresholdMs ?? Number.POSITIVE_INFINITY) / histTotal : 0;
    total = successTotal;
    good = Math.round(successTotal * latencyQualifiedRatio);
  }

  const expectedBuckets = Math.floor((end - start) / BUCKET_MS);
  return {
    total,
    good,
    bad: Math.max(0, total - good),
    maintenanceExcluded,
    gapBuckets,
    expectedBuckets,
    reportedBuckets,
    hist,
  };
}

export function windowBounds(slo: SloDef, at: number): { start: number; end: number } {
  return slo.windowType === 'calendarMonth'
    ? calendarMonthBounds(at)
    : rolling28Bounds(at);
}

export function computeWindowResult(
  db: DatabaseSync,
  slo: SloDef,
  at: number,
): SloWindowResult {
  const { start, end } = windowBounds(slo, at);
  const agg = aggregateWindow(db, slo, start, end);
  const ratio = agg.total > 0 ? agg.good / agg.total : null;

  let status: SloWindowResult['status'] = 'noData';
  if (ratio !== null) {
    if (ratio < slo.target) status = 'exhausted';
    else {
      const allowedErrorRate = 1 - slo.target;
      const actualErrorRate = 1 - ratio;
      const burn = actualErrorRate / allowedErrorRate;
      status = burn >= 1 ? 'burning' : 'healthy';
    }
  }

  return {
    sloId: slo.id,
    windowType: slo.windowType,
    windowStart: start,
    windowEnd: end,
    total: agg.total,
    good: agg.good,
    bad: agg.bad,
    maintenanceExcluded: agg.maintenanceExcluded,
    gapBuckets: agg.gapBuckets,
    expectedBuckets: agg.expectedBuckets,
    ratio,
    status,
  };
}
