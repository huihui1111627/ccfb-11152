export const RULES = [
    // 快速燃烧:6h / 30min 双窗口,BR>=6,约 4.7 天烧完 28 天预算
    { name: 'fast-burn', severity: 'critical', threshold: 6, longBuckets: 72, shortBuckets: 6, minTotal: 200 },
    // 慢速燃烧:24h / 2h 双窗口,BR>=2,约 14 天烧完
    { name: 'slow-burn', severity: 'warning', threshold: 2, longBuckets: 288, shortBuckets: 24, minTotal: 500 },
];
export function burnRateOf(stat, allowedRatio) {
    if (stat.total <= 0)
        return 0;
    return stat.bad / stat.total / allowedRatio;
}
export function ruleFires(rule, long, short, allowedRatio) {
    if (long.total < rule.minTotal)
        return false; // 流量太低不下结论
    return (burnRateOf(long, allowedRatio) >= rule.threshold &&
        burnRateOf(short, allowedRatio) >= rule.threshold);
}
// 迟滞恢复线:降到阈值的 0.85 倍以下才算恢复,防止在阈值线附近抖动(flapping)
export const RECOVERY_FACTOR = 0.85;
// 告警关闭后的冷却期,期内不重复开新告警
export const COOLDOWN_SEC = 1800;
