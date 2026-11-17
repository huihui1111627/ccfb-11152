/**
 * 全局领域类型 —— 后端与前端共享的类型契约。
 * 所有时间统一为 epoch 毫秒(UTC),桶固定 5 分钟。
 */

// ---------- 基础常量 ----------
export const BUCKET_MS = 5 * 60 * 1000; // 5 分钟
export const DAY_MS = 24 * 60 * 60 * 1000;
export const ROLLING_DAYS = 28;

/** 延迟直方图上界(ms),共 LATENCY_EDGES.length 个桶,最后一个是 +Inf 语义 */
export const LATENCY_EDGES = [
  10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
] as const;
export const HIST_BINS = LATENCY_EDGES.length + 1; // 17 个计数槽

// ---------- 服务目录 ----------
export type ServiceTier = 'tier1' | 'tier2' | 'tier3';
export type OwnerTeam =
  | '充电交易'
  | '场站运维'
  | '账户支付'
  | '用户增长'
  | '平台基础'
  | '数据智能';

export interface ServiceDef {
  id: string;
  name: string;
  tier: ServiceTier;
  owner: OwnerTeam;
  /** 业务描述 */
  description: string;
  /** 依赖的下游服务 id(图边方向:本服务 -> 下游) */
  dependencies: string[];
  /** 流量基线:每个 5 分钟桶的平均请求数 */
  baseTraffic: number;
  /** 基线错误率(健康时) */
  baseErrorRate: number;
  /** 延迟中位数基线(ms),p95 大约为 median * p95Factor */
  baseLatencyMedian: number;
  p95Factor: number;
}

// ---------- SLO 定义 ----------
export type SloKind = 'availability' | 'latency';
export type WindowType = 'rolling28' | 'calendarMonth';
export type SloStatus = 'healthy' | 'burning' | 'exhausted' | 'noData';

export interface SloDef {
  id: string;
  serviceId: string;
  kind: SloKind;
  name: string;
  /**
   * 目标达标率,如 0.999 表示 99.9%。
   * 可用性:good = 非错误请求;延迟:good = 延迟 <= thresholdMs 的请求。
   */
  target: number;
  /** 延迟 SLO 的阈值 ms;可用性 SLO 为 null */
  thresholdMs: number | null;
  windowType: WindowType;
  /** 告警策略 id(对应 alerting 中的 burn profile) */
  alertProfileId: string;
}

/** 一个窗口内的 SLO 计算结果 */
export interface SloWindowResult {
  sloId: string;
  windowType: WindowType;
  windowStart: number;
  windowEnd: number;
  total: number;
  good: number;
  bad: number;
  /** 计划内维护排除的请求数(不计入分母) */
  maintenanceExcluded: number;
  /** 上报缺失桶数 / 应有桶数 */
  gapBuckets: number;
  expectedBuckets: number;
  /** 达标率,0..1;无数据时为 null */
  ratio: number | null;
  status: SloStatus;
}

// ---------- 错误预算 ----------
export interface ErrorBudget {
  sloId: string;
  windowStart: number;
  windowEnd: number;
  target: number;
  total: number;
  good: number;
  bad: number;
  maintenanceExcluded: number;
  /** 预算 = total * (1 - target) */
  budget: number;
  remaining: number;
  /** 剩余预算占比,可能为负(超支) */
  remainingFraction: number;
  /** 燃烧率 = 实际错误率 / 允许错误率 */
  burnRate: number | null;
  /** 按近 24h 消耗速度,预算耗尽预测时间(epoch ms);无法预测为 null */
  etaBurnout: number | null;
  /** 按近 1h 消耗速度的 ETA */
  etaBurnout1h: number | null;
  updatedAt: number;
}

// ---------- 告警 ----------
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'firing' | 'resolved';

export interface BurnRule {
  id: string;
  severity: AlertSeverity;
  /** 短窗口(小时)与燃烧率阈值 */
  shortWindowHours: number;
  shortBurnRate: number;
  /** 长窗口(小时)与燃烧率阈值 */
  longWindowHours: number;
  longBurnRate: number;
  /** 描述 */
  description: string;
}

export interface AlertProfile {
  id: string;
  name: string;
  rules: BurnRule[];
  /** 数据缺口连续桶数达到该值触发 info 告警 */
  gapAlertBuckets: number;
  /** 窗口内最小请求量,低于则不参与燃烧率判定(区分小流量与真故障) */
  minRequests: number;
}

