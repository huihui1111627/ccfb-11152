import { api, esc, fmtNum, fmtPct, statusBadge, budgetColor } from '../lib/api.js';
import { budgetGauge } from '../lib/charts.js';
import type { SloView } from '../lib/types.js';

export async function renderSlos(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载 SLO 定义…</div>';
  const slos = await api<SloView[]>('/api/slos');

  const kindFilter = window.__sloFilter?.kw ?? '';
  const filtered = slos.filter(
    (s) =>
      !kindFilter ||
      s.def.kind === kindFilter ||
      s.def.serviceId.includes(kindFilter) ||
      s.def.name.includes(kindFilter),
  );

  app.innerHTML = `
    <div class="filters">
      <div><label>类型/关键字</label>
        <select id="f-kind">
          <option value="">全部 SLO</option>
          <option value="availability" ${kindFilter === 'availability' ? 'selected' : ''}>仅可用性</option>
          <option value="latency" ${kindFilter === 'latency' ? 'selected' : ''}>仅延迟</option>
        </select></div>
      <div class="mini" style="align-self:center">共 ${filtered.length} 个 SLO(好请求 / 总请求 口径)</div>
    </div>
    <div class="card">
      <p class="mini" style="margin-bottom:14px;line-height:1.7">
        SLO 统一用 <code class="inline">达标请求数 / 总请求数</code> 定义:可用性的达标请求 = 非错误请求;
        延迟的达标请求 = 延迟不超过阈值的请求(由直方图按分位数口径计算)。
        窗口支持 <b>滚动 28 天</b> 与 <b>自然月</b> 两种;上报缺口桶与计划内维护请求不计入分母。
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>SLO</th><th>服务</th><th>类型</th><th>目标</th><th>窗口</th><th>当前达标率</th><th>状态</th><th>预算剩余</th></tr></thead>
        <tbody>
          ${filtered.map((s) => `
            <tr>
              <td style="font-weight:600">${esc(s.def.name)}</td>
              <td class="mono mini clickable" data-svc="${esc(s.def.serviceId)}">${esc(s.def.serviceId)}</td>
              <td><span class="badge ${s.def.kind === 'availability' ? 'normal' : 'emergency'}">${statusBadge(s.def.kind)}</span>
                  ${s.def.thresholdMs ? `<div class="mini">≤ ${s.def.thresholdMs}ms</div>` : ''}</td>
              <td class="mono">${fmtPct(s.def.target, 2)}</td>
              <td class="mini">${statusBadge(s.def.windowType)}</td>
              <td class="mono">${s.window.ratio === null ? '无数据' : fmtPct(s.window.ratio, 3)}</td>
              <td><span class="badge ${s.window.status}">${statusBadge(s.window.status)}</span></td>
              <td>
                <div style="display:flex;align-items:center;gap:9px">
                  ${budgetGauge(s.budget.remainingFraction)}
                  <div><div class="bar" style="width:90px"><span style="width:${Math.max(0, s.budget.remainingFraction * 100)}%;background:${budgetColor(s.budget.remainingFraction)}"></span></div>
                  <div class="mini mono">${fmtNum(s.budget.remaining)}</div></div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody></table></div>
    </div>`;

  (document.getElementById('f-kind') as HTMLSelectElement).addEventListener('change', (e) => {
    window.__sloFilter = { ...(window.__sloFilter ?? {}), kw: (e.target as HTMLSelectElement).value };
    renderSlos(app);
  });
  app.querySelectorAll<HTMLElement>('[data-svc]').forEach((el) =>
    el.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: el.dataset.svc } })),
    ),
  );
}
