//! 异常注入：在仿真产出的消息流上打补丁，并记录真值清单。
//!
//! 分阶段执行，顺序很重要：
//! 1. **内容修改**（价格/量/tick/涨跌停/时段）——只改字段；
//! 2. **插入消息**（撤单/更正/废单/停牌成交/未知撤单）——按 ts 插入；
//! 3. **整源按 ts 稳定排序 + 连续重编号**（此时源内时间单调、序号连续）；
//! 4. **破坏顺序的注入**：时间戳倒挂、同序号重复、删消息制造缺口——必须最后做，
//!    否则会被第 3 步洗掉。

use crate::anomalies::{InjectKind, InjectionReport};
use mk_core::dataset::InjectedAnomaly;
use mk_core::message::{CorrectionAction, MsgKind, RawMessage, Side};
use mk_core::time::{ms_to_date_string, ms_to_hm, ts_from_local};
use std::collections::HashMap;

pub fn inject_all(
    messages_by_symbol: &mut HashMap<String, String>,
    symbols: &[String],
    _seed: u64,
) -> Vec<InjectedAnomaly> {
    let mut report = InjectionReport::default();
    for sym in symbols.iter() {
        let Some(text) = messages_by_symbol.get(sym).cloned() else {
            continue;
        };
        let mut a: Vec<RawMessage> = Vec::new();
        let mut b: Vec<RawMessage> = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let m: RawMessage = serde_json::from_str(line).expect("message json");
            if m.source == "A" {
                a.push(m);
            } else {
                b.push(m);
            }
        }
        a.sort_by_key(|m| m.seq);
        b.sort_by_key(|m| m.seq);

        let equity = sym.ends_with(".SH") || sym.ends_with(".SZ");
        let tick = if equity {
            0.01
        } else if sym.starts_with("au") {
            0.02
        } else {
            1.0
        };

        inject_a(&mut a, sym, equity, tick, &mut report);
        if !b.is_empty() {
            inject_peer_conflict(&mut b, sym, tick, &mut report);
        }

        let mut out = String::new();
        for m in a.iter().chain(b.iter()) {
            out.push_str(&serde_json::to_string(m).unwrap());
            out.push('\n');
        }
        messages_by_symbol.insert(sym.clone(), out);
    }
    report.items
}

fn round_tick(v: f64, tick: f64) -> f64 {
    ((v / tick).round() * tick * 1e6).round() / 1e6
}

fn trade_positions(a: &[RawMessage]) -> Vec<usize> {
    a.iter()
        .enumerate()
        .filter(|(_, m)| m.kind == MsgKind::Trade && m.trade.is_some())
        .map(|(i, _)| i)
        .collect()
}

/// 连续竞价成交的位置（排除集合竞价成交）。
/// 异常注入应落在连续竞价里：竞价成交的量天然很大，不适合做"异常量"样本。
fn continuous_trade_positions(a: &[RawMessage]) -> Vec<usize> {
    a.iter()
        .enumerate()
        .filter(|(_, m)| {
            m.kind == MsgKind::Trade
                && m.trade
                    .as_ref()
                    .map(|t| !t.auction)
                    .unwrap_or(false)
        })
        .map(|(i, _)| i)
        .collect()
}

/// 在按 ts 升序的流里，找到第一个 ts > target 的位置。
fn insert_pos(a: &[RawMessage], target: i64) -> usize {
    a.iter().position(|m| m.ts() > target).unwrap_or(a.len())
}

