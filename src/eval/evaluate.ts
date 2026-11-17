// 评估回放:用带标注的半年数据验证平台行为。
//  1. 窗口一致性:校验服务逐请求重算 vs 引擎窗口聚合,结果必须一致
//  2. 缺口识别:上报缺口不计入分母、不误判故障、不触发告警
//  3. 维护剔除:计划内维护的坏请求不进预算
//  4. 预算连续:自然月/滚动窗口切换时预算不跳变
//  5. 告警质量:MWMB 零漏报(重大故障),并对比固定阈值基线的告警量
//  6. 发布闸门:拦截与标注风险时段对齐,紧急发布留痕
//  7. 耗尽预测:预算耗尽前给出量级正确的预测
//  8. 周报导出:CSV 行数、覆盖率、故障周达标率下降
import { initSchema, one, openDb, rows, run } from '../db/index.js';
import { budgetStatusFrom } from '../slo/budget.js';
import { weeklyCsv } from '../slo/compliance.js';
import { gateVerdict } from '../slo/gate.js';
import { SloSeries } from '../slo/rollup.js';
import { replayAlerts, AlertEvent } from '../slo/stream.js';
import { computeWindow } from '../slo/window.js';
import { BUCKET_SEC, DAY_SEC, IncidentRow, MaintenanceRow, ServiceRow, SloRow } from '../types.js';

const db = openDb();
initSchema(db);

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const services = rows<ServiceRow>(db, `SELECT * FROM services`);
const slos = rows<SloRow>(db, `SELECT * FROM slos`);
const svcById = new Map(services.map((s) => [s.id, s]));
const sloById = new Map(slos.map((s) => [s.id, s]));
const incidents = rows<IncidentRow>(db, `SELECT * FROM incidents`);
const upstreamOf = new Map<number, number[]>();
for (const d of rows<{ service_id: number; upstream_id: number }>(db, `SELECT * FROM dependencies`)) {
  const l = upstreamOf.get(d.service_id) ?? [];
  l.push(d.upstream_id);
  upstreamOf.set(d.service_id, l);
}

const simStart = one<{ mn: number }>(db, `SELECT MIN(bucket_start) AS mn FROM buckets`)!.mn;
const simEnd = one<{ mx: number }>(db, `SELECT MAX(bucket_start) AS mx FROM buckets`)!.mx + BUCKET_SEC;
console.log(`数据区间 ${new Date(simStart * 1000).toISOString()} ~ ${new Date(simEnd * 1000).toISOString()}`);

// 预建内存序列(供预算/闸门高频计算)
console.log('构建内存前缀和...');
const seriesBySlo = new Map<number, SloSeries>();
for (const slo of slos) seriesBySlo.set(slo.id, new SloSeries(db, slo));
const winFn = (slo: SloRow) => {
  const s = seriesBySlo.get(slo.id)!;
  return (a: number, b: number) => s.window(a, b);
};

// ---------- 告警回放(MWMB)落库 ----------
console.log('回放 MWMB 告警...');
run(db, `DELETE FROM alerts`);
run(db, `DELETE FROM releases`);
const allAlerts: AlertEvent[] = [];
db.exec('BEGIN');
const insAlert = db.prepare(
  `INSERT INTO alerts(slo_id, service_id, severity, rule, opened_at, resolved_at, peak_burn) VALUES(?,?,?,?,?,?,?)`,
);
for (const slo of slos) {
  for (const ev of replayAlerts(db, slo)) {
    allAlerts.push(ev);
    insAlert.run(ev.sloId, ev.serviceId, ev.severity, ev.rule, ev.openedAt, ev.resolvedAt, ev.peakBurn);
  }
}
db.exec('COMMIT');
console.log(`  MWMB 告警 ${allAlerts.length} 条(critical ${allAlerts.filter((a) => a.severity === 'critical').length})`);

// ---------- 发布闸门回放:每 2 小时一个服务发起非紧急发布 ----------
console.log('回放发布请求...');
const alertsByService = new Map<number, AlertEvent[]>();
for (const a of allAlerts) {
  const l = alertsByService.get(a.serviceId) ?? [];
  l.push(a);
  alertsByService.set(a.serviceId, l);
}
const activeCriticalAt = (serviceId: number, t: number) =>
  (alertsByService.get(serviceId) ?? []).filter(
    (a) => a.severity === 'critical' && a.openedAt <= t && (a.resolvedAt === null || a.resolvedAt > t),
  ).length;

