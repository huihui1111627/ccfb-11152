//! 分析视图：把引擎输出 + 数据集整理成 API 载荷。

use anyhow::Result;
use mk_core::bar::Bar;
use mk_core::factor::FactorSet;
use mk_core::period::{session_windows, Period};
use mk_core::schedule::TradingSchedule;
use mk_core::time::{ms_to_hm, ts_from_local};
use mk_core::{Dataset, Instrument};
use mk_engine::{Engine, EngineOutput, SymbolOutput};
use std::collections::{BTreeMap, HashMap};

use crate::model::*;
use crate::reconcile::ReconcileResp;

pub struct Analysis {
    pub dataset: Dataset,
    pub engine_out: EngineOutput,
    pub golden: Vec<mk_sim::golden::GoldenCase>,
    pub reconcile: Option<ReconcileResp>,
    /// symbol → 日线（供连续合约）
    by_symbol: HashMap<String, SymbolOutput>,
}

impl Analysis {
    pub fn build(dataset: Dataset, golden: Vec<mk_sim::golden::GoldenCase>) -> Result<Self> {
        let engine_out = Engine::new(Default::default()).run(&dataset);
        let by_symbol = engine_out
            .symbols
            .iter()
            .map(|s| (s.symbol.clone(), s.clone()))
            .collect();
        let reconcile = crate::reconcile::reconcile(&golden);
        Ok(Self { dataset, engine_out, golden, reconcile: Some(reconcile), by_symbol })
    }

    fn sym(&self, symbol: &str) -> Result<&SymbolOutput> {
        self.by_symbol
            .get(symbol)
            .ok_or_else(|| anyhow::anyhow!("unknown symbol: {}", symbol))
    }

    pub fn instrument(&self, symbol: &str) -> Option<&Instrument> {
        self.dataset.instrument(symbol)
    }

    // ---------------- /api/meta ----------------
    pub fn meta(&self) -> MetaResp {
        let instruments = self
            .dataset
            .meta
            .instruments
            .iter()
            .map(|i| InstrumentResp {
                symbol: i.symbol.clone(),
                name: i.name.clone(),
                exchange: i.exchange.as_str().to_string(),
                asset: match i.asset {
                    mk_core::AssetClass::Equity => "equity",
                    mk_core::AssetClass::Future => "future",
                }
                .to_string(),
                product: i.product.clone(),
                price_tick: i.price_tick,
                price_decimals: i.price_decimals,
                multiplier: i.multiplier,
                lot_size: i.lot_size,
                limit_pct: i.limit_pct,
                schedule_id: i.schedule_id.as_str().to_string(),
                sources: i.sources.clone(),
                contracts: i.contracts.clone(),
            })
            .collect();
        let trades_kept: usize = self.engine_out.symbols.iter().map(|s| s.trades.len()).sum();
        let trades_isolated: usize = self.engine_out.symbols.iter().map(|s| s.isolated.len()).sum();
        let anomalies: usize = self.engine_out.symbols.iter().map(|s| s.anomalies.len()).sum();
        MetaResp {
            dataset: self.dataset.meta.dataset.clone(),
            generated_at: self.dataset.meta.generated_at.clone(),
            engine_version: self.dataset.meta.engine_version.clone(),
            periods: vec![
                "1m".into(),
                "5m".into(),
                "15m".into(),
                "30m".into(),
                "60m".into(),
                "1d".into(),
            ],
            adjust_modes: vec!["none".into(), "forward".into(), "backward".into()],
            trading_days: self.dataset.meta.calendar.trading_days.clone(),
            instruments,
            summary: DatasetSummary {
                symbols: self.dataset.meta.instruments.len(),
                messages: self.dataset.messages.len(),
                trades_kept,
                trades_isolated,
                anomalies,
                golden_cases: self.golden.len(),
            },
        }
    }

