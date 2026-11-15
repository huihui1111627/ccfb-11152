//! 单交易日 1 分钟 bar 构造 + 冲正账本（rules.md R10–R24）。
//!
//! 账本模型：每个交易日持有 `Vec<MinuteSlot>`，`MinuteSlot` 与该交易日的 1m 窗口一一对应。
//! 每笔有效成交记录自己的 `seq` 与所属 slot；冲正时把成交标记为无效并重算该 slot。
//! 1m 之上的所有周期都由 1m 重新聚合，所以冲正天然向上传导。

use crate::config::EmptyBarPolicy;
use crate::validate::Reject;
use mk_core::bar::{recompute, Bar, BarFlags, BarTrade};
use mk_core::fixed::{round4, SCALE};
use mk_core::period::{Period, Window};
use mk_core::{Anomaly, AnomalyKind, Instrument, SessionDay};
use std::collections::HashMap;

/// 一个 1 分钟窗口的账本。
#[derive(Debug, Clone)]
pub struct MinuteSlot {
    pub window: Window,
    pub trades: Vec<BarTrade>,
    /// 该 slot 是否因停牌而完全不交易
    pub halted: bool,
    /// 窗口与停牌区间部分重叠
    pub halt_overlap: bool,
    /// 未补上的序号缺口落在此 bar
    pub gap_unfilled: bool,
    /// 因冲正被清空/修正
    pub had_cancel: bool,
    pub had_correct: bool,
    /// 被冲正掉的量（用于 cv 字段与页面展示）
    pub canceled_volume: u64,
}

impl MinuteSlot {
    pub fn new(window: Window) -> Self {
        MinuteSlot {
            window,
            trades: Vec::new(),
            halted: false,
            halt_overlap: false,
            gap_unfilled: false,
            had_cancel: false,
            had_correct: false,
            canceled_volume: 0,
        }
    }

    pub fn valid_trades(&self) -> impl Iterator<Item = &BarTrade> {
        self.trades.iter().filter(|t| t.valid)
    }

    pub fn valid_count(&self) -> usize {
        self.valid_trades().count()
    }

    pub fn has_auction_trade(&self) -> bool {
        self.valid_trades().any(|t| t.auction)
    }
}

/// 冲正结果。
#[derive(Debug, Clone)]
pub enum ReversalOutcome {
    /// 生效
    Applied { slot_label: i64, volume: u64, price: i64 },
    /// 找不到原成交
    NotFound,
    /// 原成交已被冲正
    AlreadyReversed,
}

/// 单交易日的 bar 账本。
#[derive(Debug, Clone)]
pub struct DayLedger {
    pub trade_date: String,
    pub slots: Vec<MinuteSlot>,
    /// trade_id → (slot_idx, trade_idx_in_slot)
    pub index: HashMap<String, (usize, usize)>,
    pub prev_close: i64,
    pub multiplier: i64,
    pub empty_policy: EmptyBarPolicy,
    /// 待冲正（尚未收到原成交）的 trade_id
    pub pending_reversals: HashMap<String, PendingReversal>,
}

#[derive(Debug, Clone)]
pub struct PendingReversal {
    pub seq: u64,
    pub ts: i64,
    pub source: String,
    pub kind: AnomalyKind,
    pub correction: Option<mk_core::message::CorrectionAction>,
}

impl DayLedger {
    pub fn new(
        trade_date: String,
        windows: Vec<Window>,
        prev_close: i64,
        multiplier: i64,
        empty_policy: EmptyBarPolicy,
    ) -> Self {
        DayLedger {
            trade_date,
            slots: windows.into_iter().map(MinuteSlot::new).collect(),
            index: HashMap::new(),
            prev_close,
            multiplier,
            empty_policy,
            pending_reversals: HashMap::new(),
        }
    }

    /// 找到包含给定时间戳的 1m slot。
    /// 集合竞价 slot（`auction_only`）只接受集合竞价成交。
    pub fn locate(&self, ts: i64, auction: bool) -> Option<usize> {
        // 竞价 slot 优先（A 股 09:25 的成交）
        if auction {
            if let Some(i) = self
                .slots
                .iter()
                .position(|s| s.window.auction_only && s.window.contains(ts))
            {
                return Some(i);
            }
        }
        self.slots.iter().position(|s| !s.window.auction_only && s.window.contains(ts))
    }

    /// 加入一笔有效成交。调用方已完成合法性校验与隔离判定。
    pub fn add_trade(&mut self, slot_idx: usize, trade: BarTrade) -> Result<(), ()> {
        if let Some((s, t)) = self.index.get(&trade.trade_id).copied() {
            // 已有同主键成交（重复推送）→ 忽略
            let _ = (s, t);
            return Err(());
        }
        let idx_in_slot = self.slots[slot_idx].trades.len();
        self.index
            .insert(trade.trade_id.clone(), (slot_idx, idx_in_slot));
        self.slots[slot_idx].trades.push(trade);
        Ok(())
    }

