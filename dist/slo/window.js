import { rows } from '../db/index.js';
import { BUCKET_SEC, HIST_EDGES } from '../types.js';
// 延迟 SLO 的"好请求" = 延迟 <= 阈值的请求。阈值取自 HIST_EDGES,所以直方图求和精确。
export function goodOf(slo, ok, hist) {
    if (slo.type === 'availability')
        return ok;
    const t = slo.latency_threshold_ms;
    let g = 0;
    for (let i = 0; i < HIST_EDGES.length; i++) {
        if (HIST_EDGES[i] <= t)
            g += hist[i] ?? 0;
    }
    return g;
}
function maintenanceFraction(bucketStart, bucketEnd, maint) {
    let covered = 0;
    for (const m of maint) {
        const s = Math.max(bucketStart, m.start_ts);
        const e = Math.min(bucketEnd, m.end_ts);
        if (e > s)
            covered += e - s;
    }
    return Math.min(1, covered / (bucketEnd - bucketStart));
}
export function computeWindow(db, slo, startSec, endSec) {
    const buckets = rows(db, `SELECT * FROM buckets WHERE service_id=? AND bucket_start>=? AND bucket_start<?`, slo.service_id, startSec, endSec);
    const maint = rows(db, `SELECT * FROM maintenance WHERE service_id=? AND end_ts>? AND start_ts<?`, slo.service_id, startSec, endSec);
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
        if (w <= 0)
            continue; // 整桶在维护里,完全剔除
        const b = byStart.get(bs);
        if (!b || b.gap) {
            gapWeight += w; // 没数据:不进分母
            continue;
        }
        scoredWeight += w;
        const hist = JSON.parse(b.hist);
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
export function badTotal(db, slo, startSec, endSec) {
    const w = computeWindow(db, slo, startSec, endSec);
    return { bad: w.total - w.good, total: w.total, insufficient: w.insufficientData };
}