    // ---------------- /api/sessions ----------------
    pub fn sessions(&self, symbol: &str, date: Option<&str>) -> Result<SessionsResp> {
        let inst = self
            .instrument(symbol)
            .ok_or_else(|| anyhow::anyhow!("unknown symbol: {}", symbol))?;
        let schedule =
            TradingSchedule::new(inst.schedule_id, self.dataset.meta.calendar.clone());
        let day = date
            .map(|d| d.to_string())
            .or_else(|| schedule.calendar.trading_days.last().cloned())
            .unwrap_or_default();
        let prev_close = self
            .dataset
            .meta
            .prev_closes
            .iter()
            .find(|p| p.symbol == symbol && p.trade_date == day)
            .map(|p| p.price);
        let sd = schedule
            .session_day(&day, None)
            .ok_or_else(|| anyhow::anyhow!("not a trading day: {}", day))?;
        let segments = sd
            .segments
            .iter()
            .map(|s| SegmentResp {
                kind: match s.kind {
                    mk_core::SegmentKind::Auction => "auction",
                    mk_core::SegmentKind::Continuous => "continuous",
                    mk_core::SegmentKind::Break => "break",
                }
                .into(),
                label: s.label.clone(),
                start: s.start,
                end: s.end,
                hm: s.hm(),
                attach: s.attach.map(|a| format!("{:?}", a).to_lowercase()),
            })
            .collect();
        let halts = self
            .dataset
            .meta
            .halts
            .iter()
            .filter(|h| h.symbol == symbol && h.trade_date == day)
            .map(|h| HaltResp {
                start: h.start,
                end: h.end,
                hm: format!("{}-{}", ms_to_hm(h.start), ms_to_hm(h.end)),
                label: h.label.clone(),
            })
            .collect();
        Ok(SessionsResp {
            symbol: symbol.to_string(),
            trade_date: day,
            calendar_dates: sd.calendar_dates.clone(),
            prev_close,
            segments,
            halts,
        })
    }

