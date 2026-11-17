// 前端 API 封装与通用工具(原生 TS,无框架)

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const txt = await res.text();
  const data = txt ? JSON.parse(txt) : null;
  if (!res.ok) throw new Error(data?.error ?? `请求失败 ${res.status}`);
  return data as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

export function fmtDate(ts: number): string {
  return fmtDateTime(ts).slice(0, 10);
}

export function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  return Math.round(x).toLocaleString('zh-CN');
}

export function statusBadge(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康', burning: '燃烧中', exhausted: '预算耗尽', noData: '无数据',
    firing: '告警中', resolved: '已恢复', allow: '放行', block: '拦截',
    critical: '严重', warning: '警告', info: '提示',
    tier1: 'T1 核心', tier2: 'T2 重要', tier3: 'T3 一般',
    normal: '常规发布', emergency: '紧急发布',
    totalOutage: '突发全挂', gradualDegradation: '缓慢劣化',
    reportingGap: '上报中断', errorSpike: '错误尖峰',
    availability: '可用性', latency: '延迟',
    rolling28: '滚动28天', calendarMonth: '自然月',
    mwmb: 'MWMB 燃烧率', fixedThreshold: '固定阈值', gap: '缺口检测',
  };
  return map[status] ?? status;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function budgetColor(frac: number | null): string {
  if (frac === null || !Number.isFinite(frac)) return 'var(--muted)';
  if (frac <= 0) return 'var(--red)';
  if (frac < 0.25) return 'var(--red)';
  if (frac < 0.5) return 'var(--orange)';
  return 'var(--green)';
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, kind: 'success' | 'error' | 'info' = 'info'): void {
  const el = document.getElementById('toast')!;
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}

export function downloadCsv(sloId: string): void {
  window.open(`/api/slos/${encodeURIComponent(sloId)}/export`, '_blank');
}
