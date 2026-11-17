import { rows } from '../db/index.js';
import { BUCKET_SEC } from '../types.js';
import { goodOf } from './window.js';
export class SloSeries {
    firstTs;
    n;
    preBad;
    preTot;
    preGap;
    preMaint;
    preScored;
    constructor(db, slo) {
        const buckets = rows(db, `SELECT * FROM buckets WHERE service_id=? ORDER BY bucket_start`, slo.service_id);
        const maint = rows(db, `SELECT * FROM maintenance WHERE service_id=?`, slo.service_id);
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
                if (e > s)
                    m += (e - s) / BUCKET_SEC;
            }
            m = Math.min(1, m);
            const w = 1 - m;
            let bad = 0, tot = 0, gap = 0, scored = 0;
            if (w > 0) {
                if (b.gap) {
                    gap = w;
                }
                else {
                    const hist = JSON.parse(b.hist);
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
    get endTs() {
        return this.firstTs + this.n * BUCKET_SEC;
    }
    window(startSec, endSec) {
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
