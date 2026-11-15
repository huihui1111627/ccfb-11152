//! 品种定义。

use crate::fixed::from_f64;
use crate::schedule::TradingScheduleId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Exchange {
    SSE,
    SZSE,
    SHFE,
    DCE,
    CZCE,
    CFFEX,
}

impl Exchange {
    pub fn as_str(&self) -> &'static str {
        match self {
            Exchange::SSE => "SSE",
            Exchange::SZSE => "SZSE",
            Exchange::SHFE => "SHFE",
            Exchange::DCE => "DCE",
            Exchange::CZCE => "CZCE",
            Exchange::CFFEX => "CFFEX",
        }
    }
    pub fn is_equity(&self) -> bool {
        matches!(self, Exchange::SSE | Exchange::SZSE)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssetClass {
    Equity,
    Future,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instrument {
    pub symbol: String,
    pub name: String,
    pub exchange: Exchange,
    pub asset: AssetClass,
    /// 品种（期货为品种代码，如 rb）
    pub product: String,
    /// 最小变动价位（原始单位）
    pub price_tick: f64,
    pub price_decimals: u8,
    /// 合约乘数
    pub multiplier: f64,
    /// 股票最小交易单位（股），期货为 1
    pub lot_size: u64,
    /// 涨跌停幅度（如 0.10），期货为 None（按交易所公布价）
    pub limit_pct: Option<f64>,
    pub schedule_id: TradingScheduleId,
    /// 行情源通道
    pub sources: Vec<String>,
    /// 同一品种的合约列表（期货主力连续用）
    pub contracts: Option<Vec<String>>,
    /// 上市日 / 到期日（期货）
    pub listed: Option<String>,
    pub expiry: Option<String>,
}

impl Instrument {
    pub fn price_tick_fixed(&self) -> i64 {
        from_f64(self.price_tick)
    }
    pub fn multiplier_fixed(&self) -> i64 {
        from_f64(self.multiplier)
    }
    pub fn is_future(&self) -> bool {
        self.asset == AssetClass::Future
    }
    pub fn is_equity(&self) -> bool {
        self.asset == AssetClass::Equity
    }
    pub fn price_decimals_usize(&self) -> usize {
        self.price_decimals as usize
    }
    /// 品种主键：股票为交易所+代码，期货为品种代码。
    pub fn product_key(&self) -> String {
        self.product.clone()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub code: String,
    pub name: String,
    pub exchange: Exchange,
    pub asset: AssetClass,
    pub price_tick: f64,
    pub multiplier: f64,
    pub price_decimals: u8,
    pub schedule_id: TradingScheduleId,
    pub contracts: Vec<String>,
}
