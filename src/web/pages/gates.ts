import { api, post, put, esc, fmtDateTime, fmtPct, statusBadge, toast } from '../lib/api.js';
import type { Meta, ReleaseView, ServiceView } from '../lib/types.js';

export async function renderGates(app: HTMLElement, presetService?: string): Promise<void> {
  app.innerHTML = '<div class="loading">加载发布闸门…</div>';
  const [services, releases, meta] = await Promise.all([
    api<ServiceView[]>('/api/services'),
    api<ReleaseView[]>('/api/releases'),
    api<Meta>('/api/meta'),
  ]);

  app.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h2>🚦 闸门策略</h2>
      <div class="grid cols-3">
        <div class="form-row"><label>非紧急发布拦截阈值(预算剩余占比低于该值)</label>
          <input id="gate-threshold" type="number" min="0" max="1" step="0.05" value="${meta.gatePolicy.blockBelowFraction}"/></div>
        <div class="form-row"><label>预算耗尽时紧急发布需二次审批</label>
          <select id="gate-approval">
            <option value="true" ${meta.gatePolicy.exhaustedRequiresApproval ? 'selected' : ''}>开启</option>
            <option value="false" ${!meta.gatePolicy.exhaustedRequiresApproval ? 'selected' : ''}>关闭</option>
          </select></div>
        <div class="form-row" style="align-self:end"><button class="btn" id="save-policy">保存策略</button></div>
      </div>
      <p class="mini">当服务任一 SLO 的错误预算剩余占比低于阈值时,常规发布自动拦截;紧急发布必须填写理由,系统完整留痕(谁、何时、为什么)。</p>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="flex-between"><h2>🚀 发起发布申请</h2></div>
      <div class="grid cols-3" style="margin-top:8px">
        <div class="form-row"><label>服务</label>
          <select id="rel-service">${services.map((s) =>
            `<option value="${esc(s.id)}" ${s.id === presetService ? 'selected' : ''}>${esc(s.name)} (${esc(s.id)})</option>`).join('')}</select></div>
        <div class="form-row"><label>发布类型</label>
          <select id="rel-kind"><option value="normal">常规发布</option><option value="emergency">紧急发布(填理由,留痕)</option></select></div>
        <div class="form-row"><label>版本号</label><input id="rel-version" placeholder="如 v2.4.1" value="v2.4.1"/></div>
        <div class="form-row"><label>申请人</label><input id="rel-requester" placeholder="工号/姓名" value="值班-张三"/></div>
        <div class="form-row"><label>关联工单(可选)</label><input id="rel-ticket" placeholder="如 OPS-1234"/></div>
        <div class="form-row" id="reason-wrap" style="display:none;grid-column:1/-1"><label>紧急发布理由(必填,不少于 5 字)</label>
          <textarea id="rel-reason" rows="2" placeholder="说明紧急原因、影响面与回滚方案"></textarea></div>
      </div>
      <button class="btn danger" id="submit-release">提交发布申请(经闸门判定)</button>
    </div>

    <div class="card"><h2>📋 发布记录(完整留痕)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>时间</th><th>服务</th><th>类型</th><th>版本</th><th>申请人</th><th>判定时预算</th><th>闸门阈值</th><th>决定</th><th>理由 / 工单</th></tr></thead>
        <tbody>
          ${releases.length === 0 ? '<tr><td colspan="9" class="empty">暂无发布记录</td></tr>' : releases.map((r) => `
            <tr>
              <td class="mono mini">${fmtDateTime(r.decidedAt)}</td>
              <td class="mono mini clickable" data-svc="${esc(r.serviceId)}">${esc(r.serviceId)}</td>
              <td><span class="badge ${r.kind}">${statusBadge(r.kind)}</span></td>
              <td class="mono">${esc(r.version)}</td>
              <td>${esc(r.requester)}</td>
              <td class="mono">${r.minBudgetFraction === null ? '—' : fmtPct(r.minBudgetFraction, 1)}</td>
              <td class="mono mini">${fmtPct(r.gateThreshold, 0)}</td>
              <td><span class="badge ${r.decision}">${statusBadge(r.decision)}</span></td>
              <td class="mini">${r.reason ? esc(r.reason) : '—'}${r.ticket ? ` <span class="muted">(${esc(r.ticket)})</span>` : ''}</td>
            </tr>`).join('')}
        </tbody></table></div></div>`;

  const kindSel = document.getElementById('rel-kind') as HTMLSelectElement;
  const reasonWrap = document.getElementById('reason-wrap')!;
  kindSel.addEventListener('change', () => {
    reasonWrap.style.display = kindSel.value === 'emergency' ? 'block' : 'none';
  });

  document.getElementById('save-policy')!.addEventListener('click', async () => {
    const blockBelowFraction = Number((document.getElementById('gate-threshold') as HTMLInputElement).value);
    const exhaustedRequiresApproval = (document.getElementById('gate-approval') as HTMLSelectElement).value === 'true';
    try {
      await put('/api/gate-policy', { blockBelowFraction, exhaustedRequiresApproval });
      toast('闸门策略已更新', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });

  document.getElementById('submit-release')!.addEventListener('click', async () => {
    const payload = {
      serviceId: (document.getElementById('rel-service') as HTMLSelectElement).value,
      kind: kindSel.value,
      version: (document.getElementById('rel-version') as HTMLInputElement).value,
      requester: (document.getElementById('rel-requester') as HTMLInputElement).value,
      ticket: (document.getElementById('rel-ticket') as HTMLInputElement).value || null,
      reason: (document.getElementById('rel-reason') as HTMLTextAreaElement).value || null,
    };
    try {
      const res = await post<{
        decision: 'allow' | 'block';
        reasons: string[];
        minBudgetFraction: number | null;
      }>('/api/releases', payload);
      toast(`${res.decision === 'allow' ? '✅ 放行' : '⛔ 拦截'}:${res.reasons.join(';')}`, res.decision === 'allow' ? 'success' : 'error');
      renderGates(app);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });

  app.querySelectorAll<HTMLElement>('[data-svc]').forEach((el) =>
    el.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'services', serviceId: el.dataset.svc } })),
    ),
  );
}
