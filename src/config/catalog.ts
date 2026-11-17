import type {
  AlertProfile,
  FaultSpec,
  GatePolicy,
  MaintenanceWindow,
  ServiceDef,
  SloDef,
} from '../shared/types.js';

/**
 * 充电桩运营平台服务目录(30 个服务,4 层 DAG)。
 * dependencies 方向:调用方 -> 被依赖的下游。
 */
export const SERVICES: ServiceDef[] = [
  // ---------- 接入层 ----------
  {
    id: 'api-gateway', name: 'API 网关', tier: 'tier1', owner: '平台基础',
    description: '全量 App / 小程序 / 硬件接入网关,认证、限流、路由',
    dependencies: ['auth-service', 'bff-app', 'bff-operator', 'config-center'],
    baseTraffic: 600, baseErrorRate: 0.0003, baseLatencyMedian: 35, p95Factor: 2.6,
  },
  {
    id: 'bff-app', name: 'App 聚合层', tier: 'tier1', owner: '用户增长',
    description: '面向车主 App 的接口聚合 BFF',
    dependencies: ['charging-session', 'order-service', 'user-account', 'station-service', 'reservation-service', 'coupon-service'],
    baseTraffic: 480, baseErrorRate: 0.0003, baseLatencyMedian: 90, p95Factor: 2.8,
  },
  {
    id: 'bff-operator', name: '运营后台 BFF', tier: 'tier2', owner: '平台基础',
    description: '面向场站运营人员的后台聚合服务',
    dependencies: ['station-service', 'gun-service', 'order-service', 'report-service'],
    baseTraffic: 120, baseErrorRate: 0.0015, baseLatencyMedian: 110, p95Factor: 3.0,
  },

  // ---------- 业务服务层 ----------
  {
    id: 'charging-session', name: '充电会话服务', tier: 'tier1', owner: '充电交易',
    description: '启停充电、会话状态机、实时计费上下文',
    dependencies: ['gun-service', 'pricing-service', 'billing-engine', 'notification-service', 'id-gen', 'kafka-bus'],
    baseTraffic: 380, baseErrorRate: 0.0003, baseLatencyMedian: 70, p95Factor: 2.6,
  },
  {
    id: 'order-service', name: '订单服务', tier: 'tier1', owner: '充电交易',
    description: '充电订单创建、流转、查询与关单',
    dependencies: ['pricing-service', 'payment-service', 'coupon-service', 'id-gen', 'kafka-bus'],
    baseTraffic: 300, baseErrorRate: 0.0003, baseLatencyMedian: 85, p95Factor: 2.8,
  },
  {
    id: 'payment-service', name: '支付服务', tier: 'tier1', owner: '账户支付',
    description: '微信/支付宝/余额支付与代扣',
    dependencies: ['transaction-ledger', 'risk-control', 'billing-engine'],
    baseTraffic: 260, baseErrorRate: 0.0003, baseLatencyMedian: 120, p95Factor: 3.0,
  },
  {
    id: 'refund-service', name: '退款服务', tier: 'tier2', owner: '账户支付',
    description: '多付退款、异常订单退款流程',
    dependencies: ['payment-service', 'transaction-ledger', 'notification-service'],
    baseTraffic: 60, baseErrorRate: 0.0015, baseLatencyMedian: 140, p95Factor: 3.2,
  },
  {
    id: 'user-account', name: '用户账户服务', tier: 'tier2', owner: '用户增长',
    description: '车主账户、实名信息、车辆绑定',
    dependencies: ['auth-service', 'mysql-platform'],
    baseTraffic: 180, baseErrorRate: 0.0015, baseLatencyMedian: 60, p95Factor: 2.5,
  },
  {
    id: 'station-service', name: '场站服务', tier: 'tier2', owner: '场站运维',
    description: '场站档案、区位、营业状态',
    dependencies: ['gun-service', 'config-center'],
    baseTraffic: 200, baseErrorRate: 0.0015, baseLatencyMedian: 55, p95Factor: 2.4,
  },
  {
    id: 'gun-service', name: '充电桩枪服务', tier: 'tier2', owner: '场站运维',
    description: '充电桩/枪实时状态、远程指令下发',
    dependencies: ['mysql-platform', 'kafka-bus'],
    baseTraffic: 240, baseErrorRate: 0.0015, baseLatencyMedian: 65, p95Factor: 2.7,
  },
  {
    id: 'pricing-service', name: '计费规则服务', tier: 'tier2', owner: '充电交易',
    description: '分时电价、服务费规则、试算',
    dependencies: ['mysql-platform', 'redis-cache'],
    baseTraffic: 220, baseErrorRate: 0.0015, baseLatencyMedian: 45, p95Factor: 2.3,
  },
  {
    id: 'notification-service', name: '通知服务', tier: 'tier2', owner: '平台基础',
    description: '充电完成、支付结果等站内信与短信编排',
    dependencies: ['message-push'],
    baseTraffic: 150, baseErrorRate: 0.0015, baseLatencyMedian: 80, p95Factor: 3.2,
  },
  {
    id: 'invoice-service', name: '发票服务', tier: 'tier3', owner: '账户支付',
    description: '电子发票开具与推送',
    dependencies: ['file-service', 'billing-engine'],
    baseTraffic: 50, baseErrorRate: 0.004, baseLatencyMedian: 180, p95Factor: 3.0,
  },
  {
    id: 'reservation-service', name: '充电预约服务', tier: 'tier3', owner: '用户增长',
    description: '桩位预约、占位费计算',
    dependencies: ['station-service', 'order-service'],
    baseTraffic: 90, baseErrorRate: 0.004, baseLatencyMedian: 95, p95Factor: 2.9,
  },
  {
    id: 'coupon-service', name: '优惠券服务', tier: 'tier3', owner: '用户增长',
    description: '优惠券发放、核销、营销活动',
    dependencies: ['redis-cache', 'mysql-platform'],
    baseTraffic: 70, baseErrorRate: 0.004, baseLatencyMedian: 50, p95Factor: 2.6,
  },
  {
    id: 'rating-service', name: '评价服务', tier: 'tier3', owner: '用户增长',
    description: '订单评价、投诉工单入口',
    dependencies: ['order-service'],
    baseTraffic: 40, baseErrorRate: 0.004, baseLatencyMedian: 70, p95Factor: 2.8,
  },

  // ---------- 核心能力层 ----------
  {
    id: 'billing-engine', name: '计费引擎', tier: 'tier1', owner: '充电交易',
    description: '充电量实时计费、账单生成',
    dependencies: ['transaction-ledger', 'mysql-platform'],
    baseTraffic: 240, baseErrorRate: 0.0003, baseLatencyMedian: 50, p95Factor: 2.4,
  },
  {
    id: 'transaction-ledger', name: '交易账务流水', tier: 'tier1', owner: '账户支付',
    description: '资金流水、余额账、对账核心',
    dependencies: ['mysql-platform', 'kafka-bus'],
    baseTraffic: 280, baseErrorRate: 0.0003, baseLatencyMedian: 35, p95Factor: 2.2,
  },
  {
    id: 'auth-service', name: '认证鉴权服务', tier: 'tier2', owner: '平台基础',
    description: 'Token 签发与校验、RBAC',
    dependencies: ['redis-cache', 'mysql-platform'],
    baseTraffic: 300, baseErrorRate: 0.0015, baseLatencyMedian: 25, p95Factor: 2.4,
  },
  {
    id: 'risk-control', name: '风控服务', tier: 'tier2', owner: '账户支付',
    description: '支付风控、反欺诈规则判定',
    dependencies: ['redis-cache'],
    baseTraffic: 120, baseErrorRate: 0.0015, baseLatencyMedian: 60, p95Factor: 3.0,
  },
  {
    id: 'id-gen', name: 'ID 生成服务', tier: 'tier2', owner: '平台基础',
    description: '全局分布式 ID 发号器',
    dependencies: ['redis-cache'],
    baseTraffic: 350, baseErrorRate: 0.0015, baseLatencyMedian: 8, p95Factor: 2.5,
  },
  {
    id: 'message-push', name: '消息推送管道', tier: 'tier3', owner: '平台基础',
    description: '短信 / Push / 公众号通道适配',
    dependencies: ['kafka-bus'],
    baseTraffic: 150, baseErrorRate: 0.004, baseLatencyMedian: 40, p95Factor: 3.4,
  },
  {
    id: 'file-service', name: '文件服务', tier: 'tier3', owner: '平台基础',
    description: '电子凭证、附件存取',
    dependencies: ['object-storage'],
    baseTraffic: 40, baseErrorRate: 0.004, baseLatencyMedian: 120, p95Factor: 2.8,
  },
  {
    id: 'report-service', name: '报表服务', tier: 'tier3', owner: '数据智能',
    description: '运营报表、对账报表离线查询',
    dependencies: ['elasticsearch', 'kafka-bus'],
    baseTraffic: 20, baseErrorRate: 0.004, baseLatencyMedian: 260, p95Factor: 2.6,
  },
  {
    id: 'config-center', name: '配置中心', tier: 'tier2', owner: '平台基础',
    description: '动态配置、开关、灰度参数',
    dependencies: ['mysql-platform'],
    baseTraffic: 100, baseErrorRate: 0.0015, baseLatencyMedian: 15, p95Factor: 2.6,
  },

  // ---------- 基础设施层 ----------
  {
    id: 'mysql-platform', name: '平台 MySQL 集群', tier: 'tier1', owner: '平台基础',
    description: '交易/账户/配置核心库(多服务共享)',
    dependencies: [],
    baseTraffic: 900, baseErrorRate: 0.0003, baseLatencyMedian: 12, p95Factor: 2.8,
  },
  {
    id: 'redis-cache', name: 'Redis 缓存集群', tier: 'tier1', owner: '平台基础',
    description: '缓存、分布式锁、发号、会话',
    dependencies: [],
    baseTraffic: 800, baseErrorRate: 0.0003, baseLatencyMedian: 2, p95Factor: 3.0,
  },
  {
    id: 'kafka-bus', name: 'Kafka 消息总线', tier: 'tier1', owner: '数据智能',
    description: '异步消息、事件流、对账管道',
    dependencies: [],
    baseTraffic: 700, baseErrorRate: 0.0003, baseLatencyMedian: 25, p95Factor: 2.6,
  },
  {
    id: 'object-storage', name: '对象存储', tier: 'tier3', owner: '平台基础',
    description: '凭证文件、静态资源',
    dependencies: [],
    baseTraffic: 60, baseErrorRate: 0.004, baseLatencyMedian: 90, p95Factor: 2.5,
  },
  {
    id: 'elasticsearch', name: 'ES 检索集群', tier: 'tier3', owner: '数据智能',
    description: '报表与日志检索',
    dependencies: [],
    baseTraffic: 30, baseErrorRate: 0.004, baseLatencyMedian: 180, p95Factor: 2.7,
  },
];

