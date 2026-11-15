//! 引擎集成测试：用手工构造的小样本验证关键规则。

use mk_core::fixed::from_f64;
use mk_core::message::{CorrectionAction, MsgKind, RawMessage, Side, Trade};
use mk_core::schedule::{Calendar, TradingScheduleId};
use mk_core::time::ts_from_local;
use mk_core::{Dataset, Instrument};
use std::collections::BTreeMap;

use mk_engine::config::EmptyBarPolicy;
use mk_engine::config::EngineConfig;
use mk_engine::Engine;

fn inst_equity() -> Instrument {
    Instrument {
        symbol: "600000.SH".into(),
        name: "浦发银行".into(),
        exchange: mk_core::Exchange::SSE,
        asset: mk_core::AssetClass::Equity,
        product: "600000".into(),
        price_tick: 0.01,
        price_decimals: 2,
        multiplier: 1.0,
        lot_size: 100,
        limit_pct: Some(0.10),
        schedule_id: TradingScheduleId::EquityCn,
        sources: vec!["A".into()],
        contracts: None,
        listed: None,
        expiry: None,
    }
}

fn msg(source: &str, seq: u64, kind: MsgKind, trade: Option<Trade>) -> RawMessage {
    let ts = trade.as_ref().map(|t| t.ts).unwrap_or(0);
    RawMessage {
        source: source.into(),
        seq,
        symbol: "600000.SH".into(),
        kind,
        recv_ts: ts,
        trade,
        order: None,
        snapshot: None,
        ref_trade_id: None,
        ref_order_id: None,
        correction: None,
        halt_reason: None,
    }
}

fn trade(ts: &str, id: &str, price: f64, volume: u64, auction: bool) -> Trade {
    Trade {
        trade_id: id.into(),
        ts: ts_from_local(ts).unwrap(),
        price,
        volume,
        side: Side::B,
        turnover: None,
        order_id: None,
        auction,
    }
}

fn dataset(instrument: Instrument, messages: Vec<RawMessage>, prev_close: f64) -> Dataset {
    let mut meta = mk_core::dataset::DatasetMeta {
        dataset: "t".into(),
        generated_at: "2026-03-06T15:00:00+08:00".into(),
        engine_version: "0.1.0".into(),
        calendar: Calendar::new(vec!["2026-03-02".into()], vec![]),
        instruments: vec![instrument],
        corporate_actions: vec![],
        products: vec![],
        halts: vec![],
        prev_closes: vec![mk_core::dataset::PrevClose {
            symbol: "600000.SH".into(),
            trade_date: "2026-03-02".into(),
            price: prev_close,
        }],
        continuous: vec![],
        injected_anomalies: vec![],
    };
    meta.instruments.shrink_to_fit();
    Dataset { meta, messages, factors: vec![] }
}

fn engine(fill: bool) -> Engine {
    let mut cfg = EngineConfig::default();
    cfg.policy.empty_bar_policy = if fill { EmptyBarPolicy::Fill } else { EmptyBarPolicy::Omit };
    Engine::new(cfg)
}

fn bars(out: &mk_engine::SymbolOutput, period: &str) -> Vec<mk_core::Bar> {
    out.bars
        .get("2026-03-02")
        .and_then(|p| p.get(period))
        .cloned()
        .unwrap_or_default()
}

fn find(out: &mk_engine::SymbolOutput, period: &str, hm: &str) -> Option<mk_core::Bar> {
    bars(out, period).into_iter().find(|b| b.hm().starts_with(hm))
}

