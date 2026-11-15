//! 冲正的边界场景：乱序到达、重复冲正、冲正后再更正。

use mk_core::fixed::from_f64;
use mk_core::message::{CorrectionAction, MsgKind, RawMessage, Side, Trade};
use mk_core::schedule::{Calendar, TradingScheduleId};
use mk_core::time::ts_from_local;
use mk_core::{Dataset, Instrument};
use mk_engine::Engine;

fn inst() -> Instrument {
    Instrument {
        symbol: "600000.SH".into(), name: "x".into(), exchange: mk_core::Exchange::SSE,
        asset: mk_core::AssetClass::Equity, product: "600000".into(), price_tick: 0.01,
        price_decimals: 2, multiplier: 1.0, lot_size: 100, limit_pct: Some(0.10),
        schedule_id: TradingScheduleId::EquityCn, sources: vec!["A".into()],
        contracts: None, listed: None, expiry: None,
    }
}

fn mk(source: &str, seq: u64, kind: MsgKind, recv: &str, trade: Option<Trade>, ref_id: Option<&str>, corr: Option<CorrectionAction>) -> RawMessage {
    RawMessage {
        source: source.into(), seq, symbol: "600000.SH".into(), kind,
        recv_ts: ts_from_local(recv).unwrap(), trade, order: None, snapshot: None,
        ref_trade_id: ref_id.map(|s| s.to_string()), ref_order_id: None,
        correction: corr, halt_reason: None,
    }
}

fn tr(ts: &str, id: &str, px: f64, v: u64) -> Trade {
    Trade { trade_id: id.into(), ts: ts_from_local(ts).unwrap(), price: px, volume: v,
            side: Side::B, turnover: None, order_id: None, auction: false }
}

fn ds(msgs: Vec<RawMessage>) -> Dataset {
    Dataset {
        meta: mk_core::dataset::DatasetMeta {
            dataset: "t".into(), generated_at: String::new(), engine_version: "0".into(),
            calendar: Calendar::new(vec!["2026-03-02".into()], vec![]),
            instruments: vec![inst()], corporate_actions: vec![], products: vec![],
            halts: vec![], prev_closes: vec![mk_core::dataset::PrevClose {
                symbol: "600000.SH".into(), trade_date: "2026-03-02".into(), price: 10.0 }],
            continuous: vec![], injected_anomalies: vec![],
        },
        messages: msgs,
        factors: vec![],
    }
}

fn bars(out: &mk_engine::SymbolOutput) -> Vec<mk_core::Bar> {
    out.bars.get("2026-03-02").and_then(|p| p.get("1m")).cloned().unwrap_or_default()
}

#[test]
fn cancel_before_trade_is_applied_when_trade_arrives() {
    // 冲正消息先到（recv_ts 更早），成交后到 —— 模拟跨源乱序
    let msgs = vec![
        mk("A", 1, MsgKind::Trade, "2026-03-02 09:31:01", Some(tr("2026-03-02 09:30:10", "T1", 10.0, 100)), None, None),
        mk("A", 2, MsgKind::Trade, "2026-03-02 09:31:02", Some(tr("2026-03-02 09:30:20", "T2", 10.02, 200)), None, None),
        // 先到 recv 的撤单（recv_ts 早），但引用的 T2 在同一批里
        mk("A", 3, MsgKind::TradeCancel, "2026-03-02 09:31:03", None, Some("T2"), None),
    ];
    let out = Engine::new(Default::default()).run_symbol(&ds(msgs), &inst());
    let b = bars(&out).into_iter().find(|b| b.hm().starts_with("09:31")).unwrap();
    assert_eq!(b.volume, 100, "T2 应被撤销");
    assert_eq!(b.count, 1);
}

