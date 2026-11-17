// HTTP 服务:node:http 裸实现,JSON API + 静态前端。
// "当前时间"取数据集中最新桶的结束时刻(数据是回放的历史数据)。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { initSchema, one, openDb, rows } from '../db/index.js';
import { budgetStatus } from '../slo/budget.js';
import { weeklyCsv } from '../slo/compliance.js';
import { evaluateGate, requestRelease } from '../slo/gate.js';
import { dependencyImpact } from '../slo/impact.js';
import { computeWindow } from '../slo/window.js';
import { BUCKET_SEC } from '../types.js';
const db = openDb();
initSchema(db);
const PORT = Number(process.env.PORT ?? 3000);
function now() {
    return one(db, `SELECT MAX(bucket_start) AS mx FROM buckets`).mx + BUCKET_SEC;
}
function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
async function body(req) {
    let s = '';
    for await (const c of req)
        s += c;
    return s ? JSON.parse(s) : {};
}
const STATIC = {
    '/': ['web/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
};
function sloWithStatus(slo, t) {
    const b = budgetStatus(db, slo, t);
    return { ...slo, budget: b };
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    const t = now();
    try {
        if (req.method === 'GET' && STATIC[path]) {
            const [file, type] = STATIC[path];
            res.writeHead(200, { 'Content-Type': type });
            res.end(readFileSync(file));
            return;
        }
        if (path === '/api/overview' && req.method === 'GET') {
            const out = rows(db, `SELECT * FROM services ORDER BY name`).map((svc) => {
                const svcSlos = rows(db, `SELECT * FROM slos WHERE service_id=?`, svc.id);
                const statuses = svcSlos.map((s) => ({ slo: s, b: budgetStatus(db, s, t) }));
                const worst = statuses.reduce((acc, cur) => (!acc || cur.b.remainingFraction < acc.b.remainingFraction ? cur : acc), null);
                const activeAlerts = one(db, `SELECT COUNT(*) AS n FROM alerts WHERE service_id=? AND resolved_at IS NULL`, svc.id).n;
                const impact = dependencyImpact(db, svc.id, t);
                return {
                    ...svc,
                    sloCount: svcSlos.length,
                    worstRemaining: worst && !worst.b.insufficientData ? worst.b.remainingFraction : null,
                    worstCompliance: worst?.b.compliance ?? null,
                    insufficient: statuses.every((s) => s.b.insufficientData),
                    activeAlerts,
                    impacted: impact.impacted,
                };
            });
            return json(res, { now: t, services: out });
        }
        if (path === '/api/services' && req.method === 'GET') {
            return json(res, rows(db, `SELECT * FROM services ORDER BY name`));
        }
        const svcMatch = path.match(/^\/api\/services\/(\d+)$/);
        if (svcMatch && req.method === 'GET') {
            const id = Number(svcMatch[1]);
            const svc = one(db, `SELECT * FROM services WHERE id=?`, id);
            if (!svc)
                return json(res, { error: 'not found' }, 404);
            const svcSlos = rows(db, `SELECT * FROM slos WHERE service_id=?`, id).map((s) => sloWithStatus(s, t));
            const alerts = rows(db, `SELECT * FROM alerts WHERE service_id=? ORDER BY opened_at DESC LIMIT 20`, id);
            const releases = rows(db, `SELECT * FROM releases WHERE service_id=? ORDER BY requested_at DESC LIMIT 20`, id);
            const impact = dependencyImpact(db, id, t);
            return json(res, { ...svc, slos: svcSlos, alerts, releases, impact });
        }
        if (path === '/api/slos' && req.method === 'GET') {
            const out = rows(db, `SELECT slos.*, services.name AS service_name FROM slos JOIN services ON services.id=slos.service_id ORDER BY service_name, slos.id`).map((s) => sloWithStatus(s, t));
            return json(res, out);
        }
        const sloMatch = path.match(/^\/api\/slos\/(\d+)$/);
        if (sloMatch && req.method === 'GET') {
            const slo = one(db, `SELECT * FROM slos WHERE id=?`, Number(sloMatch[1]));
            if (!slo)
                return json(res, { error: 'not found' }, 404);
            const svc = one(db, `SELECT * FROM services WHERE id=?`, slo.service_id);
            const win = computeWindow(db, slo, ...(() => {
                const b = budgetStatus(db, slo, t);
                return [b.windowStart, b.windowEnd];
            })());
            return json(res, { ...slo, service_name: svc.name, budget: budgetStatus(db, slo, t), window: win });
        }
        const seriesMatch = path.match(/^\/api\/slos\/(\d+)\/series$/);
        if (seriesMatch && req.method === 'GET') {
            const slo = one(db, `SELECT * FROM slos WHERE id=?`, Number(seriesMatch[1]));
            if (!slo)
                return json(res, { error: 'not found' }, 404);
            const days = Math.min(28, Number(url.searchParams.get('days') ?? 7));
            const step = 1800; // 30 分钟一个点
            const pts = [];
            for (let ts = t - days * 86400; ts <= t; ts += step) {
                const w = computeWindow(db, slo, ts - 6 * 3600, ts);
                pts.push({
                    t: ts,
                    burn: w.insufficientData || w.total <= 0 ? null : (1 - w.good / w.total) / (1 - slo.target),
                });
            }
            return json(res, { sloId: slo.id, step, points: pts });
        }
        if (path === '/api/alerts' && req.method === 'GET') {
            const activeOnly = url.searchParams.get('active') === '1';
            const where = activeOnly ? `WHERE a.resolved_at IS NULL` : '';
            return json(res, rows(db, `SELECT a.*, s.name AS service_name, sl.name AS slo_name FROM alerts a
         JOIN services s ON s.id=a.service_id JOIN slos sl ON sl.id=a.slo_id
         ${where} ORDER BY a.opened_at DESC LIMIT 200`));
        }
        if (path === '/api/releases' && req.method === 'GET') {
            const svcId = url.searchParams.get('service_id');
            const where = svcId ? `WHERE r.service_id=${Number(svcId)}` : '';
            return json(res, rows(db, `SELECT r.*, s.name AS service_name FROM releases r JOIN services s ON s.id=r.service_id ${where} ORDER BY r.requested_at DESC LIMIT 200`));
        }
        if (path === '/api/releases' && req.method === 'POST') {
            const b = await body(req);
            const rel = requestRelease(db, Number(b.service_id), String(b.version ?? ''), {
                emergency: Boolean(b.emergency),
                reason: String(b.reason ?? ''),
                decidedBy: String(b.decided_by ?? 'web'),
                now: t,
            });
            return json(res, rel, rel.status === 'blocked' ? 409 : 200);
        }
        const gateMatch = path.match(/^\/api\/gate\/(\d+)$/);
        if (gateMatch && req.method === 'GET') {
            return json(res, evaluateGate(db, Number(gateMatch[1]), t));
        }
        if (path === '/api/dependencies' && req.method === 'GET') {
            const nodes = rows(db, `SELECT * FROM services`).map((svc) => {
                const impact = dependencyImpact(db, svc.id, t);
                return { ...svc, burn: impact.selfBurn, impacted: impact.impacted, impactScore: impact.impactScore };
            });
            const edges = rows(db, `SELECT * FROM dependencies`);
            return json(res, { nodes, edges });
        }
        const impactMatch = path.match(/^\/api\/impact\/(\d+)$/);
        if (impactMatch && req.method === 'GET') {
            return json(res, dependencyImpact(db, Number(impactMatch[1]), t));
        }
        const csvMatch = path.match(/^\/api\/compliance\/(\d+)\.csv$/);
        if (csvMatch && req.method === 'GET') {
            const slo = one(db, `SELECT * FROM slos WHERE id=?`, Number(csvMatch[1]));
            if (!slo)
                return json(res, { error: 'not found' }, 404);
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="slo-${slo.id}-weekly.csv"` });
            res.end(weeklyCsv(db, slo));
            return;
        }
        if (path === '/api/maintenance' && req.method === 'GET') {
            return json(res, rows(db, `SELECT m.*, s.name AS service_name FROM maintenance m JOIN services s ON s.id=m.service_id ORDER BY m.start_ts DESC`));
        }
        json(res, { error: 'not found' }, 404);
    }
    catch (e) {
        json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
});
server.listen(PORT, () => {
    console.log(`SLO 平台: http://localhost:${PORT}(数据"当前时间" ${new Date(now() * 1000).toISOString()})`);
});
