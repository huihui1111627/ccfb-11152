import { api, esc, fmtDateTime, fmtNum, fmtPct, statusBadge, budgetColor } from '../lib/api.js';
import { budgetGauge } from '../lib/charts.js';
import type { SloView } from '../lib/types.js';

export async function renderBudgets(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载错误预算…</div>';
  const slos = await api<SloView[]>('/api/slos');

  const totalBudget = slos.reduce((a, s) => a + s.budget.budget, 0);
  const totalRemaining = slos.reduce((a, s) => a + Math.max(0, s.budget.remaining), 0);
  const exhausted = slos.filter((s) => s.budget.remainingFraction <= 0);
  const lowBudget = slos.filter((s) => s.budget.remainingFraction > 0 && s.budget.remainingFraction < 0.25);
  const soonBurnout = slos
    .filter((s) => s.budget.etaBurnout !== null && s.budget.etaBurnout - Date.now() < 7 * 86400000)
    .sort((a, b) => (a.budget.etaBurnout ?? 0) - (b.budget.etaBurnout ?? 0));

  app.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:18px">
      <div class="card stat"><span class="label">预算总额(错误额度)</span><span class="num">${fmtNum(totalBudget)}</span></div>
      <div class="card stat"><span class="label">剩余总额</span><span class="num" style="color:var(--green)">${fmtNum(totalRemaining)}</span></div>
      <div class="card stat"><span class="label">预算耗尽 SLO</span><span class="num" style="color:${exhausted.length ? 'var(--red)' : 'var(--green)'}">${exhausted.length}</span>
        <span class="mini">低于 25%:${lowBudget.length}</span></div>
      <div class="card stat"><span class="label">7 天内预测耗尽</span><span class="num" style="color:${soonBurnout.length ? 'var(--orange)' : 'var(--green)'}">${soonBurnout.length}</span></div>
    </div>

    ${soonBurnout.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--orange)">
      <h2>⏰ 即将耗尽(按近期燃烧速度线性外推)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>SLO</th><th>剩余预算</th><th>当前燃烧率</th><th>预计耗尽时间</th></tr></thead>
        <tbody>${soonBurnout.map((s) => `
          <tr><td>${esc(s.def.name)}</td>
          <td class="mono" style="color:${budgetColor(s.budget.remainingFraction)}">${fmtPct(s.budget.remainingFraction, 1)}</td>
          <td class="mono">${s.budget.burnRate?.toFixed(2) ?? '—'}x</td>
          <td class="mono" style="color:var(--orange)">${fmtDateTime(s.budget.etaBurnout1h ?? s.budget.etaBurnout)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}

    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>SLO</th><th>类型</th><th>预算额度</th><th>已消耗</th><th>剩余</th><th>剩余占比</th><th>燃烧率</th><th>1h 速度 ETA</th><th>24h 速度 ETA</th><th>维护排除</th></tr></thead>
      <tbody>
        ${slos.map((s) => {
          const b = s.budget;
          return `<tr>
            <td style="font-weight:600">${esc(s.def.name)}<div class="mini mono">${esc(s.def.serviceId)}</div></td>
            <td class="mini">${statusBadge(s.def.kind)}</td>
            <td class="mono">${fmtNum(b.budget)}</td>
            <td class="mono">${fmtNum(b.bad)}</td>
            <td class="mono" style="color:${budgetColor(b.remainingFraction)}">${fmtNum(b.remaining)}</td>
            <td><div style="display:flex;align-items:center;gap:8px">${budgetGauge(b.remainingFraction)}<span class="mono">${fmtPct(b.remainingFraction, 1)}</span></div></td>
            <td class="mono" style="color:${(b.burnRate ?? 0) > 1 ? 'var(--orange)' : 'var(--green)'}">${b.burnRate?.toFixed(2) ?? '—'}x</td>
            <td class="mono mini">${b.etaBurnout1h ? fmtDateTime(b.etaBurnout1h) : '—'}</td>
            <td class="mono mini">${b.etaBurnout ? fmtDateTime(b.etaBurnout) : '—'}</td>
            <td class="mono mini">${fmtNum(b.maintenanceExcluded)}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="mini" style="margin-top:12px">
        燃烧率 = 实际错误率 ÷ SLO 允许错误率(1 − 目标)。1x 表示恰好按预算速度消耗,&gt;1x 超速、&lt;1x 预算有结余。
        ETA 分别用近 1 小时、近 24 小时的错误产生速度外推;缺口与维护时段不参与速度计算。
      </p>
    </div>`;
}
