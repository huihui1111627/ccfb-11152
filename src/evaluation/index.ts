import { writeFileSync } from 'node:fs';
import { buildSloDefs } from '../config/catalog.js';
import { getDb, getSimMeta, rows } from '../db/index.js';
import { materializeFaults } from '../simulate/index.js';
import type {
  AlertEvent,
  DetectorSummary,
  EvaluationReport,
  FaultEvaluation,
  FaultGroundTruth,
} from '../shared/types.js';
import { replayAlerts } from '../slo/stream.js';
import { formatDateTime } from '../shared/time.js';

type Detector = 'mwmb' | 'fixedThreshold' | 'gap';

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[idx];
}

export function runEvaluation(dbPath = 'data/slo.db'): EvaluationReport {
  const db = getDb(dbPath);
  const rangeStart = Number(getSimMeta(db, 'rangeStart'));
  const rangeEnd = Number(getSimMeta(db, 'rangeEnd'));
  const slos = buildSloDefs();

  console.log('▶ 回放全部桶,驱动 MWMB 与固定阈值双检测器…');
  const replay = replayAlerts(db, slos, rangeStart, rangeEnd);
  console.log(`  评估点 ${replay.evaluationTicks} 个,告警事件(含恢复) ${replay.events.length} 条`);

  const faults = materializeFaults(rangeStart);
  const groundTruth: FaultGroundTruth[] = faults.map((f) => ({
    faultId: f.id,
    serviceId: f.serviceId,
    kind: f.kind,
    start: f.start,
    end: f.end,
    detectable: f.kind !== 'reportingGap',
  }));

  interface AlertRow {
    id: number;
    slo_id: string;
    service_id: string;
    detector: AlertEvent['detector'];
    rule_id: string;
    severity: AlertEvent['severity'];
    state: AlertEvent['state'];
    fired_at: number;
    resolved_at: number | null;
    short_window_hours: number | null;
    long_window_hours: number | null;
    short_burn_rate: number | null;
    long_burn_rate: number | null;
    message: string;
  }
  const alertRows = rows<AlertRow>(
    db.prepare('SELECT * FROM alert_events ORDER BY fired_at'),
  );
  const allEvents: AlertEvent[] = alertRows.map((r) => ({
    id: r.id,
    sloId: r.slo_id,
    serviceId: r.service_id,
    detector: r.detector,
    ruleId: r.rule_id,
    severity: r.severity,
    state: r.state,
    firedAt: r.fired_at,
    resolvedAt: r.resolved_at,
    shortWindowHours: r.short_window_hours,
    longWindowHours: r.long_window_hours,
    shortBurnRate: r.short_burn_rate,
    longBurnRate: r.long_burn_rate,
    message: r.message,
  }));

  // 同一服务的 SLO 集合
  const sloIdsByService = new Map<string, Set<string>>();
  for (const slo of slos) {
    const set = sloIdsByService.get(slo.serviceId) ?? new Set<string>();
    set.add(slo.id);
    sloIdsByService.set(slo.serviceId, set);
  }

  // 每个故障找各检测器的首次命中
  const perFault: FaultEvaluation[] = groundTruth.map((fault) => {
    const sloIds = sloIdsByService.get(fault.serviceId) ?? new Set<string>();
    const detectors: Detector[] =
      fault.kind === 'reportingGap' ? ['gap'] : ['mwmb', 'fixedThreshold'];

    const matches = [];
    for (const detector of detectors) {
      const hit = allEvents.find(
        (e) =>
          e.detector === detector &&
          sloIds.has(e.sloId) &&
          e.firedAt >= fault.start - 2 * 3_600_000 &&
          e.firedAt <= fault.end + 30 * 60_000,
      );
      if (hit) {
        matches.push({
          faultId: fault.faultId,
          detector,
          alertId: hit.id,
          firedAt: hit.firedAt,
          detectDelayMinutes: Math.round((hit.firedAt - fault.start) / 60_000),
        });
      }
    }
    return {
      fault,
      detected: matches.length > 0,
      matches,
      missed: fault.detectable && !matches.some((m) => m.detector !== 'gap'),
    };
  });

  // 检测器汇总
  const summaries: DetectorSummary[] = (['mwmb', 'fixedThreshold', 'gap'] as Detector[]).map(
    (detector) => {
      // 只统计触发事件(恢复不产生新行,alert_events 每行都是一次 firing)
      const firingEvents = allEvents.filter((e) => e.detector === detector);
      const relevantFaults =
        detector === 'gap'
          ? groundTruth.filter((f) => f.kind === 'reportingGap')
          : groundTruth.filter((f) => f.kind !== 'reportingGap');

      let tp = 0;
      const matchedFaults = new Set<string>();
      for (const e of firingEvents) {
        const hitFault = relevantFaults.find(
          (f) =>
            f.serviceId === e.serviceId &&
            e.firedAt >= f.start - 2 * 3_600_000 &&
            e.firedAt <= f.end + 30 * 60_000,
        );
        if (hitFault) {
          tp += 1;
          matchedFaults.add(hitFault.faultId);
        }
      }
      const fp = firingEvents.length - tp;
      const faultsDetected = matchedFaults.size;
      const faultsMissed = relevantFaults.length - faultsDetected;
      const delays = perFault
        .flatMap((p) => p.matches)
        .filter((m) => m.detector === detector)
        .map((m) => m.detectDelayMinutes);

      return {
        detector,
        alertsFired: firingEvents.length,
        truePositiveAlerts: tp,
        falsePositiveAlerts: fp,
        faultsDetected,
        faultsMissed,
        meanDetectDelayMinutes:
          delays.length > 0 ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
        p90DetectDelayMinutes: percentile(delays, 0.9),
        precision: firingEvents.length > 0 ? tp / firingEvents.length : null,
        recall: relevantFaults.length > 0 ? faultsDetected / relevantFaults.length : null,
      };
    },
  );

  const mwmb = summaries.find((s) => s.detector === 'mwmb')!;
  const fixed = summaries.find((s) => s.detector === 'fixedThreshold')!;
  const alertVolumeReductionPct =
    fixed.alertsFired > 0
      ? Math.round(((fixed.alertsFired - mwmb.alertsFired) / fixed.alertsFired) * 1000) / 10
      : null;  const report: EvaluationReport = {
    generatedAt: Date.now(),
    rangeStart,
    rangeEnd,
    totalFaults: groundTruth.length,
    perFault,
    detectorSummaries: summaries,
    alertVolumeReductionPct,
  };

  writeFileSync('data/evaluation-report.json', JSON.stringify(report, null, 2));
  return report;
}