    // ---------------- /api/bars ----------------
    pub fn bars(
        &self,
        symbol: &str,
        period: &str,
        date: Option<&str>,
        date_from: Option<&str>,
        date_to: Option<&str>,
        adjust: &str,
        limit: Option<usize>,
    ) -> Result<BarsResp> {
        let inst = self
            .instrument(symbol)
            .ok_or_else(|| anyhow::anyhow!("unknown symbol: {}", symbol))?;
        let p = Period::parse(period).ok_or_else(|| anyhow::anyhow!("invalid period: {}", period))?;
        if adjust != "none" && inst.is_future() {
            anyhow::bail!("adjust_not_supported: 期货不适用复权");
        }
        let out = self.sym(symbol)?;
        let mut all: Vec<&Bar> = Vec::new();
        for (d, per) in out.bars.iter() {
            if let Some(df) = date_from {
                if d.as_str() < df {
                    continue;
                }
            }
            if let Some(dt) = date_to {
                if d.as_str() > dt {
                    continue;
                }
            }
            if let Some(sel) = date {
                if sel != d {
                    continue;
                }
            }
            if let Some(v) = per.get(p.as_str()) {
                all.extend(v.iter());
            }
        }
        all.sort_by_key(|b| b.t);
        let factors = self.dataset.factors_for(symbol);
        let mut bars: Vec<BarResp> = all
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let mut r = BarResp::from_bar(i, b);
                if adjust != "none" && inst.is_equity() {
                    if let Some(fs) = factors {
                        let f = if adjust == "forward" {
                            fs.forward_for(&b.date())
                        } else {
                            fs.backward_for(&b.date())
                        };
                        r.o = mk_core::fixed::round4(FactorSet::apply(b.open, f));
                        r.h = mk_core::fixed::round4(FactorSet::apply(b.high, f));
                        r.l = mk_core::fixed::round4(FactorSet::apply(b.low, f));
                        r.c = mk_core::fixed::round4(FactorSet::apply(b.close, f));
                    }
                }
                r
            })
            .collect();
        let truncated = limit.map(|n| bars.len() > n).unwrap_or(false);
        if let Some(n) = limit {
            if bars.len() > n {
                bars = bars.split_off(bars.len() - n);
                for (i, b) in bars.iter_mut().enumerate() {
                    b.i = i;
                }
            }
        }
        let first_seq = all.iter().map(|b| b.seq0).filter(|s| *s > 0).min().unwrap_or(0);
        let last_seq = all.iter().map(|b| b.seq1).max().unwrap_or(0);
        let note = match adjust {
            "forward" => "前复权：以最新交易日为基准，P_adj = P_raw × Π(除权日>t) q",
            "backward" => "后复权：以最早交易日为基准，P_adj = P_raw ÷ Π(除权日≤t) q",
            _ if truncated => "结果已按 limit 截断（保留最新）",
            _ => "",
        };
        Ok(BarsResp {
            symbol: symbol.to_string(),
            period: p.as_str().to_string(),
            adjust: adjust.to_string(),
            source: "merged".into(),
            meta: BarsMeta {
                count: bars.len(),
                first: bars.first().map(|b| format!("{} {}", b.date, b.end)),
                last: bars.last().map(|b| format!("{} {}", b.date, b.end)),
                first_seq,
                last_seq,
                note: note.to_string(),
            },
            bars,
        })
    }

    // ---------------- /api/replay ----------------
    pub fn replay(&self, symbol: &str, date: Option<&str>) -> Result<ReplayResp> {
        let inst = self
            .instrument(symbol)
            .ok_or_else(|| anyhow::anyhow!("unknown symbol: {}", symbol))?;
        let schedule =
            TradingSchedule::new(inst.schedule_id, self.dataset.meta.calendar.clone());
        let out = self.sym(symbol)?;
        // 默认选取有数据的最后一个交易日
        let day = date
            .map(|d| d.to_string())
            .or_else(|| out.bars.keys().last().cloned())
            .or_else(|| schedule.calendar.trading_days.last().cloned())
            .unwrap_or_default();
        let sd = schedule
            .session_day(&day, None)
            .ok_or_else(|| anyhow::anyhow!("not a trading day: {}", day))?;
        let sessions = sd
            .segments
            .iter()
            .map(|s| SegmentResp {
                kind: match s.kind {
                    mk_core::SegmentKind::Auction => "auction",
                    mk_core::SegmentKind::Continuous => "continuous",
                    mk_core::SegmentKind::Break => "break",
                }
                .into(),
                label: s.label.clone(),
                start: s.start,
                end: s.end,
                hm: s.hm(),
                attach: s.attach.map(|a| format!("{:?}", a).to_lowercase()),
            })
            .collect();
        let halts: Vec<HaltResp> = self
            .dataset
            .meta
            .halts
            .iter()
            .filter(|h| h.symbol == symbol && h.trade_date == day)
            .map(|h| HaltResp {
                start: h.start,
                end: h.end,
                hm: format!("{}-{}", ms_to_hm(h.start), ms_to_hm(h.end)),
                label: h.label.clone(),
            })
            .collect();

        // 网格
        let mut grids = BTreeMap::new();
        for p in [Period::Min1, Period::Min5, Period::Min15, Period::Min30, Period::Min60] {
            let ws = session_windows(&sd, p);
            grids.insert(
                p.as_str().to_string(),
                ws.iter().map(|w| GridWindow { s: w.start, e: w.end }).collect(),
            );
        }

        // 当日成交（按交易日归属）
        let trades: Vec<ReplayTradeResp> = out
            .trades
            .iter()
            .filter(|t| schedule.trade_date_of(t.ts) == day)
            .enumerate()
            .map(|(i, t)| ReplayTradeResp {
                i,
                ts: t.ts,
                p: t.price,
                v: t.volume,
                side: t.side.to_string(),
                id: t.trade_id.clone(),
                src: t.source.clone(),
                syn: t.synthetic,
                auction: t.auction,
                flags: {
                    let mut f = Vec::new();
                    if t.synthetic {
                        f.push("synthetic".to_string());
                    }
                    if t.gap_fill {
                        f.push("gap_fill".to_string());
                    }
                    if !t.reject.is_empty() {
                        f.push(t.reject.clone());
                    }
                    f
                },
                bar_t: t.bar_t,
                seq: t.seq,
            })
            .collect();
        let isolated: Vec<ReplayTradeResp> = out
            .isolated
            .iter()
            .filter(|t| schedule.trade_date_of(t.ts) == day)
            .enumerate()
            .map(|(i, t)| ReplayTradeResp {
                i,
                ts: t.ts,
                p: t.price,
                v: t.volume,
                side: t.side.to_string(),
                id: t.trade_id.clone(),
                src: t.source.clone(),
                syn: t.synthetic,
                auction: t.auction,
                flags: vec![t.reject.clone()],
                bar_t: None,
                seq: t.seq,
            })
            .collect();

        let anomalies: Vec<AnomalyResp> = out
            .anomalies
            .iter()
            .filter(|a| mk_core::time::ms_to_date_string(a.ts) == day || a.ts == 0)
            .map(AnomalyResp::from)
            .collect();

        let mut bars = BTreeMap::new();
        for p in ["1m", "5m", "15m", "30m", "60m", "1d"] {
            if let Some(list) = out.bars.get(&day).and_then(|m| m.get(p)) {
                bars.insert(
                    p.to_string(),
                    list.iter()
                        .enumerate()
                        .map(|(i, b)| BarResp::from_bar(i, b))
                        .collect(),
                );
            }
        }

        let prev_close = self
            .dataset
            .meta
            .prev_closes
            .iter()
            .find(|p| p.symbol == symbol && p.trade_date == day)
            .map(|p| p.price);

        Ok(ReplayResp {
            symbol: symbol.to_string(),
            trade_date: day,
            prev_close,
            sessions,
            halts,
            grids,
            trades,
            isolated,
            anomalies,
            bars,
        })
    }

    // ---------------- /api/factors ----------------
    pub fn factors(&self, symbol: &str) -> Result<FactorsResp> {
        let inst = self
            .instrument(symbol)
            .ok_or_else(|| anyhow::anyhow!("unknown symbol: {}", symbol))?;
        let empty = FactorSet::default();
        let fs = self.dataset.factors_for(symbol).unwrap_or(&empty);
        let mut definitions = BTreeMap::new();
        definitions.insert(
            "q".to_string(),
            "除权价/除权前收盘价 = (prev_close - cash_div + rights·rights_price) / (prev_close·(1+bonus+rights))".to_string(),
        );
        definitions.insert(
            "forward".to_string(),
            "前复权因子 P_adj(t)=P_raw(t)·∏_{ex_date>t} q；基准=最新交易日".to_string(),
        );
        definitions.insert(
            "backward".to_string(),
            "后复权因子 P_adj(t)=P_raw(t)/∏_{ex_date≤t} q；基准=最早交易日".to_string(),
        );
        Ok(FactorsResp {
            symbol: symbol.to_string(),
            asset: if inst.is_future() { "future" } else { "equity" }.to_string(),
            rows: fs.rows.clone(),
            series: fs.series.clone(),
            definitions,
        })
    }

    // ---------------- /api/anomalies ----------------
    pub fn anomalies(
        &self,
        kind: Option<&str>,
        symbol: Option<&str>,
        severity: Option<&str>,
        date: Option<&str>,
        limit: usize,
    ) -> AnomaliesResp {
        let mut items: Vec<AnomalyResp> = Vec::new();
        for s in self.engine_out.symbols.iter() {
            if let Some(sym) = symbol {
                if s.symbol != sym {
                    continue;
                }
            }
            for a in s.anomalies.iter() {
                if let Some(k) = kind {
                    if a.kind.as_str() != k {
                        continue;
                    }
                }
                if let Some(sev) = severity {
                    if a.severity.as_str() != sev {
                        continue;
                    }
                }
                if let Some(d) = date {
                    if mk_core::time::ms_to_date_string(a.ts) != d {
                        continue;
                    }
                }
                items.push(AnomalyResp::from(a));
            }
        }
        let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_severity: BTreeMap<String, usize> = BTreeMap::new();
        for a in items.iter() {
            *by_kind.entry(a.kind.clone()).or_default() += 1;
            *by_severity.entry(a.severity.clone()).or_default() += 1;
        }
        items.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
        let total = items.len();
        if items.len() > limit {
            items.truncate(limit);
        }
        AnomaliesResp { total, items, by_kind, by_severity }
    }

    // ---------------- /api/sources ----------------
    pub fn sources(&self, symbol: Option<&str>) -> SourcesResp {
        let mut items = Vec::new();
        for s in self.engine_out.symbols.iter() {
            if let Some(sym) = symbol {
                if s.symbol != sym {
                    continue;
                }
            }
            for st in s.source_stats.iter() {
                items.push(SourceItem {
                    symbol: s.symbol.clone(),
                    source: st.source.clone(),
                    channel: st.channel,
                    received: st.received,
                    duplicates: st.duplicates,
                    gaps: st.gaps,
                    gap_seq_total: st.gap_seq_total,
                    filled_trades: st.filled_trades,
                    filled_volume: st.filled_volume,
                    synthetic_trades: st.synthetic_trades,
                    unfilled: st.unfilled,
                    first_seq: st.first_seq,
                    last_seq: st.last_seq,
                    inversions: st.inversions,
                });
            }
        }
        SourcesResp { items }
    }

    // ---------------- /api/continuous ----------------
    pub fn continuous(&self, product: &str, period: &str) -> Result<ContinuousResp> {
        let p = self
            .dataset
            .meta
            .products
            .iter()
            .find(|p| p.code == product)
            .ok_or_else(|| anyhow::anyhow!("unknown product: {}", product))?;
        let contracts = &p.contracts;
        // 每日持仓量：取各合约日线的 oi（引擎输出）
        let mut oi_map: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        for c in contracts.iter() {
            if let Some(out) = self.by_symbol.get(c) {
                for (d, per) in out.bars.iter() {
                    if let Some(daily) = per.get("1d").and_then(|v| v.first()) {
                        oi_map.insert(
                            (c.clone(), d.clone()),
                            (daily.oi.unwrap_or(0), daily.volume),
                        );
                    }
                }
            }
        }
        let days = self.dataset.meta.calendar.trading_days.clone();
        let mains = mk_core::continuous::build_main(&days, contracts, &|d, c| {
            oi_map.get(&(c.to_string(), d.to_string())).copied()
        });
        let daily_of = |d: &str, c: &str| -> Option<Bar> {
            self.by_symbol
                .get(c)
                .and_then(|o| o.bars.get(d))
                .and_then(|p| p.get("1d"))
                .and_then(|v| v.first().cloned())
        };
        let series = mk_core::continuous::build_continuous(&mains, &|d, c| daily_of(d, c));
        Ok(ContinuousResp {
            product: product.to_string(),
            period: period.to_string(),
            main: series.main,
            rolls: series.rolls,
            bars: series.bars,
        })
    }

    // ---------------- /api/consistency ----------------
    pub fn consistency(&self) -> ConsistencyResp {
        let mut items = Vec::new();
        let mut ok = 0usize;
        let mut failed = 0usize;
        for s in self.engine_out.symbols.iter() {
            for (date, per) in s.bars.iter() {
                let Some(ones) = per.get("1m") else { continue };
                let Some(daily) = per.get("1d").and_then(|v| v.first()) else { continue };
                let vol1m: u64 = ones.iter().map(|b| b.volume).sum();
                let to1m: f64 = ones.iter().map(|b| b.turnover_f()).sum();
                let vol_ok = vol1m == daily.volume;
                let to_ok = (to1m - daily.turnover_f()).abs() < 0.01;
                let pass = vol_ok && to_ok;
                if pass {
                    ok += 1;
                } else {
                    failed += 1;
                }
                items.push(ConsistencyItem {
                    symbol: s.symbol.clone(),
                    date: date.clone(),
                    kind: "1d_vs_1m".into(),
                    volume_1d: daily.volume,
                    volume_1m: vol1m,
                    turnover_1d: daily.turnover_f(),
                    turnover_1m: (to1m * 10000.0).round() / 10000.0,
                    ok: pass,
                    diff: if pass {
                        String::new()
                    } else {
                        format!(
                            "量差 {}，额差 {}",
                            daily.volume as i64 - vol1m as i64,
                            daily.turnover_f() - to1m
                        )
                    },
                });
                // 5m 与 1m
                if let Some(fives) = per.get("5m") {
                    let vol5: u64 = fives.iter().map(|b| b.volume).sum();
                    let pass5 = vol5 == vol1m;
                    if pass5 {
                        ok += 1;
                    } else {
                        failed += 1;
                    }
                    items.push(ConsistencyItem {
                        symbol: s.symbol.clone(),
                        date: date.clone(),
                        kind: "5m_vs_1m".into(),
                        volume_1d: vol5,
                        volume_1m: vol1m,
                        turnover_1d: daily.turnover_f(),
                        turnover_1m: (to1m * 10000.0).round() / 10000.0,
                        ok: pass5,
                        diff: if pass5 {
                            String::new()
                        } else {
                            format!("量差 {}", vol5 as i64 - vol1m as i64)
                        },
                    });
                }
            }
        }
        let checked = items.len();
        ConsistencyResp {
            summary: ConsistencySummary { checked, ok, failed },
            items,
        }
    }

    pub fn replay_defaults(&self) -> BTreeMap<String, Vec<String>> {
        let mut m = BTreeMap::new();
        for (sym, out) in self.by_symbol.iter() {
            m.insert(sym.clone(), out.bars.keys().cloned().collect());
        }
        m
    }

    /// 异常召回率（注入真值 vs 引擎识别）。
    ///
    /// 匹配口径：同一品种下，引擎产出的异常中**存在同类异常**且（注入有 trade_id 时）
    /// trade_id 一致；`trade_cancel` / `seq_gap` / `order_reject` 这类"动作型"注入
    /// 允许映射到其引擎侧的表现类型。
    pub fn injection_recall(&self) -> Vec<RecallRow> {
        let mut rows = Vec::new();
        for inj in self.dataset.meta.injected_anomalies.iter() {
            let sym_out = self.engine_out.symbols.iter().find(|s| s.symbol == inj.symbol);
            let detected = sym_out
                .map(|s| {
                    s.anomalies.iter().any(|a| {
                        let kind_ok = a.kind.as_str() == inj.kind
                            || matches!(
                                (inj.kind.as_str(), a.kind),
                                ("trade_cancel", mk_core::AnomalyKind::TradeCanceled)
                                    | ("trade_cancel", mk_core::AnomalyKind::CancelUnknown)
                                    | ("trade_correct", mk_core::AnomalyKind::TradeCorrected)
                                    | ("order_reject", mk_core::AnomalyKind::OrderRejected)
                                    | ("seq_gap", mk_core::AnomalyKind::SeqGap)
                                    | ("seq_gap", mk_core::AnomalyKind::SeqGapFilled)
                            );
                        if !kind_ok {
                            return false;
                        }
                        match (&inj.trade_id, &a.trade_id) {
                            (Some(want), Some(got)) => want == got,
                            // 注入没有指定成交（如 seq_gap），同类异常即可
                            (None, _) => true,
                            // 引擎侧该异常没有 trade_id，退化为同类即可
                            (Some(_), None) => true,
                        }
                    })
                })
                .unwrap_or(false);
            rows.push(RecallRow {
                injected_kind: inj.kind.clone(),
                symbol: inj.symbol.clone(),
                trade_id: inj.trade_id.clone(),
                note: inj.note.clone(),
                detected,
            });
        }
        rows
    }

    pub fn reconcile(&self) -> Option<&ReconcileResp> {
        self.reconcile.as_ref()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RecallRow {
    pub injected_kind: String,
    pub symbol: String,
    pub trade_id: Option<String>,
    pub note: String,
    pub detected: bool,
}

/// 工具：取某个交易日的某个周期 bar。
pub fn bars_for(out: &SymbolOutput, date: &str, period: &str) -> Vec<Bar> {
    out.bars
        .get(date)
        .and_then(|p| p.get(period))
        .cloned()
        .unwrap_or_default()
}

pub fn ts(s: &str) -> i64 {
    ts_from_local(s).unwrap_or(0)
}
