import { api, esc, fmtDateTime, statusBadge } from '../lib/api.js';
import type { AlertView } from '../lib/types.js';

export async function renderAlerts(app: HTMLElement): Promise<void> {
  app.innerHTML = '<div class="loading">加载告警事件…</div>';
  const all = await api<AlertView[]>('/api/alerts?limit=500');

  const f = window.__sloFilter ?? {};
  const detector = f.detector ?? '';
  const severity = f.severity ?? '';
  const filtered = all.filter(
    (a) => (!detector || a.detector === detector) && (!severity || a.severity === severity),
  );

  const firing = filtered.filter((a) => a.state === 'firing');

  app.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${['mwmb', 'fixedThreshold', 'gap'].map((d) => {
        const c = all.filter((a) => a.detector === d).length;
        const fire = all.filter((a) => a.detector === d && a.state === 'firing').length;
        return `<div class="card stat"><span class="label">${statusBadge(d)}</span>
          <span class="num">${c}</span><span class="mini">告警中 ${fire}</span></div>`;
      }).join('')}
      <div class="card stat"><span class="label">当前筛选结果</span><span class="num">${filtered.length}</span>
        <span class="mini">firing ${firing.length}</span></div>
    </div>

    <div class="filters">
      <div><label>检测器</label><select id="f-detector">
        <option value="">全部</option>
        <option value="mwmb" ${detector === 'mwmb' ? 'selected' : ''}>MWMB 多窗口燃烧率</option>
        <option value="fixedThreshold" ${detector === 'fixedThreshold' ? 'selected' : ''}>固定阈值(对照)</option>
        <option value="gap" ${detector === 'gap' ? 'selected' : ''}>数据缺口</option>
      </select></div>
      <div><label>级别</label><select id="f-severity">
        <option value="">全部</option>
        <option value="critical" ${severity === 'critical' ? 'selected' : ''}>严重</option>
        <option value="warning" ${severity === 'warning' ? 'selected' : ''}>警告</option>
        <option value="info" ${severity === 'info' ? 'selected' : ''}>提示</option>
      </select></div>
    </div>

    <div class="card">
      <p class="mini" style="margin-bottom:12px;line-height:1.7">
        MWMB 规则要求<b>短窗口与长窗口燃烧率同时超阈值</b>才触发,并带恢复迟滞与 30 分钟重报冷却抑制抖动;
        缺口检测只认连续无数据桶,不会把"没数据"误判成"真故障"。点击行查看完整上下文。
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>触发时间</th><th>恢复时间</th><th>服务 / SLO</th><th>检测器</th><th>规则</th><th>级别</th><th>状态</th><th>燃烧率(短/长)</th><th>信息</th></tr></thead>
        <tbody>
          ${filtered.map((a) => `
            <tr>
              <td class="mono mini">${fmtDateTime(a.firedAt)}</td>
              <td class="mono mini">${a.resolvedAt ? fmtDateTime(a.resolvedAt) : '—'}</td>
              <td class="clickable" data-svc="${esc(a.serviceId)}">${esc(a.serviceId)}<div class="mini mono">${esc(a.sloId)}</div></td>
              <td><span class="badge ${a.detector === 'gap' ? 'info' : a.detector === 'mwmb' ? 'normal' : 'tier3'}">${statusBadge(a.detector)}</span></td>
              <td class="mini mono">${esc(a.ruleId)}</td>
              <td><span class="badge ${a.severity}">${statusBadge(a.severity)}</span></td>
              <td><span class="badge ${a.state}">${statusBadge(a.state)}</span></td>
              <td class="mono mini">${a.shortBurnRate !== null ? `${a.shortBurnRate.toFixed(1)}x / ${a.longBurnRate?.toFixed(1) ?? '—'}x` : '—'}</td>
              <td class="mini" style="max-width:340px">${esc(a.message)}</td>
            </tr>`).join('')}
        </tbody></table></div>
      ${filtered.length === 0 ? '<div class="empty">无匹配告警</div>' : ''}
    </div>`;

  (document.getElementById('f-detector') as HTMLSelectElement).addEventListener('change', (e) => {
    window.__sloFilter = { ...(window.__sloFilter ?? {}), detector: (e.target as HTMLSelectElement).value };
    renderAlerts(app);
  });
  (document.getElementById('f-severity') as HTMLSelectElement).addEventListener('change', (e) => {
    window.__sloFilter = { ...(window.__sloFilter ?? {}), severity: (e.target as HTMLSelectElement).value };
    renderAlerts(app);
  });
  app.querySelectorAll<HTMLElement>('[data-svc]').forEach((el) =>
    el.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: el.dataset.svc } })),
    ),
  );
}
