import { api, esc, fmtDateTime, fmtNum, fmtPct, statusBadge, budgetColor, toast, downloadCsv } from '../lib/api.js';
import { budgetGauge, lineChart } from '../lib/charts.js';
import type { Meta, ServiceView, SloView, AlertView, TrendPoint, WeeklyRow } from '../lib/types.js';

export async function renderServices(app: HTMLElement, serviceId?: string): Promise<void> {
  if (serviceId) return renderDetail(app, serviceId);
  app.innerHTML = '<div class="loading">加载服务目录…</div>';
  const services = await api<ServiceView[]>('/api/services');

  const tierFilter = window.__sloFilter?.tier ?? '';
  const kw = (window.__sloFilter?.kw ?? '').toLowerCase();
  const filtered = services.filter(
    (s) =>
      (!tierFilter || s.tier === tierFilter) &&
      (!kw || s.id.toLowerCase().includes(kw) || s.name.toLowerCase().includes(kw) || s.owner.includes(kw)),
  );

  app.innerHTML = `
    <div class="filters">
      <div><label>关键字</label><input id="f-kw" placeholder="服务名 / 团队" value="${esc(kw)}"/></div>
      <div><label>层级</label><select id="f-tier">
        <option value="">全部</option>
        <option value="tier1" ${tierFilter === 'tier1' ? 'selected' : ''}>T1 核心</option>
        <option value="tier2" ${tierFilter === 'tier2' ? 'selected' : ''}>T2 重要</option>
        <option value="tier3" ${tierFilter === 'tier3' ? 'selected' : ''}>T3 一般</option>
      </select></div>
      <div class="mini" style="align-self:center">共 ${filtered.length} 个服务</div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>服务</th><th>层级</th><th>负责团队</th><th>依赖下游</th><th>状态</th><th>最低预算剩余</th><th></th></tr></thead>
      <tbody>
        ${filtered.map((s) => `
          <tr>
            <td><div style="font-weight:600">${esc(s.name)}</div><div class="mini mono">${esc(s.id)}</div></td>
            <td><span class="badge ${s.tier}">${statusBadge(s.tier)}</span></td>
            <td>${esc(s.owner)}</td>
            <td class="mini">${s.dependencies.length} 个</td>
            <td><span class="badge ${s.status}">${statusBadge(s.status)}</span></td>
            <td style="min-width:130px">
              <div class="bar"><span style="width:${Math.max(0, (s.minBudgetFraction ?? 0) * 100)}%;background:${budgetColor(s.minBudgetFraction)}"></span></div>
              <div class="mini mono" style="color:${budgetColor(s.minBudgetFraction)}">${fmtPct(s.minBudgetFraction, 1)}</div>
            </td>
            <td><button class="btn secondary" data-detail="${esc(s.id)}">详情</button></td>
          </tr>`).join('')}
      </tbody></table></div></div>`;

  const kwInput = document.getElementById('f-kw') as HTMLInputElement;
  const tierSel = document.getElementById('f-tier') as HTMLSelectElement;
  const apply = () => {
    window.__sloFilter = { ...(window.__sloFilter ?? {}), kw: kwInput.value, tier: tierSel.value };
    renderServices(app);
  };
  kwInput.addEventListener('input', apply);
  tierSel.addEventListener('change', apply);
  app.querySelectorAll<HTMLElement>('[data-detail]').forEach((b) =>
    b.addEventListener('click', () => renderDetail(app, b.dataset.detail!)),
  );
}