#[test]
fn boundary_1130_belongs_to_last_morning_bar() {
    // 11:30:00.000 应归入 11:30 bar，而不是 11:31（不存在）
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 11:28:00.000", "T1", 10.0, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 11:29:00.000", "T2", 10.01, 100, false))),
        msg("A", 3, MsgKind::Trade, Some(trade("2026-03-02 11:30:00.000", "T3", 10.02, 200, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    let b = find(&out, "1m", "11:29").unwrap();
    assert_eq!(b.volume, 100, "bar 11:29 覆盖 (11:28, 11:29]");
    let b2 = find(&out, "1m", "11:30").unwrap();
    assert_eq!(b2.volume, 200, "11:30:00.000 归 11:30 bar");
}

#[test]
fn auction_trade_attaches_to_0930_bar() {
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:25:00.000", "A1", 10.0, 500, true))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 09:30:05.000", "T1", 10.01, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    let b = find(&out, "1m", "09:30").unwrap();
    assert_eq!(b.volume, 500);
    assert_eq!(b.auction_volume, 500);
    assert!(b.flags.names().contains(&"auction"));
    // 5m 首根包含竞价量
    let b5 = find(&out, "5m", "09:35").unwrap();
    assert_eq!(b5.auction_volume, 500);
    assert_eq!(b5.volume, 600);
}

#[test]
fn cancel_reverses_ohlc() {
    // T2 是最高价，撤销后 high 应回落到 10.01
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:01", "T1", 10.00, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 09:30:02", "T2", 10.05, 300, false))),
        msg("A", 3, MsgKind::Trade, Some(trade("2026-03-02 09:30:03", "T3", 10.01, 200, false))),
        msg("A", 4, MsgKind::TradeCancel, None),
    ];
    let mut msgs = msgs;
    msgs[3].ref_trade_id = Some("T2".into());
    msgs[3].recv_ts = ts_from_local("2026-03-02 09:31:05").unwrap();
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    let b = find(&out, "1m", "09:31").unwrap();
    assert_eq!(b.volume, 300, "撤销后量从 600 减到 300");
    assert_eq!(b.high, from_f64(10.01), "最高价按剩余成交重算");
    assert_eq!(b.count, 2);
    assert_eq!(b.canceled_volume, 300);
    assert!(b.flags.names().contains(&"canceled"));
    // 1d 也应同步
    let d = find(&out, "1d", "15:00").unwrap();
    assert_eq!(d.volume, 300);
}

#[test]
fn correction_can_move_trade_across_bars() {
    // T1 原在 09:31，更正其时间为 09:33 → 应从 09:31 移到 09:33
    let mut msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.00, 100, false))),
        msg("A", 2, MsgKind::TradeCorrect, None),
    ];
    msgs[1].ref_trade_id = Some("T1".into());
    msgs[1].correction = Some(CorrectionAction::Amend {
        price: Some(10.03),
        volume: Some(150),
        ts: Some(ts_from_local("2026-03-02 09:32:10").unwrap()),
    });
    msgs[1].recv_ts = ts_from_local("2026-03-02 09:32:11").unwrap();
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    assert!(find(&out, "1m", "09:31").is_none(), "原 bar 因唯一成交被移除");
    let b = find(&out, "1m", "09:33").unwrap();
    assert_eq!(b.volume, 150);
    assert_eq!(b.open, from_f64(10.03));
    assert!(b.flags.names().contains(&"corrected"));
}

#[test]
fn out_of_session_trade_isolated() {
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:30", "T2", 10.0, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 12:15:00", "T1", 10.0, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    assert_eq!(out.isolated.len(), 1);
    assert_eq!(out.isolated[0].reject, "out_of_session");
    let b = find(&out, "1m", "09:31").unwrap();
    assert_eq!(b.volume, 100);
}