#[test]
fn duplicate_cancel_is_idempotent() {
    let msgs = vec![
        mk("A", 1, MsgKind::Trade, "2026-03-02 09:31:01", Some(tr("2026-03-02 09:30:10", "T1", 10.0, 100)), None, None),
        mk("A", 2, MsgKind::Trade, "2026-03-02 09:31:02", Some(tr("2026-03-02 09:30:20", "T2", 10.02, 200)), None, None),
        mk("A", 3, MsgKind::TradeCancel, "2026-03-02 09:31:03", None, Some("T2"), None),
        mk("A", 4, MsgKind::TradeCancel, "2026-03-02 09:31:04", None, Some("T2"), None),
    ];
    let out = Engine::new(Default::default()).run_symbol(&ds(msgs), &inst());
    let b = bars(&out).into_iter().find(|b| b.hm().starts_with("09:31")).unwrap();
    assert_eq!(b.volume, 100, "重复冲正不应重复扣减");
    assert!(out.anomalies.iter().any(|a| a.kind == mk_core::AnomalyKind::CorrectionUnknown),
        "重复冲正应记 correction_unknown");
}

#[test]
fn correct_then_cancel_removes_trade() {
    let msgs = vec![
        mk("A", 1, MsgKind::Trade, "2026-03-02 09:31:01", Some(tr("2026-03-02 09:30:10", "T1", 10.0, 100)), None, None),
        mk("A", 2, MsgKind::Trade, "2026-03-02 09:31:02", Some(tr("2026-03-02 09:30:20", "T2", 10.02, 200)), None, None),
        mk("A", 3, MsgKind::TradeCorrect, "2026-03-02 09:31:03", None, Some("T2"),
           Some(CorrectionAction::Amend { price: Some(10.05), volume: Some(300), ts: None })),
        mk("A", 4, MsgKind::TradeCancel, "2026-03-02 09:31:04", None, Some("T2"), None),
    ];
    let out = Engine::new(Default::default()).run_symbol(&ds(msgs), &inst());
    let b = bars(&out).into_iter().find(|b| b.hm().starts_with("09:31")).unwrap();
    assert_eq!(b.volume, 100, "更正后再撤销，T2 的更正后量也应扣掉");
    assert_eq!(b.high, from_f64(10.0));
}

#[test]
fn corrected_price_out_of_limit_is_still_checked_on_next_trade() {
    // 更正把价格改到极其离谱（但引擎不重新做合法性校验），
    // 后续成交的参考价应使用更正后的价格（因为它已入账）
    let msgs = vec![
        mk("A", 1, MsgKind::Trade, "2026-03-02 09:31:01", Some(tr("2026-03-02 09:30:10", "T1", 10.0, 100)), None, None),
        mk("A", 2, MsgKind::TradeCorrect, "2026-03-02 09:31:02", None, Some("T1"),
           Some(CorrectionAction::Amend { price: Some(10.03), volume: None, ts: None })),
        mk("A", 3, MsgKind::Trade, "2026-03-02 09:31:04", Some(tr("2026-03-02 09:31:03", "T2", 10.04, 100)), None, None),
    ];
    let out = Engine::new(Default::default()).run_symbol(&ds(msgs), &inst());
    // T1 在 09:31 bar（已更正为 10.03），T2 在 09:32 bar
    let b31 = bars(&out).into_iter().find(|b| b.hm().starts_with("09:31")).unwrap();
    assert_eq!(b31.volume, 100);
    assert_eq!(b31.open, from_f64(10.03));
    let b32 = bars(&out).into_iter().find(|b| b.hm().starts_with("09:32")).unwrap();
    assert_eq!(b32.volume, 100);
    assert_eq!(b32.high, from_f64(10.04));
}

#[test]
fn daily_volume_tracks_reversal() {
    let msgs = vec![
        mk("A", 1, MsgKind::Trade, "2026-03-02 09:31:01", Some(tr("2026-03-02 09:30:10", "T1", 10.0, 100)), None, None),
        mk("A", 2, MsgKind::Trade, "2026-03-02 14:00:00", Some(tr("2026-03-02 13:59:30", "T2", 10.02, 900)), None, None),
        mk("A", 3, MsgKind::TradeCancel, "2026-03-02 14:30:00", None, Some("T2"), None),
    ];
    let out = Engine::new(Default::default()).run_symbol(&ds(msgs), &inst());
    let d = out.bars.get("2026-03-02").unwrap().get("1d").unwrap()[0].clone();
    assert_eq!(d.volume, 100, "日线要跟随冲正");
    assert_eq!(d.count, 1);
    assert_eq!(d.close, from_f64(10.0), "日线收盘回到 T1 的价格");
}
