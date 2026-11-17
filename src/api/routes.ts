import type { DatabaseSync } from 'node:sqlite';
import { buildSloDefs, SERVICES } from '../config/catalog.js';
import { getGatePolicy, getSimMeta, one, rows, setGatePolicy } from '../db/index.js';
import type {
  AlertEvent,
  GatePolicy,
  MaintenanceWindow,
  SloDef,
} from '../shared/types.js';
import { computeBudget, budgetTrend } from '../slo/budget.js';
import { computeWindowResult } from '../slo/window.js';
import { evaluateGate, listReleases } from '../slo/gate.js';
import { computeImpactGraph, impactBlastRadius } from '../slo/impact.js';
import { weeklyCompliance, exportWeeklyCsv } from '../slo/compliance.js';
import { getAlertProfile } from '../db/index.js';

interface ServiceRow {
  id: string;
  name: string;
  tier: string;
  owner: string;
  description: string;
  dependencies_json: string;
  base_traffic: number;
}

interface FaultRow {
  id: string;
  service_id: string;
  kind: string;
  start_ts: number;
  end_ts: number;
  magnitude: number;
  note: string;
}

interface AlertRow {
  id: number;
  slo_id: string;
  service_id: string;
  detector: AlertEvent['detector'];
  rule_id: string;
  severity: AlertEvent['severity'];
  state: AlertEvent['state'];
  fired_at: number;
  resolved_at: number | null;
  short_burn_rate: number | null;
  long_burn_rate: number | null;
  message: string;
}

function mapAlert(r: AlertRow): AlertEvent {
  return {
    id: r.id,
    sloId: r.slo_id,
    serviceId: r.service_id,
    detector: r.detector,
    ruleId: r.rule_id,
    severity: r.severity,
    state: r.state,
    firedAt: r.fired_at,
    resolvedAt: r.resolved_at,
    shortWindowHours: null,
    longWindowHours: null,
    shortBurnRate: r.short_burn_rate,
    longBurnRate: r.long_burn_rate,
    message: r.message,
  };
}

/** 取"当前时间":模拟数据终点(演示用,保证页面看到的是有数据的最新窗口) */
function currentAt(db: DatabaseSync): number {
  return Number(getSimMeta(db, 'rangeEnd'));
}

export interface ApiResponse {
  status: number;
  body: unknown;
  contentType?: string;
  raw?: string;
}