db.exec('BEGIN');
const insRel = db.prepare(
  `INSERT INTO releases(service_id, version, requested_at, status, emergency, reason, budget_remaining, decided_by) VALUES(?,?,?,?,?,?,?,?)`,
);
let relCount = 0;
for (let t = simStart + 28 * DAY_SEC, i = 0; t < simEnd; t += 2 * 3600, i++) {
  const svc = services[i % services.length];
  const svcSlos = slos.filter((s) => s.service_id === svc.id);
  const verdict = gateVerdict(
    svcSlos,
    (slo) => budgetStatusFrom(winFn(slo), slo, t),
    activeCriticalAt(svc.id, t),
  );
  insRel.run(svc.id, `v2026.${i}`, t, verdict.allowed ? 'approved' : 'blocked', 0, '', verdict.worstRemaining, 'eval-bot');
  relCount++;
}
db.exec('COMMIT');
console.log(`  发布请求 ${relCount} 条`);

// ================= 检查 1:窗口一致性(逐请求重算) =================
console.log('\n检查 1:窗口达标率 vs 原始请求逐条重算');
{
  const VERIFY = ['pricing-service', 'coupon-engine', 'notification-service'];
  let compared = 0, skipped = 0, maxDiff = 0;
  for (const name of VERIFY) {
    const svc = services.find((s) => s.name === name)!;
    const svcSlos = slos.filter((s) => s.service_id === svc.id);
    const maint = rows<MaintenanceRow>(db, `SELECT * FROM maintenance WHERE service_id=?`, svc.id);
    const notClause = maint.map(() => `NOT (ts >= ? AND ts < ?)`).join(' AND ');
    const maintParams = maint.flatMap((m) => [m.start_ts, m.end_ts]);
    for (const slo of svcSlos) {
      for (let t = simStart + 28 * DAY_SEC; t <= simEnd; t += DAY_SEC) {
        const ws = slo.window === 'rolling_28d'
          ? t - 28 * DAY_SEC
          : (() => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; })();
        const w = computeWindow(db, slo, ws, t);
        if (w.insufficientData) { skipped++; continue; }
        const goodExpr = slo.type === 'availability' ? 'SUM(ok)' : `SUM(latency_ms <= ${slo.latency_threshold_ms})`;
        const sql = `SELECT COUNT(*) AS c, ${goodExpr} AS g FROM requests WHERE service_id=? AND ts>=? AND ts<?${notClause ? ' AND ' + notClause : ''}`;
        const r = one<{ c: number; g: number }>(db, sql, svc.id, ws, t, ...maintParams)!;
        const recomputed = r.g / r.c;
        const diff = Math.abs(recomputed - w.compliance!);
        maxDiff = Math.max(maxDiff, diff);
        compared++;
      }
    }
  }
  check('逐请求重算一致', compared > 0 && maxDiff < 1e-9, `对比 ${compared} 个窗口(跳过数据不足 ${skipped}),最大偏差 ${maxDiff.toExponential(2)}`);
}

// ================= 检查 2:缺口识别 =================
console.log('\n检查 2:指标缺口 — 没数据 ≠ 故障');
{
  const gaps = incidents.filter((i) => i.kind === 'gap');
  let allOk = true;
  for (const g of gaps) {
    const svcSlos = slos.filter((s) => s.service_id === g.service_id);
    const gapBuckets = Math.round((g.end_ts - g.start_ts) / BUCKET_SEC);
    for (const slo of svcSlos) {
      const w = computeWindow(db, slo, g.start_ts - 3600, g.end_ts + 3600);
      const scoredExpected = w.expected - w.maintenanceWeight - gapBuckets;
      if (Math.abs(w.gapWeight - gapBuckets) > 0.01) { allOk = false; console.log(`    缺口权重不符: ${w.gapWeight} != ${gapBuckets}`); }
      if (Math.abs(w.scoredWeight - scoredExpected) > 0.01) { allOk = false; console.log(`    计分权重不符`); }
      if (w.compliance === null || w.compliance < slo.target - 0.005) { allOk = false; console.log(`    缺口被误判为故障: compliance=${w.compliance}`); }
    }
    // 缺口期间不应有告警
    const alerted = allAlerts.some(
      (a) => a.serviceId === g.service_id && a.openedAt >= g.start_ts - 600 && a.openedAt <= g.end_ts + 1800,
    );
    if (alerted) { allOk = false; console.log(`    ${svcById.get(g.service_id)!.name} 缺口期间误报告警`); }
  }
  check('缺口不计分母、不误判、不告警', allOk, `${gaps.length} 个缺口事件`);
}