/** 边调用占比:故障沿依赖边按该比例传导(已按高扇入场景收紧,避免多层累积失真) */
export const CALL_RATIOS: Record<string, Record<string, number>> = {
  'api-gateway': { 'auth-service': 0.6, 'bff-app': 0.35, 'bff-operator': 0.08, 'config-center': 0.15 },
  'bff-app': { 'charging-session': 0.28, 'order-service': 0.22, 'user-account': 0.18, 'station-service': 0.25, 'reservation-service': 0.06, 'coupon-service': 0.05 },
  'bff-operator': { 'station-service': 0.25, 'gun-service': 0.25, 'order-service': 0.18, 'report-service': 0.1 },
  'charging-session': { 'gun-service': 0.35, 'pricing-service': 0.3, 'billing-engine': 0.28, 'notification-service': 0.12, 'id-gen': 0.2, 'kafka-bus': 0.45 },
  'order-service': { 'pricing-service': 0.3, 'payment-service': 0.25, 'coupon-service': 0.08, 'id-gen': 0.22, 'kafka-bus': 0.42 },
  'payment-service': { 'transaction-ledger': 0.45, 'risk-control': 0.35, 'billing-engine': 0.2 },
  'refund-service': { 'payment-service': 0.3, 'transaction-ledger': 0.4, 'notification-service': 0.25 },
  'user-account': { 'auth-service': 0.35, 'mysql-platform': 0.3 },
  'station-service': { 'gun-service': 0.3, 'config-center': 0.1 },
  'gun-service': { 'mysql-platform': 0.35, 'kafka-bus': 0.38 },
  'pricing-service': { 'mysql-platform': 0.5, 'redis-cache': 0.8 },
  'notification-service': { 'message-push': 0.9 },
  'invoice-service': { 'file-service': 0.7, 'billing-engine': 0.6 },
  'reservation-service': { 'station-service': 0.7, 'order-service': 0.4 },
  'rating-service': { 'order-service': 0.8 },
  'billing-engine': { 'transaction-ledger': 0.75, 'mysql-platform': 0.8 },
  'transaction-ledger': { 'mysql-platform': 0.9, 'kafka-bus': 0.7 },
  'auth-service': { 'redis-cache': 0.85, 'mysql-platform': 0.4 },
  'risk-control': { 'redis-cache': 0.9 },
  'id-gen': { 'redis-cache': 0.95 },
  'message-push': { 'kafka-bus': 0.9 },
  'file-service': { 'object-storage': 0.85 },
  'report-service': { 'elasticsearch': 0.8, 'kafka-bus': 0.6 },
  'config-center': { 'mysql-platform': 0.7 },
  'coupon-service': { 'redis-cache': 0.7, 'mysql-platform': 0.5 },
};

