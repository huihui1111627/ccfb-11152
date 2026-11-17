// 告警状态机:按时间回放桶序列,驱动 MWMB 规则,产出告警事件。
// 状态:OK -> FIRING(双窗口超阈值)-> OK(长窗口燃烧率 < 0.85*阈值,迟滞恢复)
// 关闭后 30 分钟冷却期内不重开,避免抖动刷屏。
// 缺口桶按 0 权重处理(不计入分子分母),维护窗口按时间比例缩放 —— 与 window.ts 语义一致。
import { DatabaseSync } from 'node:sqlite';
import { rows } from '../db/index.js';
import { BUCKET_SEC, BucketRow, MaintenanceRow, SloRow } from '../types.js';
import { COOLDOWN_SEC, RECOVERY_FACTOR, RULES, BurnRule, burnRateOf, ruleFires } from './alerting.js';
import { goodOf } from './window.js';

export interface AlertEvent {
  sloId: number;
  serviceId: number;
  severity: 'critical' | 'warning';
  rule: string;
  openedAt: number;
  resolvedAt: number | null;
  peakBurn: number;
}

interface RuleState {
  firing: boolean;
  openedAt: number;
  peakBurn: number;
  cooldownUntil: number;
}

export function replayAlerts(db: DatabaseSync, slo: SloRow, rules: BurnRule[] = RULES): AlertEvent[] {
  const buckets = rows<BucketRow>(
    db,
    `SELECT * FROM buckets WHERE service_id=? ORDER BY bucket_start`,
    slo.service_id,
  );
  if (buckets.length === 0) return [];
  const maint = rows<MaintenanceRow>(
    db,
    `SELECT * FROM maintenance WHERE service_id=? ORDER BY start_ts`,
    slo.service_id,
  );

  // 每桶的有效 bad/total(维护按比例剔除,缺口置 0)
  const n = buckets.length;
  const bad = new Float64Array(n);
  const tot = new Float64Array(n);
  const ts = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const b = buckets[i];
    ts[i] = b.bucket_start;
    if (b.gap) continue;
    let m = 0;
    for (const mw of maint) {
      const s = Math.max(b.bucket_start, mw.start_ts);
      const e = Math.min(b.bucket_start + BUCKET_SEC, mw.end_ts);
      if (e > s) m += (e - s) / BUCKET_SEC;
    }
    const w = 1 - Math.min(1, m);
    if (w <= 0) continue;
    const hist = JSON.parse(b.hist) as number[];
    const g = goodOf(slo, b.ok, hist);
    bad[i] = (b.total - g) * w;
    tot[i] = b.total * w;
  }
  // 前缀和,滑动窗口 O(1) 求和
  const preBad = new Float64Array(n + 1);
  const preTot = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    preBad[i + 1] = preBad[i] + bad[i];
    preTot[i + 1] = preTot[i] + tot[i];
  }
  const win = (end: number, len: number) => {
    const s = Math.max(0, end - len);
    return { bad: preBad[end] - preBad[s], total: preTot[end] - preTot[s] };
  };

  const allowed = 1 - slo.target;
  const states = new Map<BurnRule, RuleState>(
    rules.map((r) => [r, { firing: false, openedAt: 0, peakBurn: 0, cooldownUntil: 0 }]),
  );
  const events: AlertEvent[] = [];

  for (let i = 0; i < n; i++) {
    const now = ts[i] + BUCKET_SEC; // 桶结束时刻
    for (const rule of rules) {
      const st = states.get(rule)!;
      const long = win(i + 1, rule.longBuckets);
      const short = win(i + 1, rule.shortBuckets);
      const longBurn = burnRateOf(long, allowed);

      if (!st.firing) {
        if (now >= st.cooldownUntil && ruleFires(rule, long, short, allowed)) {
          st.firing = true;
          st.openedAt = now;
          st.peakBurn = longBurn;
        }
      } else {
        st.peakBurn = Math.max(st.peakBurn, longBurn);
        if (longBurn < rule.threshold * RECOVERY_FACTOR) {
          events.push({
            sloId: slo.id,
            serviceId: slo.service_id,
            severity: rule.severity,
            rule: rule.name,
            openedAt: st.openedAt,
            resolvedAt: now,
            peakBurn: st.peakBurn,
          });
          st.firing = false;
          st.cooldownUntil = now + COOLDOWN_SEC;
        }
      }
    }
  }
  // 回放结束仍在 firing 的告警保持打开
  const end = ts[n - 1] + BUCKET_SEC;
  for (const rule of rules) {
    const st = states.get(rule)!;
    if (st.firing) {
      events.push({
        sloId: slo.id,
        serviceId: slo.service_id,
        severity: rule.severity,
        rule: rule.name,
        openedAt: st.openedAt,
        resolvedAt: null,
        peakBurn: st.peakBurn,
      });
    }
  }
  return events.sort((a, b) => a.openedAt - b.openedAt);
}
