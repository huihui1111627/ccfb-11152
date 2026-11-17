import { one, rows, run } from '../db/index.js';
import { budgetStatus } from './budget.js';
export function gateVerdict(slos, budgetOf, activeCritical) {
    const blockers = [];
    let worst = null;
    for (const slo of slos) {
        const b = budgetOf(slo);
        if (b.insufficientData)
            continue; // 数据不足不拦(没数据 ≠ 故障),但页面会标出
        if (worst === null || b.remainingFraction < worst)
            worst = b.remainingFraction;
        if (b.remainingFraction < slo.gate_threshold) {
            blockers.push(`SLO「${slo.name}」预算剩余 ${(b.remainingFraction * 100).toFixed(1)}%,低于闸门线 ${(slo.gate_threshold * 100).toFixed(0)}%`);
        }
    }
    if (activeCritical > 0)
        blockers.push(`存在 ${activeCritical} 条未恢复的 critical 告警`);
    return { allowed: blockers.length === 0, blockers, worstRemaining: worst };
}
export function evaluateGate(db, serviceId, now) {
    const slos = rows(db, `SELECT * FROM slos WHERE service_id=?`, serviceId);
    const activeCritical = one(db, `SELECT COUNT(*) AS n FROM alerts WHERE service_id=? AND severity='critical' AND opened_at<=? AND (resolved_at IS NULL OR resolved_at>?)`, serviceId, now, now).n;
    return gateVerdict(slos, (slo) => budgetStatus(db, slo, now), activeCritical);
}
export function requestRelease(db, serviceId, version, opts) {
    const verdict = evaluateGate(db, serviceId, opts.now);
    let status;
    if (verdict.allowed) {
        status = opts.emergency ? 'emergency_approved' : 'approved';
    }
    else if (opts.emergency) {
        if (!opts.reason.trim())
            throw new Error('紧急发布必须填写理由');
        status = 'emergency_approved';
    }
    else {
        status = 'blocked';
    }
    run(db, `INSERT INTO releases(service_id, version, requested_at, status, emergency, reason, budget_remaining, decided_by)
     VALUES(?,?,?,?,?,?,?,?)`, serviceId, version, opts.now, status, opts.emergency ? 1 : 0, opts.reason, verdict.worstRemaining, opts.decidedBy);
    return one(db, `SELECT * FROM releases ORDER BY id DESC LIMIT 1`);
}
