import { SERVICES } from '../config/catalog.js';
import { BUCKET_MS, LATENCY_EDGES } from '../shared/types.js';
import type { FaultSpec, ServiceDef } from '../shared/types.js';
import { gaussian, rngFor } from './rng.js';
import { buildDepGraph, getCallRatio, type DepGraph } from './deps.js';
import { emptyHist } from '../slo/histogram.js';

export interface BucketRecord {
  serviceId: string;
  bucketTs: number;
  total: number;
  good: number;
  errors: number;
  latencyGood: number;
  reported: boolean;
  hist: Uint16Array;
  /** 该桶是否处于计划内维护窗口(引擎侧用于排除) */
  inMaintenance: boolean;
}

interface ActiveFault {
  spec: FaultSpec;
  /** 0..1 进度 */
  progress: number;
}

/** 标准 erf 近似(Abramowitz 7.1.26) */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function lognormalCdf(x: number, mu: number, sigma: number): number {
  if (x <= 0) return 0;
  return 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2)));
}

/**
 * 交通昼夜模式:凌晨低谷、早高峰(9-11)、晚高峰(18-22,充电主力)、周末略降。
 * 纯函数,同一 ts 结果一致。
 */
function trafficPattern(ts: number): number {
  const d = new Date(ts);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  // 两个高斯峰:10:00 与 19:30
  const morning = Math.exp(-((hour - 10) ** 2) / 8);
  const evening = 1.3 * Math.exp(-((hour - 19.5) ** 2) / 10);
  const nightFloor = 0.25;
  let f = nightFloor + morning + evening;
  if (isWeekend) f *= 0.85;
  return f;
}

export class MetricGenerator {
  private readonly graph: DepGraph;
  private readonly faultsByService: Map<string, FaultSpec[]>;
  private readonly maintenanceByService: Map<string, Array<{ start: number; end: number }>>;
  private readonly rangeStart: number;
  private readonly rangeEnd: number;

  constructor(
    faults: FaultSpec[],
    maintenance: Array<{ serviceId: string; start: number; end: number }>,
    rangeStart: number,
    rangeEnd: number,
  ) {
    this.graph = buildDepGraph();
    this.faultsByService = new Map();
    for (const f of faults) {
      const list = this.faultsByService.get(f.serviceId) ?? [];
      list.push(f);
      this.faultsByService.set(f.serviceId, list);
    }
    this.maintenanceByService = new Map();
    for (const m of maintenance) {
      const list = this.maintenanceByService.get(m.serviceId) ?? [];
      list.push({ start: m.start, end: m.end });
      this.maintenanceByService.set(m.serviceId, list);
    }
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
  }

  private activeFaults(serviceId: string, ts: number): ActiveFault[] {
    const out: ActiveFault[] = [];
    for (const spec of this.faultsByService.get(serviceId) ?? []) {
      if (ts >= spec.start && ts < spec.end) {
        out.push({ spec, progress: (ts - spec.start) / (spec.end - spec.start) });
      }
    }
    return out;
  }

  private inMaintenance(serviceId: string, ts: number): boolean {
    for (const m of this.maintenanceByService.get(serviceId) ?? []) {
      if (ts >= m.start && ts < m.end) return true;
    }
    return false;
  }

  /** 故障自身贡献的错误率与延迟倍率 */
  private faultEffect(
    svc: ServiceDef,
    ts: number,
  ): { ownErrorRate: number; latencyMul: number; isGap: boolean } {
    const active = this.activeFaults(svc.id, ts);
    let ownErrorRate = 0;
    let latencyMul = 1;
    let isGap = false;
    for (const { spec, progress } of active) {
      switch (spec.kind) {
        case 'totalOutage':
          // 全挂:持续高位,加 5% 抖动避免完全平直
          ownErrorRate = Math.max(ownErrorRate, spec.magnitude * (0.97 + 0.03 * Math.sin(progress * 17)));
          break;
        case 'errorSpike':
          ownErrorRate = Math.max(ownErrorRate, spec.magnitude);
          break;
        case 'gradualDegradation':
          // 线性爬升
          ownErrorRate = Math.max(ownErrorRate, spec.magnitude * progress);
          latencyMul = Math.max(latencyMul, 1 + (spec.latencyMultiplier ?? 1.5 - 1) * progress);
          break;
        case 'reportingGap':
          isGap = true;
          break;
      }
    }
    return { ownErrorRate, latencyMul, isGap };
  }

