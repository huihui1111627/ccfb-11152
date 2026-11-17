import { api, esc, statusBadge } from '../lib/api.js';
import type { GraphView } from '../lib/types.js';

const STATUS_COLOR: Record<string, string> = {
  healthy: '#22c55e',
  burning: '#eab308',
  exhausted: '#ef4444',
  noData: '#06b6d4',
};

/** 按依赖层级做简单分层布局:无下游依赖的基础设施在底层 */
function layout(graph: GraphView): Map<string, { x: number; y: number; layer: number }> {
  const downstream = new Map<string, string[]>();
  graph.nodes.forEach((n) => downstream.set(n.id, []));
  graph.edges.forEach((e) => downstream.get(e.from)?.push(e.to));

  // 层级 = 最长下游链长度
  const layerOf = new Map<string, number>();
  const calc = (id: string, visiting: Set<string>): number => {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = downstream.get(id) ?? [];
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => calc(d, visiting) + 1));
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  graph.nodes.forEach((n) => calc(n.id, new Set()));

  const maxLayer = Math.max(...layerOf.values());
  const byLayer = new Map<number, string[]>();
  graph.nodes.forEach((n) => {
    // 翻转:接入层在顶部
    const layer = maxLayer - (layerOf.get(n.id) ?? 0);
    const list = byLayer.get(layer) ?? [];
    list.push(n.id);
    byLayer.set(layer, list);
  });

  const W = 1280;
  const layerHeight = 640 / (maxLayer + 1);
  const pos = new Map<string, { x: number; y: number; layer: number }>();
  byLayer.forEach((ids, layer) => {
    ids.sort();
    const step = W / (ids.length + 1);
    ids.forEach((id, i) => pos.set(id, { x: step * (i + 1), y: 40 + layer * layerHeight, layer }));
  });
  return pos;
}

export async function renderGraph(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载依赖图…</div>';
  const graph = await api<GraphView>('/api/graph');
  const pos = layout(graph);
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n]));

  const edgeSvg = graph.edges
    .map((e) => {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      return `<path class="graph-edge ${e.activeImpact ? 'impact' : ''}"
        d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}"
        data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`;
    })
    .join('');

  const nodeSvg = graph.nodes
    .map((n) => {
      const p = pos.get(n.id)!;
      const color = STATUS_COLOR[n.status] ?? '#8b98a5';
      const impact = n.impactedByUpstream;
      return `<g class="graph-node" data-id="${esc(n.id)}" transform="translate(${p.x - 62},${p.y - 16})">
        <rect width="124" height="34" rx="7" fill="var(--panel)" stroke="${impact ? '#ef4444' : color}" stroke-width="${impact ? 2.4 : 1.4}"/>
        <circle cx="10" cy="17" r="4" fill="${color}"/>
        <text x="20" y="15" font-size="10.5" font-weight="600">${esc(n.name.length > 9 ? n.name.slice(0, 9) + '…' : n.name)}</text>
        <text x="20" y="27" font-size="8.5" fill="var(--muted)">${esc(n.id.slice(0, 14))}${impact ? ' ⚠上游' : ''}</text>
      </g>`;
    })
    .join('');

  const impacted = graph.nodes.filter((n) => n.impactedByUpstream);
  const unhealthy = graph.nodes.filter((n) => n.status === 'burning' || n.status === 'exhausted');

  app.innerHTML = `
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card stat"><span class="label">图节点 / 边</span><span class="num">${graph.nodes.length} / ${graph.edges.length}</span></div>
      <div class="card stat"><span class="label">自身异常服务</span><span class="num" style="color:var(--red)">${unhealthy.length}</span></div>
      <div class="card stat"><span class="label">受上游影响(传导)</span><span class="num" style="color:var(--orange)">${impacted.length}</span></div>
    </div>
    <div class="card">
      <h2>🕸️ 服务依赖与故障传导图</h2>
      <div class="legend" style="margin-bottom:10px">
        <span><i style="background:#22c55e"></i>健康</span>
        <span><i style="background:#eab308"></i>燃烧中</span>
        <span><i style="background:#ef4444"></i>耗尽/故障</span>
        <span><i style="background:#06b6d4"></i>无数据</span>
        <span><i style="background:#ef4444"></i>红边=上游异常正在传导</span>
      </div>
      <svg id="graph-canvas" viewBox="0 0 1280 680" preserveAspectRatio="xMidYMid meet">
        ${edgeSvg}${nodeSvg}
      </svg>
      <div id="graph-detail" class="mini" style="margin-top:12px;min-height:40px">点击节点查看服务详情与影响来源</div>
    </div>`;

  const detail = document.getElementById('graph-detail')!;
  app.querySelectorAll<SVGGElement>('.graph-node').forEach((g) => {
    g.addEventListener('click', () => {
      const id = g.dataset.id!;
      const n = nameOf.get(id)!;
      detail.innerHTML = `<b>${esc(n.name)}</b> <span class="badge ${n.tier}">${statusBadge(n.tier)}</span>
        <span class="badge ${n.status}">${statusBadge(n.status)}</span>
        ${n.impactedByUpstream ? `<p style="margin-top:8px;color:var(--orange)">⚠️ 受上游影响,异常来源:${n.impactSources.map((s) => `<code class="inline">${esc(s)}</code>`).join(' ')}</p>` : '<p style="margin-top:8px" class="muted">当前无上游故障传导</p>'}
        <p style="margin-top:8px"><button class="btn secondary" id="graph-open">打开服务详情</button></p>`;
      document.getElementById('graph-open')!.addEventListener('click', () =>
        window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: id } })),
      );
    });
  });
}
