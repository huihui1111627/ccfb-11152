// 内存前缀和:把一个 SLO 的全部桶加载成数组,窗口查询 O(1)。
// 供评估/回放等高频场景使用;语义与 window.ts 的 computeWindow 完全一致
// (维护按比例剔除、缺口不计分母、覆盖率不足判 insufficient)。
import { DatabaseSync } from 'node:sqlite';
import { rows } from '../db/index.js';
import { BUCKET_SEC, BucketRow, MaintenanceRow, SloRow } from '../types.js';
import { goodOf, WindowResult } from './window.js';

export class SloSeries {
  readonly firstTs: number;
  readonly n: number;
  private preBad: Float64Array;
  private preTot: Float64Array;
  private preGap: Float64Array;
  private preMaint: Float64Array;
  private preScored: Float64Array;

  constructor(db: DatabaseSync, slo: SloRow) {
    const buckets = rows<BucketRow>(db, `SELECT * FROM buckets WHERE service_id=? ORDER BY bucket_start`, slo.service_id);
    const maint = rows<MaintenanceRow>(db, `SELECT * FROM maintenance WHERE service_id=?`, slo.service_id);
    this.firstTs = buckets.length ? buckets[0].bucket_start : 0;
    this.n = buckets.length;
    const k = this.n + 1;
    this.preBad = new Float64Array(k);
    this.preTot = new Float64Array(k);
    this.preGap = new Float64Array(k);
    this.preMaint = new Float64Array(k);
    this.preScored = new Float64Array(k);
    for (let i = 0; i < this.n; i++) {
      const b = buckets[i];
      let m = 0;
      for (const mw of maint) {
        const s = Math.max(b.bucket_start, mw.start_ts);
        const e = Math.min(b.bucket_start + BUCKET_SEC, mw.end_ts);
        if (e > s) m += (e - s) / BUCKET_SEC;
      }
      m = Math.min(1, m);
      const w = 1 - m;
      let bad = 0, tot = 0, gap = 0, scored = 0;
      if (w > 0) {
        if (b.gap) {
          gap = w;
        } else {
          const hist = JSON.parse(b.hist) as number[];
          const g = goodOf(slo, b.ok, hist);
          bad = (b.total - g) * w;
          tot = b.total * w;
          scored = w;
        }
      }
      this.preBad[i + 1] = this.preBad[i] + bad;
      this.preTot[i + 1] = this.preTot[i] + tot;
      this.preGap[i + 1] = this.preGap[i] + gap;
      this.preMaint[i + 1] = this.preMaint[i] + m;
      this.preScored[i + 1] = this.preScored[i] + scored;
    }
  }

  get endTs(): number {
    return this.firstTs + this.n * BUCKET_SEC;
  }

  window(startSec: number, endSec: number): WindowResult {
    const a = Math.max(0, Math.min(this.n, Math.round((startSec - this.firstTs) / BUCKET_SEC)));
    const b = Math.max(a, Math.min(this.n, Math.round((endSec - this.firstTs) / BUCKET_SEC)));
    const expected = Math.max(1, Math.round((endSec - startSec) / BUCKET_SEC));
    const total = this.preTot[b] - this.preTot[a];
    const bad = this.preBad[b] - this.preBad[a];
    const gapWeight = this.preGap[b] - this.preGap[a];
    const scoredWeight = this.preScored[b] - this.preScored[a];
    const maintenanceWeight = this.preMaint[b] - this.preMaint[a];
    const denom = scoredWeight + gapWeight;
    const coverage = denom > 0 ? scoredWeight / denom : 0;
    const insufficientData = scoredWeight <= 0 || coverage < 0.7 || total <= 0;
    const good = total - bad;
    return {
      expected,
      maintenanceWeight,
      gapWeight,
      scoredWeight,
      total,
      good,
      coverage,
      compliance: insufficientData ? null : good / total,
      insufficientData,
    };
  }
}
