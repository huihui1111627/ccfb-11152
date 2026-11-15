//! 引擎统计。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SymbolMetrics {
    pub symbol: String,
    pub messages_in: u64,
    pub trades_kept: u64,
    pub trades_isolated: u64,
    pub trades_synthetic: u64,
    pub trades_reversed: u64,
    pub corrections: u64,
    pub bars_1m: u64,
    pub anomalies: u64,
    pub errors: u64,
    pub warns: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineMetrics {
    pub elapsed_ms: u64,
    pub symbols: Vec<SymbolMetrics>,
}
