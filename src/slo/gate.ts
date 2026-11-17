import type { DatabaseSync } from 'node:sqlite';
import { buildSloDefs, GATE_POLICY } from '../config/catalog.js';
import { getGatePolicy, one, rows } from '../db/index.js';
import type {
  ErrorBudget,
  GatePolicy,
  ReleaseDecision,
  ReleaseKind,
  ReleaseRequest,
} from '../shared/types.js';
import { computeBudget } from './budget.js';

export interface GateInput {
  serviceId: string;
  kind: ReleaseKind;
  version: string;
  requester: string;
  reason?: string | null;
  ticket?: string | null;
}

export interface GateResult {
  decision: ReleaseDecision;
  /** 参与判定的服务相关 SLO 预算 */
  budgets: Array<ErrorBudget & { sloName: string }>;
  minBudgetFraction: number | null;
  threshold: number;
  reasons: string[];
  request: ReleaseRequest;
}

interface ReleaseRow {
  id: number;
  service_id: string;
  kind: ReleaseKind;
  version: string;
  requester: string;
  reason: string | null;
  decision: ReleaseDecision;
  min_budget_fraction: number | null;
  gate_threshold: number;
  decided_at: number;
  ticket: string | null;
}

function rowToRequest(r: ReleaseRow): ReleaseRequest {
  return {
    id: r.id,
    serviceId: r.service_id,
    kind: r.kind,
    version: r.version,
    requester: r.requester,
    reason: r.reason,
    decision: r.decision,
    minBudgetFraction: r.min_budget_fraction,
    gateThreshold: r.gate_threshold,
    decidedAt: r.decided_at,
    ticket: r.ticket,
  };
}

/**
 * 发布闸门:
 *  - 取该服务全部 SLO 的当前预算,以最低剩余占比作为闸门输入
 *  - 剩余占比 < blockBelowFraction:拦截非紧急发布
 *  - 紧急发布:必填理由,始终放行但完整留痕;预算耗尽时额外标记需二次确认
 */
export function evaluateGate(db: DatabaseSync, input: GateInput, at: number): GateResult {
  const policy: GatePolicy = getGatePolicy(db);
  const allSlos = buildSloDefs();
  const serviceSlos = allSlos.filter((s) => s.serviceId === input.serviceId);

  const budgets = serviceSlos.map((slo) => {
    const b = computeBudget(db, slo, at);
    return { ...b, sloName: slo.name };
  });
  const fractions = budgets.map((b) => b.remainingFraction).filter((x) => Number.isFinite(x));
  const minBudgetFraction = fractions.length > 0 ? Math.min(...fractions) : null;

  const reasons: string[] = [];
  let decision: ReleaseDecision = 'allow';

  const belowThreshold = minBudgetFraction !== null && minBudgetFraction < policy.blockBelowFraction;

  if (input.kind === 'normal') {
    if (belowThreshold) {
      decision = 'block';
      reasons.push(
        `最低错误预算剩余 ${(minBudgetFraction! * 100).toFixed(1)}% < 闸门阈值 ${(
          policy.blockBelowFraction * 100
        ).toFixed(0)}%,自动拦截非紧急发布`,
      );
    } else {
      reasons.push('预算水位满足发布条件,放行');
    }
  } else {
    // 紧急发布
    if (!input.reason || input.reason.trim().length < 5) {
      decision = 'block';
      reasons.push('紧急发布必须填写不少于 5 个字的理由,已拦截并要求补全');
    } else {
      reasons.push(`紧急发布,理由留痕:「${input.reason.trim()}」`);
      if (minBudgetFraction !== null && minBudgetFraction <= 0 && policy.exhaustedRequiresApproval) {
        reasons.push('⚠️ 预算已耗尽,按策略该紧急发布需二次审批(已记录,待审批人确认)');
      }
      if (belowThreshold) {
        reasons.push(
          `当前预算水位 ${(minBudgetFraction! * 100).toFixed(1)}% 低于阈值,紧急通道放行`,
        );
      }
    }
  }

  const info = db
    .prepare(
      `INSERT INTO release_requests
        (service_id, kind, version, requester, reason, decision, min_budget_fraction, gate_threshold, decided_at, ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.serviceId,
      input.kind,
      input.version,
      input.requester,
      input.reason?.trim() || null,
      decision,
      minBudgetFraction,
      policy.blockBelowFraction,
      at,
      input.ticket ?? null,
    );

  const row = one<ReleaseRow>(
    db.prepare('SELECT * FROM release_requests WHERE id = ?'),
    Number(info.lastInsertRowid),
  )!;

  return {
    decision,
    budgets,
    minBudgetFraction,
    threshold: policy.blockBelowFraction,
    reasons,
    request: rowToRequest(row),
  };
}

export function listReleases(db: DatabaseSync, serviceId?: string): ReleaseRequest[] {
  const stmt = serviceId
    ? db.prepare('SELECT * FROM release_requests WHERE service_id = ? ORDER BY decided_at DESC')
    : db.prepare('SELECT * FROM release_requests ORDER BY decided_at DESC');
  const data = serviceId
    ? rows<ReleaseRow>(stmt, serviceId)
    : rows<ReleaseRow>(stmt);
  return data.map(rowToRequest);
}

export { GATE_POLICY };
