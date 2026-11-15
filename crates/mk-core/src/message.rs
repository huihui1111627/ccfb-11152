//! 原始行情消息模型。
//!
//! 仿真器产出 JSONL，每行一条 `RawMessage`；引擎按 `(symbol, source, seq)` 读入。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MsgKind {
    Trade,
    Order,
    OrderCancel,
    OrderReject,
    TradeCancel,
    TradeCorrect,
    Snapshot,
    HaltBegin,
    HaltEnd,
}

impl MsgKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MsgKind::Trade => "trade",
            MsgKind::Order => "order",
            MsgKind::OrderCancel => "order_cancel",
            MsgKind::OrderReject => "order_reject",
            MsgKind::TradeCancel => "trade_cancel",
            MsgKind::TradeCorrect => "trade_correct",
            MsgKind::Snapshot => "snapshot",
            MsgKind::HaltBegin => "halt_begin",
            MsgKind::HaltEnd => "halt_end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    B,
    S,
    #[default]
    N,
}

/// 成交更正的动作。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum CorrectionAction {
    /// 删除该笔成交（等价于撤销）
    Delete,
    /// 修改字段（价格为 None 表示不变）
    Amend {
        price: Option<f64>,
        volume: Option<u64>,
        ts: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    #[serde(default)]
    pub trade_id: String,
    /// 本地时间戳 ms
    pub ts: i64,
    /// 成交价（原始单位）
    pub price: f64,
    /// 成交量（股 / 手）
    pub volume: u64,
    #[serde(default)]
    pub side: Side,
    /// 成交额（仿真器给出；引擎会校验/重算）
    #[serde(default)]
    pub turnover: Option<f64>,
    #[serde(default)]
    pub order_id: Option<String>,
    /// 是否集合竞价成交
    #[serde(default)]
    pub auction: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    New,
    PartiallyFilled,
    Filled,
    Canceled,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id: String,
    pub ts: i64,
    pub price: f64,
    pub volume: u64,
    #[serde(default)]
    pub side: Side,
    #[serde(default)]
    pub status: Option<OrderStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub ts: i64,
    pub last: f64,
    #[serde(default)]
    pub bid: Option<f64>,
    #[serde(default)]
    pub ask: Option<f64>,
    #[serde(default)]
    pub bid_volume: Option<u64>,
    #[serde(default)]
    pub ask_volume: Option<u64>,
    /// 累计成交量
    #[serde(default)]
    pub cum_volume: Option<u64>,
    /// 累计成交额
    #[serde(default)]
    pub cum_turnover: Option<f64>,
    #[serde(default)]
    pub cum_buy_volume: Option<u64>,
    #[serde(default)]
    pub cum_sell_volume: Option<u64>,
    #[serde(default)]
    pub oi: Option<u64>,
}

/// 行情源上的一条原始消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMessage {
    /// 行情源（A/B…）
    pub source: String,
    /// 该源内部的递增序号（从 1 开始）
    pub seq: u64,
    pub symbol: String,
    pub kind: MsgKind,
    /// 接收时间（本地 ms），用于检测乱序/倒挂
    pub recv_ts: i64,
    #[serde(default)]
    pub trade: Option<Trade>,
    #[serde(default)]
    pub order: Option<Order>,
    #[serde(default)]
    pub snapshot: Option<Snapshot>,
    /// 冲正类消息引用的成交 ID
    #[serde(default)]
    pub ref_trade_id: Option<String>,
    #[serde(default)]
    pub ref_order_id: Option<String>,
    #[serde(default)]
    pub correction: Option<CorrectionAction>,
    #[serde(default)]
    pub halt_reason: Option<String>,
}

impl RawMessage {
    pub fn ts(&self) -> i64 {
        match self.kind {
            MsgKind::Trade => self.trade.as_ref().map(|t| t.ts).unwrap_or(self.recv_ts),
            MsgKind::Order => self.order.as_ref().map(|o| o.ts).unwrap_or(self.recv_ts),
            MsgKind::Snapshot => self.snapshot.as_ref().map(|s| s.ts).unwrap_or(self.recv_ts),
            _ => self.recv_ts,
        }
    }
}
