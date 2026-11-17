import { api, fmtDateTime, toast } from './lib/api.js';
import type { Meta } from './lib/types.js';
import { renderOverview } from './pages/overview.js';
import { renderServices } from './pages/services.js';
import { renderSlos } from './pages/slos.js';
import { renderBudgets } from './pages/budgets.js';
import { renderAlerts } from './pages/alerts.js';
import { renderGates } from './pages/gates.js';
import { renderGraph } from './pages/graph.js';
import { renderEvaluation } from './pages/evaluation.js';

type Tab = 'overview' | 'services' | 'slos' | 'budgets' | 'alerts' | 'gates' | 'graph' | 'evaluation';

const app = document.getElementById('app')!;
const tabs = document.getElementById('tabs')!;
let currentTab: Tab = 'overview';

const renderers: Record<Tab, (el: HTMLElement, arg?: string) => Promise<void>> = {
  overview: renderOverview,
  services: renderServices,
  slos: renderSlos,
  budgets: renderBudgets,
  alerts: renderAlerts,
  gates: renderGates,
  graph: renderGraph,
  evaluation: renderEvaluation,
};

async function navigate(tab: Tab, arg?: string): Promise<void> {
  currentTab = tab;
  tabs.querySelectorAll<HTMLElement>('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab),
  );
  try {
    await renderers[tab](app, arg);
  } catch (e) {
    app.innerHTML = `<div class="card empty">页面加载失败:${(e as Error).message}</div>`;
    toast((e as Error).message, 'error');
  }
}

tabs.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (btn?.dataset.tab) navigate(btn.dataset.tab as Tab);
});

// 页面间跳转事件
window.addEventListener('navigate', ((e: CustomEvent<{ tab: Tab; serviceId?: string }>) => {
  navigate(e.detail.tab, e.detail.serviceId);
}) as EventListener);

async function boot(): Promise<void> {
  try {
    const meta = await api<Meta>('/api/meta');
    document.getElementById('meta-line')!.textContent =
      `数据区间 ${fmtDateTime(meta.rangeStart).slice(0, 10)} ~ ${fmtDateTime(meta.rangeEnd).slice(0, 10)} · ` +
      `${meta.serviceCount} 个服务 · ${meta.sloCount} 个 SLO · 桶粒度 5 分钟 · UTC 时间`;
  } catch {
    document.getElementById('meta-line')!.textContent = '后端未连接,请先运行 npm run simulate && npm run evaluate';
  }
  await navigate('overview');
}

void boot();