// ---------- 告警策略(Google SRE 多窗口多燃烧率标准) ----------
export const ALERT_PROFILES: AlertProfile[] = [
  {
    id: 'profile-critical',
    name: '核心交易链路(三级燃烧率)',
    gapAlertBuckets: 6,
    minRequests: 50,
    rules: [
      {
        id: 'fast-burn', severity: 'critical',
        shortWindowHours: 0.0833, shortBurnRate: 14.4, // 5 分钟
        longWindowHours: 1, longBurnRate: 14.4,
        description: '快速燃烧:5 分钟与 1 小时燃烧率均 ≥14.4x,2% 预算/1h',
      },
      {
        id: 'medium-burn', severity: 'warning',
        shortWindowHours: 0.5, shortBurnRate: 6, // 30 分钟
        longWindowHours: 6, longBurnRate: 6,
        description: '中速燃烧:30 分钟与 6 小时燃烧率均 ≥6x,5% 预算/6h',
      },
      {
        id: 'slow-burn', severity: 'warning',
        shortWindowHours: 2, shortBurnRate: 3,
        longWindowHours: 72, longBurnRate: 1,
        description: '慢速燃烧:2h ≥3x 且 3 天 ≥1x,10% 预算/3d',
      },
    ],
  },
  {
    id: 'profile-standard',
    name: '重要业务(两级燃烧率)',
    gapAlertBuckets: 6,
    minRequests: 30,
    rules: [
      {
        id: 'fast-burn', severity: 'critical',
        shortWindowHours: 0.0833, shortBurnRate: 14.4,
        longWindowHours: 1, longBurnRate: 14.4,
        description: '快速燃烧:5 分钟与 1 小时燃烧率均 ≥14.4x',
      },
      {
        id: 'slow-burn', severity: 'warning',
        shortWindowHours: 2, shortBurnRate: 3,
        longWindowHours: 72, longBurnRate: 1,
        description: '慢速燃烧:2h ≥3x 且 3 天 ≥1x',
      },
    ],
  },
  {
    id: 'profile-relaxed',
    name: '一般业务(宽松两级)',
    gapAlertBuckets: 12,
    minRequests: 15,
    rules: [
      {
        id: 'fast-burn', severity: 'critical',
        shortWindowHours: 0.25, shortBurnRate: 14.4, // 15 分钟
        longWindowHours: 1.5, longBurnRate: 14.4,
        description: '快速燃烧:15 分钟与 1.5 小时燃烧率均 ≥14.4x',
      },
      {
        id: 'slow-burn', severity: 'warning',
        shortWindowHours: 6, shortBurnRate: 3,
        longWindowHours: 72, longBurnRate: 1,
        description: '慢速燃烧:6h ≥3x 且 3 天 ≥1x',
      },
    ],
  },
];