// ================= 检查 3:维护窗口剔除 =================
console.log('\n检查 3:计划内维护从预算剔除');
{
  const maint = rows<MaintenanceRow>(db, `SELECT * FROM maintenance`);
  let allOk = true;
  for (const m of maint) {
    const slo = slos.find((s) => s.service_id === m.service_id && s.type === 'availability')!;
    const ws = m.start_ts - 3600, we = m.end_ts + 3600;
    const w = computeWindow(db, slo, ws, we);
    const rawAll = one<{ t: number; o: number }>(
      db, `SELECT SUM(total) AS t, SUM(ok) AS o FROM buckets WHERE service_id=? AND bucket_start>=? AND bucket_start<? AND gap=0`,
      m.service_id, ws, we,
    )!;
    const rawMaint = one<{ t: number; o: number }>(
      db, `SELECT SUM(total) AS t, SUM(ok) AS o FROM buckets WHERE service_id=? AND bucket_start>=? AND bucket_start<? AND gap=0`,
      m.service_id, m.start_ts, m.end_ts,
    )!;
    const expectedBad = rawAll.t - rawAll.o - (rawMaint.t - rawMaint.o);
    const engineBad = w.total - w.good;
    if (Math.abs(engineBad - expectedBad) > 1) {
      allOk = false;
      console.log(`    ${svcById.get(m.service_id)!.name}: 引擎坏请求 ${engineBad.toFixed(0)} != 剔除后期望 ${expectedBad}`);
    }
  }
  check('维护期坏请求不进分子分母', allOk, `${maint.length} 个维护窗口`);
}

// ================= 检查 4:预算连续性 =================
console.log('\n检查 4:窗口切换预算不跳变');
{
  let maxJump = 0, checked = 0;
  // 找数据范围内的所有自然月边界
  const boundaries: number[] = [];
  for (let t = simStart; t <= simEnd; t += DAY_SEC) {
    const d = new Date(t * 1000);
    const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    if (b > simStart + DAY_SEC && b < simEnd - DAY_SEC && !boundaries.includes(b)) boundaries.push(b);
  }
  for (const slo of slos) {
    const win = winFn(slo);
    if (slo.window === 'calendar_month') {
      for (const b of boundaries) {
        const r1 = budgetStatusFrom(win, slo, b - BUCKET_SEC).remainingFraction;
        const r2 = budgetStatusFrom(win, slo, b + BUCKET_SEC).remainingFraction;
        maxJump = Math.max(maxJump, Math.abs(r2 - r1));
        checked++;
      }
    } else {
      // 滚动窗口:任意相邻两点的变化都应微小
      for (let t = simStart + 30 * DAY_SEC; t < simEnd; t += 6 * 3600) {
        const r1 = budgetStatusFrom(win, slo, t).remainingFraction;
        const r2 = budgetStatusFrom(win, slo, t + BUCKET_SEC).remainingFraction;
        maxJump = Math.max(maxJump, Math.abs(r2 - r1));
        checked++;
      }
    }
  }
  check('预算跳变 <= 1%', maxJump <= 0.01, `${checked} 个采样点,最大跳变 ${(maxJump * 100).toFixed(4)}%`);
}

// ================= 检查 5:告警质量 =================
console.log('\n检查 5:MWMB 告警 vs 固定阈值基线');
{
  // 基线检测器:5 分钟坏请求率 > 5x 允许值即报(无迟滞无冷却),统计告警集数
  let baselineCount = 0;
  for (const slo of slos) {
    const s = seriesBySlo.get(slo.id)!;
    const allowed = 1 - slo.target;
    let firing = false;
    for (let i = 0; i < s.n; i++) {
      const w = s.window(s.firstTs + i * BUCKET_SEC, s.firstTs + (i + 1) * BUCKET_SEC);
      const fires = !w.insufficientData && w.total > 0 && (1 - w.good / w.total) > 5 * allowed;
      if (fires && !firing) baselineCount++;
      firing = fires;
    }
  }

  // 召回:重大故障(影响 >=10% 用户)必须被覆盖
  const major = incidents.filter((i) => i.kind !== 'gap' && i.affected_ratio >= 0.1);
  const missed: string[] = [];
  for (const inc of major) {
    const covered = allAlerts.some(
      (a) => a.serviceId === inc.service_id && a.openedAt <= inc.end_ts + 1800 && (a.resolvedAt === null || a.resolvedAt >= inc.start_ts - 600),
    );
    if (!covered) missed.push(`${svcById.get(inc.service_id)!.name}(${inc.description})`);
  }

  // 误报:告警发生时,本服务及上游 1 跳内无标注故障(维护也不算)
  const realIncidents = incidents.filter((i) => i.kind !== 'gap');
  const unexplained = allAlerts.filter((a) => {
    const related = [a.serviceId, ...(upstreamOf.get(a.serviceId) ?? [])];
    return !realIncidents.some(
      (inc) => related.includes(inc.service_id) && a.openedAt <= inc.end_ts + 3600 && (a.resolvedAt ?? simEnd) + 3600 >= inc.start_ts,
    );
  });

  console.log(`  MWMB ${allAlerts.length} 条 vs 固定阈值基线 ${baselineCount} 条(降 ${((1 - allAlerts.length / baselineCount) * 100).toFixed(1)}%)`);
  check('重大故障零漏报', missed.length === 0, missed.length ? `漏报: ${missed.join('; ')}` : `${major.length} 个重大故障全覆盖`);
  check('MWMB 告警量显著低于基线(>80%)', allAlerts.length < baselineCount * 0.2, `${allAlerts.length} vs ${baselineCount}`);
  check('MWMB 无标注外误报', unexplained.length === 0, unexplained.length ? `${unexplained.length} 条无法解释` : '全部告警可对应标注故障');
}