#[test]
fn price_jump_isolated_and_does_not_poison_ref() {
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.00, 100, false))),
        // +20% 跳变
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 09:31:10", "T2", 12.00, 100, false))),
        msg("A", 3, MsgKind::Trade, Some(trade("2026-03-02 09:32:10", "T3", 10.02, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    assert!(out.isolated.iter().any(|t| t.trade_id == "T2"));
    assert!(
        !out.isolated.iter().any(|t| t.trade_id == "T3"),
        "坏点不应污染后续参考价"
    );
}

#[test]
fn limit_breach_isolated() {
    // prev_close 10.0 → 涨停 11.00
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.00, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 09:31:10", "T2", 11.10, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 10.0), &inst_equity());
    assert_eq!(out.isolated.len(), 1);
    assert_eq!(out.isolated[0].reject, "limit_breach");
}

#[test]
fn invalid_tick_isolated() {
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.001, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    assert_eq!(out.isolated.len(), 1);
    assert_eq!(out.isolated[0].reject, "invalid_tick");
}

#[test]
fn five_minute_reconciles_with_daily() {
    let mut msgs = Vec::new();
    let mut seq = 0u64;
    // 09:31–10:00 每分钟一笔
    for m in 1..=30u64 {
        let hour = if m <= 29 { 9 } else { 10 };
        let mint = if m <= 29 { 30 + m } else { 0 };
        let ts = format!("2026-03-02 {:02}:{:02}:00", hour, mint);
        seq += 1;
        msgs.push(msg(
            "A",
            seq,
            MsgKind::Trade,
            Some(trade(&ts, &format!("T{}", seq), 10.00 + (seq as f64) * 0.01, 100, false)),
        ));
    }
    let out = engine(true).run_symbol(&dataset(inst_equity(), msgs, 10.0), &inst_equity());
    let b1 = bars(&out, "1m");
    let b5 = bars(&out, "5m");
    let b1d = bars(&out, "1d");
    let sum1: u64 = b1.iter().map(|b| b.volume).sum();
    let sum5: u64 = b5.iter().map(|b| b.volume).sum();
    assert_eq!(sum1, 3000);
    assert_eq!(sum5, sum1);
    assert_eq!(b1d[0].volume, sum1);
    assert_eq!(b1d[0].count, sum1 as u32 / 100);
}

#[test]
fn missing_minute_bar_omitted_when_no_trade() {
    // 无成交的 1m 不生成 bar；但有成交的相邻分钟正常
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:31:00", "T1", 10.0, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 09:35:00", "T2", 10.0, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    let b1 = bars(&out, "1m");
    assert_eq!(b1.len(), 2, "omit 策略下只保留有成交的分钟");
    let b5 = bars(&out, "5m");
    assert_eq!(b5.len(), 48, "高周期始终 fill，网格完整");
}

#[test]
fn duplicate_trade_id_across_sources_kept_once() {
    let mut inst = inst_equity();
    inst.sources = vec!["A".into(), "B".into()];
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:30", "T1", 10.0, 100, false))),
        msg("B", 7, MsgKind::Trade, Some(trade("2026-03-02 09:30:30", "T1", 10.0, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst.clone(), msgs, 9.9), &inst);
    let b = find(&out, "1m", "09:31").unwrap();
    assert_eq!(b.volume, 100, "同 trade_id 只计一次");
}

#[test]
fn source_conflict_detected() {
    let mut inst = inst_equity();
    inst.sources = vec!["A".into(), "B".into()];
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:30", "T1", 10.0, 100, false))),
        msg("B", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:30", "T1", 10.02, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst.clone(), msgs, 9.9), &inst);
    assert!(out.anomalies.iter().any(|a| a.kind == mk_core::AnomalyKind::SourceConflict));
    let b = find(&out, "1m", "09:31").unwrap();
    assert_eq!(b.open, from_f64(10.0), "采用主源 A 的价格");
}

#[test]
fn gap_filled_from_peer_source() {
    let mut inst = inst_equity();
    inst.sources = vec!["A".into(), "B".into()];
    // A 缺 seq2，B 有
    let msgs = vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.0, 100, false))),
        msg("A", 3, MsgKind::Trade, Some(trade("2026-03-02 09:32:10", "T3", 10.02, 100, false))),
        msg("B", 1, MsgKind::Trade, Some(trade("2026-03-02 09:30:10", "T1", 10.0, 100, false))),
        msg("B", 2, MsgKind::Trade, Some(trade("2026-03-02 09:31:10", "T2", 10.01, 100, false))),
        msg("B", 3, MsgKind::Trade, Some(trade("2026-03-02 09:32:10", "T3", 10.02, 100, false))),
    ];
    let out = engine(false).run_symbol(&dataset(inst.clone(), msgs, 9.9), &inst);
    let b = find(&out, "1m", "09:32").unwrap();
    assert_eq!(b.volume, 100, "缺口由 B 源补上");
    assert!(out.anomalies.iter().any(|a| a.kind == mk_core::AnomalyKind::SeqGapFilled));
}

#[test]
fn halt_window_has_no_bars() {
    let mut inst = inst_equity();
    inst.sources = vec!["A".into()];
    let mut ds = dataset(inst.clone(), vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 10:15:00", "T1", 10.0, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 10:30:00", "T2", 10.0, 100, false))),
    ], 9.9);
    ds.meta.halts = vec![mk_core::dataset::HaltPlan {
        symbol: "600000.SH".into(),
        trade_date: "2026-03-02".into(),
        start: ts_from_local("2026-03-02 10:20:00").unwrap(),
        end: ts_from_local("2026-03-02 10:29:59").unwrap(),
        label: "临时停牌".into(),
    }];
    let out = engine(false).run_symbol(&ds, &inst);
    assert!(find(&out, "1m", "10:20").is_none());
    assert!(find(&out, "1m", "10:25").is_none());
    assert!(find(&out, "1m", "10:30").is_some());
}

