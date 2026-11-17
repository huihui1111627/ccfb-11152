// 发布闸门:预算不足或存在进行中的 critical 告警时拦截非紧急发布;
// 紧急发布必须填理由,决策与当时预算快照一起落库留痕。
// gateVerdict 是纯函数,DB 路径(服务器)和内存路径(评估回放)共用。
import { DatabaseSync } from 'node:sqlite';
import { one, rows, run } from '../db/index.js';
import { ReleaseRow, SloRow } from '../types.js';
import { budgetStatus, BudgetStatus } from './budget.js';

export interface GateVerdict {
  allowed: boolean;
  blockers: string[];
  worstRemaining: number | null; // 该服务所有 SLO 中最差的预算剩余比例
}

export function gateVerdict(
  slos: SloRow[],
  budgetOf: (slo: SloRow) => BudgetStatus,
  activeCritical: number,
): GateVerdict {
  const blockers: string[] = [];
  let worst: number | null = null;
  for (const slo of slos) {
    const b = budgetOf(slo);
    if (b.insufficientData) continue; // 数据不足不拦(没数据 ≠ 故障),但页面会标出
    if (worst === null || b.remainingFraction < worst) worst = b.remainingFraction;
    if (b.remainingFraction < slo.gate_threshold) {
      blockers.push(
        `SLO「${slo.name}」预算剩余 ${(b.remainingFraction * 100).toFixed(1)}%,低于闸门线 ${(slo.gate_threshold * 100).toFixed(0)}%`,
      );
    }
  }
  if (activeCritical > 0) blockers.push(`存在 ${activeCritical} 条未恢复的 critical 告警`);
  return { allowed: blockers.length === 0, blockers, worstRemaining: worst };
}

export function evaluateGate(db: DatabaseSync, serviceId: number, now: number): GateVerdict {
  const slos = rows<SloRow>(db, `SELECT * FROM slos WHERE service_id=?`, serviceId);
  const activeCritical = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM alerts WHERE service_id=? AND severity='critical' AND opened_at<=? AND (resolved_at IS NULL OR resolved_at>?)`,
    serviceId,
    now,
    now,
  )!.n;
  return gateVerdict(slos, (slo) => budgetStatus(db, slo, now), activeCritical);
}

export function requestRelease(
  db: DatabaseSync,
  serviceId: number,
  version: string,
  opts: { emergency: boolean; reason: string; decidedBy: string; now: number },
): ReleaseRow {
  const verdict = evaluateGate(db, serviceId, opts.now);
  let status: ReleaseRow['status'];
  if (verdict.allowed) {
    status = opts.emergency ? 'emergency_approved' : 'approved';
  } else if (opts.emergency) {
    if (!opts.reason.trim()) throw new Error('紧急发布必须填写理由');
    status = 'emergency_approved';
  } else {
    status = 'blocked';
  }
  run(
    db,
    `INSERT INTO releases(service_id, version, requested_at, status, emergency, reason, budget_remaining, decided_by)
     VALUES(?,?,?,?,?,?,?,?)`,
    serviceId,
    version,
    opts.now,
    status,
    opts.emergency ? 1 : 0,
    opts.reason,
    verdict.worstRemaining,
    opts.decidedBy,
  );
  return one<ReleaseRow>(db, `SELECT * FROM releases ORDER BY id DESC LIMIT 1`)!;
}