// ================= 检查 6:发布闸门 =================
console.log('\n检查 6:发布闸门拦截与风险时段对齐');
{
  const releases = rows<{ id: number; service_id: number; requested_at: number; status: string; budget_remaining: number | null }>(
    db, `SELECT * FROM releases`,
  );
  const blocked = releases.filter((r) => r.status === 'blocked');
  console.log(`  共 ${releases.length} 次发布请求,拦截 ${blocked.length} 次`);

  // (a) 拦截必须事出有因:预算低于闸门线或当时有 critical 告警
  const unjustified = blocked.filter((r) => {
    const budgetLow = r.budget_remaining !== null && r.budget_remaining < 0.2;
    const crit = activeCriticalAt(r.service_id, r.requested_at) > 0;
    return !budgetLow && !crit;
  });
  check('拦截均有预算/告警依据', unjustified.length === 0, unjustified.length ? `${unjustified.length} 次无理由拦截` : '');

  // (b) 故障进行中发起发布必须被拦:对每个重大故障,在故障第 90 分钟(短故障则结束前 15 分钟)模拟一次发布请求
  const major = incidents.filter((i) => i.kind !== 'gap' && i.affected_ratio >= 0.15);
  const notBlocked: string[] = [];
  for (const inc of major) {
    const offsetMin = Math.min(90, (inc.end_ts - inc.start_ts) / 60 - 15);
    const t = inc.start_ts + offsetMin * 60;
    const svcSlos = slos.filter((s) => s.service_id === inc.service_id);
    const verdict = gateVerdict(
      svcSlos,
      (slo) => budgetStatusFrom(winFn(slo), slo, t),
      activeCriticalAt(inc.service_id, t),
    );
    insRel.run(inc.service_id, `mid-incident-${inc.id}`, t, verdict.allowed ? 'approved' : 'blocked', 0, '', verdict.worstRemaining, 'eval-bot');
    if (verdict.allowed) notBlocked.push(svcById.get(inc.service_id)!.name);
  }
  check('重大故障进行中发布被拦', notBlocked.length === 0, notBlocked.length ? `未拦截: ${notBlocked.join(', ')}` : `${major.length} 个重大故障均拦截`);

  // (c) 拦截只发生在故障影响期内(故障后预算恢复最长约 28 天,放宽到 35 天)
  const realIncidents = incidents.filter((i) => i.kind !== 'gap');
  const orphan = blocked.filter((r) => {
    const related = [r.service_id, ...(upstreamOf.get(r.service_id) ?? [])];
    return !realIncidents.some((inc) => related.includes(inc.service_id) && r.requested_at >= inc.start_ts - 3600 && r.requested_at <= inc.end_ts + 35 * DAY_SEC);
  });
  check('健康期无误拦截', orphan.length === 0, orphan.length ? `${orphan.length} 次拦截无对应故障` : '');

  // (d) 紧急发布:填理由放行并留痕;不填理由拒绝。用预算剩余最低的拦截记录(预算路径确定性最强)
  const anyBlocked = blocked
    .filter((r) => r.budget_remaining !== null)
    .sort((a, b) => a.budget_remaining! - b.budget_remaining!)[0];
  let emergencyOk = false, auditOk = false, noReasonRejected = false;
  if (anyBlocked) {
    const { requestRelease } = await import('../slo/gate.js');
    const rel = requestRelease(db, anyBlocked.service_id, 'hotfix-1', {
      emergency: true, reason: '线上支付失败,紧急修复对账逻辑', decidedBy: 'oncall-zhang', now: anyBlocked.requested_at,
    });
    emergencyOk = rel.status === 'emergency_approved';
    auditOk = rel.reason.includes('紧急') && rel.decided_by === 'oncall-zhang' && rel.budget_remaining !== null;
    try {
      requestRelease(db, anyBlocked.service_id, 'hotfix-2', { emergency: true, reason: '  ', decidedBy: 'x', now: anyBlocked.requested_at });
    } catch {
      noReasonRejected = true;
    }
  }
  check('紧急发布填理由放行', emergencyOk);
  check('紧急发布留痕(理由/操作人/预算快照)', auditOk);
  check('紧急发布无理由被拒绝', noReasonRejected);
}