// ---------- SLO 定义 ----------
const AVAIL_TARGET: Record<ServiceDef['tier'], number> = {
  tier1: 0.999,
  tier2: 0.995,
  tier3: 0.99,
};

/**
 * 延迟 SLO 独立目标。延迟天然长尾,达标率目标低于可用性,
 * 且基于真实健康表现设定(而非拍脑袋),否则健康期就持续违约、告警泛滥。
 */
const LATENCY_TARGET: Record<ServiceDef['tier'], number> = {
  tier1: 0.97,
  tier2: 0.95,
  tier3: 0.92,
};

/** 自然月窗口的服务(其余滚动 28 天) */
const CALENDAR_MONTH_SERVICES = new Set([
  'api-gateway', 'charging-session', 'order-service', 'payment-service', 'mysql-platform',
]);

/** 延迟 SLO 阈值(ms),取健康 p95 的 ~1.3 倍留余量;仅 tier1/tier2 配置 */
const LATENCY_THRESHOLD: Record<string, number> = {
  'api-gateway': 180,
  'bff-app': 450,
  'bff-operator': 600,
  'charging-session': 350,
  'order-service': 450,
  'payment-service': 600,
  'refund-service': 800,
  'user-account': 300,
  'station-service': 250,
  'gun-service': 300,
  'pricing-service': 200,
  'notification-service': 450,
  'billing-engine': 250,
  'transaction-ledger': 150,
  'auth-service': 120,
  'risk-control': 350,
  'id-gen': 60,
  'config-center': 80,
  'mysql-platform': 90,
  'redis-cache': 30,
  'kafka-bus': 150,
};