fn inject_a(
    a: &mut Vec<RawMessage>,
    symbol: &str,
    equity: bool,
    tick: f64,
    report: &mut InjectionReport,
) {
    let positions = trade_positions(a);
    let n = positions.len();
    if n < 200 {
        return;
    }
    let pick = |num: usize, den: usize| positions[(n * num / den).min(n - 1)];

    // ================= 阶段 1：内容修改 =================
    // 价格跳变 +8%（用连续竞价成交，避免竞价被排除后注入落空）
    let continuous = continuous_trade_positions(a);
    let cn = continuous.len();
    if cn < 100 {
        return;
    }
    let pick_c = |num: usize, den: usize| continuous[(cn * num / den).min(cn - 1)];
    {
        let i = pick_c(2, 5);
        let (recv, seq) = (a[i].recv_ts, a[i].seq);
        if let Some(t) = a[i].trade.as_mut() {
            let old = t.price;
            t.price = round_tick(old * 1.08, tick);
            report.push(
                InjectKind::PriceJump,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                recv,
                format!("成交价 {old:.4} → {:.4}（+8%）", t.price),
            );
        }
    }
    // 成交量异常：股票×200（绝对下限 500 万股），期货×2000（绝对下限 5 万手）。
    // 引擎的阈值是 max(绝对下限, 100×近 64 笔中位数)，这里必须明显越过它。
    {
        let i = pick_c(1, 2);
        let (recv, seq) = (a[i].recv_ts, a[i].seq);
        if let Some(t) = a[i].trade.as_mut() {
            let old = t.volume;
            t.volume = if equity {
                old.saturating_mul(200).max(5_000_000)
            } else {
                old.saturating_mul(2_000).max(50_000)
            };
            report.push(
                InjectKind::VolumeSpike,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                recv,
                format!("成交量 {old} → {}", t.volume),
            );
        }
    }
    // 非整手
    if equity {
        let i = pick(1, 5);
        let (recv, seq) = (a[i].recv_ts, a[i].seq);
        if let Some(t) = a[i].trade.as_mut() {
            t.volume = 150;
            report.push(
                InjectKind::BadVolume,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                recv,
                "成交量改为 150 股（非 100 股整数倍）".into(),
            );
        }
    }
    // 非 tick 价格
    {
        let i = pick(1, 4);
        let (recv, seq) = (a[i].recv_ts, a[i].seq);
        if let Some(t) = a[i].trade.as_mut() {
            t.price += tick / 100.0;
            report.push(
                InjectKind::InvalidTick,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                recv,
                format!("成交价加 {:.4}，不再是 tick {tick:.2} 的整数倍", tick / 100.0),
            );
        }
    }
    // 涨跌停越界：抬到当日涨停价之上。这里用「前一日收盘价 × 1.20」近似保证越界，
    // 再额外抬 2 个 tick，避免恰好落在涨停价上被判为合法。
    if equity {
        let i = pick_c(3, 5);
        let (recv, seq) = (a[i].recv_ts, a[i].seq);
        // 当日该品种的参考价：用同一交易日的首笔成交价近似
        let date = a[i].trade.as_ref().map(|t| ms_to_date_string(t.ts)).unwrap_or_default();
        let day_first = a
            .iter()
            .filter(|m| m.kind == MsgKind::Trade)
            .find(|m| m.trade.as_ref().map(|t| ms_to_date_string(t.ts)) == Some(date.clone()))
            .and_then(|m| m.trade.as_ref().map(|t| t.price))
            .unwrap_or(10.0);
        if let Some(t) = a[i].trade.as_mut() {
            let old = t.price;
            // 昨收 ≈ 当日首笔价；涨停 = 昨收*1.1，取 1.25 倍首笔价确保越界
            t.price = round_tick(day_first * 1.25 + tick * 2.0, tick);
            report.push(
                InjectKind::LimitBreach,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                recv,
                format!("成交价 {old:.2} → {:.2}（超过涨停价 {:.2}）", t.price, day_first * 1.1),
            );
        }
    }
    // 非交易时段：时间挪到午休
    {
        let i = pick(1, 6);
        let old_ts = a[i].trade.as_ref().map(|t| t.ts).unwrap_or(a[i].recv_ts);
        let date = ms_to_date_string(old_ts);
        let noon = ts_from_local(&format!("{date} 12:15:00")).unwrap();
        let seq = a[i].seq;
        a[i].recv_ts = noon + 2;
        if let Some(t) = a[i].trade.as_mut() {
            t.ts = noon;
            report.push(
                InjectKind::OutOfSession,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                noon,
                format!("成交时间 {} → 12:15:00（午休，非交易时段）", ms_to_hm(old_ts)),
            );
        }
    }

    // ================= 阶段 2：插入消息 =================
    let mut inserts: Vec<(i64, RawMessage, InjectKind, Option<String>, String)> = Vec::new();

    // 成交撤销
    {
        let i = pick(1, 8);
        if let Some(t) = a[i].trade.clone() {
            let at = t.ts + 5_000;
            let mut m = a[i].clone();
            m.kind = MsgKind::TradeCancel;
            m.recv_ts = at;
            m.trade = None;
            m.snapshot = None;
            m.ref_trade_id = Some(t.trade_id.clone());
            inserts.push((
                at,
                m,
                InjectKind::TradeCancel,
                Some(t.trade_id.clone()),
                format!("撤销成交 {}", t.trade_id),
            ));
        }
    }
    // 成交更正
    {
        let i = pick(1, 9);
        if let Some(t) = a[i].trade.clone() {
            let at = t.ts + 8_000;
            let mut m = a[i].clone();
            m.kind = MsgKind::TradeCorrect;
            m.recv_ts = at;
            m.trade = None;
            m.snapshot = None;
            m.ref_trade_id = Some(t.trade_id.clone());
            m.correction = Some(CorrectionAction::Amend {
                price: Some(round_tick(t.price + tick * 2.0, tick)),
                volume: None,
                ts: None,
            });
            inserts.push((
                at,
                m,
                InjectKind::TradeCorrect,
                Some(t.trade_id.clone()),
                format!("成交 {} 价格更正 +{:.2}", t.trade_id, tick * 2.0),
            ));
        }
    }
    // 废单
    {
        let i = pick(1, 10);
        if let Some(t) = a[i].trade.clone() {
            let at = t.ts + 3_000;
            let mut m = a[i].clone();
            m.kind = MsgKind::OrderReject;
            m.recv_ts = at;
            m.trade = None;
            m.snapshot = None;
            m.ref_trade_id = None;
            m.ref_order_id = t.order_id.clone();
            inserts.push((
                at,
                m,
                InjectKind::OrderReject,
                None,
                format!("委托 {:?} 废单", t.order_id),
            ));
        }
    }
    // 停牌期间成交（600000.SH 在第三个交易日 10:20–10:50 停牌）
    if symbol == "600000.SH" {
        // 一次遍历统计：每个交易日 10:20–10:50 之间是否有成交
        let mut days_with_trades: Vec<String> = Vec::new();
        let mut days_with_halt_window_trade: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for m in a.iter().filter(|m| m.kind == MsgKind::Trade) {
            let d = ms_to_date_string(m.ts());
            if !days_with_trades.contains(&d) {
                days_with_trades.push(d.clone());
            }
            let hm = ms_to_hm(m.ts());
            if hm.as_str() >= "10:20" && hm.as_str() <= "10:50" {
                days_with_halt_window_trade.insert(d);
            }
        }
        let halted_day = days_with_trades
            .into_iter()
            .find(|d| !days_with_halt_window_trade.contains(d));
        if let Some(day) = halted_day {
            let at = ts_from_local(&format!("{day} 10:35:00")).unwrap();
            let price = a
                .iter()
                .find(|m| ms_to_date_string(m.ts()) == day && m.kind == MsgKind::Trade)
                .and_then(|m| m.trade.as_ref().map(|t| t.price))
                .unwrap_or(10.0);
            let mut m = a[0].clone();
            m.kind = MsgKind::Trade;
            m.recv_ts = at;
            m.snapshot = None;
            m.trade = Some(mk_core::Trade {
                trade_id: format!("{}-HALT", symbol.replace('.', "")),
                ts: at,
                price,
                volume: 100,
                side: Side::B,
                turnover: None,
                order_id: None,
                auction: false,
            });
            inserts.push((
                at,
                m,
                InjectKind::TradeDuringHalt,
                Some(format!("{}-HALT", symbol.replace('.', ""))),
                "停牌区间 10:20–10:50 内插入成交".into(),
            ));
        }
    }
    // 不存在的撤单
    if let Some(last) = a.last().cloned() {
        let at = last.ts() + 1_000;
        let mut m = last;
        m.kind = MsgKind::TradeCancel;
        m.recv_ts = at;
        m.trade = None;
        m.snapshot = None;
        m.ref_trade_id = Some(format!("{}-NOSUCH", symbol.replace('.', "")));
        inserts.push((
            at,
            m,
            InjectKind::CancelUnknown,
            Some(format!("{}-NOSUCH", symbol.replace('.', ""))),
            "撤单引用不存在的成交".into(),
        ));
    }

    for (at, m, kind, tid, note) in inserts {
        let pos = insert_pos(a, at);
        let mut m = m;
        m.seq = 0;
        a.insert(pos, m);
        let inserted_seq = a[pos].seq;
        report.push(kind, symbol, "A", tid, Some(inserted_seq), at, note);
    }

    // ================= 阶段 3：按 ts 稳定排序 + 连续编号 =================
    a.sort_by(|x, y| x.ts().cmp(&y.ts()).then_with(|| x.seq.cmp(&y.seq)));
    for (i, m) in a.iter_mut().enumerate() {
        m.seq = i as u64 + 1;
    }

    // ================= 阶段 4：破坏顺序的注入 =================
    // 4a. 时间戳倒挂
    {
        let positions = trade_positions(a);
        let i = positions[positions.len() / 7];
        let seq = a[i].seq;
        if let Some(t) = a[i].trade.as_mut() {
            let old = t.ts;
            t.ts = old - 60_000;
            report.push(
                InjectKind::TimestampInversion,
                symbol,
                "A",
                Some(t.trade_id.clone()),
                Some(seq),
                t.ts,
                format!(
                    "成交时间 {} 回拨 60s 到 {}，早于同源前一条消息",
                    ms_to_hm(old),
                    ms_to_hm(t.ts)
                ),
            );
        }
    }
    // 4b. 同 seq 重复（内容不同）
    {
        let positions = trade_positions(a);
        let i = positions[positions.len() / 2];
        let mut dup = a[i].clone();
        if let Some(t) = dup.trade.as_mut() {
            t.volume = t.volume.saturating_add(100);
        }
        dup.recv_ts += 2;
        let tid = a[i].trade.as_ref().map(|t| t.trade_id.clone());
        let seq = a[i].seq;
        let ts = a[i].ts();
        a.insert(i + 1, dup);
        report.push(
            InjectKind::DuplicateSeq,
            symbol,
            "A",
            tid,
            Some(seq),
            ts,
            "同源同序号推送两次，第二次成交量 +100（内容不同）".into(),
        );
    }
    // 4c. 删除一条成交制造序号缺口
    {
        let positions = trade_positions(a);
        let i = positions[positions.len() / 3];
        let victim = a.remove(i);
        let tid = victim.trade.as_ref().map(|t| t.trade_id.clone());
        report.push(
            InjectKind::SeqGap,
            symbol,
            "A",
            tid,
            Some(victim.seq),
            victim.ts(),
            format!("删除源 A 序号 {} 的成交，制造真实的序号空号", victim.seq),
        );
    }
}

/// B 源：同 trade_id 价格与 A 源不一致 → source_conflict。
fn inject_peer_conflict(
    b: &mut Vec<RawMessage>,
    symbol: &str,
    tick: f64,
    report: &mut InjectionReport,
) {
    let idxs: Vec<usize> = b
        .iter()
        .enumerate()
        .filter(|(_, m)| m.kind == MsgKind::Trade)
        .map(|(i, _)| i)
        .collect();
    if idxs.is_empty() {
        return;
    }
    let i = idxs[idxs.len() / 2];
    let (seq, ts) = (b[i].seq, b[i].ts());
    if let Some(t) = b[i].trade.as_mut() {
        let old = t.price;
        t.price = round_tick(old + tick * 2.0, tick);
        report.push(
            InjectKind::SourceConflict,
            symbol,
            "B",
            Some(t.trade_id.clone()),
            Some(seq),
            ts,
            format!("B 源成交价 {old:.4} 与 A 源不一致（+2 tick）"),
        );
    }
}
