// 前端共享视图模型类型(与后端 API 响应对齐)
export interface Meta {
  rangeStart: number;
  rangeEnd: number;
  generatedAt: number;
  currentAt: number;
  serviceCount: number;
  sloCount: number;
  gatePolicy: { blockBelowFraction: number; exhaustedRequiresApproval: boolean };
}

export interface ServiceView {
  id: string;
  name: string;
  tier: 'tier1' | 'tier2' | 'tier3';
  owner: string;
  description: string;
  dependencies: string[];
  baseTraffic: number;
  minBudgetFraction: number | null;
  status: 'healthy' | 'burning' | 'exhausted' | 'noData';
  sloIds: string[];
}

export interface SloView {
  def: {
    id: string; serviceId: string; kind: 'availability' | 'latency';
    name: string; target: number; thresholdMs: number | null;
    windowType: 'rolling28' | 'calendarMonth'; alertProfileId: string;
  };
  window: {
    total: number; good: number; bad: number; maintenanceExcluded: number;
    gapBuckets: number; expectedBuckets: number; ratio: number | null;
    status: 'healthy' | 'burning' | 'exhausted' | 'noData';
    windowStart: number; windowEnd: number;
  };
  budget: {
    budget: number; remaining: number; remainingFraction: number;
    burnRate: number | null; etaBurnout: number | null; etaBurnout1h: number | null;
    bad: number; total: number; maintenanceExcluded: number;
  };
}

export interface AlertView {
  id: number;
  sloId: string;
  serviceId: string;
  detector: 'mwmb' | 'fixedThreshold' | 'gap';
  ruleId: string;
  severity: 'critical' | 'warning' | 'info';
  state: 'firing' | 'resolved';
  firedAt: number;
  resolvedAt: number | null;
  shortBurnRate: number | null;
  longBurnRate: number | null;
  message: string;
}

export interface ReleaseView {
  id: number;
  serviceId: string;
  kind: 'normal' | 'emergency';
  version: string;
  requester: string;
  reason: string | null;
  decision: 'allow' | 'block';
  minBudgetFraction: number | null;
  gateThreshold: number;
  decidedAt: number;
  ticket: string | null;
}

export interface GraphView {
  nodes: Array<{
    id: string; name: string; tier: string; status: string;
    impactedByUpstream: boolean; impactSources: string[];
  }>;
  edges: Array<{ from: string; to: string; callRatio: number; activeImpact: boolean }>;
}

export interface EvaluationView {
  generatedAt: number;
  rangeStart: number;
  rangeEnd: number;
  totalFaults: number;
  alertVolumeReductionPct: number | null;
  perFault: Array<{
    fault: {
      faultId: string; serviceId: string; kind: string;
      start: number; end: number; detectable: boolean; note?: string;
    };
    detected: boolean;
    missed: boolean;
    matches: Array<{
      faultId: string; detector: string; alertId: number;
      firedAt: number; detectDelayMinutes: number;
    }>;
  }>;
  detectorSummaries: Array<{
    detector: string; alertsFired: number; truePositiveAlerts: number;
    falsePositiveAlerts: number; faultsDetected: number; faultsMissed: number;
    meanDetectDelayMinutes: number | null; p90DetectDelayMinutes: number | null;
    precision: number | null; recall: number | null;
  }>;
}

export interface TrendPoint {
  ts: number;
  remainingFraction: number;
  burnRate: number | null;
  ratio: number | null;
}

export interface WeeklyRow {
  weekStart: number;
  weekEnd: number;
  total: number;
  good: number;
  bad: number;
  maintenanceExcluded: number;
  gapBuckets: number;
  ratio: number | null;
  target: number;
  met: boolean | null;
}
