//! 金标准核对：在用例消息上单独跑引擎，逐 bar 逐字段比对。

use mk_core::Dataset;
use mk_engine::config::EngineConfig;
use mk_engine::Engine;
use serde::{Deserialize, Serialize};

use crate::analysis::Analysis;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileResp {
    pub summary: ReconcileSummary,
    pub cases: Vec<CaseReport>,
    pub diffs: Vec<DiffRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileSummary {
    pub cases: usize,
    pub bars: usize,
    pub matched: usize,
    pub mismatched: usize,
    pub field_diffs: usize,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseReport {
    pub id: String,
    pub title: String,
    pub symbol: String,
    pub period: String,
    pub status: String,
    pub bar_count: usize,
    pub mismatch_count: usize,
    /// 完全匹配的期望 bar 数
    pub matched_bars: usize,
    /// 存在字段差异的期望 bar 数
    pub rejected_bars: usize,
    pub rules: Vec<String>,
    pub fixture: String,
    pub checked_bars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffRow {
    pub case_id: String,
    pub symbol: String,
    pub period: String,
    pub trade_date: String,
    pub bar_t: i64,
    pub bar_end: String,
    pub field: String,
    pub expected: serde_json::Value,
    pub actual: serde_json::Value,
    pub reason: String,
    pub reason_code: String,
    pub trade_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseDetailResp {
    pub case: CaseReport,
    pub description: String,
    pub trades: Vec<CaseTradeRow>,
    pub expected: Vec<ExpectedRow>,
    pub actual: Vec<ActualRow>,
    pub diffs: Vec<DiffRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseTradeRow {
    pub id: String,
    pub ts: i64,
    pub hm: String,
    pub p: f64,
    pub v: u64,
    pub side: String,
    pub auction: bool,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedRow {
    pub t: i64,
    pub end: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: u64,
    pub to: f64,
    pub n: u32,
    pub bvol: u64,
    pub svol: u64,
    pub av: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActualRow {
    pub t: i64,
    pub end: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: u64,
    pub to: f64,
    pub n: u32,
    pub bvol: u64,
    pub svol: u64,
    pub av: u64,
    pub flags: Vec<String>,
}

/// 在一个用例消息集上跑引擎，返回该交易日的 bar（按周期）。
pub fn run_case(case: &mk_sim::golden::GoldenCase) -> Vec<mk_core::Bar> {
    let inst = mk_sim::golden::instrument_for_case(case);
    let msgs = case.to_raw_messages();
    let mut calendar = mk_sim::golden::calendar_for_case(case);
    // 只保留用例涉及的两个交易日（夜盘场景需要前一日）
    calendar.trading_days.retain(|d| {
        d.as_str() == case.trade_date
            || d.as_str() == mk_core::time::shift_date(&case.trade_date, -1)
            || d.as_str() == mk_core::time::shift_date(&case.trade_date, -2)
            || d.as_str() == mk_core::time::shift_date(&case.trade_date, -3)
    });
    let mut meta = mk_core::dataset::DatasetMeta {
        dataset: "golden".into(),
        generated_at: String::new(),
        engine_version: "0.1.0".into(),
        calendar,
        instruments: vec![inst.clone()],
        corporate_actions: vec![],
        products: vec![],
        halts: vec![],
        prev_closes: vec![mk_core::dataset::PrevClose {
            symbol: case.symbol.clone(),
            trade_date: case.trade_date.clone(),
            price: case.prev_close,
        }],
        continuous: vec![],
        injected_anomalies: vec![],
    };
    meta.instruments = vec![inst.clone()];
    let ds = Dataset { meta, messages: msgs, factors: vec![] };
    let mut cfg = EngineConfig::default();
    // 金标准用 omit 策略，便于验证"无成交不生成 bar"
    cfg.policy.empty_bar_policy = mk_engine::config::EmptyBarPolicy::Omit;
    let out = Engine::new(cfg).run_symbol(&ds, &inst);
    let period = mk_sim::golden::period_of(case).as_str().to_string();
    let mut bars: Vec<mk_core::Bar> = out
        .bars
        .get(&case.trade_date)
        .and_then(|p| p.get(&period))
        .cloned()
        .unwrap_or_default();
    bars.sort_by_key(|b| b.t);
    bars
}

/// 判定差异原因，给出规则引用。
fn reason_for(field: &str, case: &mk_sim::golden::GoldenCase) -> (&'static str, String) {
    let code = match field {
        "v" | "n" | "av" => "boundary",
        "o" | "h" | "l" | "c" => "boundary",
        _ => "rounding",
    };
    let rules = case.rules.join("、");
    (code, format!("与金标准不一致；疑似违反 {}（{}）", rules, case.title))
}

/// 对单个用例比较并生成报告条目 + 差异。
pub fn check_case(case: &mk_sim::golden::GoldenCase) -> (CaseReport, Vec<DiffRow>, Vec<mk_core::Bar>) {
    let bars = run_case(case);
    let mut diffs = Vec::new();
    let mut matched = 0usize;
    let mut rejected = 0usize;
    let mut compared = 0usize;
    let actual_by_hm: std::collections::BTreeMap<String, &mk_core::Bar> =
        bars.iter().map(|b| (b.hm()[..5].to_string(), b)).collect();

    for exp in case.expected.iter() {
        let Some(actual) = actual_by_hm.get(&exp.hm) else {
            diffs.push(DiffRow {
                case_id: case.id.clone(),
                symbol: case.symbol.clone(),
                period: case.period.clone(),
                trade_date: case.trade_date.clone(),
                bar_t: exp.t,
                bar_end: format!("{}:00.000", exp.hm),
                field: "bar".into(),
                expected: serde_json::json!("存在"),
                actual: serde_json::json!("缺失"),
                reason: format!(
                    "期望的 {} bar 未生成；可能时间窗归属错误或被隔离",
                    exp.hm
                ),
                reason_code: "missing_trade".into(),
                trade_ids: vec![],
            });
            continue;
        };
        compared += 1;
        let mut case_ok = true;
        for (field, exp_v, act_v) in [
            ("o", exp.o, actual.open_f()),
            ("h", exp.h, actual.high_f()),
            ("l", exp.l, actual.low_f()),
            ("c", exp.c, actual.close_f()),
            ("v", exp.v as f64, actual.volume as f64),
            ("n", exp.n as f64, actual.count as f64),
            ("bvol", exp.bvol as f64, actual.buy_volume as f64),
            ("svol", exp.svol as f64, actual.sell_volume as f64),
            ("av", exp.av as f64, actual.auction_volume as f64),
        ] {
            // av/bvol/svol 只在期望值非零时校验（用例可能不关心）
            if matches!(field, "bvol" | "svol" | "av") && exp_v == 0.0 {
                continue;
            }
            let (exp_json, act_json, ok) = if field == "v" || field == "n" {
                (
                    serde_json::json!(exp_v as u64),
                    serde_json::json!(act_v as u64),
                    (exp_v - act_v).abs() < 0.5,
                )
            } else if matches!(field, "bvol" | "svol" | "av") {
                (
                    serde_json::json!(exp_v as u64),
                    serde_json::json!(act_v as u64),
                    (exp_v - act_v).abs() < 0.5,
                )
            } else {
                (
                    serde_json::json!(exp_v),
                    serde_json::json!(act_v),
                    (exp_v - act_v).abs() < 1e-6,
                )
            };
            if !ok {
                case_ok = false;
                let (code, reason) = reason_for(field, case);
                diffs.push(DiffRow {
                    case_id: case.id.clone(),
                    symbol: case.symbol.clone(),
                    period: case.period.clone(),
                    trade_date: case.trade_date.clone(),
                    bar_t: exp.t,
                    bar_end: format!("{}:00.000", exp.hm),
                    field: field.into(),
                    expected: exp_json,
                    actual: act_json,
                    reason,
                    reason_code: code.into(),
                    trade_ids: vec![],
                });
            }
        }
        if case_ok {
            matched += 1;
        } else {
            rejected += 1;
        }
    }

    let status = if diffs.is_empty() { "pass" } else { "fail" };
    let report = CaseReport {
        id: case.id.clone(),
        title: case.title.clone(),
        symbol: case.symbol.clone(),
        period: case.period.clone(),
        status: status.into(),
        bar_count: case.expected.len(),
        mismatch_count: diffs.len(),
        matched_bars: matched,
        rejected_bars: rejected,
        rules: case.rules.clone(),
        fixture: format!("data/golden/{}.json", case.id),
        checked_bars: compared,
    };
    (report, diffs, bars)
}

/// 全量核对。
pub fn reconcile(cases: &[mk_sim::golden::GoldenCase]) -> ReconcileResp {
    let mut reports = Vec::new();
    let mut all_diffs = Vec::new();
    let mut bars = 0usize;
    let mut matched = 0usize;
    let mut mismatched = 0usize;
    for case in cases {
        let (rep, diffs, _) = check_case(case);
        bars += rep.bar_count;
        matched += rep.matched_bars;
        mismatched += rep.rejected_bars;
        all_diffs.extend(diffs);
        reports.push(rep);
    }
    let field_diffs = all_diffs.len();
    ReconcileResp {
        summary: ReconcileSummary {
            cases: reports.len(),
            bars,
            matched,
            mismatched,
            field_diffs,
            generated_at: chrono::Local::now().to_rfc3339(),
        },
        cases: reports,
        diffs: all_diffs,
    }
}

/// 单个用例详情。
pub fn case_detail(
    case: &mk_sim::golden::GoldenCase,
    analysis: &Analysis,
) -> CaseDetailResp {
    let (report, diffs, bars) = check_case(case);
    // 与 GoldenCase::to_raw_messages 的自动 ID 规则保持一致
    let trades = case
        .messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let ts = mk_core::time::ts_from_local(&m.ts).unwrap_or(0);
            CaseTradeRow {
                id: if m.kind == "trade" {
                    if m.trade_id.is_empty() {
                        format!("C{}-{:03}", case.id, i)
                    } else {
                        m.trade_id.clone()
                    }
                } else {
                    m.ref_trade_id.clone()
                },
                ts,
                hm: mk_core::time::ms_to_hm(ts),
                p: m.price,
                v: m.volume,
                side: m.side.clone(),
                auction: m.auction,
                kind: m.kind.clone(),
            }
        })
        .collect();
    let expected = case
        .expected
        .iter()
        .map(|e| ExpectedRow {
            t: e.t,
            end: format!("{}:00.000", e.hm),
            o: e.o,
            h: e.h,
            l: e.l,
            c: e.c,
            v: e.v,
            to: e.to,
            n: e.n,
            bvol: e.bvol,
            svol: e.svol,
            av: e.av,
        })
        .collect();
    let actual: Vec<ActualRow> = case
        .expected
        .iter()
        .filter_map(|e| {
            bars.iter()
                .find(|b| b.hm()[..5] == e.hm[..5])
                .map(|b| ActualRow {
                    t: b.t,
                    end: format!("{}:00.000", e.hm),
                    o: b.open_f(),
                    h: b.high_f(),
                    l: b.low_f(),
                    c: b.close_f(),
                    v: b.volume,
                    to: b.turnover_f(),
                    n: b.count,
                    bvol: b.buy_volume,
                    svol: b.sell_volume,
                    av: b.auction_volume,
                    flags: b.flags.names().into_iter().map(|s| s.to_string()).collect(),
                })
        })
        .collect();
    let _ = analysis;
    CaseDetailResp {
        case: report,
        description: case.description.clone(),
        trades,
        expected,
        actual,
        diffs,
    }
}
