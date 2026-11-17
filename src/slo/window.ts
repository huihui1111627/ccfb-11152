// 窗口聚合:把 5 分钟桶聚合成任意窗口的 SLI 达标率。
// 三条硬规则:
//  1. 维护窗口按时间比例剔除(分子分母同比例缩放,只缩一次,不双重缩放);
//  2. 缺口桶(gap=1 或整桶缺失)不进分母 —— 没数据不等于故障;
//  3. 覆盖率不足时返回 insufficientData,不判不达标(窗口未满/数据太少不下结论)。
import { DatabaseSync } from 'node:sqlite';
import { rows } from '../db/index.js';
import { BUCKET_SEC, HIST_EDGES, BucketRow, MaintenanceRow, SloRow } from '../types.js';

export interface WindowResult {
  expected: number; // 窗口内应有的桶数
  maintenanceWeight: number; // 被维护窗口覆盖的桶权重(0..expected)
  gapWeight: number; // 缺口桶权重
  scoredWeight: number; // 实际参与计分的桶权重
  total: number; // 计分请求数(维护按比例剔除后)
  good: number; // 计分好请求数
  coverage: number; // scored / (scored + gap),即非维护时间里的数据覆盖率
  compliance: number | null; // good/total;数据不足或窗口内无请求时为 null
  insufficientData: boolean;
}

// 延迟 SLO 的"好请求" = 延迟 <= 阈值的请求。阈值取自 HIST_EDGES,所以直方图求和精确。
export function goodOf(slo: SloRow, ok: number, hist: number[]): number {
  if (slo.type === 'availability') return ok;
  const t = slo.latency_threshold_ms!;
  let g = 0;
  for (let i = 0; i < HIST_EDGES.length; i++) {
    if (HIST_EDGES[i] <= t) g += hist[i] ?? 0;
  }
  return g;
}

function maintenanceFraction(bucketStart: number, bucketEnd: number, maint: MaintenanceRow[]): number {
  let covered = 0;
  for (const m of maint) {
    const s = Math.max(bucketStart, m.start_ts);
    const e = Math.min(bucketEnd, m.end_ts);
    if (e > s) covered += e - s;
  }
  return Math.min(1, covered / (bucketEnd - bucketStart));
}

export function computeWindow(
  db: DatabaseSync,
  slo: SloRow,
  startSec: number,
  endSec: number,
): WindowResult {
  const buckets = rows<BucketRow>(
    db,
    `SELECT * FROM buckets WHERE service_id=? AND bucket_start>=? AND bucket_start<?`,
    slo.service_id,
    startSec,
    endSec,
  );
  const maint = rows<MaintenanceRow>(
    db,
    `SELECT * FROM maintenance WHERE service_id=? AND end_ts>? AND start_ts<?`,
    slo.service_id,
    startSec,
    endSec,
  );
  const expected = Math.max(1, Math.round((endSec - startSec) / BUCKET_SEC));
  const byStart = new Map(buckets.map((b) => [b.bucket_start, b]));

  let maintenanceWeight = 0;
  let gapWeight = 0;
  let scoredWeight = 0;
  let total = 0;
  let good = 0;

  for (let i = 0; i < expected; i++) {
    const bs = startSec + i * BUCKET_SEC;
    const m = maintenanceFraction(bs, bs + BUCKET_SEC, maint);
    maintenanceWeight += m;
    const w = 1 - m;
    if (w <= 0) continue; // 整桶在维护里,完全剔除
    const b = byStart.get(bs);
    if (!b || b.gap) {
      gapWeight += w; // 没数据:不进分母
      continue;
    }
    scoredWeight += w;
    const hist = JSON.parse(b.hist) as number[];
    total += b.total * w;
    good += goodOf(slo, b.ok, hist) * w;
  }

  const denom = scoredWeight + gapWeight;
  const coverage = denom > 0 ? scoredWeight / denom : 0;
  const insufficientData = scoredWeight <= 0 || coverage < 0.7 || total <= 0;
  return {
    expected,
    maintenanceWeight,
    gapWeight,
    scoredWeight,
    total,
    good,
    coverage,
    compliance: insufficientData ? null : good / total,
    insufficientData,
  };
}

// 供燃烧率/告警用的轻量窗口:只要 bad/total
export function badTotal(
  db: DatabaseSync,
  slo: SloRow,
  startSec: number,
  endSec: number,
): { bad: number; total: number; insufficient: boolean } {
  const w = computeWindow(db, slo, startSec, endSec);
  return { bad: w.total - w.good, total: w.total, insufficient: w.insufficientData };
}