  /**
   * 生成一个时间桶内全部服务的记录(按拓扑序,便于错误率沿依赖边传导)。
   */
  generateBucket(ts: number): BucketRecord[] {
    const slotIndex = Math.floor((ts - this.rangeStart) / BUCKET_MS);
    const pattern = trafficPattern(ts);
    // 每个服务的总错误率(含传导),拓扑序计算
    const totalErrorRate = new Map<string, number>();
    const latencyMulBySvc = new Map<string, number>();
    const gapBySvc = new Set<string>();

    for (const svcId of this.graph.topoOrder) {
      const svc = SERVICES.find((s) => s.id === svcId)!;
      const effect = this.faultEffect(svc, ts);
      if (effect.isGap) gapBySvc.add(svcId);
      latencyMulBySvc.set(svcId, effect.latencyMul);

      // 下游传导:每个下游的"调用失败概率"按独立事件做概率并,避免线性求和沿多层依赖爆炸
      let propagationSurvival = 1;
      for (const dep of svc.dependencies) {
        const ratio = getCallRatio(this.graph, svcId, dep);
        const depRate = totalErrorRate.get(dep) ?? 0;
        propagationSurvival *= 1 - ratio * depRate;
      }
      const propagatedFailure = 1 - propagationSurvival;
      const combined = 1 - (1 - effect.ownErrorRate) * (1 - propagatedFailure);
      const rate = Math.min(0.995, svc.baseErrorRate + combined * (1 - svc.baseErrorRate));
      totalErrorRate.set(svcId, rate);
    }

    const records: BucketRecord[] = [];
    for (const svc of SERVICES) {
      const rand = rngFor(`${svc.id}|${slotIndex}`);
      const reported = !gapBySvc.has(svc.id);
      const inMaintenance = this.inMaintenance(svc.id, ts);

      // 流量:基线 * 昼夜模式 + 高斯噪声(负值裁剪)
      const noise = 1 + gaussian(rand) * 0.08;
      const mean = svc.baseTraffic * pattern * Math.max(0.4, noise);
      // 泊松采样(正态近似,均值足够大)
      let total = Math.max(0, Math.round(mean + gaussian(rand) * Math.sqrt(mean)));

      if (!reported) {
        records.push({
          serviceId: svc.id,
          bucketTs: ts,
          total: 0,
          good: 0,
          errors: 0,
          latencyGood: 0,
          reported: false,
          hist: emptyHist(),
          inMaintenance,
        });
        continue;
      }

      const errRate = totalErrorRate.get(svc.id)!;
      // 错误请求数:二项采样(正态近似)
      let errors = Math.round(total * errRate + gaussian(rand) * Math.sqrt(total * errRate * (1 - errRate)));
      errors = Math.max(0, Math.min(total, errors));
      const good = total - errors;

      // 延迟分布:对数正态,median=基线*故障倍率,p95/median 比值固定
      const mul = latencyMulBySvc.get(svc.id) ?? 1;
      const median = svc.baseLatencyMedian * mul;
      const sigma = Math.log(svc.p95Factor) / 1.6448536269514722;
      const mu = Math.log(median);
      const hist = emptyHist();
      // 解析法按 bin 填充(避免逐请求采样)
      const edges = [0, ...LATENCY_EDGES, Infinity];
      for (let i = 0; i < edges.length - 1; i++) {
        const lo = edges[i]!;
        const hi = edges[i + 1]!;
        const share = lognormalCdf(hi, mu, sigma) - lognormalCdf(lo, mu, sigma);
        let n = Math.round(share * total);
        n = Math.min(n, 65535);
        hist[i] = n;
      }
      // 修正计数误差,使 hist 总和 = total
      let histSum = hist.reduce((a, b) => a + b, 0);
      if (histSum !== total) {
        const diff = total - histSum;
        const maxBin = hist.reduce((best, v, i) => (v > hist[best] ? i : best), 0);
        hist[maxBin] = Math.max(0, hist[maxBin] + diff);
        histSum = hist.reduce((a, b) => a + b, 0);
      }

      // 延迟达标数:用 CDF 直接算延迟 <= 各 SLO 阈值的数量(这里取该服务所有延迟 SLO 的最严阈值)
      // 引擎侧通过 countBelow(hist, threshold) 精确计算,这里存全量直方图即可。
      // latencyGood 字段存"非错误且延迟低于 1000ms"的参考值,前端概览使用。
      const latencyGood = Math.round(total * lognormalCdf(1000, mu, sigma));

      records.push({
        serviceId: svc.id,
        bucketTs: ts,
        total,
        good,
        errors,
        latencyGood: Math.min(latencyGood, total),
        reported: true,
        hist,
        inMaintenance,
      });
    }
    return records;
  }

  get slotCount(): number {
    return Math.floor((this.rangeEnd - this.rangeStart) / BUCKET_MS);
  }
}
