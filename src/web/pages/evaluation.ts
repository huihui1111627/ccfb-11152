import { api, esc, fmtDateTime, fmtPct, statusBadge } from '../lib/api.js';
import { barChart } from '../lib/charts.js';
import type { EvaluationView } from '../lib/types.js';

export async function renderEvaluation(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载评估报告…</div>';
  let report: EvaluationView;
  try {
    report = await api<EvaluationView>('/api/evaluation');
  } catch (e) {
    app.innerHTML = `<div class="card empty">${esc((e as Error).message)}<br/><br/>
      <code class="inline">npm run evaluate</code> 生成报告后刷新</div>`;
    return;
  }

  const detName: Record<string, string> = {
    mwmb: 'MWMB 多窗口燃烧率',
    fixedThreshold: '固定阈值 5%',
    gap: '数据缺口检测',
  };

  app.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h2>🧪 告警策略评估:MWMB vs 固定阈值</h2>
      <p class="mini" style="line-height:1.8">
        模拟区间 ${fmtDateTime(report.rangeStart).slice(0, 10)} ~ ${fmtDateTime(report.rangeEnd).slice(0, 10)},
        注入 <b>${report.totalFaults}</b> 个故障:突发全挂、缓慢劣化、上报中断、错误尖峰四类。
        用同一批数据回放两套检测器,对比<b>检测延迟、漏报、误报</b>。
        ${report.alertVolumeReductionPct !== null ? `<br/>MWMB 相对固定阈值告警量减少 <b style="color:var(--green)">${report.alertVolumeReductionPct}%</b>` : ''}
      </p>
    </div>

    <div class="grid cols-3" style="margin-bottom:16px">
      ${report.detectorSummaries.map((s) => `
        <div class="card">
          <h3 style="font-size:14px;color:var(--text)">${detName[s.detector] ?? s.detector}</h3>
          <div class="kv">
            <span class="k">告警总数</span><span class="mono">${s.alertsFired}</span>
            <span class="k">命中故障(TP)</span><span class="mono" style="color:var(--green)">${s.truePositiveAlerts}</span>
            <span class="k">误报(FP)</span><span class="mono" style="color:${s.falsePositiveAlerts ? 'var(--orange)' : 'var(--green)'}">${s.falsePositiveAlerts}</span>
            <span class="k">漏报故障</span><span class="mono" style="color:${s.faultsMissed ? 'var(--red)' : 'var(--green)'}">${s.faultsMissed}</span>
            <span class="k">平均检测延迟</span><span class="mono">${s.meanDetectDelayMinutes === null ? '—' : s.meanDetectDelayMinutes + ' 分钟'}</span>
            <span class="k">P90 检测延迟</span><span class="mono">${s.p90DetectDelayMinutes === null ? '—' : s.p90DetectDelayMinutes + ' 分钟'}</span>
            <span class="k">精确率</span><span class="mono">${s.precision === null ? '—' : fmtPct(s.precision, 1)}</span>
            <span class="k">召回率</span><span class="mono">${s.recall === null ? '—' : fmtPct(s.recall, 1)}</span>
          </div>
        </div>`).join('')}
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card"><h2>告警总量对比(越少越省心)</h2>
        ${barChart(
          report.detectorSummaries
            .filter((s) => s.detector !== 'gap')
            .map((s) => ({
              label: detName[s.detector] ?? s.detector,
              value: s.alertsFired,
              color: s.detector === 'mwmb' ? 'var(--accent)' : 'var(--orange)',
            })),
          { format: (v) => `${v} 条` },
        )}
      </div>
      <div class="card"><h2>平均检测延迟对比(分钟,越短越好)</h2>
        ${barChart(
          report.detectorSummaries
            .filter((s) => s.meanDetectDelayMinutes !== null)
            .map((s) => ({
              label: detName[s.detector] ?? s.detector,
              value: s.meanDetectDelayMinutes ?? 0,
              color: s.detector === 'mwmb' ? 'var(--accent)' : 'var(--orange)',
            })),
          { format: (v) => `${v} min` },
        )}
      </div>
    </div>

    <div class="card"><h2>🔍 逐故障检测明细</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>故障</th><th>服务</th><th>类型</th><th>开始时间</th><th>时长</th><th>MWMB 延迟</th><th>固定阈值延迟</th><th>缺口检测</th><th>结论</th></tr></thead>
        <tbody>
          ${report.perFault.map((p) => {
            const mwmb = p.matches.find((m) => m.detector === 'mwmb');
            const fixed = p.matches.find((m) => m.detector === 'fixedThreshold');
            const gap = p.matches.find((m) => m.detector === 'gap');
            const fmt = (m?: { detectDelayMinutes: number }) =>
              !m ? '—' : m.detectDelayMinutes <= 0 ? `${m.detectDelayMinutes} min(即时)` : `${m.detectDelayMinutes} min`;
            return `<tr>
              <td class="mono">${esc(p.fault.faultId)}</td>
              <td class="mono mini clickable" data-svc="${esc(p.fault.serviceId)}">${esc(p.fault.serviceId)}</td>
              <td><span class="badge ${p.fault.kind === 'reportingGap' ? 'info' : p.fault.kind === 'totalOutage' ? 'critical' : 'warning'}">${statusBadge(p.fault.kind)}</span></td>
              <td class="mono mini">${fmtDateTime(p.fault.start).slice(5)}</td>
              <td class="mini">${Math.round((p.fault.end - p.fault.start) / 60000)} min</td>
              <td class="mono mini">${fmt(mwmb)}</td>
              <td class="mono mini">${fmt(fixed)}</td>
              <td class="mono mini">${fmt(gap)}</td>
              <td>${p.fault.kind === 'reportingGap'
                ? (gap ? '<span class="badge healthy">缺口已识别</span>' : '<span class="badge critical">漏报</span>')
                : p.missed ? '<span class="badge critical">漏报</span>' : '<span class="badge healthy">已检出</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody></table></div>
      <p class="mini" style="margin-top:12px;line-height:1.8">
        <b>解读:</b>突发全挂两类检测器都能秒级发现;缓慢劣化时 MWMB 靠长窗口燃烧率能在恶化早期(几小时内)识别,
        而固定阈值要等单桶错误率真正越过 5% 才报,常延迟十几到几十小时;上报中断只触发缺口检测,
        不会污染 SLO 分母或产生虚假故障告警;短错误尖峰上 MWMB 的双窗口确认机制显著压低误报。
      </p>
    </div>`;

  app.querySelectorAll<HTMLElement>('[data-svc]').forEach((el) =>
    el.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: el.dataset.svc } })),
    ),
  );
}
