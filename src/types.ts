// 共享类型与常量

export const BUCKET_SEC = 300; // 5 分钟桶
export const DAY_SEC = 86400;
export const ROLLING_28D_SEC = 28 * DAY_SEC;

// 固定延迟直方图边界(ms)。延迟 SLO 阈值必须取自该集合,
// 这样桶级聚合与逐请求重算严格相等(聚合无损)。
export const HIST_EDGES = [50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000, 10000];

export type SloType = 'availability' | 'latency';
export type WindowType = 'rolling_28d' | 'calendar_month';

export interface ServiceRow {
  id: number;
  name: string;
  tier: 'core' | 'edge' | 'batch';
  owner: string;
}

export interface SloRow {
  id: number;
  service_id: number;
  name: string;
  type: SloType;
  target: number; // 如 0.999
  latency_threshold_ms: number | null; // type=latency 时取 HIST_EDGES 中的值
  window: WindowType;
  gate_threshold: number; // 预算剩余低于该比例时发布闸门拦截,如 0.2
}

export interface BucketRow {
  service_id: number;
  bucket_start: number; // unix 秒,5 分钟对齐
  total: number;
  ok: number; // 非 5xx 请求数
  hist: string; // JSON number[],长度 HIST_EDGES.length+1,最后一格为 >max(edge)
  gap: number; // 1 = 上报缺口(没数据,不是故障)
}

export interface RequestRow {
  service_id: number;
  ts: number;
  ok: number;
  latency_ms: number;
}

export interface IncidentRow {
  id: number;
  service_id: number;
  start_ts: number;
  end_ts: number;
  kind: 'availability' | 'latency' | 'propagation' | 'gap';
  affected_ratio: number; // 标注:实际影响用户比例
  description: string;
}

export interface MaintenanceRow {
  id: number;
  service_id: number;
  start_ts: number;
  end_ts: number;
  reason: string;
}

export interface AlertRow {
  id: number;
  slo_id: number;
  service_id: number;
  severity: 'critical' | 'warning';
  rule: string;
  opened_at: number;
  resolved_at: number | null;
  peak_burn: number;
}

export interface ReleaseRow {
  id: number;
  service_id: number;
  version: string;
  requested_at: number;
  status: 'approved' | 'blocked' | 'emergency_approved';
  emergency: number;
  reason: string;
  budget_remaining: number | null; // 决策时该服务最差预算剩余比例(留痕)
  decided_by: string;
}
