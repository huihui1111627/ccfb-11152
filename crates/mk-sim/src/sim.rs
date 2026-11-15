//! 行情仿真器：按交易所真实时段生成多源逐笔成交 + 快照，并注入可控异常。
//!
//! 输出：`SimOutput`，由 CLI 落盘为
//! `dataset.json` + `messages/<symbol>.jsonl` + `golden/<case>.json`。

use crate::rng::Rng;
use mk_core::dataset::{HaltPlan, PrevClose};
use mk_core::factor::CorporateAction;
use mk_core::instrument::{AssetClass, Exchange, Instrument};
use mk_core::message::{MsgKind, RawMessage, Side, Snapshot, Trade};
use mk_core::schedule::{Calendar, TradingSchedule, TradingScheduleId};
use mk_core::time::{ms_to_date_string, parse_date, ts_from_local};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimConfig {
    pub seed: u64,
    pub start: String,
    pub end: String,
    /// 连续竞价每分钟成交笔数
    pub trades_per_minute: u64,
    pub dual_source: bool,
    /// A 源丢包率（制造主源序号缺口）
    pub primary_loss_rate: f64,
    /// B 源丢包率
    pub peer_loss_rate: f64,
    pub snapshot_secs: i64,
    pub inject_anomalies: bool,
    pub golden: bool,
    /// 除权事件（symbol + 描述）
    pub corporate_actions: bool,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            seed: 20260302,
            start: "2026-02-27".into(),
            end: "2026-03-06".into(),
            trades_per_minute: 30,
            dual_source: true,
            primary_loss_rate: 0.002,
            peer_loss_rate: 0.003,
            snapshot_secs: 3,
            inject_anomalies: true,
            golden: true,
            corporate_actions: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SimOutput {
    pub meta: mk_core::dataset::DatasetMeta,
    pub messages_by_symbol: HashMap<String, String>,
    pub golden: Vec<crate::golden::GoldenCase>,
}

fn make_msg(
    source: &str,
    seq: u64,
    symbol: &str,
    kind: MsgKind,
    recv_ts: i64,
    trade: Option<Trade>,
    snapshot: Option<Snapshot>,
    halt_reason: Option<String>,
) -> RawMessage {
    RawMessage {
        source: source.to_string(),
        seq,
        symbol: symbol.to_string(),
        kind,
        recv_ts,
        trade,
        order: None,
        snapshot,
        ref_trade_id: None,
        ref_order_id: None,
        correction: None,
        halt_reason,
    }
}

fn round_px(px: f64, inst: &Instrument) -> f64 {
    let tick = inst.price_tick;
    let v = (px / tick).round() * tick;
    let d = inst.price_decimals as i32;
    let f = 10f64.powi(d);
    (v * f).round() / f
}

fn initial_price(inst: &Instrument) -> f64 {
    match inst.symbol.as_str() {
        "600000.SH" => 10.0,
        "000001.SZ" => 12.0,
        "rb2601" => 3500.0,
        "rb2605" => 3560.0,
        "rb2610" => 3600.0,
        "au2602" => 520.0,
        "IF2603" => 3800.0,
        _ => 100.0,
    }
}

pub fn build_calendar(start: &str, end: &str) -> Calendar {
    let holidays = ["2026-02-28", "2026-03-01"];
    let mut days = Vec::new();
    let mut d = parse_date(start).expect("start");
    let e = parse_date(end).expect("end");
    while d <= e {
        let ds = format!("{}", d.format("%Y-%m-%d"));
        let weekday = d.format("%u").to_string().parse::<u32>().unwrap_or(1);
        if weekday <= 5 && !holidays.contains(&ds.as_str()) {
            days.push(ds);
        }
        d += chrono::Duration::days(1);
    }
    Calendar::new(days, holidays.iter().map(|s| s.to_string()).collect())
}

/// 品种清单：2 只股票 + 3 个期货品种（含夜盘、黄金跨日、股指）。
pub fn build_instruments() -> Vec<Instrument> {
    vec![
        Instrument {
            symbol: "600000.SH".into(),
            name: "浦发银行".into(),
            exchange: Exchange::SSE,
            asset: AssetClass::Equity,
            product: "600000".into(),
            price_tick: 0.01,
            price_decimals: 2,
            multiplier: 1.0,
            lot_size: 100,
            limit_pct: Some(0.10),
            schedule_id: TradingScheduleId::EquityCn,
            sources: vec!["A".into(), "B".into()],
            contracts: None,
            listed: None,
            expiry: None,
        },
        Instrument {
            symbol: "000001.SZ".into(),
            name: "平安银行".into(),
            exchange: Exchange::SZSE,
            asset: AssetClass::Equity,
            product: "000001".into(),
            price_tick: 0.01,
            price_decimals: 2,
            multiplier: 1.0,
            lot_size: 100,
            limit_pct: Some(0.10),
            schedule_id: TradingScheduleId::EquityCn,
            sources: vec!["A".into(), "B".into()],
            contracts: None,
            listed: None,
            expiry: None,
        },
        Instrument {
            symbol: "rb2601".into(),
            name: "螺纹钢2601".into(),
            exchange: Exchange::SHFE,
            asset: AssetClass::Future,
            product: "rb".into(),
            price_tick: 1.0,
            price_decimals: 0,
            multiplier: 10.0,
            lot_size: 1,
            limit_pct: None,
            schedule_id: TradingScheduleId::FutureNight2300,
            sources: vec!["A".into(), "B".into()],
            contracts: Some(vec!["rb2601".into(), "rb2605".into(), "rb2610".into()]),
            listed: Some("2025-01-15".into()),
            expiry: Some("2026-01-15".into()),
        },
        Instrument {
            symbol: "au2602".into(),
            name: "黄金2602".into(),
            exchange: Exchange::SHFE,
            asset: AssetClass::Future,
            product: "au".into(),
            price_tick: 0.02,
            price_decimals: 2,
            multiplier: 1000.0,
            lot_size: 1,
            limit_pct: None,
            schedule_id: TradingScheduleId::FutureNight0230,
            sources: vec!["A".into(), "B".into()],
            contracts: Some(vec!["au2602".into()]),
            listed: None,
            expiry: None,
        },
        Instrument {
            symbol: "IF2603".into(),
            name: "沪深300股指2603".into(),
            exchange: Exchange::CFFEX,
            asset: AssetClass::Future,
            product: "IF".into(),
            price_tick: 0.2,
            price_decimals: 1,
            multiplier: 300.0,
            lot_size: 1,
            limit_pct: None,
            schedule_id: TradingScheduleId::IndexFuture,
            sources: vec!["A".into(), "B".into()],
            contracts: Some(vec!["IF2603".into()]),
            listed: None,
            expiry: None,
        },
    ]
}

fn corporate_action_for(symbol: &str, date: &str) -> Option<CorporateAction> {
    match (symbol, date) {
        ("600000.SH", "2026-03-04") => Some(CorporateAction {
            ex_date: date.to_string(),
            cash_div: 0.35,
            bonus: 0.3,
            rights: 0.1,
            rights_price: 5.0,
            prev_close: 0.0, // 由仿真器用真实前收盘填充
            note: "10派3.5元送3股配1股@5元".into(),
        }),
        ("000001.SZ", "2026-03-05") => Some(CorporateAction {
            ex_date: date.to_string(),
            cash_div: 0.2,
            bonus: 0.0,
            rights: 0.0,
            rights_price: 0.0,
            prev_close: 0.0, // 由仿真器用真实前收盘填充
            note: "10派2元".into(),
        }),
        _ => None,
    }
}

pub struct Simulator {
    pub cfg: SimConfig,
}

/// 每个 symbol 的跨日序号（真实行情源序号是连续的，不按日重置）。
#[derive(Default, Clone)]
struct SeqState {
    seq_a: u64,
    seq_b: u64,
}

impl Simulator {
    pub fn new(cfg: SimConfig) -> Self {
        Self { cfg }
    }

    pub fn run(&self) -> SimOutput {
        let calendar = build_calendar(&self.cfg.start, &self.cfg.end);
        let mut instruments = build_instruments();
        // 同品种的其它合约也要有行情，否则主力连续没有可比数据。
        // 它们用更低的成交密度（trades_per_minute 缩小），但时段结构与主力一致。
        let rb = instruments.iter().find(|i| i.symbol == "rb2601").unwrap().clone();
        for c in ["rb2605", "rb2610"] {
            let mut ci = rb.clone();
            ci.symbol = c.to_string();
            ci.name = format!("螺纹钢{}", &c[2..]);
            ci.listed = None;
            ci.expiry = None;
            ci.contracts = Some(vec!["rb2601".into(), "rb2605".into(), "rb2610".into()]);
            instruments.push(ci);
        }
        let mut messages_by_symbol: HashMap<String, String> = HashMap::new();

        let mut factors: Vec<(String, CorporateAction)> = Vec::new();
        let mut prev_closes: Vec<PrevClose> = Vec::new();
        let mut halts: Vec<HaltPlan> = Vec::new();
        let mut seqs: HashMap<String, SeqState> = HashMap::new();
        let mut last_close: HashMap<String, f64> = HashMap::new();
        let mut oi_daily: HashMap<(String, String), (u64, u64)> = HashMap::new();
        let mut trade_no: HashMap<String, u64> = HashMap::new();

        let equity_symbols: Vec<String> = [
            "600000.SH".to_string(),
            "000001.SZ".to_string(),
        ]
        .to_vec();

        // 先为每个品种生成
        for (idx, inst) in instruments.iter().enumerate() {
            // 非主力合约成交稀疏
            let is_secondary = inst.symbol == "rb2605" || inst.symbol == "rb2610";
            let per_min = if is_secondary {
                (self.cfg.trades_per_minute / 6).max(2)
            } else {
                self.cfg.trades_per_minute
            };
            let mut rng = Rng::new(self.cfg.seed.wrapping_add(idx as u64 * 7919));
            let schedule = TradingSchedule::new(inst.schedule_id, calendar.clone());
            let mut price = initial_price(inst);

            if inst.is_equity() && equity_symbols.contains(&inst.symbol) {
                // 股票
            }
            for date in calendar.trading_days.iter() {
                let pc = *last_close.get(&inst.symbol).unwrap_or(&price);
                prev_closes.push(PrevClose {
                    symbol: inst.symbol.clone(),
                    trade_date: date.clone(),
                    price: round_px(pc, inst),
                });
                let Some(_day) = schedule.session_day(date, None) else {
                    continue;
                };
                // 除权：开盘基准按除权价调整。
                // 关键：`prev_close` 必须用**仿真数据里真实的**前一日收盘价，
                // 否则因子与行情不匹配，复权后价格在除权日会出现假跳空。
                if self.cfg.corporate_actions {
                    if let Some(mut action) = corporate_action_for(&inst.symbol, date) {
                        action.prev_close = round_px(pc, inst);
                        let q = action.q() as f64 / mk_core::factor::FSCALE_F;
                        price = round_px(pc * q, inst);
                        factors.push((inst.symbol.clone(), action));
                    }
                }
                // 停牌计划：600000.SH 在第三个交易日 10:20–10:50
                let halt = if self.cfg.inject_anomalies
                    && inst.symbol == "600000.SH"
                    && calendar.trading_days.get(2) == Some(date)
                {
                    let s = ts_from_local(&format!("{} 10:20:00", date)).unwrap();
                    let e = ts_from_local(&format!("{} 10:49:59", date)).unwrap();
                    halts.push(HaltPlan {
                        symbol: inst.symbol.clone(),
                        trade_date: date.clone(),
                        start: s,
                        end: e,
                        label: "临时停牌（波动异常）".into(),
                    });
                    Some((s, e))
                } else {
                    None
                };
                let st = seqs.entry(inst.symbol.clone()).or_default();
                let tn = *trade_no.get(&inst.symbol).unwrap_or(&0);
                let res = self.simulate_day(
                    inst,
                    &schedule,
                    date,
                    pc,
                    &mut price,
                    &mut rng,
                    halt,
                    st.seq_a,
                    st.seq_b,
                    tn,
                    per_min,
                );
                st.seq_a = res.4;
                st.seq_b = res.5;
                // 统计当日成交号（用于跨日唯一 id）
                let emitted = res.8;
                trade_no.insert(inst.symbol.clone(), tn + emitted);

                let mut src_keys: Vec<&String> = res.0.keys().collect();
                src_keys.sort();
                for src in src_keys {
                    let msgs = &res.0[src];
                    let buf = messages_by_symbol.entry(inst.symbol.clone()).or_default();
                    for m in msgs {
                        buf.push_str(&serde_json::to_string(m).unwrap());
                        buf.push('\n');
                    }
                }
                last_close.insert(inst.symbol.clone(), res.3);
                if inst.is_future() {
                    oi_daily.insert(
                        (inst.symbol.clone(), date.clone()),
                        (res.6.unwrap_or(0), res.7),
                    );
                }
            }
        }

        // 期货主力合约（rb 的三个合约都需要 oi 序列；上面只为 rb2601 生成了行情）
        for inst in instruments.iter().filter(|i| i.symbol == "rb2601") {
            let contracts = inst.contracts.clone().unwrap_or_default();
            for c in contracts.iter() {
                for (di, d) in calendar.trading_days.iter().enumerate() {
                    let (oi, vol) = match c.as_str() {
                        "rb2601" => (200_000u64.saturating_sub(di as u64 * 9_000), 80_000u64.saturating_sub(di as u64 * 3_000)),
                        "rb2605" => (140_000 + di as u64 * 12_000, 30_000 + di as u64 * 2_000),
                        _ => (25_000 + di as u64 * 1_500, 8_000),
                    };
                    let e = oi_daily.entry((c.clone(), d.clone())).or_insert((0, 0));
                    e.0 = oi;
                    e.1 = vol;
                }
            }
        }

        // 多源/异常注入 + 金标准
        let mut meta = mk_core::dataset::DatasetMeta {
            dataset: format!("sim-{}-{}", self.cfg.start, self.cfg.end),
            generated_at: format!("{}T16:00:00+08:00", self.cfg.end),
            engine_version: crate::SIM_VERSION.into(),
            calendar: calendar.clone(),
            instruments: instruments.clone(),
            corporate_actions: factors,
            products: vec![mk_core::Product {
                code: "rb".into(),
                name: "螺纹钢".into(),
                exchange: Exchange::SHFE,
                asset: AssetClass::Future,
                price_tick: 1.0,
                multiplier: 10.0,
                price_decimals: 0,
                schedule_id: TradingScheduleId::FutureNight2300,
                contracts: vec!["rb2601".into(), "rb2605".into(), "rb2610".into()],
            }],
            halts,
            prev_closes,
            continuous: vec![],
            injected_anomalies: vec![],
        };

        if self.cfg.inject_anomalies {
            let symbols: Vec<String> = messages_by_symbol.keys().cloned().collect();
            meta.injected_anomalies = crate::inject::inject_all(
                &mut messages_by_symbol,
                &symbols,
                self.cfg.seed,
            );
        }

        let golden = if self.cfg.golden {
            crate::golden::build_cases(&instruments, &calendar)
        } else {
            Vec::new()
        };
        SimOutput { meta, messages_by_symbol, golden }
    }

    /// 返回 (每源消息, 未用, 未用, 收盘价, seq_a, seq_b, oi末值, 当日成交量)
    #[allow(clippy::too_many_arguments)]
    fn simulate_day(
        &self,
        inst: &Instrument,
        schedule: &TradingSchedule,
        date: &str,
        prev_close: f64,
        price: &mut f64,
        rng: &mut Rng,
        halt: Option<(i64, i64)>,
        seq_a_in: u64,
        seq_b_in: u64,
        trade_no_in: u64,
        per_min: u64,
    ) -> (
        HashMap<String, Vec<RawMessage>>,
        (),
        (),
        f64,
        u64,
        u64,
        Option<u64>,
        u64,
        u64,
    ) {
        let Some(day) = schedule.session_day(date, None) else {
            return (HashMap::new(), (), (), *price, seq_a_in, seq_b_in, None, 0, trade_no_in);
        };
        let tick = inst.price_tick;
        let (limit_dn, limit_up) = match inst.limit_pct {
            Some(p) => (
                round_px(prev_close * (1.0 - p), inst),
                round_px(prev_close * (1.0 + p), inst),
            ),
            None => (f64::NEG_INFINITY, f64::INFINITY),
        };
        let vol = if inst.is_equity() { 0.00035 } else { 0.00020 };
        let per_min = per_min.max(1);
        let mut seq_a = seq_a_in;
        let mut seq_b = seq_b_in;
        let mut a: Vec<RawMessage> = Vec::new();
        let mut b: Vec<RawMessage> = Vec::new();
        let mut cum_volume: u64 = 0;
        let mut cum_turnover = 0.0f64;
        let mut cum_buy: u64 = 0;
        let mut cum_sell: u64 = 0;
        let mut trade_no: u64 = trade_no_in;
        let mut cur = *price;
        let mut oi_last: Option<u64> = None;

        // 封装成交推送
        macro_rules! emit_trade {
            ($ts:expr, $px:expr, $v:expr, $side:expr, $auction:expr) => {{
                trade_no += 1;
                let tid = format!(
                    "{}-{:06}",
                    inst.symbol.replace('.', ""),
                    trade_no
                );
                let turnover = $px * $v as f64 * inst.multiplier;
                cum_volume += $v;
                cum_turnover += turnover;
                match $side {
                    Side::B => cum_buy += $v,
                    Side::S => cum_sell += $v,
                    Side::N => {}
                }
                let trade = Trade {
                    trade_id: tid,
                    ts: $ts,
                    price: $px,
                    volume: $v,
                    side: $side,
                    turnover: Some((turnover * 10_000.0).round() / 10_000.0),
                    order_id: Some(format!("O{:06}", trade_no)),
                    auction: $auction,
                };
                seq_a += 1;
                if !rng.chance(self.cfg.primary_loss_rate) {
                    let recv = $ts + 1 + rng.range_i64(0, 3);
                    a.push(make_msg("A", seq_a, &inst.symbol, MsgKind::Trade, recv, Some(trade.clone()), None, None));
                }
                if self.cfg.dual_source {
                    seq_b += 1;
                    if !rng.chance(self.cfg.peer_loss_rate) {
                        let recv = $ts + 1 + rng.range_i64(0, 3);
                        b.push(make_msg("B", seq_b, &inst.symbol, MsgKind::Trade, recv, Some(trade), None, None));
                    }
                }
            }};
        }

        // ---- 集合竞价 ----
        for au in day.auctions() {
            let px = round_px(cur * (1.0 + rng.normal() * 0.0015), inst).clamp(limit_dn, limit_up);
            let lot = inst.lot_size.max(1);
            let vol0 = (rng.range_u64(2_000, 40_000) / lot) * lot;
            let side = if rng.chance(0.55) { Side::B } else { Side::S };
            emit_trade!(au.end, px, vol0.max(lot), side, true);
            cur = px;
        }

        // ---- 连续竞价 ----
        for seg in day.continuous() {
            let first_min = seg.start / 60_000;
            let end_min = seg.end / 60_000;
            for minute in first_min..end_min {
                let n = rng.range_u64(per_min / 2, per_min + per_min / 2);
                for k in 0..n {
                    let ts = minute * 60_000 + (k as i64 * 60_000) / n as i64;
                    if let Some((hs, he)) = halt {
                        if ts > hs && ts <= he {
                            continue;
                        }
                    }
                    let drift = rng.normal() * vol * cur;
                    cur = round_px(cur + drift, inst).clamp(limit_dn, limit_up);
                    let v = if inst.is_equity() {
                        let lot = inst.lot_size.max(1);
                        ((rng.range_u64(100, 4_000) / lot) * lot).max(lot)
                    } else {
                        rng.range_u64(1, 40)
                    };
                    let side = if rng.chance(0.5) { Side::B } else { Side::S };
                    emit_trade!(ts, cur, v, side, false);
                }
            }
        }

        // ---- 快照 ----
        // 快照时间戳取"网格时刻"与"最后一条已发生消息时刻"的较大者，
        // 保证同源内时间单调（真实行情中快照与逐笔共享同一时钟）。
        let mut last_event_ts = a.iter().map(|m| m.ts()).max().unwrap_or(0);
        let day_start = day.segments.iter().map(|s| s.start).min().unwrap_or(0);
        let day_end = day.segments.iter().map(|s| s.end).max().unwrap_or(0);
        let mut ts = day_start;
        let mut halt_begin_seq: Option<u64> = None;
        let mut halt_end_seq: Option<u64> = None;
        while ts <= day_end {
            let active = day
                .segments
                .iter()
                .any(|s| s.kind != mk_core::SegmentKind::Break && s.contains(ts));
            if active {
                let snap_ts = ts.max(last_event_ts);
                let oi = if inst.is_future() {
                    let d = ms_to_date_string(ts);
                    let (o, _) = future_oi(inst, &d, rng);
                    oi_last = Some(o);
                    Some(o)
                } else {
                    None
                };
                let snap = Snapshot {
                    ts: snap_ts,
                    last: cur,
                    bid: Some(round_px(cur - tick, inst)),
                    ask: Some(round_px(cur + tick, inst)),
                    bid_volume: Some(rng.range_u64(1, 100)),
                    ask_volume: Some(rng.range_u64(1, 100)),
                    cum_volume: Some(cum_volume),
                    cum_turnover: Some((cum_turnover * 10_000.0).round() / 10_000.0),
                    cum_buy_volume: Some(cum_buy),
                    cum_sell_volume: Some(cum_sell),
                    oi,
                };
                seq_a += 1;
                a.push(make_msg("A", seq_a, &inst.symbol, MsgKind::Snapshot, snap_ts, None, Some(snap.clone()), None));
                last_event_ts = last_event_ts.max(snap_ts);
                if self.cfg.dual_source {
                    seq_b += 1;
                    b.push(make_msg("B", seq_b, &inst.symbol, MsgKind::Snapshot, snap_ts, None, Some(snap), None));
                }
                // 停牌起止状态消息
                if let Some((hs, he)) = halt {
                    if halt_begin_seq.is_none() && ts > hs {
                        seq_a += 1;
                        let hts = ts.max(last_event_ts);
                        a.push(make_msg("A", seq_a, &inst.symbol, MsgKind::HaltBegin, hts, None, None, Some("临时停牌（波动异常）".into())));
                        last_event_ts = hts;
                        halt_begin_seq = Some(seq_a);
                    }
                    if halt_begin_seq.is_some() && halt_end_seq.is_none() && ts > he {
                        seq_a += 1;
                        let hts = ts.max(last_event_ts);
                        a.push(make_msg("A", seq_a, &inst.symbol, MsgKind::HaltEnd, hts, None, None, None));
                        last_event_ts = hts;
                        halt_end_seq = Some(seq_a);
                    }
                }
            }
            ts += self.cfg.snapshot_secs * 1000;
        }

        // 同一个源内部按事件时间排序后再编号：
        // 真实行情源的 seq 与时间单调一致，而我们按“时段循环”生成时，
        // 快照是整段补写的、夜盘竞价与日盘竞价也是分开生成的，必须重排。
        renumber_by_ts(&mut a, seq_a_in);
        renumber_by_ts(&mut b, seq_b_in);

        let mut out = HashMap::new();
        let seq_a_end = a.iter().map(|m| m.seq).max().unwrap_or(seq_a_in);
        let seq_b_end = b.iter().map(|m| m.seq).max().unwrap_or(seq_b_in);
        out.insert("A".to_string(), a);
        if self.cfg.dual_source {
            out.insert("B".to_string(), b);
        }
        *price = cur;
        (out, (), (), cur, seq_a_end, seq_b_end, oi_last, cum_volume, trade_no)
    }
}

/// 按事件时间稳定排序，并从 `start` 起连续编号（跨交易日单调递增，与真实行情一致）。
fn renumber_by_ts(msgs: &mut Vec<RawMessage>, start: u64) {
    msgs.sort_by(|x, y| x.ts().cmp(&y.ts()).then_with(|| x.seq.cmp(&y.seq)));
    for (i, m) in msgs.iter_mut().enumerate() {
        m.seq = start + i as u64 + 1;
    }
}

/// 期货持仓量：随交易日演进（近月递减、远月递增），这样主力切换能被真实触发。
fn future_oi(inst: &Instrument, date: &str, rng: &mut Rng) -> (u64, u64) {
    // 以数据集起点为第 0 日
    let day = mk_core::time::parse_date("2026-02-27")
        .zip(mk_core::time::parse_date(date))
        .map(|(a, b)| (b - a).num_days().max(0) as u64)
        .unwrap_or(0);
    let base = match inst.symbol.as_str() {
        // rb2601 主力逐步移仓到 rb2605：第 2 日 rb2605 反超
        "rb2601" => 200_000u64.saturating_sub(day * 14_000),
        "rb2605" => 140_000u64 + day * 16_000,
        "rb2610" => 30_000u64 + day * 1_500,
        "au2602" => 90_000,
        "IF2603" => 120_000,
        _ => 100_000,
    };
    (base + rng.range_u64(0, 500), rng.range_u64(10_000, 20_000))
}

/// 生成金标准用例需要的除权事件表（供 golden 模块使用）。
pub fn equity_corporate_actions() -> Vec<(String, CorporateAction)> {
    vec![
        (
            "600000.SH".into(),
            corporate_action_for("600000.SH", "2026-03-04").unwrap(),
        ),
        (
            "000001.SZ".into(),
            corporate_action_for("000001.SZ", "2026-03-05").unwrap(),
        ),
    ]
}

/// 由仿真器产出的消息生成金标准。
pub fn build_golden(cfg: &SimConfig) -> Vec<crate::golden::GoldenCase> {
    let cal = build_calendar(&cfg.start, &cfg.end);
    let insts = build_instruments();
    crate::golden::build_cases(&insts, &cal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_has_six_days() {
        let c = build_calendar("2026-02-27", "2026-03-06");
        assert_eq!(c.trading_days.len(), 6);
        assert_eq!(c.trading_days[0], "2026-02-27");
        assert_eq!(c.trading_days[5], "2026-03-06");
    }

    #[test]
    fn sim_is_deterministic() {
        let a = Simulator::new(SimConfig { trades_per_minute: 3, start: "2026-03-02".into(), end: "2026-03-02".into(), golden: false, ..Default::default() }).run();
        let b = Simulator::new(SimConfig { trades_per_minute: 3, start: "2026-03-02".into(), end: "2026-03-02".into(), golden: false, ..Default::default() }).run();
        let la = a.messages_by_symbol.get("600000.SH").unwrap();
        let lb = b.messages_by_symbol.get("600000.SH").unwrap();
        assert_eq!(la, lb, "相同 seed 的消息流应完全一致");
    }
}
