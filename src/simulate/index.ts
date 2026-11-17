import { getDb, setSimMeta } from '../db/index.js';
import {
  FAULT_PLAN,
  MAINTENANCE_PLAN,
  SIMULATION_DAYS,
} from '../config/catalog.js';
import type { FaultSpec } from '../shared/types.js';
import { BUCKET_MS, DAY_MS } from '../shared/types.js';
import { MetricGenerator } from './generator.js';
import { encodeHist } from '../slo/histogram.js';

/**
 * 生成半年模拟数据。
 * 时间范围:以今天 UTC 00:00 为终点,往前 181 天。
 * 故障/维护按相对天偏移实例化,保证可复现。
 */
export function materializeFaults(rangeStart: number): FaultSpec[] {
  return FAULT_PLAN.map((p) => ({
    id: p.id,
    serviceId: p.serviceId,
    kind: p.kind,
    start: rangeStart + p.startDay * DAY_MS + p.startHour * 3_600_000,
    end: rangeStart + p.startDay * DAY_MS + (p.startHour + p.durationHours) * 3_600_000,
    magnitude: p.magnitude,
    latencyMultiplier: p.latencyMultiplier,
    note: p.note,
  }));
}

function materializeMaintenance(rangeStart: number) {
  return MAINTENANCE_PLAN.map((m) => ({
    serviceId: m.serviceId,
    start: rangeStart + m.startDay * DAY_MS + m.startHour * 3_600_000,
    end: rangeStart + m.startDay * DAY_MS + (m.startHour + m.durationHours) * 3_600_000,
    reason: m.reason,
  }));
}

export function runSimulation(dbPath = 'data/slo.db'): {
  rangeStart: number;
  rangeEnd: number;
  bucketCount: number;
  serviceCount: number;
} {
  const db = getDb(dbPath);

  // 幂等:清空旧的生成数据
  db.exec(`
    DELETE FROM metric_buckets;
    DELETE FROM latency_hist;
    DELETE FROM faults;
    DELETE FROM maintenance_windows;
    DELETE FROM alert_events;
    DELETE FROM release_requests;
    DELETE FROM sim_meta;
  `);

  const now = new Date();
  const rangeEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rangeStart = rangeEnd - SIMULATION_DAYS * DAY_MS;

  const faults = materializeFaults(rangeStart);
  const maintenance = materializeMaintenance(rangeStart);

  const insFault = db.prepare(`
    INSERT INTO faults (id, service_id, kind, start_ts, end_ts, magnitude, latency_multiplier, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of faults) {
    insFault.run(f.id, f.serviceId, f.kind, f.start, f.end, f.magnitude, f.latencyMultiplier ?? null, f.note);
  }
  const insMaint = db.prepare(
    'INSERT INTO maintenance_windows (service_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?)',
  );
  for (const m of maintenance) {
    insMaint.run(m.serviceId, m.start, m.end, m.reason);
  }

  const generator = new MetricGenerator(faults, maintenance, rangeStart, rangeEnd);
  const bucketCount = generator.slotCount;

  const insBucket = db.prepare(`
    INSERT INTO metric_buckets (bucket_ts, service_id, total, good, errors, latency_good, reported)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insHist = db.prepare(
    'INSERT INTO latency_hist (service_id, bucket_ts, hist) VALUES (?, ?, ?)',
  );

  let written = 0;
  const BATCH = 288; // 一天
  db.exec('BEGIN');
  try {
    for (let slot = 0; slot < bucketCount; slot++) {
      const ts = rangeStart + slot * BUCKET_MS;
      const records = generator.generateBucket(ts);
      for (const r of records) {
        insBucket.run(
          r.bucketTs, r.serviceId, r.total, r.good, r.errors, r.latencyGood, r.reported ? 1 : 0,
        );
        insHist.run(r.serviceId, r.bucketTs, encodeHist(r.hist));
      }
      written += records.length;
      if (slot > 0 && slot % BATCH === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN');
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  setSimMeta(db, 'rangeStart', String(rangeStart));
  setSimMeta(db, 'rangeEnd', String(rangeEnd));
  setSimMeta(db, 'generatedAt', String(Date.now()));

  const serviceCount = (db.prepare('SELECT COUNT(*) AS c FROM services').get() as { c: number }).c;
  return { rangeStart, rangeEnd, bucketCount, serviceCount };
}

// 直接执行: npm run simulate
if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const result = runSimulation();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('✅ 模拟数据生成完成');
  console.log(`   时间范围: ${new Date(result.rangeStart).toISOString().slice(0, 10)} ~ ${new Date(result.rangeEnd).toISOString().slice(0, 10)}`);
  console.log(`   服务数:   ${result.serviceCount}`);
  console.log(`   桶数:     ${result.bucketCount}(每服务),总记录 ${result.bucketCount * result.serviceCount} 行`);
  console.log(`   耗时:     ${elapsed}s`);
}
