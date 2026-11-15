//! 数据集描述文件（由仿真器生成，引擎与 Web 服务读取）。

use crate::continuous::ContinuousSeries;
use crate::factor::{CorporateAction, FactorSet};
use crate::instrument::Instrument;
use crate::message::RawMessage;
use crate::schedule::Calendar;
use serde::{Deserialize, Serialize};

/// `dataset.json`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetMeta {
    pub dataset: String,
    pub generated_at: String,
    pub engine_version: String,
    pub calendar: Calendar,
    pub instruments: Vec<Instrument>,
    /// 除权除息事件，按 symbol
    #[serde(default)]
    pub corporate_actions: Vec<(String, CorporateAction)>,
    /// 期货品种 → 合约列表顺序（主力连续用）
    #[serde(default)]
    pub products: Vec<crate::instrument::Product>,
    /// 临时停牌日程（symbol → 区间）
    #[serde(default)]
    pub halts: Vec<HaltPlan>,
    /// 每交易日昨收（symbol → date → price）
    #[serde(default)]
    pub prev_closes: Vec<PrevClose>,
    /// 各品种主力连续序列（仿真器给出日线，引擎复算）
    #[serde(default)]
    pub continuous: Vec<ContinuousSeries>,
    /// 异常的注入记录（仿真器知道真值，用于核对召回）
    #[serde(default)]
    pub injected_anomalies: Vec<InjectedAnomaly>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HaltPlan {
    pub symbol: String,
    pub trade_date: String,
    pub start: i64,
    pub end: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrevClose {
    pub symbol: String,
    pub trade_date: String,
    pub price: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InjectedAnomaly {
    pub kind: String,
    pub symbol: String,
    pub source: String,
    pub trade_id: Option<String>,
    pub seq: Option<u64>,
    pub ts: i64,
    pub note: String,
}

/// 数据集（内存形态）。
#[derive(Debug, Clone)]
pub struct Dataset {
    pub meta: DatasetMeta,
    /// 消息按 symbol 分文件：`messages/<symbol>.jsonl`
    pub messages: Vec<RawMessage>,
    /// 因子表按 symbol
    pub factors: Vec<(String, FactorSet)>,
}

impl Dataset {
    pub fn instrument(&self, symbol: &str) -> Option<&Instrument> {
        self.meta.instruments.iter().find(|i| i.symbol == symbol)
    }
    pub fn factors_for(&self, symbol: &str) -> Option<&FactorSet> {
        self.factors
            .iter()
            .find(|(s, _)| s == symbol)
            .map(|(_, f)| f)
    }
}