export interface AlertEvent {
  id: number;
  sloId: string;
  serviceId: string;
  detector: 'mwmb' | 'fixedThreshold' | 'gap';
  ruleId: string;
  severity: AlertSeverity;
  state: AlertState;
  /** 触发 / 恢复时间 */
  firedAt: number;
  resolvedAt: number | null;
  shortWindowHours: number | null;
  longWindowHours: number | null;
  shortBurnRate: number | null;
  longBurnRate: number | null;
  message: string;
}

// ---------- 发布闸门 ----------
export type ReleaseDecision = 'allow' | 'block';
export type ReleaseKind = 'normal' | 'emergency';

export interface ReleaseRequest {
  id: number;
  serviceId: string;
  kind: ReleaseKind;
  version: string;
  requester: string;
  /** 紧急发布理由(紧急发布必填) */
  reason: string | null;
  decision: ReleaseDecision;
  /** 判定时该服务相关 SLO 的最低剩余预算占比 */
  minBudgetFraction: number | null;
  /** 自动闸门阈值配置引用 */
  gateThreshold: number;
  decidedAt: number;
  ticket: string | null;
}

export interface GatePolicy {
  /** 剩余预算占比低于该值时拦截非紧急发布(如 0.25 表示剩余不足 25%) */
  blockBelowFraction: number;
  /** 预算完全耗尽时是否连紧急发布也要求二次确认(演示:仅记录) */
  exhaustedRequiresApproval: boolean;
}

// ---------- 维护窗口 ----------
export interface MaintenanceWindow {
  id: number;
  serviceId: string;
  start: number;
  end: number;
  reason: string;
}

// ---------- 依赖图 ----------
export interface DependencyNode {
  id: string;
  name: string;
  tier: ServiceTier;
  status: SloStatus;
  /** 受上游影响标记:当前是否存在上游故障传导 */
  impactedByUpstream: boolean;
  /** 具体受哪些上游服务影响(当前窗口) */
  impactSources: string[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  /** 调用占比 0..1,故障传导强度 */
  callRatio: number;
  /** 该边当前是否处于影响传导状态 */
  activeImpact: boolean;
}

// ---------- 故障注入(模拟器) ----------
export type FaultKind = 'totalOutage' | 'gradualDegradation' | 'reportingGap' | 'errorSpike';

export interface FaultSpec {
  id: string;
  serviceId: string;
  kind: FaultKind;
  start: number;
  end: number;
  /** 注入强度:outage=错误率提升量;degradation=目标错误率;spike=峰值错误率 */
  magnitude: number;
  /** 仅 latencyDegradation 使用:延迟放大倍数 */
  latencyMultiplier?: number;
  note: string;
}

/** 评估时使用的故障真相区间 */
export interface FaultGroundTruth {
  faultId: string;
  serviceId: string;
  kind: FaultKind;
  start: number;
  end: number;
  /** 该故障是否应被 SLO 告警捕获(reportingGap 由 gap 检测器捕获) */
  detectable: boolean;
}

// ---------- 评估 ----------
export interface DetectorMatch {
  faultId: string;
  detector: 'mwmb' | 'fixedThreshold' | 'gap';
  alertId: number;
  firedAt: number;
  /** 检测延迟(分钟) */
  detectDelayMinutes: number;
}

export interface FaultEvaluation {
  fault: FaultGroundTruth;
  detected: boolean;
  /** 各检测器的首次命中 */
  matches: DetectorMatch[];
  /** 漏报:故障期间无任何对应检测器命中 */
  missed: boolean;
}

export interface DetectorSummary {
  detector: 'mwmb' | 'fixedThreshold' | 'gap';
  alertsFired: number;
  /** 命中已标注故障的告警数 */
  truePositiveAlerts: number;
  /** 落在任何故障窗口之外的告警数(误报) */
  falsePositiveAlerts: number;
  /** 已检测出的故障数 */
  faultsDetected: number;
  /** 漏报故障数 */
  faultsMissed: number;
  /** 平均检测延迟(分钟),仅统计命中 */
  meanDetectDelayMinutes: number | null;
  p90DetectDelayMinutes: number | null;
  /** 精确率/召回率 */
  precision: number | null;
  recall: number | null;
}

export interface EvaluationReport {
  generatedAt: number;
  rangeStart: number;
  rangeEnd: number;
  totalFaults: number;
  perFault: FaultEvaluation[];
  detectorSummaries: DetectorSummary[];
  /** MWMB 相对固定阈值在告警总量上的降幅 */
  alertVolumeReductionPct: number | null;
}

// ---------- API 通用包装 ----------
export interface ApiError {
  error: string;
}
