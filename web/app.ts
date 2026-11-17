// 前端 SPA:原生 TS + 手写 SVG,无依赖。hash 路由。
type Any = Record<string, any>;

const app = document.getElementById('app')!;
const fmtPct = (x: number | null, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
const fmtTs = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function api(path: string, opts?: RequestInit): Promise<Any> {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(data.error ?? `HTTP ${r.status}`);
  return { ...data, __status: r.status };
}

function pill(text: string, cls: string) {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}
function budgetPill(remaining: number | null, insufficient: boolean) {
  if (insufficient || remaining === null) return pill('数据不足', 'dim');
  const cls = remaining < 0 ? 'bad' : remaining < 0.2 ? 'warn' : 'ok';
  return pill(fmtPct(remaining, 1), cls);
}
function compliancePill(c: number | null, target: number) {
  if (c === null) return pill('—', 'dim');
  return pill(fmtPct(c, 3), c >= target ? 'ok' : 'bad');
}

// ---------- 页面 ----------
async function pageServices() {
  const { now, services } = await api('/api/overview');
  document.getElementById('now')!.textContent = `数据时间 ${fmtTs(now)} UTC`;
  app.innerHTML = `<h2>服务目录(${services.length})</h2>
  <table><tr><th>服务</th><th>层级</th><th>负责人</th><th>SLO 数</th><th>最差达标率</th><th>最差预算剩余</th><th>活跃告警</th><th>依赖影响</th></tr>
  ${services.map((s: Any) => `<tr>
    <td><a href="#/services/${s.id}">${esc(s.name)}</a></td>
    <td>${esc(s.tier)}</td><td>${esc(s.owner)}</td><td>${s.sloCount}</td>
    <td>${s.insufficient ? pill('数据不足', 'dim') : fmtPct(s.worstCompliance, 3)}</td>
    <td>${budgetPill(s.worstRemaining, s.insufficient)}</td>
    <td>${s.activeAlerts > 0 ? pill(String(s.activeAlerts), 'bad') : pill('0', 'ok')}</td>
    <td>${s.impacted ? pill('受上游影响', 'warn') : ''}</td>
  </tr>`).join('')}</table>`;
}

async function pageServiceDetail(id: string) {
  const s = await api(`/api/services/${id}`);
  app.innerHTML = `<h2>${esc(s.name)} <span class="muted">${esc(s.tier)} · ${esc(s.owner)}</span></h2>
  <h3>SLO 状态</h3>
  <table><tr><th>SLO</th><th>类型</th><th>目标</th><th>窗口</th><th>当前达标率</th><th>预算剩余</th><th>6h 燃烧率</th><th>预计耗尽</th></tr>
  ${s.slos.map((sl: Any) => `<tr>
    <td><a href="#/slos/${sl.id}">${esc(sl.name)}</a></td>
    <td>${sl.type === 'availability' ? '可用性' : `延迟 ≤${sl.latency_threshold_ms}ms`}</td>
    <td>${fmtPct(sl.target, 2)}</td>
    <td>${sl.window === 'rolling_28d' ? '滚动 28 天' : '自然月'}</td>
    <td>${compliancePill(sl.budget.compliance, sl.target)}</td>
    <td>${budgetPill(sl.budget.remainingFraction, sl.budget.insufficientData)}</td>
    <td>${sl.budget.burnRate6h.toFixed(2)}x</td>
    <td>${sl.budget.exhaustionInHours === null ? '—' : sl.budget.exhaustionInHours === 0 ? pill('已耗尽', 'bad') : sl.budget.exhaustionInHours < 72 ? pill(sl.budget.exhaustionInHours.toFixed(0) + 'h', 'warn') : sl.budget.exhaustionInHours.toFixed(0) + 'h'}</td>
  </tr>`).join('')}</table>
  ${s.impact.impacted ? `<div class="verdict bad">⚠ 当前恶化可能受上游影响(影响度 ${(s.impact.impactScore * 100).toFixed(0)}%):${s.impact.upstreams.filter((u: Any) => u.contribution > 0.1).map((u: Any) => esc(u.upstreamName)).join('、')}</div>` : ''}
  <div class="grid2">
    <div><h3>最近告警</h3><table><tr><th>级别</th><th>规则</th><th>开始</th><th>恢复</th></tr>
      ${s.alerts.map((a: Any) => `<tr><td>${pill(a.severity, a.severity === 'critical' ? 'bad' : 'warn')}</td><td>${esc(a.rule)}</td><td>${fmtTs(a.opened_at)}</td><td>${a.resolved_at ? fmtTs(a.resolved_at) : pill('进行中', 'bad')}</td></tr>`).join('') || '<tr><td colspan=4 class=muted>无</td></tr>'}</table></div>
    <div><h3>最近发布</h3><table><tr><th>版本</th><th>时间</th><th>结果</th></tr>
      ${s.releases.map((r: Any) => `<tr><td>${esc(r.version)}</td><td>${fmtTs(r.requested_at)}</td><td>${releasePill(r)}</td></tr>`).join('') || '<tr><td colspan=3 class=muted>无</td></tr>'}</table></div>
  </div>`;
}

function releasePill(r: Any) {
  if (r.status === 'approved') return pill('通过', 'ok');
  if (r.status === 'blocked') return pill('已拦截', 'bad');
  return pill('紧急放行', 'warn');
}

async function pageSlos() {
  const slos = await api('/api/slos');
  app.innerHTML = `<h2>SLO 定义(${slos.length})</h2>
  <table><tr><th>服务</th><th>SLO</th><th>类型</th><th>目标</th><th>窗口</th><th>达标率</th><th>预算剩余</th><th>周报</th></tr>
  ${slos.map((sl: Any) => `<tr>
    <td>${esc(sl.service_name)}</td>
    <td><a href="#/slos/${sl.id}">${esc(sl.name)}</a></td>
    <td>${sl.type === 'availability' ? '可用性' : `延迟 ≤${sl.latency_threshold_ms}ms`}</td>
    <td>${fmtPct(sl.target, 2)}</td>
    <td>${sl.window === 'rolling_28d' ? '滚动 28 天' : '自然月'}</td>
    <td>${compliancePill(sl.budget.compliance, sl.target)}</td>
    <td>${budgetPill(sl.budget.remainingFraction, sl.budget.insufficientData)}</td>
    <td><a href="/api/compliance/${sl.id}.csv">CSV</a></td>
  </tr>`).join('')}</table>`;
}

async function pageSloDetail(id: string) {
  const sl = await api(`/api/slos/${id}`);
  const series = await api(`/api/slos/${id}/series?days=7`);
  const b = sl.budget;
  app.innerHTML = `<h2>${esc(sl.name)} <span class="muted">${esc(sl.service_name)} · ${sl.window === 'rolling_28d' ? '滚动 28 天' : '自然月'}</span></h2>
  <div class="cards">
    <div class="card"><h4>当前达标率(目标 ${fmtPct(sl.target, 2)})</h4><div style="font-size:24px">${fmtPct(b.compliance, 3)}</div>
      <div class="muted">窗口覆盖率 ${fmtPct(b.coverage, 1)}${b.insufficientData ? ' · 数据不足' : ''}</div></div>
    <div class="card"><h4>错误预算剩余</h4><div style="font-size:24px">${fmtPct(b.remainingFraction, 1)}</div>
      <div class="bar"><div style="width:${Math.max(0, Math.min(100, b.remainingFraction * 100))}%;background:${b.remainingFraction < 0.2 ? 'var(--bad)' : 'var(--ok)'}"></div></div>
      <div class="muted">已消耗 ${fmtPct(b.consumedFraction, 1)}</div></div>
    <div class="card"><h4>燃烧率(1h / 6h / 24h)</h4><div style="font-size:24px">${b.burnRate1h.toFixed(2)}x / ${b.burnRate6h.toFixed(2)}x / ${b.burnRate24h.toFixed(2)}x</div>
      <div class="muted">预计耗尽:${b.exhaustionInHours === null ? '健康' : b.exhaustionInHours === 0 ? '已耗尽' : b.exhaustionInHours.toFixed(1) + ' 小时'}</div></div>
  </div>
  <h3>近 7 天燃烧率(6h 窗口)<a style="margin-left:16px;font-size:12px" href="/api/compliance/${sl.id}.csv">导出周报 CSV</a></h3>
  ${burnChart(series.points)}`;
}

function burnChart(points: { t: number; burn: number | null }[]): string {
  const W = 1100, H = 220, P = 30;
  const vals = points.map((p) => p.burn).filter((v): v is number => v !== null);
  const maxY = Math.max(3, ...vals) * 1.1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - (v / maxY) * (H - 2 * P);
  let d = '';
  let started = false;
  points.forEach((p, i) => {
    if (p.burn === null) { started = false; return; }
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.burn).toFixed(1)} `;
    started = true;
  });
  const alertPts = points.map((p, i) => (p.burn !== null && p.burn >= 6 ? `<circle cx="${x(i)}" cy="${y(p.burn)}" r="2.5" fill="var(--bad)"/>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--panel);border-radius:8px">
    <line x1="${P}" y1="${y(6)}" x2="${W - P}" y2="${y(6)}" stroke="var(--bad)" stroke-dasharray="4" opacity=".6"/>
    <text x="${P + 4}" y="${y(6) - 4}" fill="var(--bad)" font-size="10">critical 阈值 6x</text>
    <line x1="${P}" y1="${y(2)}" x2="${W - P}" y2="${y(2)}" stroke="var(--warn)" stroke-dasharray="4" opacity=".6"/>
    <text x="${P + 4}" y="${y(2) - 4}" fill="var(--warn)" font-size="10">warning 阈值 2x</text>
    <line x1="${P}" y1="${y(1)}" x2="${W - P}" y2="${y(1)}" stroke="var(--dim)" stroke-dasharray="2" opacity=".5"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${alertPts}
  </svg>`;
}

async function pageBudgets() {
  const slos = await api('/api/slos');
  app.innerHTML = `<h2>错误预算</h2><div class="cards">
  ${slos.map((sl: Any) => {
    const r = sl.budget.remainingFraction;
    return `<div class="card"><h4><a href="#/slos/${sl.id}">${esc(sl.name)}</a></h4>
    <div class="bar"><div style="width:${Math.max(0, Math.min(100, r * 100))}%;background:${r < 0 ? 'var(--bad)' : r < 0.2 ? 'var(--warn)' : 'var(--ok)'}"></div></div>
    <div>剩余 ${fmtPct(r, 1)} · 燃烧 ${sl.budget.burnRate6h.toFixed(2)}x</div>
    <div class="muted">${sl.budget.exhaustionInHours === null ? '按当前速度不会耗尽' : sl.budget.exhaustionInHours === 0 ? '预算已耗尽' : `预计 ${sl.budget.exhaustionInHours.toFixed(0)} 小时后耗尽`}</div></div>`;
  }).join('')}</div>`;
}

async function pageAlerts() {
  const alerts = await api('/api/alerts');
  const active = alerts.filter((a: Any) => !a.resolved_at);
  app.innerHTML = `<h2>告警(进行中 ${active.length} / 共 ${alerts.length})</h2>
  <table><tr><th>级别</th><th>服务</th><th>SLO</th><th>规则</th><th>开始</th><th>恢复</th><th>峰值燃烧率</th></tr>
  ${alerts.map((a: Any) => `<tr>
    <td>${pill(a.severity, a.severity === 'critical' ? 'bad' : 'warn')}</td>
    <td><a href="#/services/${a.service_id}">${esc(a.service_name)}</a></td>
    <td>${esc(a.slo_name)}</td><td>${esc(a.rule)}</td>
    <td>${fmtTs(a.opened_at)}</td><td>${a.resolved_at ? fmtTs(a.resolved_at) : pill('进行中', 'bad')}</td>
    <td>${a.peak_burn.toFixed(1)}x</td></tr>`).join('')}</table>`;
}

async function pageGate() {
  const [services, releases] = await Promise.all([api('/api/services'), api('/api/releases')]);
  app.innerHTML = `<h2>发布闸门</h2>
  <form class="gate" id="relForm">
    <label>服务<select name="service_id">${services.map((s: Any) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>版本<input name="version" value="v1.0.0" required /></label>
    <label>申请人<input name="decided_by" value="oncall" required /></label>
    <label>紧急发布<input type="checkbox" name="emergency" /></label>
    <label style="flex:1">紧急理由<input name="reason" placeholder="紧急发布必填,留痕" /></label>
    <button type="submit">申请发布</button>
  </form>
  <div id="verdict"></div>
  <h3>发布记录</h3>
  <table><tr><th>服务</th><th>版本</th><th>时间</th><th>结果</th><th>当时预算剩余</th><th>理由</th><th>操作人</th></tr>
  ${releases.map((r: Any) => `<tr><td>${esc(r.service_name)}</td><td>${esc(r.version)}</td><td>${fmtTs(r.requested_at)}</td>
    <td>${releasePill(r)}</td><td>${r.budget_remaining === null ? '—' : fmtPct(r.budget_remaining, 1)}</td>
    <td>${esc(r.reason)}</td><td>${esc(r.decided_by)}</td></tr>`).join('')}</table>`;

  document.getElementById('relForm')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const fd = new FormData(f);
    const payload = {
      service_id: Number(fd.get('service_id')),
      version: fd.get('version'),
      decided_by: fd.get('decided_by'),
      emergency: fd.get('emergency') === 'on',
      reason: fd.get('reason') ?? '',
    };
    const r = await api('/api/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const v = document.getElementById('verdict')!;
    if (r.status === 'blocked') v.innerHTML = `<div class="verdict bad">⛔ 已拦截:预算不足或存在 critical 告警。可勾选紧急发布并填写理由。</div>`;
    else if (r.status === 'emergency_approved') v.innerHTML = `<div class="verdict ok">⚠ 紧急放行,已留痕。</div>`;
    else v.innerHTML = `<div class="verdict ok">✅ 闸门通过。</div>`;
    setTimeout(() => pageGate(), 800);
  });
}

async function pageDeps() {
  const { nodes, edges } = await api('/api/dependencies');
  // 按拓扑深度分层布局
  const byId = new Map(nodes.map((n: Any) => [n.id, n]));
  const depth = new Map<number, number>();
  const ups = new Map<number, number[]>();
  edges.forEach((e: Any) => {
    const l = ups.get(e.service_id) ?? [];
    l.push(e.upstream_id);
    ups.set(e.service_id, l);
  });
  const depthOf = (id: number, seen: Set<number>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = (ups.get(id) ?? []).reduce((m, u) => Math.max(m, depthOf(u, seen) + 1), 0);
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n: Any) => depthOf(n.id, new Set()));
  const layers = new Map<number, Any[]>();
  nodes.forEach((n: Any) => {
    const d = depth.get(n.id)!;
    const l = layers.get(d) ?? [];
    l.push(n);
    layers.set(d, l);
  });
  const W = 1150, layerH = 150, nodeW = 150;
  const pos = new Map<number, { x: number; y: number }>();
  let maxLayer = Math.max(...layers.keys());
  layers.forEach((l, d) => {
    l.forEach((n, i) => pos.set(n.id, { x: 60 + i * (nodeW + 12), y: 40 + (maxLayer - d) * layerH }));
  });
  const H = 80 + (maxLayer + 1) * layerH;
  const edgeSvg = edges.map((e: Any) => {
    const a = pos.get(e.service_id)!, b = pos.get(e.upstream_id)!;
    return `<line x1="${a.x + nodeW / 2}" y1="${a.y}" x2="${b.x + nodeW / 2}" y2="${b.y + 34}" stroke="var(--border)" stroke-width="${1 + e.weight}"/>`;
  }).join('');
  const nodeSvg = nodes.map((n: Any) => {
    const p = pos.get(n.id)!;
    const color = n.impacted ? 'var(--warn)' : n.burn > 1 ? 'var(--bad)' : 'var(--ok)';
    return `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="34" rx="6" fill="var(--panel)" stroke="${color}" stroke-width="${n.impacted || n.burn > 1 ? 2 : 1}"/>
      <text x="${p.x + 8}" y="${p.y + 15}" font-size="11">${esc(n.name)}</text>
      <text x="${p.x + 8}" y="${p.y + 28}" font-size="9" fill="var(--dim)">burn ${n.burn.toFixed(1)}x${n.impacted ? ' · 受上游影响' : ''}</text></g>`;
  }).join('');
  app.innerHTML = `<h2>依赖关系图</h2>
  <p class="muted">边指向上游依赖,线宽表示依赖强度。红框 = 自身燃烧率超 1x;黄框 = 恶化主要来自上游传导。</p>
  <svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--bg)">${edgeSvg}${nodeSvg}</svg>`;
}

// ---------- 路由 ----------
const routes: [RegExp, (m: RegExpMatchArray) => Promise<void>][] = [
  [/^#\/services$/, () => pageServices()],
  [/^#\/services\/(\d+)$/, (m) => pageServiceDetail(m[1])],
  [/^#\/slos$/, () => pageSlos()],
  [/^#\/slos\/(\d+)$/, (m) => pageSloDetail(m[1])],
  [/^#\/budgets$/, () => pageBudgets()],
  [/^#\/alerts$/, () => pageAlerts()],
  [/^#\/gate$/, () => pageGate()],
  [/^#\/deps$/, () => pageDeps()],
];

async function route() {
  const hash = location.hash || '#/services';
  document.querySelectorAll('nav a').forEach((a) => {
    const href = a.getAttribute('href')!;
    a.classList.toggle('active', hash.startsWith(href) && href !== '#/services' || hash === href);
  });
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(m); } catch (e) { app.innerHTML = `<div class="verdict bad">${esc((e as Error).message)}</div>`; }
      return;
    }
  }
  location.hash = '#/services';
}
window.addEventListener('hashchange', route);
route();
