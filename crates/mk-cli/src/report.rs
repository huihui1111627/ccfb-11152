//! CLI 输出格式化（表格 / CSV / 摘要）。

use mk_app::model::{BarsResp, ConsistencyResp};
use mk_app::{reconcile::ReconcileResp, Analysis};
use mk_core::dataset::DatasetMeta;
use mk_core::Bar;

pub fn print_summary(analysis: &Analysis, elapsed: std::time::Duration) {
    println!("数据集：{}", analysis.dataset.meta.dataset);
    println!("交易日：{}", analysis.dataset.meta.calendar.trading_days.len());
    println!("品种：{}", analysis.dataset.meta.instruments.len());
    println!("原始消息：{}", analysis.dataset.messages.len());
    println!("引擎耗时：{:?}", elapsed);
    println!();
    println!(
        "{:<12} {:<8} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "symbol", "asset", "trades", "isolated", "anomaly", "1m bars", "1d bars"
    );
    for s in analysis.engine_out.symbols.iter() {
        let inst = analysis.instrument(&s.symbol);
        let n1: usize = s.bars.values().flat_map(|p| p.get("1m").into_iter().flatten()).count();
        let nd: usize = s.bars.values().flat_map(|p| p.get("1d").into_iter().flatten()).count();
        println!(
            "{:<12} {:<8} {:>8} {:>8} {:>8} {:>8} {:>8}",
            s.symbol,
            inst.map(|i| if i.is_future() { "future" } else { "equity" }).unwrap_or("?"),
            s.trades.len(),
            s.isolated.len(),
            s.anomalies.len(),
            n1,
            nd
        );
    }
    println!();
    print_anomaly_breakdown(analysis);
    if let Some(rep) = analysis.reconcile() {
        println!();
        println!(
            "金标准核对：{} 个用例 / {} 根 bar，匹配 {}，差异 {}（字段级 {} 处）",
            rep.summary.cases,
            rep.summary.bars,
            rep.summary.matched,
            rep.summary.mismatched,
            rep.summary.field_diffs
        );
    }
}

fn print_anomaly_breakdown(analysis: &Analysis) {
    let mut counts: std::collections::BTreeMap<(&str, &str), usize> = Default::default();
    for s in analysis.engine_out.symbols.iter() {
        for a in s.anomalies.iter() {
            *counts
                .entry((a.kind.as_str(), a.severity.as_str()))
                .or_default() += 1;
        }
    }
    if counts.is_empty() {
        return;
    }
    println!("异常分布：");
    println!("  {:<22} {:<8} {:>6}", "kind", "severity", "count");
    for ((k, sev), n) in counts.iter() {
        println!("  {:<22} {:<8} {:>6}", k, sev, n);
    }
    let recall = analysis.injection_recall();
    if !recall.is_empty() {
        let total = recall.len();
        let hit = recall.iter().filter(|r| r.detected).count();
        println!();
        println!("异常注入召回：{}/{}（{:.1}%）", hit, total, hit as f64 / total as f64 * 100.0);
        let mut by_kind: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
        for r in recall.iter() {
            let e = by_kind.entry(r.injected_kind.clone()).or_default();
            e.1 += 1;
            if r.detected {
                e.0 += 1;
            }
        }
        for (k, (h, t)) in by_kind.iter() {
            if h != t {
                println!("  未全部命中：{:<22} {}/{}", k, h, t);
            }
        }
    }
}

pub fn print_reconcile(rep: &ReconcileResp) {
    println!(
        "{:<5} {:<6} {:<6} {:<10} {:>6} {:>6} {:>6}",
        "case", "status", "period", "symbol", "bars", "match", "diff"
    );
    for c in rep.cases.iter() {
        println!(
            "{:<5} {:<6} {:<6} {:<10} {:>6} {:>6} {:>6}",
            c.id, c.status, c.period, c.symbol, c.bar_count, c.matched_bars, c.rejected_bars
        );
    }
    println!();
    println!(
        "合计：{} 用例 / {} bar，匹配 {}，差异 {}，字段级差异 {}",
        rep.summary.cases,
        rep.summary.bars,
        rep.summary.matched,
        rep.summary.mismatched,
        rep.summary.field_diffs
    );
    if !rep.diffs.is_empty() {
        println!("\n差异明细：");
        for d in rep.diffs.iter() {
            println!(
                "  [{}] {} {} field={} 期望={} 实际={} 原因={} ({})",
                d.case_id, d.period, d.bar_end, d.field, d.expected, d.actual, d.reason_code, d.reason
            );
        }
    }
    println!("\n用例说明：");
    for c in rep.cases.iter() {
        println!("  {} {}（规则 {}）", c.id, c.title, c.rules.join(","));
    }
}

