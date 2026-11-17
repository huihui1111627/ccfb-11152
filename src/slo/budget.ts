// 错误预算:剩余量、燃烧率、耗尽预测。
// 关键设计:自然月预算在月初不平滑会跳变(上月可能已耗尽,本月 1 号瞬间回到 100%)。
// 这里对自然月做 28 天加权混合:consumed = w*本月至今 + (1-w)*上月终值,w = 已过天数/28,
// 保证跨月切换时预算连续;滚动 28 天窗口天然连续。
// budgetStatusFrom 与窗口来源解耦:DB(computeWindow)和内存前缀和(SloSeries)共用一套逻辑。
import { DatabaseSync } from 'node:sqlite';
import { computeWindow, WindowResult } from './window.js';
import { DAY_SEC, ROLLING_28D_SEC, SloRow } from '../types.js';

export interface BudgetStatus {
  sloId: number;
  windowStart: number;
  windowEnd: number;
  target: number;
  compliance: number | null;
  consumedFraction: number; // 已消耗预算比例(自然月为平滑后值),可 >1
  remainingFraction: number; // 1 - consumed,可为负
  burnRate1h: number;
  burnRate6h: number;
  burnRate24h: number;
  exhaustionInHours: number | null; // 按 6h 燃烧率预测多久耗尽;已耗尽为 0,几乎不消耗为 null
  insufficientData: boolean;
  coverage: number;
}

const BUDGET_PERIOD_HOURS = ROLLING_28D_SEC / 3600; // 672h,预算周期基准

export type WindowFn = (startSec: number, endSec: number) => WindowResult;

export function windowBounds(slo: SloRow, now: number): [number, number] {
  if (slo.window === 'rolling_28d') return [now - ROLLING_28D_SEC, now];
  const d = new Date(now * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  return [start, now];
}

function burnRate(win: WindowFn, slo: SloRow, now: number, windowSec: number): number {
  const w = win(now - windowSec, now);
  if (w.insufficientData || w.total <= 0) return 0;
  return (1 - w.good / w.total) / (1 - slo.target);
}

function prevMonthConsumed(win: WindowFn, slo: SloRow, now: number): number {
  const d = new Date(now * 1000);
  const thisStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const prevStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000;
  const w = win(prevStart, thisStart);
  if (w.insufficientData || w.total <= 0) return 0;
  return (w.total - w.good) / w.total / (1 - slo.target);
}

export function budgetStatusFrom(win: WindowFn, slo: SloRow, now: number): BudgetStatus {
  const [ws, we] = windowBounds(slo, now);
  const w = win(ws, we);
  const allowed = 1 - slo.target;

  let consumed = 0;
  if (!w.insufficientData && w.total > 0) {
    consumed = (w.total - w.good) / w.total / allowed;
  }

  if (slo.window === 'calendar_month') {
    const elapsedDays = (now - ws) / DAY_SEC;
    if (elapsedDays < 28) {
      const prev = prevMonthConsumed(win, slo, now);
      const weight = elapsedDays / 28;
      consumed = weight * consumed + (1 - weight) * prev;
    }
  }

  const remaining = 1 - consumed;
  const br1 = burnRate(win, slo, now, 3600);
  const br6 = burnRate(win, slo, now, 6 * 3600);
  // 预测用较近窗口的较大燃烧率:故障初期 6h 窗口被健康时段稀释,会严重低估
  const brForecast = Math.max(br1, br6);
  const exhaustion = remaining <= 0 ? 0 : brForecast > 0.01 ? (remaining * BUDGET_PERIOD_HOURS) / brForecast : null;

  return {
    sloId: slo.id,
    windowStart: ws,
    windowEnd: we,
    target: slo.target,
    compliance: w.compliance,
    consumedFraction: consumed,
    remainingFraction: remaining,
    burnRate1h: br1,
    burnRate6h: br6,
    burnRate24h: burnRate(win, slo, now, 24 * 3600),
    exhaustionInHours: exhaustion,
    insufficientData: w.insufficientData,
    coverage: w.coverage,
  };
}

export function budgetStatus(db: DatabaseSync, slo: SloRow, now: number): BudgetStatus {
  return budgetStatusFrom((s, e) => computeWindow(db, slo, s, e), slo, now);
}
