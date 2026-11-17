import { api, fmtDateTime, fmtNum, fmtPct, statusBadge, budgetColor, esc } from '../lib/api.js';
import { barChart, budgetGauge, lineChart } from '../lib/charts.js';
import type { Meta, ServiceView, AlertView, SloView } from '../lib/types.js';

export async function renderOverview(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载总览…</div>';
  const [meta, services, alerts, slos] = await Promise.all([
    api<Meta>('/api/meta'),
    api<ServiceView[]>('/api/services'),
    api<AlertView[]>('/api/alerts?limit=300'),
    api<SloView[]>('/api/slos'),
  ]);

  const firing = alerts.filter((a) => a.state === 'firing');
  const criticalFiring = firing.filter((a) => a.severity === 'critical');
  const exhausted = slos.filter((s) => s.window.status === 'exhausted');
  const noData = slos.filter((s) => s.window.status === 'noData');
  const avgBudget =
    slos.reduce((sum, s) => sum + (Number.isFinite(s.budget.remainingFraction) ? s.budget.remainingFraction : 1), 0) /
    Math.max(1, slos.length);

  const tierCount = (t: string) => services.filter((s) => s.tier === t).length;

  // 预算水位最低的 8 个 SLO
  const worst = [...slos]
    .filter((s) => Number.isFinite(s.budget.remainingFraction))
    .sort((a, b) => a.budget.remainingFraction - b.budget.remainingFraction)
    .slice(0, 8);

  // 近 24h 告警按检测器统计
  const dayAgo = meta.currentAt - 86400000;
  const recent = alerts.filter((a) => a.firedAt >= dayAgo);
  const detCount = (d: string) => recent.filter((a) => a.detector === d).length;

  app.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:18px">
      <div class="card stat"><span class="label">服务 / SLO 总数</span>
        <span class="num">${meta.serviceCount}<span class="muted" style="font-size:16px"> / ${meta.sloCount}</span></span>
        <span class="mini">T1 ${tierCount('tier1')} · T2 ${tierCount('tier2')} · T3 ${tierCount('tier3')}</span></div>
      <div class="card stat"><span class="label">当前告警中</span>
        <span class="num" style="color:${criticalFiring.length ? 'var(--red)' : firing.length ? 'var(--yellow)' : 'var(--green)'}">${firing.length}</span>
        <span class="mini">严重 ${criticalFiring.length} · 近24h ${recent.length} 条</span></div>
      <div class="card stat"><span class="label">预算耗尽 SLO</span>
        <span class="num" style="color:${exhausted.length ? 'var(--red)' : 'var(--green)'}">${exhausted.length}</span>
        <span class="mini">无数据 ${noData.length} 个</span></div>
      <div class="card stat"><span class="label">平均预算剩余</span>
        <span class="num" style="color:${budgetColor(avgBudget)}">${fmtPct(avgBudget, 1)}</span>
        <span class="mini">数据区间 ${fmtDateTime(meta.rangeStart).slice(0, 10)} ~ ${fmtDateTime(meta.rangeEnd).slice(0, 10)}</span></div>
    </div>

    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card">
        <h2>🪫 错误预算水位最低的 SLO(Top 8)</h2>
        ${barChart(
          worst.map((s) => ({
            label: s.def.name.length > 16 ? s.def.name.slice(0, 16) + '…' : s.def.name,
            value: Math.max(0, s.budget.remainingFraction * 100),
            color: budgetColor(s.budget.remainingFraction),
            suffix: '%',
          })),
          { format: (v) => `${v.toFixed(1)}%` },
        )}
      </div>
      <div class="card">
        <h2>📊 近 24 小时告警量(按检测器)</h2>
        ${barChart(
          [
            { label: 'MWMB 多窗口燃烧率', value: detCount('mwmb'), color: 'var(--accent)' },
            { label: '固定阈值 5%(对照)', value: detCount('fixedThreshold'), color: 'var(--orange)' },
            { label: '数据缺口检测', value: detCount('gap'), color: 'var(--info)' },
          ],
          { format: (v) => `${v} 条` },
        )}
        <p class="mini" style="margin-top:14px;line-height:1.7">
          MWMB 要求短、长两个窗口燃烧率同时超阈值才告警,用更长的确认窗口换取低误报;<br/>
          固定阈值单桶超 5% 即报,反应快但夜间小流量噪声多。
        </p>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>🔥 最新告警</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>服务</th><th>检测器</th><th>级别</th><th>状态</th></tr></thead>
          <tbody>
            ${alerts.slice(0, 10).map((a) => `
              <tr>
                <td class="mono mini">${fmtDateTime(a.firedAt).slice(5)}</td>
                <td class="clickable" data-svc="${esc(a.serviceId)}">${esc(a.serviceId)}</td>
                <td><span class="badge ${a.detector === 'gap' ? 'info' : 'normal'}">${statusBadge(a.detector)}</span></td>
                <td><span class="badge ${a.severity}">${statusBadge(a.severity)}</span></td>
                <td><span class="badge ${a.state}">${statusBadge(a.state)}</span></td>
              </tr>`).join('')}
          </tbody></table></div>
      </div>
      <div class="card">
        <h2>🧭 平台健康度分布</h2>
        <div style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
          ${budgetGauge(avgBudget)}
          <div style="flex:1;min-width:200px">
            ${['healthy', 'burning', 'exhausted', 'noData'].map((st) => {
              const c = slos.filter((s) => s.window.status === st).length;
              return `<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
                <span><span class="badge ${st}">${statusBadge(st)}</span></span>
                <span class="mono">${c} 个 SLO</span></div>`;
            }).join('')}
          </div>
        </div>
        <p class="mini" style="margin-top:14px">
          总请求量(模拟半年):<span class="mono">${fmtNum(slos.reduce((a, s) => a + s.window.total, 0))}</span> 次
        </p>
      </div>
    </div>`;

  app.querySelectorAll<HTMLElement>('[data-svc]').forEach((el) => {
    el.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: el.dataset.svc } }));
    });
  });
}

// 供趋势图复用(避免未使用告警)
export const _chart = lineChart;