pub fn print_consistency(analysis: &Analysis) {
    let resp: ConsistencyResp = analysis.consistency();
    println!(
        "一致性核对：{} 项，通过 {}，失败 {}",
        resp.summary.checked, resp.summary.ok, resp.summary.failed
    );
    for it in resp.items.iter().filter(|i| !i.ok) {
        println!(
            "  失败 {} {} {}：量 1d={} 1m={} 额 1d={} 1m={} {}",
            it.symbol, it.date, it.kind, it.volume_1d, it.volume_1m, it.turnover_1d, it.turnover_1m, it.diff
        );
    }
}

pub fn print_info(meta: &DatasetMeta) {
    println!("数据集：{}", meta.dataset);
    println!("生成时间：{}", meta.generated_at);
    let days = &meta.calendar.trading_days;
    println!(
        "交易日：{} 个（{} … {}）",
        days.len(),
        days.first().cloned().unwrap_or_default(),
        days.last().cloned().unwrap_or_default()
    );
    println!("\n品种：");
    println!(
        "  {:<12} {:<8} {:<7} {:<8} {:>6} {:>8} {:>8}",
        "symbol", "exchange", "asset", "tick", "lot", "multiplier", "sources"
    );
    for i in meta.instruments.iter() {
        println!(
            "  {:<12} {:<8} {:<7} {:<8} {:>6} {:>8} {:>8}",
            i.symbol,
            i.exchange.as_str(),
            if i.is_future() { "future" } else { "equity" },
            i.price_tick,
            i.lot_size,
            i.multiplier,
            i.sources.join(",")
        );
    }
    if !meta.corporate_actions.is_empty() {
        println!("\n除权除息：");
        for (sym, a) in meta.corporate_actions.iter() {
            println!(
                "  {} {} 现金红利 {:.2} 送股 {:.2} 配股 {:.2}@{:.2} 昨收 {:.2} {}",
                sym, a.ex_date, a.cash_div, a.bonus, a.rights, a.rights_price, a.prev_close, a.note
            );
        }
    }
    if !meta.halts.is_empty() {
        println!("\n临时停牌计划：");
        for h in meta.halts.iter() {
            println!(
                "  {} {} {}-{} {}",
                h.symbol,
                h.trade_date,
                mk_core::time::ms_to_hm(h.start),
                mk_core::time::ms_to_hm(h.end),
                h.label
            );
        }
    }
    if !meta.injected_anomalies.is_empty() {
        println!("\n注入异常：{} 条", meta.injected_anomalies.len());
        let mut by_kind: std::collections::BTreeMap<&str, usize> = Default::default();
        for a in meta.injected_anomalies.iter() {
            *by_kind.entry(a.kind.as_str()).or_default() += 1;
        }
        for (k, n) in by_kind.iter() {
            println!("  {:<22} {}", k, n);
        }
    }
}

#[derive(serde::Serialize)]
pub struct BarRow {
    pub symbol: String,
    pub date: String,
    pub period: String,
    pub t: i64,
    pub hm: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
    pub turnover: f64,
    pub count: u32,
    pub oi: Option<u64>,
    pub flags: String,
}

impl BarRow {
    pub fn new(symbol: &str, date: &str, period: &str, b: &Bar) -> Self {
        BarRow {
            symbol: symbol.to_string(),
            date: date.to_string(),
            period: period.to_string(),
            t: b.t,
            hm: b.hm(),
            open: b.open_f(),
            high: b.high_f(),
            low: b.low_f(),
            close: b.close_f(),
            volume: b.volume,
            turnover: b.turnover_f(),
            count: b.count,
            oi: b.oi,
            flags: b.flags.names().join("|"),
        }
    }
}

pub fn to_csv(resp: &BarsResp) -> String {
    let mut out = String::from("date,end,open,high,low,close,volume,turnover,count,bvol,svol,av,syn,cv,flags\n");
    for b in resp.bars.iter() {
        out.push_str(&format!(
            "{},{},{:.4},{:.4},{:.4},{:.4},{},{:.4},{},{},{},{},{},{},{}\n",
            b.date,
            b.end,
            b.o,
            b.h,
            b.l,
            b.c,
            b.v,
            b.to,
            b.n,
            b.bvol,
            b.svol,
            b.av,
            b.syn,
            b.cv,
            b.flags.join("|")
        ));
    }
    out
}