async function renderDetail(app: HTMLElement, serviceId: string): Promise<void> {
  app.innerHTML = '<div class="loading">加载服务详情…</div>';
  const d = await api<{
    service: ServiceView;
    slos: Array<SloView & { profile: { id: string; name: string; rules: Array<{ id: string; severity: string; description: string; shortWindowHours: number; longWindowHours: number; shortBurnRate: number; longBurnRate: number }> } }>;
    faults: Array<{ id: string; kind: string; start: number; end: number; magnitude: number; note: string }>;
    maintenance: Array<{ id: number; start: number; end: number; reason: string }>;
    blastRadius: Array<{ serviceId: string; name: string; tier: string; status: string }>;
  }>(`/api/services/${encodeURIComponent(serviceId)}`);
  const meta = await api<Meta>('/api/meta');

  app.innerHTML = `
    <div class="detail-head">
      <div>
        <button class="back-btn" id="back">← 返回服务目录</button>
        <h2 style="margin-top:8px;font-size:20px">${esc(d.service.name)}
          <span class="badge ${d.service.tier}">${statusBadge(d.service.tier)}</span>
          <span class="mini mono">${esc(d.service.id)}</span></h2>
        <div class="mini" style="margin-top:4px">${esc(d.service.description)} · 负责团队:${esc(d.service.owner)}</div>
      </div>
      <button class="btn" id="go-release">发起发布</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2>🎯 SLO 与错误预算</h2>
      <div class="grid cols-2">
        ${d.slos.map((s, i) => sloCard(s, i)).join('')}
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card">
        <h2>🧨 注入故障(评估真相)</h2>
        ${d.faults.length ? `<div class="table-wrap"><table>
          <thead><tr><th>类型</th><th>开始</th><th>时长</th><th>说明</th></tr></thead>
          <tbody>${d.faults.map((f) => `
            <tr><td><span class="badge ${f.kind === 'reportingGap' ? 'info' : f.kind === 'totalOutage' ? 'critical' : 'warning'}">${statusBadge(f.kind)}</span></td>
            <td class="mono mini">${fmtDateTime(f.start).slice(5)}</td>
            <td class="mini">${Math.round((f.end - f.start) / 60000)} 分钟</td>
            <td class="mini">${esc(f.note)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">该服务无注入故障</div>'}
      </div>
      <div class="card">
        <h2>🛠️ 计划内维护窗口(已从预算排除)</h2>
        ${d.maintenance.length ? `<div class="table-wrap"><table>
          <thead><tr><th>开始</th><th>时长</th><th>原因</th></tr></thead>
          <tbody>${d.maintenance.map((m) => `
            <tr><td class="mono mini">${fmtDateTime(m.start).slice(5)}</td>
            <td class="mini">${Math.round((m.end - m.start) / 60000)} 分钟</td>
            <td class="mini">${esc(m.reason)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">无维护窗口</div>'}
      </div>
    </div>

    <div class="card">
      <h2>🕸️ 故障影响面(该服务故障会波及的下游)</h2>
      ${d.blastRadius.length ? `<div class="pill-list">${d.blastRadius.map((b) =>
        `<span class="badge ${b.status === 'healthy' ? 'healthy' : 'warning'}">${esc(b.name)} · ${statusBadge(b.tier)}</span>`,
      ).join('')}</div>` : '<div class="empty">无下游依赖(叶子/基础设施服务)</div>'}
    </div>`;

  document.getElementById('back')!.addEventListener('click', () => renderServices(app));
  document.getElementById('go-release')!.addEventListener('click', () =>
    window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'gates', serviceId } })),
  );

  // 趋势图与周报(异步加载,避免阻塞)
  d.slos.forEach((s, i) => {
    const mount = document.getElementById(`trend-${i}`);
    if (mount) {
      api<TrendPoint[]>(`/api/slos/${s.def.id}/trend?points=48`)
        .then((trend) => {
          mount.innerHTML = lineChart(
            [
              { name: '预算剩余占比', color: '#3b82f6', points: trend.map((t) => ({ ts: t.ts, v: t.remainingFraction })) },
            ],
            { yMin: Math.min(0, ...trend.map((t) => t.remainingFraction)), yMax: 1, yFormat: (v) => `${(v * 100).toFixed(0)}%`, threshold: meta.gatePolicy.blockBelowFraction },
          );
        })
        .catch(() => toast('趋势加载失败', 'error'));
    }
    const wkMount = document.getElementById(`weekly-${i}`);
    if (wkMount) {
      api<WeeklyRow[]>(`/api/slos/${s.def.id}/weekly`)
        .then((rows) => {
          wkMount.innerHTML = `<div class="table-wrap"><table>
            <thead><tr><th>周(UTC)</th><th>总请求</th><th>错误</th><th>缺口桶</th><th>达标率</th><th>目标</th><th>结果</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr><td class="mono mini">${fmtDateTime(r.weekStart).slice(0, 10)}</td>
              <td class="mono mini">${fmtNum(r.total)}</td>
              <td class="mono mini">${fmtNum(r.bad)}</td>
              <td class="mini">${r.gapBuckets}</td>
              <td class="mono mini">${r.ratio === null ? '无数据' : fmtPct(r.ratio, 3)}</td>
              <td class="mini">${fmtPct(r.target, 1)}</td>
              <td>${r.met === null ? '<span class="badge noData">无数据</span>' : r.met ? '<span class="badge healthy">达标</span>' : '<span class="badge critical">未达标</span>'}</td></tr>`).join('')}
            </tbody></table></div>
            <div style="margin-top:10px"><button class="btn secondary" data-export="${esc(s.def.id)}">⬇️ 导出周报 CSV</button></div>`;
          wkMount.querySelector('[data-export]')!.addEventListener('click', () => downloadCsv(s.def.id));
        })
        .catch(() => undefined);
    }
  });
}

function sloCard(s: SloView & { profile: { name: string; rules: unknown[] } }, i: number): string {
  const b = s.budget;
  const eta = b.etaBurnout1h ?? b.etaBurnout;
  return `<div class="card" style="background:var(--panel2)">
    <div class="flex-between">
      <h3 style="font-size:14px;color:var(--text)">${esc(s.def.name)}
        <span class="badge ${s.window.status}">${statusBadge(s.window.status)}</span></h3>
      ${budgetGauge(b.remainingFraction)}
    </div>
    <div class="kv" style="margin:12px 0">
      <span class="k">SLO 目标</span><span>${fmtPct(s.def.target, 2)}${s.def.thresholdMs ? ` · P95 ≤ ${s.def.thresholdMs}ms` : ''}</span>
      <span class="k">窗口</span><span>${statusBadge(s.def.windowType)}</span>
      <span class="k">当前达标率</span><span class="mono">${s.window.ratio === null ? '无数据' : fmtPct(s.window.ratio, 3)}</span>
      <span class="k">错误预算</span><span class="mono">${fmtNum(b.budget)} 次错误额度</span>
      <span class="k">已消耗 / 剩余</span><span class="mono">${fmtNum(b.bad)} / ${fmtNum(b.remaining)}</span>
      <span class="k">当前燃烧率</span><span class="mono" style="color:${(b.burnRate ?? 0) > 1 ? 'var(--orange)' : 'var(--green)'}">${b.burnRate === null ? '—' : b.burnRate.toFixed(2) + 'x'}</span>
      <span class="k">耗尽预测</span><span class="mono" style="color:${eta && eta < Date.now() + 7 * 86400000 ? 'var(--red)' : 'inherit'}">${eta ? fmtDateTime(eta) : '近期不会耗尽'}</span>
      <span class="k">维护排除</span><span class="mono mini">${fmtNum(b.maintenanceExcluded)} 请求 · 缺口 ${s.window.gapBuckets}/${s.window.expectedBuckets} 桶</span>
      <span class="k">告警策略</span><span class="mini">${esc(s.profile.name)} · ${s.profile.rules.length} 条燃烧率规则</span>
    </div>
    <div id="trend-${i}" style="margin-top:8px"></div>
    <details style="margin-top:10px"><summary class="clickable mini">查看逐周达标历史与导出</summary><div id="weekly-${i}" style="margin-top:10px"></div></details>
  </div>`;
}
