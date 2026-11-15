//! K 线模型。

use crate::fixed::{round4, SCALE};
use crate::time::{ms_to_date_string, ms_to_hm};
use crate::period::{Period, Window};
use serde::{Deserialize, Serialize};

/// bar 标记位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BarFlags(pub u16);

impl BarFlags {
    pub const AUCTION: u16 = 1 << 0;
    pub const SYNTHETIC: u16 = 1 << 1;
    pub const CANCELED: u16 = 1 << 2;
    pub const CORRECTED: u16 = 1 << 3;
    pub const HALT_OVERLAP: u16 = 1 << 4;
    pub const GAP_UNFILLED: u16 = 1 << 5;
    pub const EMPTY_FILL: u16 = 1 << 6;

    pub fn with(self, bit: u16) -> Self {
        BarFlags(self.0 | bit)
    }
    pub fn has(self, bit: u16) -> bool {
        self.0 & bit != 0
    }
    pub fn names(self) -> Vec<&'static str> {
        let mut v = Vec::new();
        for (bit, name) in [
            (Self::AUCTION, "auction"),
            (Self::SYNTHETIC, "synthetic"),
            (Self::CANCELED, "canceled"),
            (Self::CORRECTED, "corrected"),
            (Self::HALT_OVERLAP, "halt_overlap"),
            (Self::GAP_UNFILLED, "gap_unfilled"),
            (Self::EMPTY_FILL, "empty_fill"),
        ] {
            if self.has(bit) {
                v.push(name);
            }
        }
        v
    }
}

/// 一根已完成的 bar（内部定点表示，价格/额 scale 1e4）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Bar {
    /// bar 标签时间（结束时间，本地 ms）
    pub t: i64,
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: u64,
    /// 成交额（元，定点）
    pub turnover: i64,
    /// 持仓量（期货）
    pub oi: Option<u64>,
    /// 成交笔数
    pub count: u32,
    pub buy_volume: u64,
    pub sell_volume: u64,
    /// 集合竞价成交量
    pub auction_volume: u64,
    /// 补数合成成交量
    pub synthetic_volume: u64,
    /// 被冲正成交量
    pub canceled_volume: u64,
    pub flags: BarFlags,
    pub seq0: u64,
    pub seq1: u64,
    /// 所属交易日
    pub trade_date: String,
    /// 周期
    pub period: Period,
}

impl Bar {
    pub fn new(t: i64, trade_date: String, period: Period) -> Self {
        Bar { t, trade_date, period, ..Default::default() }
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn open_f(&self) -> f64 {
        round4(self.open)
    }
    pub fn high_f(&self) -> f64 {
        round4(self.high)
    }
    pub fn low_f(&self) -> f64 {
        round4(self.low)
    }
    pub fn close_f(&self) -> f64 {
        round4(self.close)
    }
    pub fn turnover_f(&self) -> f64 {
        round4(self.turnover)
    }

    /// 成交额按 `price*volume*multiplier` 精确重算（定点）。
    pub fn add_turnover(price: i64, volume: u64, multiplier: i64) -> i64 {
        (price as i128 * volume as i128 * multiplier as i128 / SCALE as i128) as i64
    }

    pub fn date(&self) -> String {
        ms_to_date_string(self.t)
    }
    pub fn hm(&self) -> String {
        ms_to_hm(self.t)
    }
}

/// 单笔成交在 bar 内的记录（用于冲正与重算）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarTrade {
    pub seq: u64,
    pub trade_id: String,
    pub ts: i64,
    pub price: i64,
    pub volume: u64,
    pub turnover: i64,
    pub side: char,
    pub auction: bool,
    pub synthetic: bool,
    pub valid: bool,
    pub source: String,
}

/// 从有效成交列表重算一根 bar 的 OHLC 与汇总字段。
pub fn recompute(bar: &mut Bar, trades: &[BarTrade], period: Period, window: Option<&Window>) {
    let mut o: Option<i64> = None;
    let mut h = i64::MIN;
    let mut l = i64::MAX;
    let mut c = 0i64;
    let mut last_seq = 0u64;
    let mut first_seq = u64::MAX;
    let mut v = 0u64;
    let mut to = 0i64;
    let mut n = 0u32;
    let mut bv = 0u64;
    let mut sv = 0u64;
    let mut av = 0u64;
    let mut syn = 0u64;
    let mut flags = bar.flags;
    for tr in trades.iter().filter(|t| t.valid) {
        if tr.synthetic {
            syn += tr.volume;
            flags = flags.with(BarFlags::SYNTHETIC);
        } else if tr.auction {
            av += tr.volume;
        }
        if tr.auction {
            flags = flags.with(BarFlags::AUCTION);
        }
        // 第一笔按消息序号；OHLC 的 open/close 也用序号顺序（R21）
        let is_first = o.is_none() || tr.seq < first_seq;
        if is_first {
            o = Some(tr.price);
            first_seq = tr.seq;
        }
        let is_last = tr.seq >= last_seq;
        if is_last {
            c = tr.price;
            last_seq = tr.seq;
        }
        h = h.max(tr.price);
        l = l.min(tr.price);
        v += tr.volume;
        to += tr.turnover;
        n += 1;
        match tr.side {
            'B' => bv += tr.volume,
            'S' => sv += tr.volume,
            _ => {}
        }
    }
    let _ = period;
    let _ = window;
    bar.open = o.unwrap_or(0);
    bar.high = if h == i64::MIN { 0 } else { h };
    bar.low = if l == i64::MAX { 0 } else { l };
    bar.close = c;
    bar.volume = v;
    bar.turnover = to;
    bar.count = n;
    bar.buy_volume = bv;
    bar.sell_volume = sv;
    bar.auction_volume = av;
    bar.synthetic_volume = syn;
    bar.seq0 = if first_seq == u64::MAX { 0 } else { first_seq };
    bar.seq1 = last_seq;
    bar.flags = flags;
}