function profileForTier(tier: ServiceDef['tier']): string {
  if (tier === 'tier1') return 'profile-critical';
  if (tier === 'tier2') return 'profile-standard';
  return 'profile-relaxed';
}

export function buildSloDefs(): SloDef[] {
  const defs: SloDef[] = [];
  for (const svc of SERVICES) {
    const windowType = CALENDAR_MONTH_SERVICES.has(svc.id) ? 'calendarMonth' : 'rolling28';
    defs.push({
      id: `slo-avail-${svc.id}`,
      serviceId: svc.id,
      kind: 'availability',
      name: `${svc.name} · 可用性`,
      target: AVAIL_TARGET[svc.tier],
      thresholdMs: null,
      windowType,
      alertProfileId: profileForTier(svc.tier),
    });
    const latencyThreshold = LATENCY_THRESHOLD[svc.id];
    if (latencyThreshold !== undefined) {
      defs.push({
        id: `slo-lat-${svc.id}`,
        serviceId: svc.id,
        kind: 'latency',
        name: `${svc.name} · P95 延迟`,
        target: LATENCY_TARGET[svc.tier],
        thresholdMs: latencyThreshold,
        windowType: 'rolling28',
        alertProfileId: profileForTier(svc.tier),
      });
    }
  }
  return defs;
}

// ---------- 发布闸门策略 ----------
export const GATE_POLICY: GatePolicy = {
  blockBelowFraction: 0.25,
  exhaustedRequiresApproval: true,
};

// ---------- 故障注入计划(相对模拟起点的天/小时偏移,保证可复现) ----------
export interface FaultPlanItem {
  id: string;
  serviceId: string;
  kind: FaultSpec['kind'];
  startDay: number;
  startHour: number;
  durationHours: number;
  magnitude: number;
  latencyMultiplier?: number;
  note: string;
}