// ================= 检查 7:耗尽预测 =================
console.log('\n检查 7:预算耗尽预测');
{
  const payment = services.find((s) => s.name === 'payment-service')!;
  const slo = slos.find((s) => s.service_id === payment.id && s.type === 'availability')!;
  const win = winFn(slo);
  const inc = incidents.find((i) => i.service_id === payment.id && i.kind === 'availability')!;
  let predAt = 0, predHours = 0, actualExhaustAt = 0;
  for (let t = inc.start_ts; t < inc.end_ts + 24 * 3600; t += 1800) {
    const b = budgetStatusFrom(win, slo, t);
    // 基线本身消耗约 20% 预算,越过 0.6 才说明进入故障性燃烧
    if (!predAt && b.remainingFraction < 0.6 && b.exhaustionInHours !== null) {
      predAt = t;
      predHours = b.exhaustionInHours;
    }
    if (!actualExhaustAt && b.remainingFraction <= 0) actualExhaustAt = t;
  }
  const healthy = budgetStatusFrom(win, slo, simStart + 75 * DAY_SEC).exhaustionInHours;
  if (predAt && actualExhaustAt) {
    const actualHours = (actualExhaustAt - predAt) / 3600;
    const ratio = predHours / actualHours;
    check('耗尽预测量级正确', ratio > 0.2 && ratio < 5, `预测 ${predHours.toFixed(1)}h vs 实际 ${actualHours.toFixed(1)}h`);
  } else {
    check('耗尽预测量级正确', false, `未取到预测点(predAt=${predAt}, actual=${actualExhaustAt})`);
  }
  check('健康期不预测近期耗尽(>7 天)', healthy === null || healthy > 168, healthy === null ? 'null' : `${healthy?.toFixed(0)}h`);
}

// ================= 检查 8:周报导出 =================
console.log('\n检查 8:周维度达标导出');
{
  const slo = slos.find((s) => s.service_id === services.find((v) => v.name === 'payment-service')!.id && s.type === 'availability')!;
  const csv = weeklyCsv(db, slo);
  const lines = csv.trim().split('\n');
  const expectedWeeks = Math.ceil((simEnd - simStart) / (7 * DAY_SEC)) + 1;
  const rowsOk = Math.abs(lines.length - 1 - expectedWeeks) <= 1;
  const parsed = lines.slice(1).map((l) => l.split(','));
  const coverageOk = parsed.every((c) => c[4] === '' || (Number(c[4]) >= 0 && Number(c[4]) <= 1));
  const inc = incidents.find((i) => i.service_id === slo.service_id && i.kind === 'availability')!;
  const incWeek = new Date(inc.start_ts * 1000).toISOString().slice(0, 10);
  const incRow = parsed.find((c) => c[0] <= incWeek && Number(new Date(c[0]).getTime()) / 1000 + 7 * DAY_SEC > inc.start_ts)!;
  const healthyRow = parsed.find((c) => Number(c[6]) === 0 && c[1] !== '' && Number(c[1]) > 0.999)!;
  check('周报行数覆盖全部周', rowsOk, `${lines.length - 1} 行`);
  check('覆盖率字段合法', coverageOk);
  check('故障周达标率显著低于健康周', Number(incRow[1]) < Number(healthyRow[1]) - 0.001, `故障周 ${incRow[1]} vs 健康周 ${healthyRow[1]}`);
}

console.log(`\n${failures === 0 ? '全部检查通过 ✅' : `${failures} 项检查失败 ❌`}`);
db.close();
process.exit(failures === 0 ? 0 : 1);