function printReport(r: EvaluationReport): void {
  const line = '─'.repeat(96);
  console.log('\n' + line);
  console.log('告警策略评估报告(对照:MWMB 多窗口多燃烧率 vs 固定阈值 5%)');
  console.log(line);
  console.log(`区间:${formatDateTime(r.rangeStart)} ~ ${formatDateTime(r.rangeEnd)}  故障总数:${r.totalFaults}`);
  console.log(line);

  const kindName: Record<string, string> = {
    totalOutage: '突发全挂',
    gradualDegradation: '缓慢劣化',
    reportingGap: '上报中断',
    errorSpike: '错误尖峰',
  };

  console.log('逐故障检测情况:');
  console.log(
    '故障  服务                    类型        时长     MWMB延迟      固定阈值延迟   结论',
  );
  for (const p of r.perFault) {
    const f = p.fault;
    const durMin = Math.round((f.end - f.start) / 60000);
    const mwmbMatch = p.matches.find((m) => m.detector === 'mwmb');
    const fixedMatch = p.matches.find((m) => m.detector === 'gap')
      ? null
      : p.matches.find((m) => m.detector === 'fixedThreshold');
    const gapMatch = p.matches.find((m) => m.detector === 'gap');
    const fmt = (mins: number | undefined) =>
      mins === undefined ? '—' : mins < 0 ? `${mins}min(提前)` : `${mins}min`;
    let conclusion = '';
    if (f.kind === 'reportingGap') {
      conclusion = gapMatch ? `缺口告警 ${gapMatch.detectDelayMinutes}min` : '漏报';
    } else {
      conclusion = p.missed ? '⚠️ 漏报' : '已检出';
    }
    console.log(
      `${f.faultId}  ${f.serviceId.padEnd(22)} ${kindName[f.kind].padEnd(9)} ` +
        `${String(durMin).padStart(4)}min  ` +
        `${fmt(mwmbMatch?.detectDelayMinutes).padStart(10)}    ${fmt(fixedMatch?.detectDelayMinutes).padStart(10)}    ${conclusion}`,
    );
  }

  console.log('\n检测器汇总:');
  console.log('检测器            告警数   命中故障   误报     漏报故障  平均延迟  P90延迟  精确率   召回率');
  for (const s of r.detectorSummaries) {
    const name =
      s.detector === 'mwmb' ? 'MWMB 燃烧率' : s.detector === 'fixedThreshold' ? '固定阈值 5%' : '缺口检测';
    const fmtPct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
    console.log(
      `${name.padEnd(16)} ${String(s.alertsFired).padStart(6)}   ${String(s.faultsDetected).padStart(6)}   ` +
        `${String(s.falsePositiveAlerts).padStart(6)}   ${String(s.faultsMissed).padStart(6)}     ` +
        `${s.meanDetectDelayMinutes === null ? '—' : s.meanDetectDelayMinutes + 'min'}`.padEnd(10) +
        `${s.p90DetectDelayMinutes === null ? '—' : s.p90DetectDelayMinutes + 'min'}`.padEnd(9) +
        ` ${fmtPct(s.precision).padStart(7)}  ${fmtPct(s.recall).padStart(7)}`,
    );
  }
  if (r.alertVolumeReductionPct !== null) {
    const mwmbCount = r.detectorSummaries.find((s) => s.detector === 'mwmb')!.alertsFired;
    const fixedCount = r.detectorSummaries.find((s) => s.detector === 'fixedThreshold')!.alertsFired;
    console.log(
      `\nMWMB 相对固定阈值告警量:${mwmbCount} 条 vs ${fixedCount} 条,减少 ${r.alertVolumeReductionPct}%`,
    );
  }
  console.log(line + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const report = runEvaluation();
  printReport(report);
  console.log(`✅ 报告已写入 data/evaluation-report.json,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