export async function handleApi(
  db: DatabaseSync,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: unknown,
): Promise<ApiResponse> {
  const at = Number(searchParams.get('at')) || currentAt(db);
  const slos = buildSloDefs();

  const json = (data: unknown, status = 200): ApiResponse => ({ status, body: data });

  // ---------- 元信息 ----------
  if (pathname === '/api/meta' && method === 'GET') {
    return json({
      rangeStart: Number(getSimMeta(db, 'rangeStart')),
      rangeEnd: Number(getSimMeta(db, 'rangeEnd')),
      generatedAt: Number(getSimMeta(db, 'generatedAt')),
      currentAt: at,
      serviceCount: SERVICES.length,
      sloCount: slos.length,
      gatePolicy: getGatePolicy(db),
    });
  }

  // ---------- 服务目录 ----------
  if (pathname === '/api/services' && method === 'GET') {
    const svcRows = rows<ServiceRow>(db.prepare('SELECT * FROM services ORDER BY tier, id'));
    const result = svcRows.map((r) => {
      const svcSlos = slos.filter((s) => s.serviceId === r.id);
      const budgets = svcSlos.map((s) => computeBudget(db, s, at));
      const minFrac = budgets.length ? Math.min(...budgets.map((b) => b.remainingFraction)) : null;
      const windowResults = svcSlos.map((s) => computeWindowResult(db, s, at));
      const worstStatus = windowResults
        .map((w) => w.status)
        .reduce((worst, st) => {
          const order = { healthy: 0, burning: 1, exhausted: 2, noData: 1 };
          return order[st] > order[worst] ? st : worst;
        }, 'healthy' as const);
      return {
        id: r.id,
        name: r.name,
        tier: r.tier,
        owner: r.owner,
        description: r.description,
        dependencies: JSON.parse(r.dependencies_json) as string[],
        baseTraffic: r.base_traffic,
        minBudgetFraction: minFrac,
        status: worstStatus,
        sloIds: svcSlos.map((s) => s.id),
      };
    });
    return json(result);
  }

  // ---------- 单服务详情(含 SLO、预算、故障、维护) ----------
  const svcMatch = pathname.match(/^\/api\/services\/([\w-]+)$/);
  if (svcMatch && method === 'GET') {
    const id = svcMatch[1]!;
    const svc = one<ServiceRow>(db.prepare('SELECT * FROM services WHERE id = ?'), id);
    if (!svc) return json({ error: '服务不存在' }, 404);
    const svcSlos = slos.filter((s) => s.serviceId === id);
    const sloDetail = svcSlos.map((slo) => {
      const window = computeWindowResult(db, slo, at);
      const budget = computeBudget(db, slo, at);
      const profile = getAlertProfile(db, slo.alertProfileId);
      return {
        def: slo,
        window,
        budget,
        profile: { id: profile.id, name: profile.name, rules: profile.rules },
      };
    });
    const faults = rows<FaultRow>(db.prepare('SELECT * FROM faults WHERE service_id = ? ORDER BY start_ts'), id);
    const maint = rows<MaintenanceWindow & Record<string, unknown>>(
      db.prepare('SELECT id, service_id, start_ts, end_ts, reason FROM maintenance_windows WHERE service_id = ? ORDER BY start_ts'),
      id,
    ).map((m) => ({
      id: m.id as number,
      serviceId: m.service_id as string,
      start: m.start_ts as number,
      end: m.end_ts as number,
      reason: m.reason as string,
    }));
    return json({
      service: {
        id: svc.id, name: svc.name, tier: svc.tier, owner: svc.owner,
        description: svc.description,
        dependencies: JSON.parse(svc.dependencies_json) as string[],
      },
      slos: sloDetail,
      faults: faults.map((f) => ({
        id: f.id, serviceId: f.service_id, kind: f.kind,
        start: f.start_ts, end: f.end_ts, magnitude: f.magnitude, note: f.note,
      })),
      maintenance: maint,
      blastRadius: impactBlastRadius(db, id, at),
    });
  }

  // ---------- SLO 列表 ----------
  if (pathname === '/api/slos' && method === 'GET') {
    const svcId = searchParams.get('serviceId');
    const list = (svcId ? slos.filter((s) => s.serviceId === svcId) : slos).map((slo: SloDef) => {
      const window = computeWindowResult(db, slo, at);
      const budget = computeBudget(db, slo, at);
      return { def: slo, window, budget };
    });
    return json(list);
  }

  // ---------- 单 SLO 预算趋势 ----------
  const trendMatch = pathname.match(/^\/api\/slos\/([\w-]+)\/trend$/);
  if (trendMatch && method === 'GET') {
    const slo = slos.find((s) => s.id === trendMatch[1]);
    if (!slo) return json({ error: 'SLO 不存在' }, 404);
    const points = Number(searchParams.get('points')) || 56;
    return json(budgetTrend(db, slo, at, points));
  }

  // ---------- 单 SLO 周报 ----------
  const weeklyMatch = pathname.match(/^\/api\/slos\/([\w-]+)\/weekly$/);
  if (weeklyMatch && method === 'GET') {
    const slo = slos.find((s) => s.id === weeklyMatch[1]);
    if (!slo) return json({ error: 'SLO 不存在' }, 404);
    const rangeStart = Number(getSimMeta(db, 'rangeStart'));
    const data = weeklyCompliance(db, slo, rangeStart, at);
    return json(data);
  }

  // ---------- 周报 CSV 导出 ----------
  const exportMatch = pathname.match(/^\/api\/slos\/([\w-]+)\/export$/);
  if (exportMatch && method === 'GET') {
    const slo = slos.find((s) => s.id === exportMatch[1]);
    if (!slo) return json({ error: 'SLO 不存在' }, 404);
    const rangeStart = Number(getSimMeta(db, 'rangeStart'));
    const data = weeklyCompliance(db, slo, rangeStart, at);
    const csv = exportWeeklyCsv(slo, data);
    return {
      status: 200,
      body: null,
      contentType: 'text/csv; charset=utf-8',
      raw: csv,
    };
  }

  // ---------- 错误预算总览 ----------
  if (pathname === '/api/budgets' && method === 'GET') {
    const data = slos.map((slo) => ({
      sloId: slo.id,
      serviceId: slo.serviceId,
      kind: slo.kind,
      name: slo.name,
      target: slo.target,
      budget: computeBudget(db, slo, at),
    }));
    return json(data);
  }

  // ---------- 告警事件 ----------
  if (pathname === '/api/alerts' && method === 'GET') {
    const detector = searchParams.get('detector');
    const serviceId = searchParams.get('serviceId');
    const state = searchParams.get('state');
    const limit = Math.min(500, Number(searchParams.get('limit')) || 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (detector) { where.push('detector = ?'); params.push(detector); }
    if (serviceId) { where.push('service_id = ?'); params.push(serviceId); }
    if (state) { where.push('state = ?'); params.push(state); }
    const sql = `SELECT * FROM alert_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY fired_at DESC LIMIT ?`;
    params.push(limit);
    const data = rows<AlertRow>(db.prepare(sql), ...params).map(mapAlert);
    return json(data);
  }

  // ---------- 依赖影响图 ----------
  if (pathname === '/api/graph' && method === 'GET') {
    return json(computeImpactGraph(db, at));
  }

  // ---------- 发布闸门:提交发布 ----------
  if (pathname === '/api/releases' && method === 'POST') {
    const b = (body ?? {}) as {
      serviceId?: string; kind?: 'normal' | 'emergency'; version?: string;
      requester?: string; reason?: string; ticket?: string;
    };
    if (!b.serviceId || !b.version || !b.requester || !b.kind) {
      return json({ error: 'serviceId、kind、version、requester 必填' }, 400);
    }
    if (!SERVICES.some((s) => s.id === b.serviceId)) return json({ error: '服务不存在' }, 404);
    const result = evaluateGate(
      db,
      {
        serviceId: b.serviceId,
        kind: b.kind,
        version: b.version,
        requester: b.requester,
        reason: b.reason ?? null,
        ticket: b.ticket ?? null,
      },
      at,
    );
    return json(result, 200);
  }

  // ---------- 发布记录 ----------
  if (pathname === '/api/releases' && method === 'GET') {
    return json(listReleases(db, searchParams.get('serviceId') ?? undefined));
  }

  // ---------- 闸门策略读写 ----------
  if (pathname === '/api/gate-policy' && method === 'GET') {
    return json(getGatePolicy(db));
  }
  if (pathname === '/api/gate-policy' && method === 'PUT') {
    const b = (body ?? {}) as Partial<GatePolicy>;
    const current = getGatePolicy(db);
    const next: GatePolicy = {
      blockBelowFraction:
        typeof b.blockBelowFraction === 'number' && b.blockBelowFraction >= 0 && b.blockBelowFraction <= 1
          ? b.blockBelowFraction
          : current.blockBelowFraction,
      exhaustedRequiresApproval:
        typeof b.exhaustedRequiresApproval === 'boolean'
          ? b.exhaustedRequiresApproval
          : current.exhaustedRequiresApproval,
    };
    setGatePolicy(db, next);
    return json(next);
  }

  // ---------- 评估报告 ----------
  if (pathname === '/api/evaluation' && method === 'GET') {
    const fs = await import('node:fs');
    try {
      const txt = fs.readFileSync('data/evaluation-report.json', 'utf8');
      return json(JSON.parse(txt));
    } catch {
      return json({ error: '评估报告未生成,请先运行 npm run evaluate' }, 404);
    }
  }

  // ---------- 故障真相(评估对照用) ----------
  if (pathname === '/api/faults' && method === 'GET') {
    const data = rows<FaultRow>(db.prepare('SELECT * FROM faults ORDER BY start_ts')).map((f) => ({
      id: f.id, serviceId: f.service_id, kind: f.kind,
      start: f.start_ts, end: f.end_ts, magnitude: f.magnitude, note: f.note,
    }));
    return json(data);
  }

  return json({ error: '未找到接口', path: pathname }, 404);
}
