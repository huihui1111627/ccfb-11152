// 依赖传导:下游 SLO 恶化时,标记其受上游影响的程度。
// 合成用 1-Π(1-c_i) 而不是线性求和 —— 多个上游贡献相加不会超过 1,不会"爆炸"。
import { DatabaseSync } from 'node:sqlite';
import { rows } from '../db/index.js';
import { SloRow } from '../types.js';
import { computeWindow } from './window.js';

export interface UpstreamImpact {
  upstreamId: number;
  upstreamName: string;
  weight: number;
  upstreamBurn: number; // 上游近 6h 燃烧率
  contribution: number; // 对本服务恶化的贡献 0..1
}

export interface ImpactResult {
  serviceId: number;
  selfBurn: number; // 本服务最差 SLO 的近 6h 燃烧率
  impacted: boolean; // 是否显著受上游影响
  impactScore: number; // 0..1
  upstreams: UpstreamImpact[];
}

function worstBurn6h(db: DatabaseSync, serviceId: number, now: number): number {
  const slos = rows<SloRow>(db, `SELECT * FROM slos WHERE service_id=?`, serviceId);
  let worst = 0;
  for (const slo of slos) {
    const w = computeWindow(db, slo, now - 6 * 3600, now);
    if (w.insufficientData || w.total <= 0) continue;
    const br = (1 - w.good / w.total) / (1 - slo.target);
    if (br > worst) worst = br;
  }
  return worst;
}

export function dependencyImpact(db: DatabaseSync, serviceId: number, now: number): ImpactResult {
  const selfBurn = worstBurn6h(db, serviceId, now);
  const deps = rows<{ upstream_id: number; weight: number; name: string }>(
    db,
    `SELECT d.upstream_id, d.weight, s.name FROM dependencies d JOIN services s ON s.id=d.upstream_id WHERE d.service_id=?`,
    serviceId,
  );
  const upstreams: UpstreamImpact[] = [];
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
