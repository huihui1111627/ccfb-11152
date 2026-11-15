//! 引擎主流程：合并 → 校验/隔离 → 1m 账本 → 聚合。

use crate::aggregate::aggregate_bars;
use crate::builder::{anomaly, DayLedger, ReversalOutcome, TradeInput};
use crate::config::EngineConfig;
use crate::merge::{merge, Conflict, Gap, Merged, NormEvent, SourceStats};
use crate::metrics::SymbolMetrics;
use crate::validate::{check_price, check_volume_spike};
use mk_core::bar::Bar;
use mk_core::fixed::{from_f64, limit_price, round4};
use mk_core::period::session_windows;
use mk_core::schedule::TradingSchedule;
use mk_core::time::ms_to_hm;
use mk_core::{Anomaly, AnomalyKind, CorrectionAction, Dataset, Instrument, Period};
use std::collections::{BTreeMap, HashMap, VecDeque};

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SymbolOutput {
    pub symbol: String,
    /// 交易日 → 周期 → bar（按时间升序）
    pub bars: BTreeMap<String, BTreeMap<String, Vec<Bar>>>,
    pub trades: Vec<ReplayTrade>,
    pub isolated: Vec<ReplayTrade>,
    pub anomalies: Vec<Anomaly>,
    pub days: Vec<DayMeta>,
    pub metrics: SymbolMetrics,
    pub source_stats: Vec<SourceStats>,
    pub gaps: Vec<Gap>,
    pub conflicts: Vec<Conflict>,
    pub snapshots: Vec<ReplaySnapshot>,
    /// 快照给出的持仓量（date → oi），供日线使用
    pub oi_by_date: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReplayTrade {
    pub seq: u64,
    pub ts: i64,
    pub price: f64,
    pub volume: u64,
    pub side: char,
    pub trade_id: String,
    pub source: String,
    pub synthetic: bool,
    pub auction: bool,
    pub gap_fill: bool,
    pub reject: String,
    pub bar_t: Option<i64>,
    pub seq_src: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReplaySnapshot {
    pub ts: i64,
    pub last: f64,
    pub oi: Option<u64>,
    pub cum_volume: Option<u64>,
    pub source: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DayMeta {
    pub trade_date: String,
    pub prev_close: Option<f64>,
    pub bars_1m: u64,
    pub halt_windows: Vec<(i64, i64)>,
    pub anomalies: u64,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct EngineOutput {
    pub symbols: Vec<SymbolOutput>,
}

pub struct Engine {
    pub config: EngineConfig,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Self {
        Self { config }
    }

    pub fn run(&self, dataset: &Dataset) -> EngineOutput {
        EngineOutput {
            symbols: dataset
                .meta
                .instruments
                .iter()
                .map(|i| self.run_symbol(dataset, i))
                .collect(),
        }
    }

    pub fn run_symbol(&self, dataset: &Dataset, inst: &Instrument) -> SymbolOutput {
        let policy = self.config.for_instrument(inst.is_future());
        let schedule = TradingSchedule::new(inst.schedule_id, dataset.meta.calendar.clone());
        let merged = merge(&inst.symbol, &dataset.messages, "A");

        // 昨收表
        let prev_closes: HashMap<String, i64> = dataset
            .meta
            .prev_closes
            .iter()
            .filter(|p| p.symbol == inst.symbol)
            .map(|p| (p.trade_date.clone(), from_f64(p.price)))
            .collect();

        // 停牌表
        let halts: HashMap<String, Vec<(i64, i64, String)>> = {
            let mut m: HashMap<String, Vec<(i64, i64, String)>> = HashMap::new();
            for h in dataset.meta.halts.iter().filter(|h| h.symbol == inst.symbol) {
                m.entry(h.trade_date.clone())
                    .or_default()
                    .push((h.start, h.end, h.label.clone()));
            }
            m
        };

        let mut out = SymbolOutput {
            symbol: inst.symbol.clone(),
            ..Default::default()
        };
        out.source_stats = merged.stats.clone();
        out.gaps = merged.gaps.clone();
        out.conflicts = merged.conflicts.clone();

        let mut anomaly_counter: u64 = 0;
        let mut anomalies: Vec<Anomaly> = Vec::new();

        // 由消息流构造交易日集合（含夜盘归属）
        let mut dates: Vec<String> = merged
            .events
            .iter()
            .map(|e| schedule.trade_date_of(e.ts()))
            .collect();
        dates.extend(schedule.calendar.trading_days.clone());
        dates.sort();
        dates.dedup();
        // 只保留日历内、且确有数据的交易日
        let mut ledger_dates: Vec<String> = Vec::new();
        for d in dates {
            if schedule.calendar.is_trading_day(&d) {
                ledger_dates.push(d);
            }
        }

        // 每源的最后一个 ts（用于倒挂异常的展示 ts）
        for inv in merged.inversions.iter() {
            let a = anomaly(
                &mut anomaly_counter,
                AnomalyKind::TimestampInversion,
                &inst.symbol,
                &inv.source,
                inv.ts,
                format!(
                    "{} 序号 {} 的时间 {} 早于前一条消息的 {}，判定为时间戳倒挂并隔离",
                    inv.kind,
                    inv.seq,
                    ms_to_hm(inv.ts),
                    ms_to_hm(inv.prev_ts)
                ),
                inv.trade_id.clone(),
                Some(inv.seq),
                None,
            );
            anomalies.push(a);
        }
        for d in merged.duplicates.iter() {
            anomalies.push(anomaly(
                &mut anomaly_counter,
                AnomalyKind::DuplicateSeq,
                &inst.symbol,
                &d.source,
                0,
                format!("源 {} 序号 {} 重复：{}", d.source, d.seq, d.note),
                None,
                Some(d.seq),
                None,
            ));
        }
        for c in merged.conflicts.iter() {
            anomalies.push(anomaly(
                &mut anomaly_counter,
                AnomalyKind::SourceConflict,
                &inst.symbol,
                &c.b_source,
                c.ts,
                format!(
                    "成交 {} 在源 {} 与源 {} 的 {} 不一致（{} vs {}），采用主源",
                    c.trade_id, c.a_source, c.b_source, c.field, c.a_value, c.b_value
                ),
                Some(c.trade_id.clone()),
                None,
                None,
            ));
        }
        for g in merged.gaps.iter() {
            let (kind, action_desc) = match g.filled {
                Some(crate::merge::FillOrigin::Peer) => (
                    AnomalyKind::SeqGapFilled,
                    format!("已用对源补 {} 笔", g.filled_count),
                ),
                Some(crate::merge::FillOrigin::Synthetic) => (
                    AnomalyKind::SeqGapFilled,
                    format!("已用快照差额合成 {} 笔", g.synthetic_count),
                ),
                None => (AnomalyKind::GapUnfilled, "无法补全".to_string()),
            };
            anomalies.push(anomaly(
                &mut anomaly_counter,
                kind,
                &inst.symbol,
                &g.source,
                g.next_ts,
                format!(
                    "源 {} 序号缺口 [{}, {}]（{} 条），窗口 ({}, {}]，{}",
                    g.source,
                    g.from_seq,
                    g.to_seq,
                    g.size(),
                    ms_to_hm(g.prev_ts),
                    ms_to_hm(g.next_ts),
                    action_desc
                ),
                None,
                Some(g.from_seq),
                None,
            ));
            // 同时记录一条 seq_gap（warn）作为原始缺口事件
            anomalies.push(anomaly(
                &mut anomaly_counter,
                AnomalyKind::SeqGap,
                &inst.symbol,
                &g.source,
                g.next_ts,
                format!(
                    "源 {} 序号从 {} 跳到 {}，缺 {} 条",
                    g.source,
                    g.from_seq.saturating_sub(1),
                    g.to_seq + 2,
                    g.size()
                ),
                None,
                Some(g.to_seq),
                None,
            ));
        }

        // 处理事件：先为每个交易日准备账本
        let mut ledgers: HashMap<String, DayLedger> = HashMap::new();
        // 每源的最后有效 ts（倒挂的成交已在 merge 标出，这里按 trade_id 排除）
        let inverted_ids: std::collections::HashSet<String> = merged
            .inversions
            .iter()
            .filter_map(|i| i.trade_id.clone())
            .collect();

        // 参考价状态
        let tick = inst.price_tick_fixed();
        let multiplier = inst.multiplier_fixed();
        let jump_fixed = policy.jump_fixed();
        let limit_pct = inst.limit_pct.map(|p| from_f64(p));

        // 每交易日独立维护 last_ref / 滚动量窗口
        let mut ref_price: HashMap<String, i64> = HashMap::new();
        let mut vol_window: HashMap<String, VecDeque<u64>> = HashMap::new();
        let mut last_ts_by_source: HashMap<String, i64> = HashMap::new();
        // 待冲正表（R24）：trade_id → 冲正动作
        let mut pending: HashMap<String, Vec<PendingRev>> = HashMap::new();
        // 记录每笔"有效成交"的 trade_id，用于冲正查找
        let mut trade_date_of_id: HashMap<String, String> = HashMap::new();

        // 快照持仓量：每个交易日最后一个快照的 oi
        let mut oi_last: HashMap<String, (i64, u64)> = HashMap::new();

        // 事件按 ts 升序（merge 已排好）；成交 & 冲正交错处理
        for ev in merged.events.iter() {
            match ev {
                NormEvent::Trade(nt) => {
                    let trade_date = schedule.trade_date_of(nt.ts);
                    // 非交易日（周末/节假日）的成交：没有任何时段可归属，
                    // 必须报 out_of_session 并隔离，而不是静默丢弃。
                    let Some(day) = schedule.session_day(&trade_date, None) else {
                        anomalies.push(anomaly(
                            &mut anomaly_counter,
                            AnomalyKind::OutOfSession,
                            &inst.symbol,
                            &nt.source,
                            nt.ts,
                            format!(
                                "成交时间 {} 落在非交易日 {}（不在交易日历内）",
                                ms_to_hm(nt.ts),
                                trade_date
                            ),
                            Some(nt.trade_id.clone()),
                            Some(nt.src_seq),
                            None,
                        ));
                        out.isolated.push(ReplayTrade {
                            seq: nt.seq,
                            ts: nt.ts,
                            price: nt.price_f,
                            volume: nt.volume,
                            side: nt.side,
                            trade_id: nt.trade_id.clone(),
                            source: nt.source.clone(),
                            synthetic: nt.synthetic,
                            auction: nt.auction,
                            gap_fill: nt.from_gap_fill,
                            reject: "out_of_session".to_string(),
                            bar_t: None,
                            seq_src: nt.src_seq,
                        });
                        continue;
                    };
                    let day_halts = halts.get(&trade_date).cloned().unwrap_or_default();

                    // 1) 是否在交易时段（R02/R04）
                    // 连续竞价：时间戳落在连续段内；
                    // 集合竞价：只有**撮合时刻**（竞价段 end）才允许成交，其余时间不交易。
                    let in_continuous = day.continuous().any(|s| s.contains(nt.ts));
                    let auction_match = day.auctions().find(|a| a.end == nt.ts).is_some();
                    let in_session = in_continuous || auction_match;
                    // 竞价标记：消息自带 auction，或时间戳恰为竞价撮合时刻
                    let is_auction_ts = nt.auction || auction_match;
                    // 2) 停牌
                    let in_halt = day_halts
                        .iter()
                        .find(|(s, e, _)| nt.ts > *s && nt.ts <= *e)
                        .cloned();

                    let mut reject_reason: Option<(AnomalyKind, String)> = None;

                    if inverted_ids.contains(&nt.trade_id) {
                        reject_reason = Some((
                            AnomalyKind::TimestampInversion,
                            format!(
                                "成交 {} 时间 {} 早于同源前一条消息，已隔离",
                                nt.trade_id,
                                ms_to_hm(nt.ts)
                            ),
                        ));
                    } else if !in_session {
                        reject_reason = Some((
                            AnomalyKind::OutOfSession,
                            format!(
                                "成交时间 {} 不在 {} 的任何交易时段内",
                                ms_to_hm(nt.ts),
                                trade_date
                            ),
                        ));
                    } else if let Some((s, e, label)) = in_halt.as_ref() {
                        reject_reason = Some((
                            AnomalyKind::TradeDuringHalt,
                            format!(
                                "成交时间 {} 落在停牌区间 {}-{}（{}）内",
                                ms_to_hm(nt.ts),
                                ms_to_hm(*s),
                                ms_to_hm(*e),
                                label
                            ),
                        ));
                    }

                    let price_fixed = from_f64(nt.price_f);
                    if reject_reason.is_none() {
                        let prev_close = prev_closes.get(&trade_date).copied().unwrap_or(0);
                        // R41：当日首笔成交的参考价是昨收，但**首笔允许跳空到涨跌停区间内的任何价位**
                        // （开盘跳空是合法行情），因此对首笔不施加 jump_pct 判定，只做涨跌停校验。
                        let has_prior = ref_price.contains_key(&trade_date);
                        let (rp, jump) = if has_prior {
                            (ref_price[&trade_date], jump_fixed)
                        } else {
                            (prev_close, 0)
                        };
                        let (dn, up) = if let Some(pct) = limit_pct {
                            if prev_close > 0 {
                                let (d, u) = limit_price(prev_close, pct, tick);
                                (Some(d), Some(u))
                            } else {
                                (None, None)
                            }
                        } else {
                            (None, None)
                        };
                        if let Some(rej) = check_price(
                            inst,
                            price_fixed,
                            nt.volume,
                            rp,
                            jump,
                            dn,
                            up,
                        ) {
                            reject_reason = Some((rej.kind, rej.detail));
                        } else if !is_auction_ts {
                            // 集合竞价成交的量天然很大（一次性撮合），不参与"成交量异常"判定（R44）：
                            // 否则每个交易日的竞价都会被误判隔离。
                            if let Some(rej) = check_volume_spike(
                                nt.volume,
                                vol_window.get(&trade_date).map(|v| v.as_slices().0).unwrap_or(&[]),
                                policy.spike_min_volume,
                                policy.spike_multiple,
                            ) {
                                reject_reason = Some((rej.kind, rej.detail));
                            }
                        }
                    }

                    if let Some((kind, detail)) = reject_reason {
                        let a = anomaly(
                            &mut anomaly_counter,
                            kind,
                            &inst.symbol,
                            &nt.source,
                            nt.ts,
                            detail.clone(),
                            Some(nt.trade_id.clone()),
                            Some(nt.src_seq),
                            None,
                        );
                        anomalies.push(a);
                        out.isolated.push(ReplayTrade {
                            seq: nt.seq,
                            ts: nt.ts,
                            price: nt.price_f,
                            volume: nt.volume,
                            side: nt.side,
                            trade_id: nt.trade_id.clone(),
                            source: nt.source.clone(),
                            synthetic: nt.synthetic,
                            auction: nt.auction,
                            gap_fill: nt.from_gap_fill,
                            reject: kind.as_str().to_string(),
                            bar_t: None,
                            seq_src: nt.src_seq,
                        });
                        // R42：隔离成交不更新参考价与滚动窗口
                        if matches!(kind, AnomalyKind::TimestampInversion) {
                            // 倒挂的成交仍推进 source ts 用于后续判定？按 R43 同源仍以最大 ts 为准
                        }
                        continue;
                    }

                    // 合法 → 入账
                    let ledger = ledgers.entry(trade_date.clone()).or_insert_with(|| {
                        let windows = session_windows(&day, Period::Min1);
                        DayLedger::new(
                            trade_date.clone(),
                            windows,
                            prev_closes.get(&trade_date).copied().unwrap_or(0),
                            multiplier,
                            policy.empty_bar_policy,
                        )
                    });
                    // 停牌窗口标记
                    for (s, e, _) in day_halts.iter() {
                        for slot in ledger.slots.iter_mut() {
                            if slot.window.label > *s && slot.window.label <= *e {
                                slot.halted = true;
                            } else if slot.window.end > *s && slot.window.start < *e {
                                slot.halt_overlap = true;
                            }
                        }
                    }
                    // 缺口标记（按时间窗）
                    for g in merged.gaps.iter().filter(|g| g.filled.is_none()) {
                        if nt.ts > g.prev_ts && nt.ts <= g.next_ts {
                            if let Some(idx) = ledger.locate(nt.ts, is_auction_ts) {
                                ledger.slots[idx].gap_unfilled = true;
                            }
                        }
                    }

                    let auction = is_auction_ts;
                    let Some(slot_idx) = ledger.locate(nt.ts, auction) else {
                        // 理论上 in_session 保证能定位；若无 slot 则记异常
                        anomalies.push(anomaly(
                            &mut anomaly_counter,
                            AnomalyKind::OutOfSession,
                            &inst.symbol,
                            &nt.source,
                            nt.ts,
                            format!("成交时间 {} 无法定位到任何 1 分钟窗口", ms_to_hm(nt.ts)),
                            Some(nt.trade_id.clone()),
                            Some(nt.src_seq),
                            None,
                        ));
                        continue;
                    };

                    let bt = TradeInput {
                        trade_id: &nt.trade_id,
                        seq: nt.seq,
                        ts: nt.ts,
                        price: price_fixed,
                        volume: nt.volume,
                        side: nt.side,
                        auction,
                        synthetic: nt.synthetic,
                        source: &nt.source,
                        multiplier,
                    }
                    .to_bar_trade();
                    if ledger.add_trade(slot_idx, bt).is_err() {
                        continue;
                    }
                    trade_date_of_id.insert(nt.trade_id.clone(), trade_date.clone());
                    // 更新参考价与滚动窗口
                    ref_price.insert(trade_date.clone(), price_fixed);
                    vol_window
                        .entry(trade_date.clone())
                        .or_default()
                        .push_back(nt.volume);
                    if let Some(w) = vol_window.get_mut(&trade_date) {
                        if w.len() > policy.spike_window {
                            w.pop_front();
                        }
                    }
                    last_ts_by_source.insert(nt.source.clone(), nt.ts);

                    out.trades.push(ReplayTrade {
                        seq: nt.seq,
                        ts: nt.ts,
                        price: nt.price_f,
                        volume: nt.volume,
                        side: nt.side,
                        trade_id: nt.trade_id.clone(),
                        source: nt.source.clone(),
                        synthetic: nt.synthetic,
                        auction,
                        gap_fill: nt.from_gap_fill,
                        reject: String::new(),
                        bar_t: Some(ledger.slots[slot_idx].window.label),
                        seq_src: nt.src_seq,
                    });

                    // 若有待冲正（乱序：冲正先到）→ 立即执行
                    if let Some(pend) = pending.remove(&nt.trade_id) {
                        for p in pend {
                            apply_reversal(
                                &mut ledgers,
                                &mut anomalies,
                                &mut anomaly_counter,
                                &inst.symbol,
                                &p,
                                &nt.trade_id,
                                &trade_date_of_id,
                                &schedule,
                                policy.late_correction_seq_gap,
                                &mut out,
                            );
                        }
                    }
                }
                NormEvent::TradeCancel { seq, ref_trade_id, ts, source } => {
                    let p = PendingRev {
                        seq: *seq,
                        ts: *ts,
                        source: source.clone(),
                        kind: AnomalyKind::CancelUnknown,
                        correction: None,
                    };
                    if trade_date_of_id.contains_key(ref_trade_id) {
                        apply_reversal(
                            &mut ledgers,
                            &mut anomalies,
                            &mut anomaly_counter,
                            &inst.symbol,
                            &p,
                            ref_trade_id,
                            &trade_date_of_id,
                            &schedule,
                            policy.late_correction_seq_gap,
                            &mut out,
                        );
                    } else {
                        pending.entry(ref_trade_id.clone()).or_default().push(p);
                        anomalies.push(anomaly(
                            &mut anomaly_counter,
                            AnomalyKind::CorrectionUnknown,
                            &inst.symbol,
                            source,
                            *ts,
                            format!(
                                "成交撤销消息引用的成交 {} 尚未收到（可能乱序），已进入待冲正表",
                                ref_trade_id
                            ),
                            Some(ref_trade_id.clone()),
                            Some(*seq),
                            None,
                        ));
                    }
                }
                NormEvent::TradeCorrect { seq, ref_trade_id, ts, source, corr } => {
                    let p = PendingRev {
                        seq: *seq,
                        ts: *ts,
                        source: source.clone(),
                        kind: AnomalyKind::CorrectionUnknown,
                        correction: Some(corr.clone()),
                    };
                    if trade_date_of_id.contains_key(ref_trade_id) {
                        apply_reversal(
                            &mut ledgers,
                            &mut anomalies,
                            &mut anomaly_counter,
                            &inst.symbol,
                            &p,
                            ref_trade_id,
                            &trade_date_of_id,
                            &schedule,
                            policy.late_correction_seq_gap,
                            &mut out,
                        );
                        // 更正后若成交仍有效，更新 trade_date_of_id
                    } else {
                        pending.entry(ref_trade_id.clone()).or_default().push(p);
                        anomalies.push(anomaly(
                            &mut anomaly_counter,
                            AnomalyKind::CorrectionUnknown,
                            &inst.symbol,
                            source,
                            *ts,
                            format!(
                                "成交更正消息引用的成交 {} 尚未收到，已进入待冲正表",
                                ref_trade_id
                            ),
                            Some(ref_trade_id.clone()),
                            Some(*seq),
                            None,
                        ));
                    }
                }
                NormEvent::OrderReject { seq, order_id, ts, source } => {
                    // 废单：若该委托有成交则逐笔冲正（R20）
                    let related = trades_of_order(&merged, order_id);
                    for tid in related {
                        if trade_date_of_id.contains_key(&tid) {
                            let p = PendingRev {
                                seq: *seq,
                                ts: *ts,
                                source: source.clone(),
                                kind: AnomalyKind::OrderRejected,
                                correction: None,
                            };
                            apply_reversal(
                                &mut ledgers,
                                &mut anomalies,
                                &mut anomaly_counter,
                                &inst.symbol,
                                &p,
                                &tid,
                                &trade_date_of_id,
                                &schedule,
                                policy.late_correction_seq_gap,
                                &mut out,
                            );
                        }
                    }
                    anomalies.push(anomaly(
                        &mut anomaly_counter,
                        AnomalyKind::OrderRejected,
                        &inst.symbol,
                        source,
                        *ts,
                        format!("委托 {} 收到废单消息，相关成交已逐笔冲正", order_id),
                        None,
                        Some(*seq),
                        None,
                    ));
                }
                NormEvent::Snapshot { snap, source, .. } => {
                    let td = schedule.trade_date_of(snap.ts);
                    if let Some(oi) = snap.oi {
                        let e = oi_last.entry(td).or_insert((0, 0));
                        if snap.ts >= e.0 {
                            *e = (snap.ts, oi);
                        }
                    }
                    out.snapshots.push(ReplaySnapshot {
                        ts: snap.ts,
                        last: snap.last,
                        oi: snap.oi,
                        cum_volume: snap.cum_volume,
                        source: source.clone(),
                    });
                }
                NormEvent::HaltBegin { ts, source, reason, .. } => {
                    anomalies.push(anomaly(
                        &mut anomaly_counter,
                        AnomalyKind::HaltBegin,
                        &inst.symbol,
                        source,
                        *ts,
                        format!("临时停牌开始：{}", reason),
                        None,
                        None,
                        None,
                    ));
                }
                NormEvent::HaltEnd { ts, source, .. } => {
                    anomalies.push(anomaly(
                        &mut anomaly_counter,
                        AnomalyKind::HaltEnd,
                        &inst.symbol,
                        source,
                        *ts,
                        "临时停牌结束".to_string(),
                        None,
                        None,
                        None,
                    ));
                }
                NormEvent::OrderCancel { .. } | NormEvent::Order { .. } => {}
            }
        }

        // 剩余待冲正 → 收盘仍未收到原成交
        for (tid, list) in pending.iter() {
            for p in list {
                anomalies.push(anomaly(
                    &mut anomaly_counter,
                    AnomalyKind::CancelUnknown,
                    &inst.symbol,
                    &p.source,
                    p.ts,
                    format!("冲正/更正引用的成交 {} 至收盘仍未收到", tid),
                    Some(tid.clone()),
                    Some(p.seq),
                    None,
                ));
            }
        }

        // 生成 bar
        for (trade_date, ledger) in ledgers.iter() {
            let Some(day) = schedule.session_day(trade_date, None) else {
                continue;
            };
            let minute_bars = ledger.bars();
            if minute_bars.is_empty() {
                continue;
            }
            // 1m 是否补齐空 bar 由策略决定；高周期始终 fill，保证网格与"行情软件"一致
    let fill = true;
            let mut per_period: BTreeMap<String, Vec<Bar>> = BTreeMap::new();
            per_period.insert("1m".to_string(), minute_bars.clone());
            for p in [Period::Min5, Period::Min15, Period::Min30, Period::Min60] {
                let mut bars = aggregate_bars(&day, &minute_bars, p, fill);
                // 期货 oi 沿用当日最后快照
                if let Some((_, oi)) = oi_last.get(trade_date) {
                    for b in bars.iter_mut() {
                        b.oi = Some(*oi);
                    }
                }
                per_period.insert(p.as_str().to_string(), bars);
            }
            let mut daily: Vec<Bar> = aggregate_bars(&day, &minute_bars, Period::Day, false)
                .into_iter()
                .collect();
            if let Some(b) = daily.first_mut() {
                if inst.is_future() {
                    b.oi = oi_last.get(trade_date).map(|(_, oi)| *oi);
                }
            }
            per_period.insert("1d".to_string(), daily);
            out.bars.insert(trade_date.clone(), per_period);

            out.days.push(DayMeta {
                trade_date: trade_date.clone(),
                prev_close: prev_closes.get(trade_date).map(|p| round4(*p)),
                bars_1m: minute_bars.len() as u64,
                halt_windows: halts
                    .get(trade_date)
                    .map(|v| v.iter().map(|(s, e, _)| (*s, *e)).collect())
                    .unwrap_or_default(),
                anomalies: 0,
            });
        }
        for (td, (_, oi)) in oi_last.iter() {
            out.oi_by_date.insert(td.clone(), *oi);
        }

        // 排序
        out.trades.sort_by_key(|t| (t.ts, t.seq));
        out.isolated.sort_by_key(|t| (t.ts, t.seq));
        out.anomalies.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
        out.days.sort_by(|a, b| a.trade_date.cmp(&b.trade_date));
        out.snapshots.sort_by_key(|s| s.ts);

        // 统计
        let m = SymbolMetrics {
            symbol: inst.symbol.clone(),
            messages_in: merged.events.len() as u64,
            trades_kept: out.trades.len() as u64,
            trades_isolated: out.isolated.len() as u64,
            trades_synthetic: out.trades.iter().filter(|t| t.synthetic).count() as u64,
            trades_reversed: out
                .bars
                .values()
                .flat_map(|p| p.get("1m").into_iter().flatten())
                .map(|b| b.canceled_volume)
                .sum::<u64>(),
            corrections: anomalies
                .iter()
                .filter(|a| matches!(a.kind, AnomalyKind::LateCorrection | AnomalyKind::CorrectionUnknown))
                .count() as u64,
            bars_1m: out.bars.values().flat_map(|p| p.get("1m").into_iter().flatten()).count() as u64,
            anomalies: anomalies.len() as u64,
            errors: anomalies.iter().filter(|a| matches!(a.severity, mk_core::Severity::Error)).count() as u64,
            warns: anomalies.iter().filter(|a| matches!(a.severity, mk_core::Severity::Warn)).count() as u64,
        };
        out.metrics = m;
        out.anomalies = anomalies;
        out
    }
}

#[derive(Debug, Clone)]
struct PendingRev {
    seq: u64,
    ts: i64,
    source: String,
    kind: AnomalyKind,
    correction: Option<CorrectionAction>,
}

#[allow(clippy::too_many_arguments)]
fn apply_reversal(
    ledgers: &mut HashMap<String, DayLedger>,
    anomalies: &mut Vec<Anomaly>,
    counter: &mut u64,
    symbol: &str,
    p: &PendingRev,
    trade_id: &str,
    trade_date_of_id: &HashMap<String, String>,
    _schedule: &TradingSchedule,
    late_gap: u64,
    out: &mut SymbolOutput,
) {
    let Some(td) = trade_date_of_id.get(trade_id) else {
        return;
    };
    let Some(ledger) = ledgers.get_mut(td) else {
        return;
    };
    let late = p.seq.saturating_sub(
        ledger
            .index
            .get(trade_id)
            .map(|(s, _)| ledger.slots[*s].trades.iter().map(|t| t.seq).max().unwrap_or(0))
            .unwrap_or(0),
    ) > late_gap;

    let result = match &p.correction {
        None => ledger.reverse(trade_id, false),
        Some(c) => match c {
            CorrectionAction::Delete => ledger.reverse(trade_id, true),
            CorrectionAction::Amend { price, volume, ts } => {
                let pf = price.map(from_f64);
                ledger.correct_trade(trade_id, pf, *volume, *ts)
                    .unwrap_or(ReversalOutcome::NotFound)
            }
        },
    };

    match result {
        ReversalOutcome::Applied { slot_label, volume, price } => {
            // 成功执行的冲正用专门的 info 级别事件，而不是 correction_unknown
            let applied_kind = match p.correction {
                Some(_) => AnomalyKind::TradeCorrected,
                None if p.kind == AnomalyKind::OrderRejected => AnomalyKind::OrderRejected,
                None => AnomalyKind::TradeCanceled,
            };
            anomalies.push(anomaly(
                counter,
                applied_kind,
                symbol,
                &p.source,
                p.ts,
                format!(
                    "成交 {} 被{}：冲正 {} 股/手，影响 bar {}（影响量同时从量额笔数中扣除并按剩余成交重算 OHLC）",
                    trade_id,
                    if p.correction.is_some() { "更正" } else { "撤销" },
                    volume,
                    ms_to_hm(slot_label)
                ),
                Some(trade_id.to_string()),
                Some(p.seq),
                Some(slot_label),
            ));
            if late {
                anomalies.push(anomaly(
                    counter,
                    AnomalyKind::LateCorrection,
                    symbol,
                    &p.source,
                    p.ts,
                    format!(
                        "成交 {} 的冲正消息序号 {} 距原成交超过 {} 条，属于迟到冲正；仍执行并按剩余成交重算",
                        trade_id, p.seq, late_gap
                    ),
                    Some(trade_id.to_string()),
                    Some(p.seq),
                    Some(slot_label),
                ));
            }
            let _ = price;
            // 同步回放流里的显示（保留事件但标为已冲正）
            for t in out.trades.iter_mut() {
                if t.trade_id == trade_id {
                    t.reject = if p.correction.is_some() { "corrected" } else { "canceled" }.into();
                }
            }
            for t in out.isolated.iter_mut() {
                if t.trade_id == trade_id {
                    // R23：已隔离的成交若被冲正，异常保留但标记 reversed
                }
            }
        }
        ReversalOutcome::AlreadyReversed => {
            anomalies.push(anomaly(
                counter,
                AnomalyKind::CorrectionUnknown,
                symbol,
                &p.source,
                p.ts,
                format!("成交 {} 已被冲正过，忽略重复的冲正消息", trade_id),
                Some(trade_id.to_string()),
                Some(p.seq),
                None,
            ));
        }
        ReversalOutcome::NotFound => {
            anomalies.push(anomaly(
                counter,
                AnomalyKind::CancelUnknown,
                symbol,
                &p.source,
                p.ts,
                format!("冲正/更正引用的成交 {} 在账本中不存在", trade_id),
                Some(trade_id.to_string()),
                Some(p.seq),
                None,
            ));
        }
    }
}

/// 找出属于某个委托的全部成交（按 `NormTrade.order_id`）。
fn trades_of_order(m: &Merged, order_id: &str) -> Vec<String> {
    m.events
        .iter()
        .filter_map(|e| match e {
            NormEvent::Trade(t) if t.order_id.as_deref() == Some(order_id) => {
                Some(t.trade_id.clone())
            }
            _ => None,
        })
        .collect()
}
