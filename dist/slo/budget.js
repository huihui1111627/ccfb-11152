import { computeWindow } from './window.js';
import { DAY_SEC, ROLLING_28D_SEC } from '../types.js';
const BUDGET_PERIOD_HOURS = ROLLING_28D_SEC / 3600; // 672h,预算周期基准
export function windowBounds(slo, now) {
    if (slo.window === 'rolling_28d')
        return [now - ROLLING_28D_SEC, now];
    const d = new Date(now * 1000);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    return [start, now];
}
function burnRate(win, slo, now, windowSec) {
    const w = win(now - windowSec, now);
    if (w.insufficientData || w.total <= 0)
        return 0;
    return (1 - w.good / w.total) / (1 - slo.target);
}
function prevMonthConsumed(win, slo, now) {
    const d = new Date(now * 1000);
    const thisStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const prevStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000;
    const w = win(prevStart, thisStart);
    if (w.insufficientData || w.total <= 0)
        return 0;
    return (w.total - w.good) / w.total / (1 - slo.target);
}
export function budgetStatusFrom(win, slo, now) {
    const [ws, we] = windowBounds(slo, now);
    const w = win(ws, we);
    const allowed = 1 - slo.target;
    let consumed = 0;
    if (!w.insufficientData && w.total > 0) {
        consumed = (w.total - w.good) / w.total / allowed;
    }
    if (slo.window === 'calendar_month') {
        const elapsedDays = (now - ws) / DAY_SEC;
        if (elapsedDays < 28) {
            const prev = prevMonthConsumed(win, slo, now);
            const weight = elapsedDays / 28;
            consumed = weight * consumed + (1 - weight) * prev;
        }
    }
    const remaining = 1 - consumed;
    const br1 = burnRate(win, slo, now, 3600);
    const br6 = burnRate(win, slo, now, 6 * 3600);
    // 预测用较近窗口的较大燃烧率:故障初期 6h 窗口被健康时段稀释,会严重低估
    const brForecast = Math.max(br1, br6);
    const exhaustion = remaining <= 0 ? 0 : brForecast > 0.01 ? (remaining * BUDGET_PERIOD_HOURS) / brForecast : null;
    return {
        sloId: slo.id,
        windowStart: ws,
        windowEnd: we,
        target: slo.target,
        compliance: w.compliance,
        consumedFraction: consumed,
        remainingFraction: remaining,
        burnRate1h: br1,
        burnRate6h: br6,
        burnRate24h: burnRate(win, slo, now, 24 * 3600),
        exhaustionInHours: exhaustion,
        insufficientData: w.insufficientData,
        coverage: w.coverage,
    };
}
export function budgetStatus(db, slo, now) {
    return budgetStatusFrom((s, e) => computeWindow(db, slo, s, e), slo, now);
}
