import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export const DB_PATH = process.env.SLO_DB ?? 'data/slo.db';
export function openDb(path = DB_PATH) {
    if (path !== ':memory:')
        mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    return db;
}
export function initSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS services(
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL,
      owner TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dependencies(
      service_id INTEGER NOT NULL REFERENCES services(id),
      upstream_id INTEGER NOT NULL REFERENCES services(id),
      weight REAL NOT NULL, -- 0..1,下游对上游的依赖强度
      PRIMARY KEY(service_id, upstream_id)
    );
    CREATE TABLE IF NOT EXISTS slos(
      id INTEGER PRIMARY KEY,
      service_id INTEGER NOT NULL REFERENCES services(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('availability','latency')),
      target REAL NOT NULL,
      latency_threshold_ms INTEGER,
      window TEXT NOT NULL CHECK(window IN ('rolling_28d','calendar_month')),
      gate_threshold REAL NOT NULL DEFAULT 0.2
    );
    CREATE TABLE IF NOT EXISTS buckets(
      service_id INTEGER NOT NULL,
      bucket_start INTEGER NOT NULL,
      total INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      hist TEXT NOT NULL,
      gap INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(service_id, bucket_start)
    );
    CREATE INDEX IF NOT EXISTS idx_buckets_svc ON buckets(service_id, bucket_start);
    CREATE TABLE IF NOT EXISTS requests(
      service_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requests_svc ON requests(service_id, ts);
    CREATE TABLE IF NOT EXISTS incidents(
      id INTEGER PRIMARY KEY,
      service_id INTEGER NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      affected_ratio REAL NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maintenance(
      id INTEGER PRIMARY KEY,
      service_id INTEGER NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts(
      id INTEGER PRIMARY KEY,
      slo_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      severity TEXT NOT NULL,
      rule TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER,
      peak_burn REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS releases(
      id INTEGER PRIMARY KEY,
      service_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      emergency INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      budget_remaining REAL,
      decided_by TEXT NOT NULL
    );
  `);
}
// node:sqlite 的 all()/get() 返回宽松索引类型,这里统一收口
export function rows(db, sql, ...params) {
    return db.prepare(sql).all(...params);
}
export function one(db, sql, ...params) {
    return db.prepare(sql).get(...params);
}
export function run(db, sql, ...params) {
    db.prepare(sql).run(...params);
}