#[test]
fn trade_during_halt_isolated() {
    let inst = inst_equity();
    let mut ds = dataset(inst.clone(), vec![
        msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 10:25:00", "T1", 10.0, 100, false))),
        msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 10:31:00", "T2", 10.0, 100, false))),
    ], 9.9);
    ds.meta.halts = vec![mk_core::dataset::HaltPlan {
        symbol: "600000.SH".into(),
        trade_date: "2026-03-02".into(),
        start: ts_from_local("2026-03-02 10:20:00").unwrap(),
        end: ts_from_local("2026-03-02 10:29:59").unwrap(),
        label: "临时停牌".into(),
    }];
    let out = engine(false).run_symbol(&ds, &inst);
    assert!(out.isolated.iter().any(|t| t.reject == "trade_during_halt"));
    let b = find(&out, "1m", "10:31").unwrap();
    assert_eq!(b.volume, 100, "复牌首根不插值");
}

#[test]
fn night_session_trade_date_assignment() {
    let mut inst = inst_equity();
    inst.symbol = "rb2601".into();
    inst.exchange = mk_core::Exchange::SHFE;
    inst.asset = mk_core::AssetClass::Future;
    inst.product = "rb".into();
    inst.price_tick = 1.0;
    inst.price_decimals = 0;
    inst.multiplier = 10.0;
    inst.limit_pct = None;
    inst.schedule_id = TradingScheduleId::FutureNight2300;
    let mut m1 = msg("A", 1, MsgKind::Trade, Some(trade("2026-03-02 21:00:00", "N1", 3500.0, 5, true)));
    m1.symbol = "rb2601".into();
    let mut m2 = msg("A", 2, MsgKind::Trade, Some(trade("2026-03-02 21:05:00", "N2", 3501.0, 5, false)));
    m2.symbol = "rb2601".into();
    let mut ds = dataset(inst.clone(), vec![m1, m2], 3500.0);
    ds.meta.calendar = Calendar::new(vec!["2026-03-02".into(), "2026-03-03".into()], vec![]);
    ds.meta.prev_closes = vec![
        mk_core::dataset::PrevClose { symbol: "rb2601".into(), trade_date: "2026-03-02".into(), price: 3490.0 },
        mk_core::dataset::PrevClose { symbol: "rb2601".into(), trade_date: "2026-03-03".into(), price: 3500.0 },
    ];
    let out = engine(false).run_symbol(&ds, &inst);
    assert!(out.bars.contains_key("2026-03-03"), "夜盘归属下一交易日");
    let b = out.bars["2026-03-03"]["1m"]
        .iter()
        .find(|b| b.hm().starts_with("21:01"))
        .unwrap();
    assert_eq!(b.volume, 5, "集合竞价并入 21:01 bar");
    assert_eq!(b.auction_volume, 5);
    let b2 = out.bars["2026-03-03"]["1m"]
        .iter()
        .find(|b| b.hm().starts_with("21:05"))
        .unwrap();
    assert_eq!(b2.volume, 5);
}

#[test]
fn daily_volume_equals_minute_sum_with_fill_policy() {
    let mut msgs = Vec::new();
    for (i, hm) in [
        "09:25:00", "09:30:01", "09:31:00", "10:15:00", "11:30:00", "13:00:00", "14:59:00", "15:00:00",
    ]
    .iter()
    .enumerate()
    {
        let auction = *hm == "09:25:00";
        msgs.push(msg(
            "A",
            i as u64 + 1,
            MsgKind::Trade,
            Some(trade(&format!("2026-03-02 {}", hm), &format!("T{}", i), 10.0, 100, auction)),
        ));
    }
    let out = engine(true).run_symbol(&dataset(inst_equity(), msgs, 9.9), &inst_equity());
    let sum: u64 = bars(&out, "1m").iter().map(|b| b.volume).sum();
    let d = &bars(&out, "1d")[0];
    assert_eq!(d.volume, sum);
    assert_eq!(d.open, from_f64(10.0));
}
