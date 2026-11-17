import { rows } from '../db/index.js';
import { computeWindow } from './window.js';
function worstBurn6h(db, serviceId, now) {
    const slos = rows(db, `SELECT * FROM slos WHERE service_id=?`, serviceId);
    let worst = 0;
    for (const slo of slos) {
        const w = computeWindow(db, slo, now - 6 * 3600, now);
        if (w.insufficientData || w.total <= 0)
            continue;
        const br = (1 - w.good / w.total) / (1 - slo.target);
        if (br > worst)
            worst = br;
    }
    return worst;
}
export function dependencyImpact(db, serviceId, now) {
    const selfBurn = worstBurn6h(db, serviceId, now);
    const deps = rows(db, `SELECT d.upstream_id, d.weight, s.name FROM dependencies d JOIN services s ON s.id=d.upstream_id WHERE d.service_id=?`, serviceId);
    const upstreams = [];
    let prod = 1;
    for (const d of deps) {
        const upBurn = worstBurn6h(db, d.upstream_id, now);
        // 上游也在烧(BR>1)才算贡献;贡献按依赖权重和上游相对烈度缩放
        const ratio = selfBurn > 0 && upBurn > 1 ? Math.min(1, upBurn / Math.max(selfBurn, 1)) : 0;
        const c = d.weight * ratio;
        prod *= 1 - c;
        upstreams.push({ upstreamId: d.upstream_id, upstreamName: d.name, weight: d.weight, upstreamBurn: upBurn, contribution: c });
    }
    const impactScore = 1 - prod;
    return {
        serviceId,
        selfBurn,
        impacted: selfBurn > 1 && impactScore > 0.5,
        impactScore,
        upstreams: upstreams.sort((a, b) => b.contribution - a.contribution),
    };
}
