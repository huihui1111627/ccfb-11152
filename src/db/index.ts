import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ALERT_PROFILES,
  buildSloDefs,
  GATE_POLICY,
  SERVICES,
} from '../config/catalog.js';
import type { AlertProfile } from '../shared/types.js';

let dbInstance: DatabaseSync | null = null;

export function getDb(dbPath = 'data/slo.db'): DatabaseSync {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA temp_store=MEMORY;');
  db.exec('PRAGMA cache_size=-65536;'); // 64MB
  db.exec('PRAGMA foreign_keys=ON;');
  createSchema(db);
  seedStaticData(db);
  dbInstance = db;
  return db;
}

/** 仅供测试/多实例场景使用 */
export function closeDb(): void {
  dbInstance?.close();
  dbInstance = null;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL,
      owner TEXT NOT NULL,
      description TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      base_traffic REAL NOT NULL,
      base_error_rate REAL NOT NULL,
      base_latency_median REAL NOT NULL,
      p95_factor REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slo_defs (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id),
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      target REAL NOT NULL,
      threshold_ms INTEGER,
      window_type TEXT NOT NULL,
      alert_profile_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gate_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL
    );

    -- 热数据表:每个服务每 5 分钟一行
    CREATE TABLE IF NOT EXISTS metric_buckets (
      bucket_ts INTEGER NOT NULL,
      service_id TEXT NOT NULL REFERENCES services(id),
      total INTEGER NOT NULL,
      good INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      latency_good INTEGER NOT NULL,
      reported INTEGER NOT NULL,
      PRIMARY KEY (service_id, bucket_ts)
    ) WITHOUT ROWID;

    -- 延迟直方图 BLOB:uint16 小端,17 个 bin,与 metric_buckets 1:1
    CREATE TABLE IF NOT EXISTS latency_hist (
      service_id TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      hist BLOB NOT NULL,
      PRIMARY KEY (service_id, bucket_ts)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_buckets_ts ON metric_buckets(bucket_ts);

    CREATE TABLE IF NOT EXISTS faults (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id),
      kind TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      magnitude REAL NOT NULL,
      latency_multiplier REAL,
      note TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL REFERENCES services(id),
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slo_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      detector TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      resolved_at INTEGER,
      short_window_hours REAL,
      long_window_hours REAL,
      short_burn_rate REAL,
      long_burn_rate REAL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alert_events(fired_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_svc ON alert_events(service_id, detector);

    CREATE TABLE IF NOT EXISTS release_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL REFERENCES services(id),
      kind TEXT NOT NULL,
      version TEXT NOT NULL,
      requester TEXT NOT NULL,
      reason TEXT,
      decision TEXT NOT NULL,
      min_budget_fraction REAL,
      gate_threshold REAL NOT NULL,
      decided_at INTEGER NOT NULL,
      ticket TEXT
    );

    -- 模拟元信息(时间范围、生成时间)
    CREATE TABLE IF NOT EXISTS sim_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seedStaticData(db: DatabaseSync): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM services').get() as { c: number };
  if (count.c > 0) return;

  const insSvc = db.prepare(`
    INSERT INTO services (id, name, tier, owner, description, dependencies_json,
      base_traffic, base_error_rate, base_latency_median, p95_factor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of SERVICES) {
    insSvc.run(
      s.id, s.name, s.tier, s.owner, s.description, JSON.stringify(s.dependencies),
      s.baseTraffic, s.baseErrorRate, s.baseLatencyMedian, s.p95Factor,
    );
  }

  const insSlo = db.prepare(`
    INSERT INTO slo_defs (id, service_id, kind, name, target, threshold_ms, window_type, alert_profile_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of buildSloDefs()) {
    insSlo.run(d.id, d.serviceId, d.kind, d.name, d.target, d.thresholdMs, d.windowType, d.alertProfileId);
  }

  const insProfile = db.prepare('INSERT INTO alert_profiles (id, name, config_json) VALUES (?, ?, ?)');
  for (const p of ALERT_PROFILES) {
    insProfile.run(p.id, p.name, JSON.stringify(p));
  }

  db.prepare('INSERT INTO gate_policy (id, config_json) VALUES (1, ?)').run(JSON.stringify(GATE_POLICY));
}

export function getAlertProfile(db: DatabaseSync, id: string): AlertProfile {
  const row = db.prepare('SELECT config_json FROM alert_profiles WHERE id = ?').get(id) as
    | { config_json: string }
    | undefined;
  if (!row) throw new Error(`未知告警策略: ${id}`);
  return JSON.parse(row.config_json) as AlertProfile;
}

export function getGatePolicy(db: DatabaseSync): import('../shared/types.js').GatePolicy {
  const row = db.prepare('SELECT config_json FROM gate_policy WHERE id = 1').get() as
    | { config_json: string }
    | undefined;
  if (!row) throw new Error('闸门策略未初始化');
  return JSON.parse(row.config_json) as import('../shared/types.js').GatePolicy;
}

export function setGatePolicy(db: DatabaseSync, policy: import('../shared/types.js').GatePolicy): void {
  db.prepare('UPDATE gate_policy SET config_json = ? WHERE id = 1').run(JSON.stringify(policy));
}

export function setSimMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sim_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getSimMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM sim_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** node:sqlite 的 all()/get() 输出为宽松索引类型,统一在边界处收口 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function rows<T>(stmt: any, ...args: any[]): T[] {
  return stmt.all(...args) as T[];
}

export function one<T>(stmt: any, ...args: any[]): T | undefined {
  return stmt.get(...args) as T | undefined;
}
