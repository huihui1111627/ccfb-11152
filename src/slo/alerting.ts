import type {
  AlertEvent,
  AlertProfile,
  AlertSeverity,
  BurnRule,
  SloDef,
} from '../shared/types.js';
import { BUCKET_MS } from '../shared/types.js';

/** 一个评估点上某窗口的聚合输入 */
export interface WindowInput {
  total: number;
  good: number;
  /** 该窗口内缺口桶数 */
  gapBuckets: number;
  expectedBuckets: number;
  /** 窗口是否已填满(回放初期未满窗口不得参与判定) */
  full: boolean;
}

export interface BurnEvaluation {
  ruleId: string;
  severity: AlertSeverity;
  firing: boolean;
  shortBurnRate: number | null;
  longBurnRate: number | null;
  reason: string;
}

function burnRateOf(w: WindowInput, target: number): number | null {
  if (w.total <= 0) return null;
  const errorRate = (w.total - w.good) / w.total;
  const allowed = 1 - target;
  return errorRate / allowed;
}

/**
 * 多窗口多燃烧率判定:短窗口与长窗口燃烧率同时超阈值才触发。
 * 数据量不足或窗口内存在明显缺口时不参与燃烧率判定(避免缺口被误判为故障)。
 */
export function evaluateBurnRule(
  rule: BurnRule,
  target: number,
  shortW: WindowInput,
  longW: WindowInput,
  minRequests: number,
): BurnEvaluation {
  const insufficient =
    !shortW.full ||
    !longW.full ||
    shortW.total < minRequests ||
    longW.total < minRequests ||
    shortW.gapBuckets > 0 ||
    longW.gapBuckets > 0;
  const shortBurn = burnRateOf(shortW, target);
  const longBurn = burnRateOf(longW, target);

  if (insufficient || shortBurn === null || longBurn === null) {
    return {
      ruleId: rule.id,
      severity: rule.severity,
      firing: false,
      shortBurnRate: shortBurn,
      longBurnRate: longBurn,
      reason: insufficient ? '数据不足或存在上报缺口,跳过燃烧率判定' : '无数据',
    };
  }

  const firing = shortBurn >= rule.shortBurnRate && longBurn >= rule.longBurnRate;
  return {
    ruleId: rule.id,
    severity: rule.severity,
    firing,
    shortBurnRate: shortBurn,
    longBurnRate: longBurn,
    reason: firing
      ? `${rule.shortWindowHours}h 燃烧率 ${shortBurn.toFixed(2)}x ≥ ${rule.shortBurnRate}x 且 ${rule.longWindowHours}h ${longBurn.toFixed(2)}x ≥ ${rule.longBurnRate}x`
      : '未同时超过双窗口阈值',
  };
}

export interface GapEvaluation {
  firing: boolean;
  consecutiveGapBuckets: number;
}

/** 连续缺口达到策略阈值则触发(只认缺口,不认错误率,与故障区分) */
export function evaluateGap(
  profile: AlertProfile,
  recentReported: number[],
): GapEvaluation {
  let consecutive = 0;
  for (let i = recentReported.length - 1; i >= 0; i--) {
    if (recentReported[i] === 0) consecutive += 1;
    else break;
  }
  return {
    firing: consecutive >= profile.gapAlertBuckets,
    consecutiveGapBuckets: consecutive,
  };
}

/**
 * 固定阈值基线检测器(对照组):
 * 单桶错误率 >= threshold 且请求量 >= minRequests 即报,恢复需连续 3 个桶低于阈值。
 */
export interface FixedThresholdConfig {
  errorRateThreshold: number;
  minRequests: number;
  recoverBuckets: number;
}

export const DEFAULT_FIXED_THRESHOLD: FixedThresholdConfig = {
  errorRateThreshold: 0.05,
  minRequests: 20,
  recoverBuckets: 3,
};

export interface FixedThresholdState {
  firing: boolean;
  recoverCount: number;
}

export function evaluateFixedThreshold(
  bucket: { total: number; good: number; reported: boolean },
  state: FixedThresholdState,
  config: FixedThresholdConfig = DEFAULT_FIXED_THRESHOLD,
): { trigger: boolean; recover: boolean; state: FixedThresholdState; errorRate: number | null } {
  if (!bucket.reported) {
    // 缺口不参与固定阈值判定
    return { trigger: false, recover: false, state, errorRate: null };
  }
  if (bucket.total < config.minRequests) {
    return { trigger: false, recover: false, state, errorRate: null };
  }
  const errorRate = (bucket.total - bucket.good) / bucket.total;
  if (!state.firing) {
    if (errorRate >= config.errorRateThreshold) {
      return {
        trigger: true,
        recover: false,
        state: { firing: true, recoverCount: 0 },
        errorRate,
      };
    }
    return { trigger: false, recover: false, state, errorRate };
  }
  // 已告警:连续 N 桶低于阈值才恢复
  if (errorRate < config.errorRateThreshold) {
    const recoverCount = state.recoverCount + 1;
    if (recoverCount >= config.recoverBuckets) {
      return { trigger: false, recover: true, state: { firing: false, recoverCount: 0 }, errorRate };
    }
    return { trigger: false, recover: false, state: { firing: true, recoverCount }, errorRate };
  }
  return { trigger: false, recover: false, state: { firing: true, recoverCount: 0 }, errorRate };
}

/** 窗口小时数转桶数 */
export function hoursToBuckets(hours: number): number {
  return Math.max(1, Math.round((hours * 3_600_000) / BUCKET_MS));
}

export function alertKey(evt: Pick<AlertEvent, 'detector' | 'ruleId' | 'sloId'>): string {
  return `${evt.detector}|${evt.ruleId}|${evt.sloId}`;
}

export function describeSlo(slo: SloDef): string {
  return slo.kind === 'availability'
    ? `${slo.name}(目标 ${(slo.target * 100).toFixed(2)}%)`
    : `${slo.name}(P95 ≤ ${slo.thresholdMs}ms,目标 ${(slo.target * 100).toFixed(2)}%)`;
}