    /// 冲正：把成交标记无效并重算所在 bar。
    ///
    /// 定位用 `index` 里的 (slot, 下标)，**不是**按 trade_id 线性搜索：
    /// 更正后同一 trade_id 会有"旧副本（已失效）+ 新副本（有效）"两条记录，
    /// 线性搜索会命中旧副本，导致再次撤销时扣错记录。
    pub fn reverse(&mut self, trade_id: &str, corrected: bool) -> ReversalOutcome {
        let Some((slot_idx, t_idx)) = self.index.get(trade_id).copied() else {
            return ReversalOutcome::NotFound;
        };
        let slot = &mut self.slots[slot_idx];
        let Some(tr) = slot.trades.get_mut(t_idx) else {
            return ReversalOutcome::NotFound;
        };
        // 防御：index 失配时（理论上不该发生）退化到查找有效副本
        if tr.trade_id != trade_id {
            let Some(pos) = slot
                .trades
                .iter()
                .position(|t| t.trade_id == trade_id && t.valid)
            else {
                return ReversalOutcome::NotFound;
            };
            let tr = &mut slot.trades[pos];
            let volume = tr.volume;
            let price = tr.price;
            tr.valid = false;
            slot.canceled_volume += volume;
            slot.had_cancel = true;
            return ReversalOutcome::Applied { slot_label: slot.window.label, volume, price };
        }
        if !tr.valid {
            return ReversalOutcome::AlreadyReversed;
        }
        let volume = tr.volume;
        let price = tr.price;
        tr.valid = false;
        slot.canceled_volume += volume;
        if corrected {
            slot.had_correct = true;
        } else {
            slot.had_cancel = true;
        }
        ReversalOutcome::Applied {
            slot_label: slot.window.label,
            volume,
            price,
        }
    }

    /// 更正：先冲正原成交，再以新值加入（可能落在另一个 slot）。
    pub fn correct_trade(
        &mut self,
        trade_id: &str,
        new_price: Option<i64>,
        new_volume: Option<u64>,
        new_ts: Option<i64>,
    ) -> Result<ReversalOutcome, ()> {
        let Some((slot_idx, t_idx)) = self.index.get(trade_id).copied() else {
            return Ok(ReversalOutcome::NotFound);
        };
        let slot = &mut self.slots[slot_idx];
        let Some(pos) = slot
            .trades
            .get(t_idx)
            .filter(|t| t.trade_id == trade_id)
            .map(|_| t_idx)
            .or_else(|| slot.trades.iter().position(|t| t.trade_id == trade_id && t.valid))
        else {
            return Ok(ReversalOutcome::NotFound);
        };
        let mut tr = slot.trades[pos].clone();
        if !tr.valid {
            return Ok(ReversalOutcome::AlreadyReversed);
        }
        // 使原成交失效，但保留其记录（供核对显示）
        slot.trades[pos].valid = false;
        slot.had_correct = true;
        slot.canceled_volume += tr.volume;

        let price = new_price.unwrap_or(tr.price);
        let volume = new_volume.unwrap_or(tr.volume);
        let ts = new_ts.unwrap_or(tr.ts);
        tr.price = price;
        tr.volume = volume;
        tr.ts = ts;
        tr.turnover = Bar::add_turnover(price, volume, self.multiplier);
        tr.valid = true;
        // 重新定位 slot
        let new_slot = if new_ts.is_some() || new_price.is_some() {
            self.slots
                .iter()
                .position(|s| !s.window.auction_only && s.window.contains(ts))
                .unwrap_or(slot_idx)
        } else {
            slot_idx
        };
        let new_idx = self.slots[new_slot].trades.len();
        self.slots[new_slot].had_correct = true;
        self.slots[new_slot].trades.push(tr);
        self.index.insert(trade_id.to_string(), (new_slot, new_idx));
        Ok(ReversalOutcome::Applied {
            slot_label: self.slots[new_slot].window.label,
            volume,
            price,
        })
    }

    /// 某 slot 重算后得到的 bar（为空则返回 None，调用方决定是否 fill）。
    pub fn bar_of(&self, slot_idx: usize) -> Option<Bar> {
        let slot = &self.slots[slot_idx];
        if slot.valid_count() == 0 {
            return None;
        }
        let mut bar = Bar::new(slot.window.label, self.trade_date.clone(), Period::Min1);
        let flags = self.slot_flags(slot);
        bar.flags = flags;
        recompute(&mut bar, &slot.trades, Period::Min1, Some(&slot.window));
        bar.canceled_volume = slot.canceled_volume;
        // 竞价 bar 的 t 是标签（09:30），窗口本身是 [09:15,09:25]
        Some(bar)
    }

