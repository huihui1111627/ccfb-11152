import { one } from '../db/index.js';
import { DAY_SEC } from '../types.js';
import { computeWindow } from './window.js';
export function weeklyReport(db, slo) {
    const first = one(db, `SELECT MIN(bucket_start) AS mn FROM buckets WHERE service_id=?`, slo.service_id);
    const last = one(db, `SELECT MAX(bucket_start) AS mx FROM buckets WHERE service_id=?`, slo.service_id);
    if (!first?.mn || !last?.mx)
        return [];
    // 对齐到周一 00:00 UTC
    const d0 = new Date(first.mn * 1000);
    const dow = (d0.getUTCDay() + 6) % 7; // 周一=0
    let weekStart = Math.floor(first.mn / DAY_SEC) * DAY_SEC - dow * DAY_SEC;
    const end = last.mx;
    const out = [];
    while (weekStart <= end) {
        const ws = weekStart;
        const we = weekStart + 7 * DAY_SEC;
        const w = computeWindow(db, slo, ws, we);
        const alerts = one(db, `SELECT COUNT(*) AS n FROM alerts WHERE slo_id=? AND opened_at<? AND COALESCE(resolved_at, ?) > ?`, slo.id, we, we, ws);
        const bad = w.total - w.good;
        out.push({
            weekStart: new Date(ws * 1000).toISOString().slice(0, 10),
            compliance: w.compliance,
            badRequests: Math.round(bad),
            totalRequests: Math.round(w.total),
            coverage: w.coverage,
            budgetConsumedPct: w.total > 0 ? (bad / w.total / (1 - slo.target)) * (7 / 28) * 100 : 0,
            alerts: alerts?.n ?? 0,
        });
        weekStart = we;
    }
    return out;
}
export function weeklyCsv(db, slo) {
    const header = 'week_start,compliance,total_requests,bad_requests,coverage,budget_consumed_pct,alerts';
    const lines = weeklyReport(db, slo).map((r) => [
        r.weekStart,
        r.compliance === null ? '' : r.compliance.toFixed(6),
        r.totalRequests,
        r.badRequests,
        r.coverage.toFixed(4),
        r.budgetConsumedPct.toFixed(2),
        r.alerts,
    ].join(','));
    return [header, ...lines].join('\n') + '\n';
}
