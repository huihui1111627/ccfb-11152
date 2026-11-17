// 数据仿真:回放半年(181 天)请求记录。
// - 30 个服务,5 分钟桶聚合写入 buckets 表(共约 156 万行)
// - 3 个"校验服务"额外写逐请求记录 requests 表,供评估时逐条重算对照
// - 16 个带标注故障(可用性/延迟/上游传导/指标缺口四类),标注含实际影响用户比例
// - 8 个计划内维护窗口(5 分钟对齐,窗口内有略高的错误率,用于验证预算剔除)
// 确定性:固定种子 RNG + 固定仿真终点,重跑结果一致。
import { rmSync } from 'node:fs';
import { initSchema, openDb, DB_PATH } from '../db/index.js';
import { BUCKET_SEC, DAY_SEC, HIST_EDGES } from '../types.js';
const SIM_END = Date.UTC(2026, 10, 17, 0, 0, 0) / 1000; // 2026-11-17T00:00:00Z
const DAYS = 181;
const SIM_START = SIM_END - DAYS * DAY_SEC;
const BUCKETS = (DAYS * DAY_SEC) / BUCKET_SEC;
// ---------- 确定性 RNG ----------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(20261117);
let spare = null;
function randn() {
    if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
    }
    let u = 0, v = 0;
    while (u === 0)
        u = rng();
    while (v === 0)
        v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
}
function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}
function poisson(lambda) {
    if (lambda <= 0)
        return 0;
    if (lambda > 30)
        return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn()));
    let k = 0, p = 1;
    const L = Math.exp(-lambda);
    do {
        k++;
        p *= rng();
    } while (p > L);
    return k - 1;
}
const S = (name, tier, owner, base, medianMs, sigma, latencySlo = false) => ({ name, tier, owner, base, medianMs, sigma, latencySlo });
const SERVICES = [
    S('charge-gateway', 'core', '充电平台组', 1400, 120, 0.55, true),
    S('order-service', 'core', '交易组', 900, 150, 0.6, true),
    S('payment-service', 'core', '支付组', 800, 180, 0.6, true),
    S('session-service', 'core', '充电平台组', 1100, 140, 0.55, true),
    S('user-service', 'core', '用户组', 700, 100, 0.5, true),
    S('auth-service', 'core', '用户组', 600, 90, 0.5, true),
    S('station-registry', 'core', '场站组', 500, 110, 0.55),
    S('pricing-service', 'edge', '交易组', 24, 160, 0.6, true), // 校验服务(逐请求)
    S('coupon-engine', 'edge', '营销组', 22, 200, 0.65, true), // 校验服务(逐请求)
    S('notification-service', 'edge', '用户组', 20, 130, 0.55, true), // 校验服务(逐请求)
    S('coupon-service', 'edge', '营销组', 300, 120, 0.55, true),
    S('billing-service', 'core', '支付组', 450, 170, 0.6, true),
    S('settlement-service', 'edge', '支付组', 250, 250, 0.65),
    S('risk-control', 'edge', '支付组', 350, 140, 0.55),
    S('map-service', 'edge', '场站组', 400, 180, 0.6, true),
    S('member-service', 'edge', '用户组', 280, 110, 0.5, true),
    S('refund-service', 'edge', '支付组', 150, 200, 0.6, true),
    S('push-service', 'edge', '用户组', 200, 100, 0.5),
    S('ocpp-connector', 'core', '物联组', 950, 160, 0.6),
    S('pile-controller', 'core', '物联组', 1000, 150, 0.55),
    S('energy-scheduler', 'edge', '物联组', 300, 220, 0.6),
    S('device-shadow', 'edge', '物联组', 350, 130, 0.55),
    S('firmware-ota', 'batch', '物联组', 120, 400, 0.7),
    S('monitor-agent', 'batch', '平台组', 180, 80, 0.5),
    S('analytics-pipeline', 'batch', '数据组', 100, 500, 0.7),
    S('report-service', 'batch', '数据组', 90, 450, 0.7),
    S('invoice-service', 'batch', '支付组', 130, 300, 0.65),
    S('crm-service', 'edge', '用户组', 160, 190, 0.6),
    S('fleet-service', 'edge', '场站组', 140, 210, 0.6, true),
    S('load-balancer-svc', 'core', '平台组', 600, 60, 0.45),
];
const VERIFY_SERVICES = new Set(['pricing-service', 'coupon-engine', 'notification-service']);
// 依赖:下游 -> [上游, 权重]
const DEPS = {
    'charge-gateway': [['auth-service', 0.8], ['session-service', 0.9], ['order-service', 0.7]],
    'order-service': [['pricing-service', 0.7], ['coupon-service', 0.5], ['station-registry', 0.7], ['user-service', 0.6]],
    'payment-service': [['risk-control', 0.8], ['settlement-service', 0.9], ['auth-service', 0.5]],
    'session-service': [['pile-controller', 0.9], ['ocpp-connector', 0.8], ['energy-scheduler', 0.6]],
    'user-service': [['auth-service', 0.9]],
    'billing-service': [['settlement-service', 0.8], ['order-service', 0.5]],
    'map-service': [['station-registry', 0.6]],
    'coupon-engine': [['coupon-service', 0.7], ['pricing-service', 0.4]],
    'member-service': [['user-service', 0.8]],
    'refund-service': [['payment-service', 0.9], ['risk-control', 0.4]],
    'notification-service': [['user-service', 0.5]],
    'push-service': [['notification-service', 0.7]],
    'firmware-ota': [['device-shadow', 0.6]],
    'monitor-agent': [['device-shadow', 0.3]],
    'analytics-pipeline': [['report-service', 0.5]],
    'report-service': [['billing-service', 0.4]],
    'invoice-service': [['billing-service', 0.8]],
    'settlement-service': [['risk-control', 0.3]],
    'load-balancer-svc': [['session-service', 0.5], ['energy-scheduler', 0.5]],
    'fleet-service': [['station-registry', 0.5], ['map-service', 0.4]],
    'crm-service': [['user-service', 0.6]],
};
const T = (day, hour, min = 0) => SIM_START + day * DAY_SEC + hour * 3600 + min * 60;
const INCIDENTS = [
    { service: 'payment-service', day: 31, hour: 14, minutes: 0, durationMin: 180, kind: 'availability', badRatio: 0.25, affected: 0.22, description: '支付通道对账异常,充电支付失败率飙升' },
    { service: 'charge-gateway', day: 33, hour: 9, minutes: 0, durationMin: 120, kind: 'availability', badRatio: 0.4, affected: 0.45, description: '网关发布引入空指针,早高峰大面积 502' },
    { service: 'session-service', day: 35, hour: 2, minutes: 0, durationMin: 480, kind: 'latency', latMult: 5, affected: 0.18, description: '会话缓存失效,启动充电耗时劣化' },
    { service: 'order-service', day: 41, hour: 20, minutes: 0, durationMin: 240, kind: 'latency', latMult: 4, affected: 0.12, description: '订单库慢查询,下单接口延迟升高' },
    { service: 'station-registry', day: 55, hour: 13, minutes: 0, durationMin: 120, kind: 'propagation', badRatio: 0.35, affected: 0.3, description: '场站注册库主从切换失败,下游下单/地图受影响' },
    { service: 'auth-service', day: 63, hour: 4, minutes: 0, durationMin: 90, kind: 'propagation', badRatio: 0.3, affected: 0.25, description: '鉴权证书过期,登录与网关鉴权连锁失败' },
    { service: 'monitor-agent', day: 70, hour: 11, minutes: 0, durationMin: 25, kind: 'gap', affected: 0, description: '监控代理升级,指标上报缺口 25 分钟(无用户影响)' },
    { service: 'ocpp-connector', day: 78, hour: 1, minutes: 0, durationMin: 300, kind: 'availability', badRatio: 0.15, affected: 0.1, description: 'OCPP 连接池泄漏,部分桩离线' },
    { service: 'pricing-service', day: 84, hour: 16, minutes: 0, durationMin: 180, kind: 'latency', latMult: 6, affected: 0.08, description: '计价规则引擎 GC 停顿,报价延迟劣化' },
    { service: 'settlement-service', day: 92, hour: 3, minutes: 0, durationMin: 120, kind: 'availability', badRatio: 0.3, affected: 0.05, description: '结算任务死锁,结算接口超时' },
    { service: 'energy-scheduler', day: 101, hour: 22, minutes: 0, durationMin: 240, kind: 'propagation', badRatio: 0.25, affected: 0.15, description: '负荷调度策略异常,有序充电与会话服务连锁劣化' },
    { service: 'firmware-ota', day: 110, hour: 10, minutes: 0, durationMin: 360, kind: 'availability', badRatio: 0.1, affected: 0.02, description: 'OTA 分发节点故障,固件下载失败率升高' },
    { service: 'map-service', day: 120, hour: 12, minutes: 0, durationMin: 300, kind: 'latency', latMult: 3, affected: 0.06, description: '地图瓦片缓存击穿,找桩页加载变慢' },
    { service: 'report-service', day: 128, hour: 15, minutes: 0, durationMin: 40, kind: 'gap', affected: 0, description: '报表服务指标管道重启,上报缺口 40 分钟(无用户影响)' },
    { service: 'notification-service', day: 140, hour: 8, minutes: 0, durationMin: 90, kind: 'availability', badRatio: 0.2, affected: 0.04, description: '消息推送供应商故障,充电完成通知丢失' },
    { service: 'coupon-engine', day: 155, hour: 18, minutes: 0, durationMin: 120, kind: 'latency', latMult: 3, badRatio: 0.12, affected: 0.03, description: '优惠券引擎规则冲突,既慢又错' },
];
const MAINTENANCE = [
    { service: 'firmware-ota', day: 30, hour: 2, durationMin: 180, badRatio: 0.02, reason: '固件批量升级窗口' },
    { service: 'settlement-service', day: 60, hour: 1, durationMin: 120, badRatio: 0.05, reason: '结算库迁移' },
    { service: 'charge-gateway', day: 88, hour: 4, durationMin: 60, badRatio: 0.01, reason: '网关证书轮换' },
    { service: 'user-service', day: 97, hour: 2, durationMin: 120, badRatio: 0.03, reason: '用户库分片扩容' },
    { service: 'analytics-pipeline', day: 115, hour: 3, durationMin: 240, badRatio: 0.04, reason: '数仓维护' },
    { service: 'billing-service', day: 133, hour: 2, durationMin: 120, badRatio: 0.03, reason: '计费系统升级' },
    { service: 'device-shadow', day: 150, hour: 1, durationMin: 120, badRatio: 0.02, reason: '设备影子服务重构发布' },
    { service: 'report-service', day: 165, hour: 2, durationMin: 240, badRatio: 0.02, reason: '报表库归档' },
];
const AVAIL_TARGET = { core: 0.999, edge: 0.995, batch: 0.99 };
const BASELINE_BAD = { core: 0.0002, edge: 0.001, batch: 0.002 }; // 基线远低于允许线,避免预算日常空耗
const LAT_TARGET = 0.99;
function latencyThreshold(medianMs, sigma) {
    // 阈值取健康 p99.9 之上的最小直方图边界,避免"阈值严于健康 p95"导致健康服务误不达标
    const need = medianMs * Math.exp(3.0 * sigma);
    for (const e of HIST_EDGES)
        if (e >= need)
            return e;
    return HIST_EDGES[HIST_EDGES.length - 1];
}
// 某服务某时刻的故障环境(自身故障 + 维护 + 上游传导,上游只传一层)
function envAt(name, t, incByService, maintByService) {
    let bad = 0, latMult = 1, gap = false;
    const own = incByService.get(name) ?? [];
    for (const inc of own) {
        if (t < inc.start || t >= inc.end)
            continue;
        if (inc.kind === 'gap') {
            gap = true;
            continue;
        }
        if (inc.badRatio)
            bad = Math.max(bad, inc.badRatio);
        if (inc.latMult)
            latMult = Math.max(latMult, inc.latMult);
    }
    for (const m of maintByService.get(name) ?? []) {
        if (t >= m.start && t < m.end)
            bad = Math.max(bad, m.badRatio);
    }
    for (const [up, w] of DEPS[name] ?? []) {
        for (const inc of incByService.get(up) ?? []) {
            if (inc.kind === 'gap' || t < inc.start || t >= inc.end)
                continue;
            if (inc.badRatio)
                bad = Math.min(0.95, bad + w * 0.8 * inc.badRatio);
            if (inc.latMult)
                latMult = Math.max(latMult, 1 + w * 0.5 * (inc.latMult - 1));
        }
    }
    return { bad, latMult, gap };
}
function diurnal(t) {
    const hour = new Date(t * 1000).getUTCHours();
    return 0.65 + 0.35 * Math.sin((2 * Math.PI * (hour - 6)) / 24); // 白天高、凌晨低
}
function main() {
    rmSync(DB_PATH, { force: true });
    const db = openDb();
    initSchema(db);
    console.log(`仿真区间 ${new Date(SIM_START * 1000).toISOString()} ~ ${new Date(SIM_END * 1000).toISOString()},${SERVICES.length} 个服务,${BUCKETS} 桶/服务`);
    const svcId = new Map();
    const insertSvc = db.prepare(`INSERT INTO services(name, tier, owner) VALUES(?,?,?)`);
    const insertDep = db.prepare(`INSERT INTO dependencies(service_id, upstream_id, weight) VALUES(?,?,?)`);
    const insertSlo = db.prepare(`INSERT INTO slos(service_id, name, type, target, latency_threshold_ms, window, gate_threshold) VALUES(?,?,?,?,?,?,?)`);
    const insertBucket = db.prepare(`INSERT INTO buckets(service_id, bucket_start, total, ok, hist, gap) VALUES(?,?,?,?,?,?)`);
    const insertReq = db.prepare(`INSERT INTO requests(service_id, ts, ok, latency_ms) VALUES(?,?,?,?)`);
    const insertInc = db.prepare(`INSERT INTO incidents(service_id, start_ts, end_ts, kind, affected_ratio, description) VALUES(?,?,?,?,?,?)`);
    const insertMaint = db.prepare(`INSERT INTO maintenance(service_id, start_ts, end_ts, reason) VALUES(?,?,?,?)`);
    db.exec('BEGIN');
    SERVICES.forEach((s, i) => {
        insertSvc.run(s.name, s.tier, s.owner);
        svcId.set(s.name, i + 1);
    });
    for (const [down, ups] of Object.entries(DEPS)) {
        for (const [up, w] of ups)
            insertDep.run(svcId.get(down), svcId.get(up), w);
    }
    // SLO 定义:可用性全覆盖,用户面服务加延迟 SLO;窗口滚动 28 天 / 自然月按 2:1 混合
    let sloSeq = 0;
    for (const s of SERVICES) {
        const id = svcId.get(s.name);
        const availWindow = sloSeq++ % 3 === 2 || s.name === 'notification-service' ? 'calendar_month' : 'rolling_28d';
        insertSlo.run(id, `${s.name} 可用性`, 'availability', AVAIL_TARGET[s.tier], null, availWindow, 0.2);
        if (s.latencySlo) {
            const latWindow = sloSeq++ % 3 === 2 || s.name === 'coupon-engine' ? 'calendar_month' : 'rolling_28d';
            insertSlo.run(id, `${s.name} 延迟达标`, 'latency', LAT_TARGET, latencyThreshold(s.medianMs, s.sigma), latWindow, 0.2);
        }
    }
    db.exec('COMMIT');
    const incByService = new Map();
    db.exec('BEGIN');
    for (const inc of INCIDENTS) {
        const start = T(inc.day, inc.hour, inc.minutes);
        const end = start + inc.durationMin * 60;
        insertInc.run(svcId.get(inc.service), start, end, inc.kind, inc.affected, inc.description);
        const list = incByService.get(inc.service) ?? [];
        list.push({ ...inc, start, end });
        incByService.set(inc.service, list);
    }
    const maintByService = new Map();
    for (const m of MAINTENANCE) {
        const start = T(m.day, m.hour);
        const end = start + m.durationMin * 60;
        insertMaint.run(svcId.get(m.service), start, end, m.reason);
        const list = maintByService.get(m.service) ?? [];
        list.push({ ...m, start, end });
        maintByService.set(m.service, list);
    }
    db.exec('COMMIT');
    // ---------- 指标回放 ----------
    let bucketRows = 0, reqRows = 0;
    const t0 = Date.now();
    for (const s of SERVICES) {
        const id = svcId.get(s.name);
        const baseline = BASELINE_BAD[s.tier];
        const verify = VERIFY_SERVICES.has(s.name);
        db.exec('BEGIN');
        for (let i = 0; i < BUCKETS; i++) {
            const ts = SIM_START + i * BUCKET_SEC;
            const env = envAt(s.name, ts, incByService, maintByService);
            if (env.gap) {
                insertBucket.run(id, ts, 0, 0, JSON.stringify(new Array(HIST_EDGES.length + 1).fill(0)), 1);
                bucketRows++;
                continue;
            }
            const total = Math.max(1, Math.round(s.base * diurnal(ts) * (0.9 + 0.2 * rng())));
            const badRatio = Math.max(baseline, env.bad);
            const latMult = env.latMult;
            if (verify) {
                // 逐请求生成,再聚合成桶 —— 模拟真实"请求 -> 指标管道 -> 桶"上报路径
                const hist = new Array(HIST_EDGES.length + 1).fill(0);
                let ok = 0;
                for (let r = 0; r < total; r++) {
                    const good = rng() >= badRatio;
                    const lat = Math.max(1, Math.round(s.medianMs * latMult * Math.exp(s.sigma * randn()) * (good ? 1 : 1.5)));
                    if (good)
                        ok++;
                    let hi = 0;
                    while (hi < HIST_EDGES.length && lat > HIST_EDGES[hi])
                        hi++;
                    hist[hi]++;
                    insertReq.run(id, ts + Math.floor(rng() * BUCKET_SEC), good ? 1 : 0, lat);
                    reqRows++;
                }
                insertBucket.run(id, ts, total, ok, JSON.stringify(hist), 0);
            }
            else {
                const bad = Math.min(total, poisson(total * badRatio));
                const hist = new Array(HIST_EDGES.length + 1).fill(0);
                const mu = Math.log(s.medianMs * latMult * (0.95 + 0.1 * rng()));
                let prev = 0;
                for (let e = 0; e < HIST_EDGES.length; e++) {
                    const cdf = normalCdf((Math.log(HIST_EDGES[e]) - mu) / s.sigma);
                    hist[e] = Math.round(total * Math.max(0, cdf - prev));
                    prev = cdf;
                }
                hist[HIST_EDGES.length] = Math.max(0, total - hist.slice(0, -1).reduce((a, b) => a + b, 0));
                insertBucket.run(id, ts, total, total - bad, JSON.stringify(hist), 0);
            }
            bucketRows++;
        }
        db.exec('COMMIT');
        console.log(`  ${s.name} 完成${verify ? '(含逐请求记录)' : ''}`);
    }
    console.log(`完成:buckets ${bucketRows} 行,requests ${reqRows} 行,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    db.close();
}
main();