    fn slot_flags(&self, slot: &MinuteSlot) -> BarFlags {
        let mut f = BarFlags::default();
        if slot.window.auction_only {
            f = f.with(BarFlags::AUCTION);
        }
        if slot.halted {
            f = f.with(BarFlags::HALT_OVERLAP);
        }
        if slot.halt_overlap {
            f = f.with(BarFlags::HALT_OVERLAP);
        }
        if slot.gap_unfilled {
            f = f.with(BarFlags::GAP_UNFILLED);
        }
        if slot.had_cancel {
            f = f.with(BarFlags::CANCELED);
        }
        if slot.had_correct {
            f = f.with(BarFlags::CORRECTED);
        }
        if slot.valid_count() == 0 && !slot.trades.is_empty() {
            f = f.with(BarFlags::CANCELED);
        }
        f
    }

    /// 全部 1m bar（按时间升序）。`fill` 策略下会为无成交窗口补前收 bar。
    pub fn bars(&self) -> Vec<Bar> {
        let mut out = Vec::new();
        for (i, slot) in self.slots.iter().enumerate() {
            match self.bar_of(i) {
                Some(b) => out.push(b),
                None => {
                    if self.empty_policy == EmptyBarPolicy::Fill && !slot.window.auction_only {
                        let mut b =
                            Bar::new(slot.window.label, self.trade_date.clone(), Period::Min1);
                        b.open = self.prev_close;
                        b.high = self.prev_close;
                        b.low = self.prev_close;
                        b.close = self.prev_close;
                        b.flags = BarFlags::default().with(BarFlags::EMPTY_FILL);
                        b.trade_date = self.trade_date.clone();
                        if slot.halt_overlap {
                            b.flags = b.flags.with(BarFlags::HALT_OVERLAP);
                        }
                        out.push(b);
                    }
                }
            }
        }
        out
    }
}

/// 单笔成交的构建辅助。
pub struct TradeInput<'a> {
    pub trade_id: &'a str,
    pub seq: u64,
    pub ts: i64,
    pub price: i64,
    pub volume: u64,
    pub side: char,
    pub auction: bool,
    pub synthetic: bool,
    pub source: &'a str,
    pub multiplier: i64,
}

impl<'a> TradeInput<'a> {
    pub fn to_bar_trade(&self) -> BarTrade {
        BarTrade {
            seq: self.seq,
            trade_id: self.trade_id.to_string(),
            ts: self.ts,
            price: self.price,
            volume: self.volume,
            turnover: Bar::add_turnover(self.price, self.volume, self.multiplier),
            side: self.side,
            auction: self.auction,
            synthetic: self.synthetic,
            valid: true,
            source: self.source.to_string(),
        }
    }
}

/// 从 `Reject` 生成异常。
pub fn reject_anomaly(
    next_id: &mut u64,
    rej: &Reject,
    symbol: &str,
    source: &str,
    ts: i64,
    trade_id: Option<&str>,
    seq: Option<u64>,
    bar_t: Option<i64>,
) -> Anomaly {
    *next_id += 1;
    Anomaly {
        id: format!("AN{:05}", *next_id),
        ts,
        symbol: symbol.to_string(),
        source: source.to_string(),
        kind: rej.kind,
        severity: rej.kind.severity(),
        detail: rej.detail.clone(),
        trade_id: trade_id.map(|s| s.to_string()),
        seq,
        action: rej.kind.action().to_string(),
        bar_t,
        reversed: false,
    }
}

/// 生成一条普通异常。
pub fn anomaly(
    next_id: &mut u64,
    kind: AnomalyKind,
    symbol: &str,
    source: &str,
    ts: i64,
    detail: String,
    trade_id: Option<String>,
    seq: Option<u64>,
    bar_t: Option<i64>,
) -> Anomaly {
    *next_id += 1;
    Anomaly {
        id: format!("AN{:05}", *next_id),
        ts,
        symbol: symbol.to_string(),
        source: source.to_string(),
        kind,
        severity: kind.severity(),
        detail,
        trade_id,
        seq,
        action: kind.action().to_string(),
        bar_t,
        reversed: false,
    }
}

/// 便于测试/展示：把 `SessionDay` 的窗口转成 1m 窗口列表。
pub fn minute_windows(day: &SessionDay) -> Vec<Window> {
    mk_core::period::session_windows(day, Period::Min1)
}

pub fn price_f(price_fixed: i64) -> f64 {
    round4(price_fixed)
}

pub fn pct(x: f64) -> f64 {
    (x * 10000.0).round() / 100.0
}

pub fn fixed_scale() -> i64 {
    SCALE
}

#[allow(dead_code)]
fn assert_instrument(_i: &Instrument) {}