export const FAULT_PLAN: FaultPlanItem[] = [
  // --- 突发全挂 ---
  { id: 'f01', serviceId: 'payment-service', kind: 'totalOutage', startDay: 12, startHour: 10, durationHours: 0.75, magnitude: 0.98, note: '支付渠道回调超时引发雪崩,45 分钟近全挂' },
  { id: 'f02', serviceId: 'mysql-platform', kind: 'totalOutage', startDay: 27, startHour: 14, durationHours: 0.42, magnitude: 0.95, note: '核心库主从切换,25 分钟大面积失败并沿依赖图传导' },
  { id: 'f03', serviceId: 'charging-session', kind: 'totalOutage', startDay: 41, startHour: 9.5, durationHours: 1.5, magnitude: 0.92, note: '会话状态机死锁,90 分钟启停充电失败' },
  { id: 'f04', serviceId: 'redis-cache', kind: 'totalOutage', startDay: 63, startHour: 16, durationHours: 0.33, magnitude: 0.97, note: '缓存集群脑裂,20 分钟' },
  { id: 'f05', serviceId: 'auth-service', kind: 'totalOutage', startDay: 145, startHour: 14, durationHours: 0.67, magnitude: 0.9, note: '鉴权服务 OOM,前 10 分钟与计划维护重叠' },
  // --- 缓慢变坏 ---
  { id: 'f06', serviceId: 'order-service', kind: 'gradualDegradation', startDay: 48, startHour: 8, durationHours: 48, magnitude: 0.08, latencyMultiplier: 2.2, note: '慢 SQL 累积,两天内错误率爬升到 8% 且延迟翻倍' },
  { id: 'f07', serviceId: 'station-service', kind: 'gradualDegradation', startDay: 75, startHour: 6, durationHours: 36, magnitude: 0.05, latencyMultiplier: 1.8, note: '连接池泄漏,36 小时逐步恶化到 5% 错误' },
  { id: 'f08', serviceId: 'kafka-bus', kind: 'gradualDegradation', startDay: 105, startHour: 9, durationHours: 60, magnitude: 0.06, latencyMultiplier: 1.5, note: '消费积压,60 小时缓慢劣化' },
  { id: 'f09', serviceId: 'pricing-service', kind: 'gradualDegradation', startDay: 155, startHour: 11, durationHours: 24, magnitude: 0.04, latencyMultiplier: 1.6, note: '电价规则热更新缺陷,24 小时缓慢劣化' },
  // --- 上报中断(服务本身正常,仅指标缺失) ---
  { id: 'f10', serviceId: 'gun-service', kind: 'reportingGap', startDay: 20, startHour: 3, durationHours: 3, magnitude: 1, note: '采集 Agent 升级,3 小时无指标' },
  { id: 'f11', serviceId: 'bff-app', kind: 'reportingGap', startDay: 58, startHour: 21, durationHours: 1.5, magnitude: 1, note: '日志管道重启,90 分钟缺口' },
  { id: 'f12', serviceId: 'api-gateway', kind: 'reportingGap', startDay: 95, startHour: 13, durationHours: 6, magnitude: 1, note: '监控租户欠费,6 小时无数据' },
  { id: 'f13', serviceId: 'transaction-ledger', kind: 'reportingGap', startDay: 130, startHour: 7, durationHours: 0.75, magnitude: 1, note: 'Sidecar 异常,45 分钟缺口' },
  // --- 短时错误尖峰(考验误报) ---
  { id: 'f14', serviceId: 'notification-service', kind: 'errorSpike', startDay: 34, startHour: 10, durationHours: 0.5, magnitude: 0.5, note: '短信通道抖动,30 分钟 50% 错误' },
  { id: 'f15', serviceId: 'risk-control', kind: 'errorSpike', startDay: 88, startHour: 15, durationHours: 0.25, magnitude: 0.4, note: '规则引擎 GC,15 分钟尖峰' },
  { id: 'f16', serviceId: 'billing-engine', kind: 'errorSpike', startDay: 120, startHour: 11, durationHours: 0.33, magnitude: 0.35, note: '账单批处理竞争,20 分钟尖峰' },
];

// ---------- 计划内维护窗口 ----------
export interface MaintenancePlanItem {
  serviceId: string;
  startDay: number;
  startHour: number;
  durationHours: number;
  reason: string;
}

export const MAINTENANCE_PLAN: MaintenancePlanItem[] = [
  { serviceId: 'mysql-platform', startDay: 26, startHour: 2, durationHours: 2, reason: 'MySQL 内核版本升级' },
  { serviceId: 'charging-session', startDay: 40, startHour: 22, durationHours: 1, reason: '会话服务灰度发布' },
  { serviceId: 'redis-cache', startDay: 63, startHour: 15, durationHours: 0.5, reason: 'Redis 哨兵扩容' },
  { serviceId: 'order-service', startDay: 47, startHour: 3, durationHours: 2, reason: '订单库索引重建' },
  { serviceId: 'kafka-bus', startDay: 104, startHour: 1, durationHours: 2, reason: 'Broker 滚动重启' },
  { serviceId: 'auth-service', startDay: 145, startHour: 13.67, durationHours: 0.5, reason: '鉴权服务证书轮换(与故障前 10 分钟重叠,验证排除逻辑)' },
];

export const SIMULATION_DAYS = 181;
