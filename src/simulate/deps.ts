import { CALL_RATIOS, SERVICES } from '../config/catalog.js';
import type { ServiceDef } from '../shared/types.js';

export interface DepGraph {
  /** 拓扑序:被依赖的基础设施排在前面 */
  topoOrder: string[];
  /** 直接下游 id */
  downstreamOf: Map<string, string[]>;
  /** 直接上游 id */
  upstreamOf: Map<string, string[]>;
  /** (caller, callee) -> 调用占比 */
  callRatio: Map<string, number>;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function buildDepGraph(): DepGraph {
  const downstreamOf = new Map<string, string[]>();
  const upstreamOf = new Map<string, string[]>();
  const callRatio = new Map<string, number>();

  for (const svc of SERVICES) {
    downstreamOf.set(svc.id, [...svc.dependencies]);
    if (!upstreamOf.has(svc.id)) upstreamOf.set(svc.id, []);
    for (const dep of svc.dependencies) {
      const list = upstreamOf.get(dep) ?? [];
      list.push(svc.id);
      upstreamOf.set(dep, list);
      const ratio = CALL_RATIOS[svc.id]?.[dep] ?? 0.5;
      callRatio.set(edgeKey(svc.id, dep), ratio);
    }
  }

  // Kahn 拓扑:入度 = 该服务依赖的下游数量;先输出无依赖的基础设施
  const indegree = new Map<string, number>();
  for (const svc of SERVICES) indegree.set(svc.id, svc.dependencies.length);
  const queue = SERVICES.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const upstream of upstreamOf.get(id) ?? []) {
      const d = (indegree.get(upstream) ?? 1) - 1;
      indegree.set(upstream, d);
      if (d === 0) queue.push(upstream);
    }
  }
  if (topoOrder.length !== SERVICES.length) {
    throw new Error('依赖图存在环,拓扑排序失败');
  }

  return { topoOrder, downstreamOf, upstreamOf, callRatio };
}

export function getCallRatio(graph: DepGraph, from: string, to: string): number {
  return graph.callRatio.get(edgeKey(from, to)) ?? 0.5;
}

/** 全部(传递)上游服务 id —— 用于依赖影响分析 */
export function transitiveUpstream(graph: DepGraph, serviceId: string): string[] {
  const seen = new Set<string>();
  const stack = [...(graph.downstreamOf.get(serviceId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.downstreamOf.get(id) ?? []));
  }
  return [...seen];
}

export function serviceById(id: string): ServiceDef {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`未知服务: ${id}`);
  return s;
}
