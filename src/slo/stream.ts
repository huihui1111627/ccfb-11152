import type { DatabaseSync } from 'node:sqlite';
import { ALERT_PROFILES } from '../config/catalog.js';
import type {
  AlertEvent,
  AlertProfile,
  SloDef,
} from '../shared/types.js';
import { BUCKET_MS } from '../shared/types.js';
import { one, rows } from '../db/index.js';
import {
  DEFAULT_FIXED_THRESHOLD,
  alertKey,
  describeSlo,
  evaluateBurnRule,
  evaluateFixedThreshold,
  evaluateGap,
  hoursToBuckets,
  type FixedThresholdState,
  type WindowInput,
} from './alerting.js';
import { countBelow, decodeHist } from './histogram.js';

interface BucketData {
  ts: number;
  total: number;
  good: number;
  /** 延迟 SLO 视角的 good(延迟达标),按 SLO 分别算 */
  latencyGoodBySlo: Map<string, number>;
  reported: boolean;
}

interface RollingWindow {
  capacity: number;
  total: number;
  good: number;
  gapBuckets: number;
  /** 环形缓冲,元素 null 表示缺口桶 */
  ring: Array<{ total: number; good: number } | null>;
  head: number;
  size: number;
}

function makeWindow(capacity: number): RollingWindow {
  return { capacity, total: 0, good: 0, gapBuckets: 0, ring: new Array(capacity).fill(null), head: 0, size: 0 };
}

function pushWindow(w: RollingWindow, bucket: { total: number; good: number } | null): void {
  const slot = w.ring[w.head];
  if (slot) {
    w.total -= slot.total;
    w.good -= slot.good;
  } else if (w.size >= w.capacity) {
    w.gapBuckets -= 1;
  }
  if (bucket) {
    w.total += bucket.total;
    w.good += bucket.good;
    w.ring[w.head] = { ...bucket };
  } else {
    if (w.size >= w.capacity) {
      // 覆盖的是缺口桶,上面已减
    } else {
      w.gapBuckets += 1;
    }
    w.ring[w.head] = null;
  }
  w.head = (w.head + 1) % w.capacity;
  w.size = Math.min(w.capacity, w.size + 1);
}

function windowInput(w: RollingWindow): WindowInput {
  return {
    total: w.total,
    good: w.good,
    gapBuckets: w.gapBuckets,
    expectedBuckets: w.capacity,
    full: w.size >= w.capacity,
  };
}

interface ActiveAlert {
  rowId: number;
  key: string;
}

export interface ReplayResult {
  events: AlertEvent[];
  evaluationTicks: number;
}

/**
 * 全量回放:按时间桶顺序重放全部数据,驱动 MWMB 与固定阈值两套检测器,
 * 告警生命周期写入 alert_events(先清空 detector 相关旧数据)。
 */
