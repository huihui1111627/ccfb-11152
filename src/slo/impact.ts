import type { DatabaseSync } from 'node:sqlite';
import { SERVICES, buildSloDefs } from '../config/catalog.js';
import { rows } from '../db/index.js';
import type {
  DependencyEdge,
  DependencyNode,
  SloStatus,
} from '../shared/types.js';
import { buildDepGraph, getCallRatio, transitiveUpstream } from '../simulate/deps.js';
import { computeWindowResult } from './window.js';

export interface ImpactGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

interface ServiceRow {
  id: string;
  name: string;
  tier: DependencyNode['tier'];
  dependencies_json: string;
}

/**
 * 计算依赖影响图。
 * 判定规则:
 *  - 每个服务取其可用性 SLO 的当前窗口状态(healthy/burning/exhausted/noData)
 *  - 若某服务的(传递)上游存在 burning/exhausted,则标记 impactedByUpstream,
 *    并列出直接处于异常状态的上游来源
 *  - 边的 activeImpact:上游端点当前异常时置真
 */
export function computeImpactGraph(db: DatabaseSync, at: number): ImpactGraph {
  const graph = buildDepGraph();
  const slos = buildSloDefs();
  const availSloByService = new Map(slos.filter((s) => s.kind === 'availability').map((s) => [s.serviceId, s]));

  const statusByService = new Map<string, SloStatus>();
  for (const svc of SERVICES) {
    const slo = availSloByService.get(svc.id);
    statusByService.set(svc.id, slo ? computeWindowResult(db, slo, at).status : 'healthy');
  }

  const unhealthy = (id: string): boolean => {
    const st = statusByService.get(id);
    return st === 'burning' || st === 'exhausted';
  };

  const nodes: DependencyNode[] = SERVICES.map((svc) => {
    const upstreamAll = transitiveUpstream(graph, svc.id);
    const impactSources = upstreamAll.filter((u) => unhealthy(u));
    return {
      id: svc.id,
      name: svc.name,
      tier: svc.tier,
      status: statusByService.get(svc.id) ?? 'healthy',
      impactedByUpstream: impactSources.length > 0 && !unhealthy(svc.id),
      impactSources: impactSources.slice(0, 8),
    };
  });

  const svcRows = new Map(
    rows<ServiceRow>(db.prepare('SELECT id, name, tier, dependencies_json FROM services')).map(
      (r) => [r.id, r],
    ),
  );

  const edges: DependencyEdge[] = [];
  for (const svc of SERVICES) {
    const deps: string[] = JSON.parse(svcRows.get(svc.id)!.dependencies_json) as string[];
    for (const dep of deps) {
      edges.push({
        from: svc.id,
        to: dep,
        callRatio: getCallRatio(graph, svc.id, dep),
        activeImpact: unhealthy(dep),
      });
    }
  }

  return { nodes, edges };
}

/** 单服务的影响面:受它影响的所有下游(它故障时谁会被波及) */
export function impactBlastRadius(db: DatabaseSync, serviceId: string, at: number) {
  const graph = buildDepGraph();
  // 反向:谁(传递)依赖该服务
  const dependents: string[] = [];
  for (const svc of SERVICES) {
    if (svc.id === serviceId) continue;
    if (transitiveUpstream(graph, svc.id).includes(serviceId)) dependents.push(svc.id);
  }
  const statusByService = new Map<string, SloStatus>();
  const slos = buildSloDefs();
  for (const id of dependents) {
    const slo = slos.find((s) => s.serviceId === id && s.kind === 'availability');
    if (slo) statusByService.set(id, computeWindowResult(db, slo, at).status);
  }
  return dependents.map((id) => {
    const svc = SERVICES.find((s) => s.id === id)!;
    return {
      serviceId: id,
      name: svc.name,
      tier: svc.tier,
      status: statusByService.get(id) ?? 'healthy',
    };
  });
}
