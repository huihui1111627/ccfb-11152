// 多窗口多燃烧率(MWMB)告警 —— 纯函数部分。
// 规则:短窗口和长窗口的燃烧率同时 >= 阈值才报,长窗口防毛刺,短窗口防迟钝。
// 燃烧率 BR = 实际坏请求比例 / 预算允许坏比例;BR=1 表示恰好按预算速度消耗。
export interface BurnRule {
  name: string;
  severity: 'critical' | 'warning';
  threshold: number; // 燃烧率阈值
  longBuckets: number; // 长窗口(5 分钟桶数)
  shortBuckets: number; // 短窗口
  minTotal: number; // 长窗口最小请求量,低流量不误报
}

export const RULES: BurnRule[] = [
  // 快速燃烧:6h / 30min 双窗口,BR>=6,约 4.7 天烧完 28 天预算
  { name: 'fast-burn', severity: 'critical', threshold: 6, longBuckets: 72, shortBuckets: 6, minTotal: 200 },
  // 慢速燃烧:24h / 2h 双窗口,BR>=2,约 14 天烧完
  { name: 'slow-burn', severity: 'warning', threshold: 2, longBuckets: 288, shortBuckets: 24, minTotal: 500 },
];

export interface WinStat {
  bad: number;
  total: number;
}

export function burnRateOf(stat: WinStat, allowedRatio: number): number {
  if (stat.total <= 0) return 0;
  return stat.bad / stat.total / allowedRatio;
}

export function ruleFires(
  rule: BurnRule,
  long: WinStat,
  short: WinStat,
  allowedRatio: number,
): boolean {
  if (long.total < rule.minTotal) return false; // 流量太低不下结论
  return (
    burnRateOf(long, allowedRatio) >= rule.threshold &&
    burnRateOf(short, allowedRatio) >= rule.threshold
  );
}

// 迟滞恢复线:降到阈值的 0.85 倍以下才算恢复,防止在阈值线附近抖动(flapping)
export const RECOVERY_FACTOR = 0.85;
// 告警关闭后的冷却期,期内不重复开新告警
export const COOLDOWN_SEC = 1800;
