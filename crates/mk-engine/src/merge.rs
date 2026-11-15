//! 多源合并、序号缺口检测与补全（rules.md R50–R53）。
//!
//! 设计：以**主源**（默认 `A`）的消息流为骨架，对源 `B` 只做三件事：
//! 1. 同主键去重（`trade_id` / `order_id` 为跨源主键）；
//! 2. 补齐主源的序号缺口（时间窗内、主键未出现过的对源成交）；
//! 3. 冲突比对（同主键不同价/量 → `source_conflict`）。
//!
//! 快照补数：当对源也补不上时，用缺口前后快照的累计成交额/量差额，在缺口时间窗内
//! 合成匿名成交（R51/R52）。

use mk_core::message::{CorrectionAction, MsgKind, RawMessage, Snapshot};
use mk_core::time::ms_to_hm;
use mk_core::Side;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillOrigin {
    Peer,
    Synthetic,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Gap {
    pub source: String,
    pub from_seq: u64,
    pub to_seq: u64,
    pub prev_ts: i64,
    pub next_ts: i64,
    pub filled: Option<FillOrigin>,
    /// 实际补上的条数
    pub filled_count: usize,
    pub synthetic_count: usize,
}

impl Gap {
    pub fn size(&self) -> u64 {
        self.to_seq - self.from_seq + 1
    }
    pub fn window(&self) -> String {
        format!("({}, {}]", ms_to_hm(self.prev_ts), ms_to_hm(self.next_ts))
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SourceStats {
    pub source: String,
    pub channel: u32,
    pub received: u64,
    pub duplicates: u64,
    pub gaps: u64,
    pub gap_seq_total: u64,
    pub filled_trades: u64,
    pub filled_volume: u64,
    pub synthetic_trades: u64,
    pub unfilled: u64,
    pub first_seq: u64,
    pub last_seq: u64,
    pub inversions: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Conflict {
    pub trade_id: String,
    pub ts: i64,
    pub a_source: String,
    pub b_source: String,
    pub field: String,
    pub a_value: String,
    pub b_value: String,
}

/// 规范化成交（合并后）。
#[derive(Debug, Clone)]
pub struct NormTrade {
    pub symbol: String,
    /// 合并后全局序号（排序后重排）
    pub seq: u64,
    /// 原源序号
    pub src_seq: u64,
    pub source: String,
    pub trade_id: String,
    pub ts: i64,
    pub price_f: f64,
    pub volume: u64,
    pub side: char,
    pub auction: bool,
    pub synthetic: bool,
    /// 委托号（废单冲正用）
    pub order_id: Option<String>,
    /// 补数来源说明（页面展示）
    pub synth_note: Option<String>,
    /// 由缺口补全而来
    pub from_gap_fill: bool,
}

#[derive(Debug, Clone)]
pub enum NormEvent {
    Trade(NormTrade),
    Order { seq: u64, order_id: String, ts: i64, price_f: f64, volume: u64, side: char },
    OrderCancel { seq: u64, order_id: String, ts: i64, source: String },
    OrderReject { seq: u64, order_id: String, ts: i64, source: String },
    TradeCancel { seq: u64, ref_trade_id: String, ts: i64, source: String },
    TradeCorrect { seq: u64, ref_trade_id: String, ts: i64, source: String, corr: CorrectionAction },
    Snapshot { seq: u64, snap: Snapshot, source: String },
    HaltBegin { seq: u64, ts: i64, source: String, reason: String },
    HaltEnd { seq: u64, ts: i64, source: String },
}

impl NormEvent {
    pub fn seq(&self) -> u64 {
        match self {
            NormEvent::Trade(t) => t.seq,
            NormEvent::Order { seq, .. }
            | NormEvent::OrderCancel { seq, .. }
            | NormEvent::OrderReject { seq, .. }
            | NormEvent::TradeCancel { seq, .. }
            | NormEvent::TradeCorrect { seq, .. }
            | NormEvent::Snapshot { seq, .. }
            | NormEvent::HaltBegin { seq, .. }
            | NormEvent::HaltEnd { seq, .. } => *seq,
        }
    }
    pub fn ts(&self) -> i64 {
        match self {
            NormEvent::Trade(t) => t.ts,
            NormEvent::Order { ts, .. }
            | NormEvent::OrderCancel { ts, .. }
            | NormEvent::OrderReject { ts, .. }
            | NormEvent::TradeCancel { ts, .. }
            | NormEvent::TradeCorrect { ts, .. }
            | NormEvent::HaltBegin { ts, .. }
            | NormEvent::HaltEnd { ts, .. } => *ts,
            NormEvent::Snapshot { snap, .. } => snap.ts,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Inversion {
    pub source: String,
    pub seq: u64,
    pub ts: i64,
    pub prev_ts: i64,
    pub trade_id: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DuplicateNote {
    pub source: String,
    pub seq: u64,
    pub identical: bool,
    pub note: String,
}

#[derive(Debug, Clone, Default)]
pub struct Merged {
    pub events: Vec<NormEvent>,
    pub gaps: Vec<Gap>,
    pub stats: Vec<SourceStats>,
    pub conflicts: Vec<Conflict>,
    pub duplicates: Vec<DuplicateNote>,
    pub inversions: Vec<Inversion>,
    pub primary: String,
    /// 主源未补上的序号（合并后序号是重排的，这里保存源序号）
    pub unfilled_seqs: Vec<(String, u64)>,
}

/// 消息内容的粗略指纹，用于判断“同 seq 重复”是否完全一致。
fn fingerprint(m: &RawMessage) -> String {
    let mut s = String::new();
    s.push_str(&m.seq.to_string());
    s.push('|');
    s.push_str(m.kind.as_str());
    s.push('|');
    s.push_str(&m.recv_ts.to_string());
    if let Some(t) = &m.trade {
        s.push_str(&format!("T{}|{}|{}|{:?}", t.trade_id, t.price, t.volume, t.side));
    }
    if let Some(o) = &m.order {
        s.push_str(&format!("O{}|{}|{}", o.order_id, o.price, o.volume));
    }
    if let Some(sn) = &m.snapshot {
        s.push_str(&format!("S{}|{}|{:?}", sn.ts, sn.last, sn.cum_volume));
    }
    if let Some(id) = &m.ref_trade_id {
        s.push_str(&format!("R{}", id));
    }
    if let Some(c) = &m.correction {
        s.push_str(&format!("C{:?}", c));
    }
    s
}

fn side_char(s: Side) -> char {
    match s {
        Side::B => 'B',
        Side::S => 'S',
        Side::N => 'N',
    }
}

fn trade_id_of(m: &RawMessage) -> String {
    m.trade
        .as_ref()
        .map(|t| t.trade_id.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}:{}", m.source, m.seq))
}

/// 合并一个 symbol 的全部源消息。
pub fn merge(symbol: &str, raw: &[RawMessage], primary: &str) -> Merged {
    let mut messages: Vec<&RawMessage> = raw.iter().filter(|m| m.symbol == symbol).collect();

    // 源列表（按名称稳定排序，主源在前）
    let mut sources: Vec<String> = messages.iter().map(|m| m.source.clone()).collect();
    sources.sort();
    sources.dedup();
    let primary = if sources.iter().any(|s| s == primary) {
        primary.to_string()
    } else {
        sources.first().cloned().unwrap_or_else(|| primary.to_string())
    };

    // ---- 1. 每源：重复、缺口、倒挂 ----
    let mut stats: BTreeMap<String, SourceStats> = BTreeMap::new();
    let mut duplicates: Vec<DuplicateNote> = Vec::new();
    let mut gaps: Vec<Gap> = Vec::new();
    let mut inversions: Vec<Inversion> = Vec::new();
    let mut per_source: BTreeMap<String, Vec<&RawMessage>> = BTreeMap::new();
    for m in messages.iter() {
        per_source.entry(m.source.clone()).or_default().push(m);
    }
    for (channel, (src, list)) in per_source.iter_mut().enumerate() {
        list.sort_by_key(|m| m.seq);
        let st = stats.entry(src.clone()).or_insert(SourceStats {
            source: src.clone(),
            channel: channel as u32 + 1,
            ..Default::default()
        });
        st.first_seq = list.first().map(|m| m.seq).unwrap_or(0);
        st.last_seq = list.last().map(|m| m.seq).unwrap_or(0);

        let mut expected = st.first_seq.max(1);
        let mut prev_seq: Option<u64> = None;
        // 倒挂的判据（R40）：按 seq 顺序，**后一条**的 ts 早于**前一条**的 ts。
        // 只与紧邻的前一条比较（不是运行最大值），否则一条坏点之后的正常消息都会被误判。
        let mut prev_ev_ts: Option<i64> = None;
        for m in list.iter() {
            if let Some(ps) = prev_seq {
                if m.seq == ps {
                    st.duplicates += 1;
                    continue;
                }
            }
            let ev_ts = m.ts();
            if let Some(pts) = prev_ev_ts {
                if ev_ts < pts {
                    st.inversions += 1;
                    inversions.push(Inversion {
                        source: src.clone(),
                        seq: m.seq,
                        ts: ev_ts,
                        prev_ts: pts,
                        trade_id: if m.kind == MsgKind::Trade {
                            Some(trade_id_of(m))
                        } else {
                            None
                        },
                        kind: m.kind.as_str().to_string(),
                    });
                }
            }
            // 检测到倒挂后把基准下移到当前消息的 ts：
            // 只对"越界的那一条"报异常，后续恢复正常递增的消息不再连锁误判。
            prev_ev_ts = Some(ev_ts);
            prev_seq = Some(m.seq);

            if m.seq > expected {
                let prev_ts_all = list
                    .iter()
                    .filter(|x| x.seq < m.seq)
                    .map(|x| x.ts())
                    .max()
                    .unwrap_or(m.ts());
                gaps.push(Gap {
                    source: src.clone(),
                    from_seq: expected,
                    to_seq: m.seq - 1,
                    prev_ts: prev_ts_all,
                    next_ts: m.ts(),
                    filled: None,
                    filled_count: 0,
                    synthetic_count: 0,
                });
                st.gaps += 1;
                st.gap_seq_total += m.seq - expected;
            }
            if m.seq >= expected {
                expected = m.seq + 1;
            }
            st.received += 1;
        }

        // 完全重复检测（同 source + seq 两条内容不同 → duplicate_seq 异常）
        let mut by_seq: HashMap<u64, Vec<&RawMessage>> = HashMap::new();
        for m in list.iter() {
            by_seq.entry(m.seq).or_default().push(m);
        }
        let mut seqs: Vec<&u64> = by_seq.keys().collect();
        seqs.sort();
        for seq in seqs {
            let group = &by_seq[seq];
            if group.len() > 1 {
                let fp0 = fingerprint(group[0]);
                let all_same = group.iter().all(|g| fingerprint(g) == fp0);
                duplicates.push(DuplicateNote {
                    source: src.clone(),
                    seq: *seq,
                    identical: all_same,
                    note: if all_same {
                        "同源重复消息，已静默去重".into()
                    } else {
                        "同源同序号但内容不同，保留首条".into()
                    },
                });
            }
        }
    }

    // ---- 2. 主源骨架 ----
    let primary_msgs: Vec<&RawMessage> = per_source
        .get(&primary)
        .cloned()
        .unwrap_or_default();
    let peer_sources: Vec<String> = sources.iter().filter(|s| **s != primary).cloned().collect();

    // 主源已出现的 trade_id 集合
    let mut primary_ids: HashSet<String> = HashSet::new();
    for m in primary_msgs.iter() {
        if m.kind == MsgKind::Trade {
            primary_ids.insert(trade_id_of(m));
        }
    }

    // ---- 3. 补缺口 ----
    let mut filled_events: Vec<NormEvent> = Vec::new();
    let mut unfilled_seqs: Vec<(String, u64)> = Vec::new();
    // 快照（按 source, ts 排序）
    let mut snaps_by_source: BTreeMap<String, Vec<Snapshot>> = BTreeMap::new();
    for m in messages.iter() {
        if m.kind == MsgKind::Snapshot {
            if let Some(s) = &m.snapshot {
                snaps_by_source.entry(m.source.clone()).or_default().push(s.clone());
            }
        }
    }
    for v in snaps_by_source.values_mut() {
        v.sort_by_key(|s| s.ts);
    }

    for gap in gaps.iter_mut() {
        if gap.source != primary {
            continue; // 只补主源的缺口（对源缺口仅统计）
        }
        let mut filled = 0usize;
        // 3a. 对源补数：时间窗内、主键未出现过的成交
        let mut peer_candidates: Vec<(String, &RawMessage)> = Vec::new();
        for peer in peer_sources.iter() {
            if let Some(list) = per_source.get(peer) {
                for m in list.iter() {
                    if m.kind != MsgKind::Trade {
                        continue;
                    }
                    let tid = trade_id_of(m);
                    if primary_ids.contains(&tid) {
                        continue;
                    }
                    let ts = m.trade.as_ref().map(|t| t.ts).unwrap_or(m.recv_ts);
                    if ts > gap.prev_ts && ts <= gap.next_ts {
                        peer_candidates.push((tid, m));
                    }
                }
            }
        }
        peer_candidates.sort_by_key(|(_, m)| m.trade.as_ref().map(|t| t.ts).unwrap_or(0));
        for (tid, m) in peer_candidates.into_iter().take(gap.size() as usize) {
            let t = m.trade.clone().unwrap();
            filled_events.push(NormEvent::Trade(NormTrade {
                symbol: symbol.to_string(),
                seq: 0,
                src_seq: m.seq,
                source: m.source.clone(),
                trade_id: tid.clone(),
                ts: t.ts,
                price_f: t.price,
                volume: t.volume,
                side: side_char(t.side),
                auction: t.auction,
                synthetic: false,
                order_id: t.order_id.clone(),
                synth_note: Some(format!("对源 {} 补序号 {}", m.source, m.seq)),
                from_gap_fill: true,
            }));
            primary_ids.insert(tid);
            filled += 1;
        }

        if filled > 0 {
            gap.filled = Some(FillOrigin::Peer);
            gap.filled_count = filled;
            if let Some(st) = stats.get_mut(&primary) {
                st.filled_trades += filled as u64;
            }
        }

        // 3b. 剩余缺口用快照差额合成
        let remaining = gap.size() as usize - filled;
        if remaining > 0 {
            // 快照必须夹住缺口：前快照 ts <= 缺口前 ts，后快照 ts >= 缺口后 ts
            let mut snaps = snaps_by_source.get(&primary).cloned().unwrap_or_default();
            snaps.sort_by_key(|s| s.ts);
            let before = snaps
                .iter()
                .filter(|s| s.ts <= gap.prev_ts)
                .max_by_key(|s| s.ts)
                .cloned();
            let after = snaps
                .iter()
                .filter(|s| s.ts >= gap.next_ts)
                .min_by_key(|s| s.ts)
                .cloned();
            let mut made = 0usize;
            if let (Some(b), Some(a)) = (before.as_ref(), after.as_ref()) {
                let vol_delta = a.cum_volume.unwrap_or(0).saturating_sub(b.cum_volume.unwrap_or(0));
                if vol_delta > 0 {
                    let tot = a.cum_turnover.unwrap_or(0.0) - b.cum_turnover.unwrap_or(0.0);
                    let buy_delta =
                        a.cum_buy_volume.unwrap_or(0).saturating_sub(b.cum_buy_volume.unwrap_or(0));
                    let sell_delta = a
                        .cum_sell_volume
                        .unwrap_or(0)
                        .saturating_sub(b.cum_sell_volume.unwrap_or(0));
                    let price = if tot > 0.0 && vol_delta > 0 {
                        tot / vol_delta as f64
                    } else {
                        b.last
                    };
                    // 在缺口时间窗内均分，余数给最后一笔
                    let per = (vol_delta / remaining as u64).max(1);
                    let mut assigned = 0u64;
                    for i in 0..remaining {
                        let v = if i + 1 == remaining {
                            vol_delta - assigned
                        } else {
                            per.min(vol_delta - assigned)
                        };
                        if v == 0 {
                            continue;
                        }
                        assigned += v;
                        let frac = (i as f64 + 1.0) / (remaining as f64 + 1.0);
                        let ts = gap.prev_ts
                            + ((gap.next_ts - gap.prev_ts) as f64 * frac).round() as i64;
                        // 方向：按累计买/卖量差额比例，单笔取差额占优方向
                        let side = if buy_delta >= sell_delta && buy_delta > 0 {
                            'B'
                        } else if sell_delta > 0 {
                            'S'
                        } else {
                            'N'
                        };
                        let seq_slot = gap.from_seq + filled as u64 + i as u64;
                        filled_events.push(NormEvent::Trade(NormTrade {
                            symbol: symbol.to_string(),
                            seq: 0,
                            src_seq: seq_slot,
                            source: primary.clone(),
                            trade_id: format!("SYN-{}-{}", symbol, seq_slot),
                            ts,
                            price_f: price,
                            volume: v,
                            side,
                            auction: false,
                            synthetic: true,
                            order_id: None,
                            synth_note: Some(format!(
                                "快照差额补数：累计量 +{}，区间 ({}, {}]",
                                vol_delta,
                                ms_to_hm(gap.prev_ts),
                                ms_to_hm(gap.next_ts)
                            )),
                            from_gap_fill: true,
                        }));
                        made += 1;
                    }
                    gap.filled = Some(if filled > 0 {
                        FillOrigin::Peer
                    } else {
                        FillOrigin::Synthetic
                    });
                    gap.synthetic_count = made;
                    if let Some(st) = stats.get_mut(&primary) {
                        st.synthetic_trades += made as u64;
                        st.filled_volume += vol_delta;
                    }
                }
            }
            if made == 0 {
                for k in 0..(gap.size() as usize - filled) {
                    unfilled_seqs.push((primary.clone(), gap.from_seq + filled as u64 + k as u64));
                }
                if let Some(st) = stats.get_mut(&primary) {
                    st.unfilled += (gap.size() as usize - filled) as u64;
                }
            }
        }
    }

    // ---- 4. 事件流：主源骨架 + 补数事件 + 对源独有的冲正类消息 ----
    let mut events: Vec<NormEvent> = Vec::new();

    for m in primary_msgs.iter() {
        match m.kind {
            MsgKind::Trade => {
                let t = m.trade.clone().unwrap();
                events.push(NormEvent::Trade(NormTrade {
                    symbol: symbol.to_string(),
                    seq: m.seq,
                    src_seq: m.seq,
                    source: m.source.clone(),
                    trade_id: trade_id_of(m),
                    ts: t.ts,
                    price_f: t.price,
                    volume: t.volume,
                    side: side_char(t.side),
                    auction: t.auction,
                    synthetic: false,
                    order_id: t.order_id.clone(),
                    synth_note: None,
                    from_gap_fill: false,
                }));
            }
            MsgKind::Order => {
                if let Some(o) = &m.order {
                    events.push(NormEvent::Order {
                        seq: m.seq,
                        order_id: o.order_id.clone(),
                        ts: o.ts,
                        price_f: o.price,
                        volume: o.volume,
                        side: side_char(o.side),
                    });
                }
            }
            MsgKind::OrderCancel => events.push(NormEvent::OrderCancel {
                seq: m.seq,
                order_id: m.ref_order_id.clone().unwrap_or_default(),
                ts: m.recv_ts,
                source: m.source.clone(),
            }),
            MsgKind::OrderReject => events.push(NormEvent::OrderReject {
                seq: m.seq,
                order_id: m.ref_order_id.clone().unwrap_or_default(),
                ts: m.recv_ts,
                source: m.source.clone(),
            }),
            MsgKind::TradeCancel => events.push(NormEvent::TradeCancel {
                seq: m.seq,
                ref_trade_id: m.ref_trade_id.clone().unwrap_or_default(),
                ts: m.recv_ts,
                source: m.source.clone(),
            }),
            MsgKind::TradeCorrect => {
                if let Some(corr) = &m.correction {
                    events.push(NormEvent::TradeCorrect {
                        seq: m.seq,
                        ref_trade_id: m.ref_trade_id.clone().unwrap_or_default(),
                        ts: m.recv_ts,
                        source: m.source.clone(),
                        corr: corr.clone(),
                    });
                }
            }
            MsgKind::Snapshot => {
                if let Some(s) = &m.snapshot {
                    events.push(NormEvent::Snapshot {
                        seq: m.seq,
                        snap: s.clone(),
                        source: m.source.clone(),
                    });
                }
            }
            MsgKind::HaltBegin => events.push(NormEvent::HaltBegin {
                seq: m.seq,
                ts: m.recv_ts,
                source: m.source.clone(),
                reason: m.halt_reason.clone().unwrap_or_default(),
            }),
            MsgKind::HaltEnd => events.push(NormEvent::HaltEnd {
                seq: m.seq,
                ts: m.recv_ts,
                source: m.source.clone(),
            }),
        }
    }
    events.extend(filled_events);

    // ---- 5. 冲突：同 trade_id 在两个源价格/量不同 ----
    let mut conflicts: Vec<Conflict> = Vec::new();
    let mut by_tid: HashMap<String, Vec<(&str, f64, u64, i64)>> = HashMap::new();
    for m in messages.iter() {
        if m.kind != MsgKind::Trade {
            continue;
        }
        if let Some(t) = &m.trade {
            by_tid
                .entry(trade_id_of(m))
                .or_default()
                .push((m.source.as_str(), t.price, t.volume, t.ts));
        }
    }
    for (tid, list) in by_tid.iter() {
        if list.len() < 2 {
            continue;
        }
        let first = list.iter().min_by_key(|x| if x.0 == primary { 0 } else { 1 }).unwrap();
        for other in list.iter().filter(|x| x.0 != first.0) {
            if (other.1 - first.1).abs() > 1e-9 {
                conflicts.push(Conflict {
                    trade_id: tid.clone(),
                    ts: first.3,
                    a_source: first.0.to_string(),
                    b_source: other.0.to_string(),
                    field: "price".into(),
                    a_value: format!("{}", first.1),
                    b_value: format!("{}", other.1),
                });
            }
            if other.2 != first.2 {
                conflicts.push(Conflict {
                    trade_id: tid.clone(),
                    ts: first.3,
                    a_source: first.0.to_string(),
                    b_source: other.0.to_string(),
                    field: "volume".into(),
                    a_value: format!("{}", first.2),
                    b_value: format!("{}", other.2),
                });
            }
        }
    }

    // ---- 6. 排序 + 重排全局序号 ----
    // 同 ts 时：成交先于冲正（保证冲正能定位到原成交）
    events.sort_by(|a, b| {
        a.ts().cmp(&b.ts()).then_with(|| {
            let ra = matches!(a, NormEvent::Trade(_)) as u8;
            let rb = matches!(b, NormEvent::Trade(_)) as u8;
            rb.cmp(&ra).then_with(|| a.seq().cmp(&b.seq()))
        })
    });
    for (i, e) in events.iter_mut().enumerate() {
        let s = i as u64 + 1;
        match e {
            NormEvent::Trade(t) => t.seq = s,
            NormEvent::Order { seq, .. }
            | NormEvent::OrderCancel { seq, .. }
            | NormEvent::OrderReject { seq, .. }
            | NormEvent::TradeCancel { seq, .. }
            | NormEvent::TradeCorrect { seq, .. }
            | NormEvent::Snapshot { seq, .. }
            | NormEvent::HaltBegin { seq, .. }
            | NormEvent::HaltEnd { seq, .. } => *seq = s,
        }
    }

    messages.clear();

    Merged {
        events,
        gaps,
        stats: stats.into_values().collect(),
        conflicts,
        duplicates,
        inversions,
        primary,
        unfilled_seqs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mk_core::message::{MsgKind, Side, Snapshot, Trade};

    fn trade_msg(source: &str, seq: u64, ts: i64, id: &str, price: f64, vol: u64) -> RawMessage {
        RawMessage {
            source: source.into(),
            seq,
            symbol: "X".into(),
            kind: MsgKind::Trade,
            recv_ts: ts + 1,
            trade: Some(Trade {
                trade_id: id.into(),
                ts,
                price,
                volume: vol,
                side: Side::B,
                turnover: None,
                order_id: None,
                auction: false,
            }),
            order: None,
            snapshot: None,
            ref_trade_id: None,
            ref_order_id: None,
            correction: None,
            halt_reason: None,
        }
    }

    #[test]
    fn dedupes_across_sources() {
        let msgs = vec![
            trade_msg("A", 1, 1000, "T1", 10.0, 100),
            trade_msg("B", 1, 1000, "T1", 10.0, 100),
            trade_msg("A", 2, 2000, "T2", 10.1, 200),
        ];
        let m = merge("X", &msgs, "A");
        let trades: Vec<_> = m.events.iter().filter_map(|e| match e {
            NormEvent::Trade(t) => Some(t),
            _ => None,
        }).collect();
        assert_eq!(trades.len(), 2, "同 trade_id 只保留一条");
    }

    #[test]
    fn fills_gap_from_peer() {
        let msgs = vec![
            trade_msg("A", 1, 1000, "T1", 10.0, 100),
            // A 缺 seq 2
            trade_msg("A", 3, 3000, "T3", 10.2, 300),
            trade_msg("B", 1, 1000, "T1", 10.0, 100),
            trade_msg("B", 2, 2000, "T2", 10.1, 200),
            trade_msg("B", 3, 3000, "T3", 10.2, 300),
        ];
        let m = merge("X", &msgs, "A");
        assert!(m.gaps.iter().any(|g| g.source == "A" && g.filled == Some(FillOrigin::Peer)));
        let trades: Vec<_> = m.events.iter().filter_map(|e| match e {
            NormEvent::Trade(t) => Some(t),
            _ => None,
        }).collect();
        assert_eq!(trades.len(), 3);
    }

    #[test]
    fn synthetic_fill_from_snapshot() {
        let snap = |seq: u64, ts: i64, cum: u64, turn: f64| RawMessage {
            source: "A".into(),
            seq,
            symbol: "X".into(),
            kind: MsgKind::Snapshot,
            recv_ts: ts + 1,
            trade: None,
            order: None,
            snapshot: Some(Snapshot {
                ts,
                last: 10.0,
                bid: Some(9.99),
                ask: Some(10.01),
                bid_volume: None,
                ask_volume: None,
                cum_volume: Some(cum),
                cum_turnover: Some(turn),
                cum_buy_volume: Some(cum),
                cum_sell_volume: Some(0),
                oi: None,
            }),
            ref_trade_id: None,
            ref_order_id: None,
            correction: None,
            halt_reason: None,
        };
        // 缺口出现在 seq 2..3：seq1 之后直接是 seq4
        let msgs = vec![
            trade_msg("A", 1, 990, "T1", 10.0, 100),
            snap(2, 1000, 100, 1000.0),
            snap(5, 2000, 500, 5000.0),
            trade_msg("A", 6, 2010, "T4", 10.0, 100),
        ];
        let m = merge("X", &msgs, "A");
        let syn: Vec<_> = m.events.iter().filter_map(|e| match e {
            NormEvent::Trade(t) if t.synthetic => Some(t),
            _ => None,
        }).collect();
        assert_eq!(syn.len(), 2, "缺口 seq2..3（2 条）各合成一笔");
        assert_eq!(syn.iter().map(|t| t.volume).sum::<u64>(), 400, "合成量等于快照累计量之差");
        assert!(syn[0].ts > 1000 && syn[0].ts < 2000, "合成成交落在缺口时间窗内");
    }
}