export function replayAlerts(db: DatabaseSync, slos: SloDef[], rangeStart: number, rangeEnd: number): ReplayResult {
  db.exec(`DELETE FROM alert_events;
           DELETE FROM sqlite_sequence WHERE name='alert_events';`);

  const profileMap = new Map<string, AlertProfile>(ALERT_PROFILES.map((p) => [p.id, p]));
  const sloByService = new Map<string, SloDef[]>();
  for (const slo of slos) {
    const list = sloByService.get(slo.serviceId) ?? [];
    list.push(slo);
    sloByService.set(slo.serviceId, list);
  }

  // 每个 SLO 一组滚动窗口(按 profile 中出现的窗口长度去重)
  const windows = new Map<string, Map<number, RollingWindow>>();
  const fixedStates = new Map<string, FixedThresholdState>();
  const activeAlerts = new Map<string, ActiveAlert>();
  const gapFiring = new Set<string>();
  /** 规则状态机:firing + 恢复迟滞 + 重报冷却,抑制阈值边界 flapping */
  const ruleStates = new Map<
    string,
    { firing: boolean; belowSince: number | null; lastFiredAt: number | null }
  >();

  /** 恢复迟滞系数:燃烧率回落到阈值 *0.85 以下才允许恢复 */
  const RECOVER_HYSTERESIS = 0.85;
  /** 同一规则恢复后再次触发的最小间隔(毫秒) */
  const REALERT_COOLDOWN = 30 * 60 * 1000;

  for (const slo of slos) {
    const profile = profileMap.get(slo.alertProfileId)!;
    const capacities = new Set<number>();
    for (const rule of profile.rules) {
      capacities.add(hoursToBuckets(rule.shortWindowHours));
      capacities.add(hoursToBuckets(rule.longWindowHours));
    }
    const map = new Map<number, RollingWindow>();
    for (const c of capacities) map.set(c, makeWindow(c));
    windows.set(slo.id, map);
    fixedStates.set(slo.id, { firing: false, recoverCount: 0 });
  }

  const insertEvent = db.prepare(`
    INSERT INTO alert_events
      (slo_id, service_id, detector, rule_id, severity, state, fired_at, resolved_at,
       short_window_hours, long_window_hours, short_burn_rate, long_burn_rate, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const resolveStmt = db.prepare('UPDATE alert_events SET state = ?, resolved_at = ? WHERE id = ?');

  const events: AlertEvent[] = [];
  let lastId = 0;

  function fire(
    slo: SloDef,
    detector: AlertEvent['detector'],
    ruleId: string,
    severity: AlertEvent['severity'],
    ts: number,
    message: string,
    extra?: {
      shortHours?: number | null;
      longHours?: number | null;
      shortBurn?: number | null;
      longBurn?: number | null;
    },
  ): void {
    const info = insertEvent.run(
      slo.id, slo.serviceId, detector, ruleId, severity, 'firing', ts, null,
      extra?.shortHours ?? null, extra?.longHours ?? null,
      extra?.shortBurn ?? null, extra?.longBurn ?? null, message,
    );
    lastId = Number(info.lastInsertRowid);
    const evt: AlertEvent = {
      id: lastId, sloId: slo.id, serviceId: slo.serviceId, detector, ruleId, severity,
      state: 'firing', firedAt: ts, resolvedAt: null,
      shortWindowHours: extra?.shortHours ?? null,
      longWindowHours: extra?.longHours ?? null,
      shortBurnRate: extra?.shortBurn ?? null,
      longBurnRate: extra?.longBurn ?? null,
      message,
    };
    events.push(evt);
    activeAlerts.set(alertKey(evt), { rowId: lastId, key: alertKey(evt) });
  }

  function resolve(key: string, ts: number): void {
    const active = activeAlerts.get(key);
    if (!active) return;
    resolveStmt.run('resolved', ts, active.rowId);
    const evt = events.find((e) => e.id === active.rowId);
    if (evt) {
      evt.state = 'resolved';
      evt.resolvedAt = ts;
    }
    activeAlerts.delete(key);
  }

  const bucketRows = rows<{
    bucket_ts: number; service_id: string; total: number; good: number; reported: number;
  }>(
    db
      .prepare(
        `SELECT bucket_ts, service_id, total, good, reported
       FROM metric_buckets
       WHERE bucket_ts >= ? AND bucket_ts < ?
       ORDER BY bucket_ts, service_id`,
      ),
    rangeStart, rangeEnd,
  );

  const histStmt = db.prepare(
    'SELECT hist FROM latency_hist WHERE service_id = ? AND bucket_ts = ?',
  );

  // 按桶分组重放
  let currentTs = -1;
  let bucketByService = new Map<string, BucketData>();
  let ticks = 0;

  const evaluateTick = (ts: number, bucketMap: Map<string, BucketData>): void => {
    ticks += 1;
    for (const slo of slos) {
      const profile = profileMap.get(slo.alertProfileId)!;
      const data = bucketMap.get(slo.serviceId);
      if (!data) continue;

      // 该 SLO 视角的 good / total
      let sloTotal = data.total;
      let sloGood = data.good;
      if (slo.kind === 'latency' && data.reported) {
        const hrow = one<{ hist: Buffer }>(histStmt, slo.serviceId, ts);
        if (hrow && data.good > 0) {
          // 延迟 SLO 口径:分母用成功请求数,达标率取直方图的延迟达标比例
          const hist = decodeHist(hrow.hist);
          const histTotal = hist.reduce((a, b) => a + b, 0);
          const qualifiedRatio =
            histTotal > 0
              ? countBelow(hist, slo.thresholdMs ?? Number.POSITIVE_INFINITY) / histTotal
              : 0;
          sloTotal = data.good;
          sloGood = Math.round(data.good * qualifiedRatio);
        }
      }
      const bucketForSlo = data.reported
        ? { total: sloTotal, good: sloGood }
        : null;

      const map = windows.get(slo.id)!;
      for (const w of map.values()) pushWindow(w, bucketForSlo);

      // ---- MWMB 燃烧率规则(迟滞 + 冷却状态机) ----
      for (const rule of profile.rules) {
        const shortW = map.get(hoursToBuckets(rule.shortWindowHours))!;
        const longW = map.get(hoursToBuckets(rule.longWindowHours))!;
        const verdict = evaluateBurnRule(
          rule, slo.target, windowInput(shortW), windowInput(longW), profile.minRequests,
        );
        const key = alertKey({ detector: 'mwmb', ruleId: rule.id, sloId: slo.id });
        const state = ruleStates.get(key) ?? { firing: false, belowSince: null, lastFiredAt: null };
        ruleStates.set(key, state);

        // 双窗口均回落到阈值 * 迟滞系数以下,视为真正恢复
        const cooledDown =
          verdict.shortBurnRate !== null &&
          verdict.longBurnRate !== null &&
          verdict.shortBurnRate < rule.shortBurnRate * RECOVER_HYSTERESIS &&
          verdict.longBurnRate < rule.longBurnRate * RECOVER_HYSTERESIS;

        if (state.firing) {
          if (cooledDown) {
            state.firing = false;
            state.belowSince = ts;
            resolve(key, ts);
          }
          // 否则保持告警,不重复插入
        } else if (verdict.firing) {
          const cooled =
            state.lastFiredAt === null || ts - state.lastFiredAt >= REALERT_COOLDOWN;
          if (cooled) {
            state.firing = true;
            state.lastFiredAt = ts;
            state.belowSince = null;
            fire(
              slo, 'mwmb', rule.id, rule.severity, ts,
              `[MWMB·${rule.severity}] ${describeSlo(slo)}:${verdict.reason}`,
              {
                shortHours: rule.shortWindowHours, longHours: rule.longWindowHours,
                shortBurn: verdict.shortBurnRate, longBurn: verdict.longBurnRate,
              },
            );
          }
        }
      }

      // ---- 缺口检测 ----
      // 用最长窗口的 ring 从最新位置还原近期 reported 序列
      const longest = [...map.values()].reduce((a, b) => (a.capacity > b.capacity ? a : b));
      const reportedSeq: number[] = [];
      for (let i = 0; i < Math.min(longest.size, profile.gapAlertBuckets + 2); i++) {
        const idx = (longest.head - 1 - i + longest.capacity) % longest.capacity;
        reportedSeq.push(longest.ring[idx] === null ? 0 : 1);
      }
      const gapVerdict = evaluateGap(profile, [...reportedSeq].reverse());
      const gapKey = alertKey({ detector: 'gap', ruleId: 'data-gap', sloId: slo.id });
      if (gapVerdict.firing && !gapFiring.has(gapKey)) {
        gapFiring.add(gapKey);
        fire(
          slo, 'gap', 'data-gap', 'info', ts,
          `[数据缺口] ${describeSlo(slo)}:连续 ${gapVerdict.consecutiveGapBuckets} 个桶(${
            (gapVerdict.consecutiveGapBuckets * BUCKET_MS) / 60000
          } 分钟)无指标上报,与真实故障区分处理`,
        );
      } else if (!gapVerdict.firing && gapFiring.has(gapKey)) {
        gapFiring.delete(gapKey);
        resolve(gapKey, ts);
      }

      // ---- 固定阈值基线(对照组) ----
      const ftState = fixedStates.get(slo.id)!;
      const ft = evaluateFixedThreshold(
        { total: data.total, good: sloGood, reported: data.reported },
        ftState,
      );
      fixedStates.set(slo.id, ft.state);
      const ftKey = alertKey({ detector: 'fixedThreshold', ruleId: 'error-rate-5pct', sloId: slo.id });
      if (ft.trigger) {
        fire(
          slo, 'fixedThreshold', 'error-rate-5pct', 'warning', ts,
          `[固定阈值] ${describeSlo(slo)}:单桶错误率 ${((ft.errorRate ?? 0) * 100).toFixed(1)}% ≥ ${
            DEFAULT_FIXED_THRESHOLD.errorRateThreshold * 100
          }%`,
        );
      } else if (ft.recover) {
        resolve(ftKey, ts);
      }
    }
  };

  for (const row of bucketRows) {
    if (row.bucket_ts !== currentTs) {
      if (currentTs !== -1) evaluateTick(currentTs, bucketByService);
      currentTs = row.bucket_ts;
      bucketByService = new Map();
    }
    bucketByService.set(row.service_id, {
      ts: row.bucket_ts,
      total: row.total,
      good: row.good,
      latencyGoodBySlo: new Map(),
      reported: row.reported === 1,
    });
  }
  if (currentTs !== -1) evaluateTick(currentTs, bucketByService);

  // 回放结束仍在 firing 的告警保持 firing(评估期内未恢复)
  return { events, evaluationTicks: ticks };
}
