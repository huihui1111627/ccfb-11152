//! API 响应模型（与 docs/api.md 一一对应）。

use mk_core::{Anomaly, Bar};
use serde::{Deserialize, Serialize};

/// `GET /api/meta`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaResp {
    pub dataset: String,
    pub generated_at: String,
    pub engine_version: String,
    pub periods: Vec<String>,
    pub adjust_modes: Vec<String>,
    pub trading_days: Vec<String>,
    pub instruments: Vec<InstrumentResp>,
    pub summary: DatasetSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetSummary {
    pub symbols: usize,
    pub messages: usize,
    pub trades_kept: usize,
    pub trades_isolated: usize,
    pub anomalies: usize,
    pub golden_cases: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentResp {
    pub symbol: String,
    pub name: String,
    pub exchange: String,
    pub asset: String,
    pub product: String,
    pub price_tick: f64,
    pub price_decimals: u8,
    pub multiplier: f64,
    pub lot_size: u64,
    pub limit_pct: Option<f64>,
    pub schedule_id: String,
    pub sources: Vec<String>,
    pub contracts: Option<Vec<String>>,
}

/// `GET /api/sessions`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsResp {
    pub symbol: String,
    pub trade_date: String,
    pub calendar_dates: Vec<String>,
    pub prev_close: Option<f64>,
    pub segments: Vec<SegmentResp>,
    pub halts: Vec<HaltResp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentResp {
    pub kind: String,
    pub label: String,
    pub start: i64,
    pub end: i64,
    pub hm: String,
    pub attach: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HaltResp {
    pub start: i64,
    pub end: i64,
    pub hm: String,
    pub label: String,
}

/// `GET /api/bars`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarsResp {
    pub symbol: String,
    pub period: String,
    pub adjust: String,
    pub source: String,
    pub bars: Vec<BarResp>,
    pub meta: BarsMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarsMeta {
    pub count: usize,
    pub first: Option<String>,
    pub last: Option<String>,
    pub first_seq: u64,
    pub last_seq: u64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarResp {
    pub i: usize,
    pub t: i64,
    pub end: String,
    pub date: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: u64,
    pub to: f64,
    pub oi: Option<u64>,
    pub n: u32,
    pub bvol: u64,
    pub svol: u64,
    pub av: u64,
    pub syn: u64,
    pub cv: u64,
    pub flags: Vec<String>,
    pub seq0: u64,
    pub seq1: u64,
}

impl BarResp {
    pub fn from_bar(i: usize, b: &Bar) -> Self {
        BarResp {
            i,
            t: b.t,
            end: b.hm(),
            date: b.date(),
            o: b.open_f(),
            h: b.high_f(),
            l: b.low_f(),
            c: b.close_f(),
            v: b.volume,
            to: b.turnover_f(),
            oi: b.oi,
            n: b.count,
            bvol: b.buy_volume,
            svol: b.sell_volume,
            av: b.auction_volume,
            syn: b.synthetic_volume,
            cv: b.canceled_volume,
            flags: b.flags.names().into_iter().map(|s| s.to_string()).collect(),
            seq0: b.seq0,
            seq1: b.seq1,
        }
    }
}

/// `GET /api/replay`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayResp {
    pub symbol: String,
    pub trade_date: String,
    pub prev_close: Option<f64>,
    pub sessions: Vec<SegmentResp>,
    pub halts: Vec<HaltResp>,
    pub grids: std::collections::BTreeMap<String, Vec<GridWindow>>,
    pub trades: Vec<ReplayTradeResp>,
    pub isolated: Vec<ReplayTradeResp>,
    pub anomalies: Vec<AnomalyResp>,
    pub bars: std::collections::BTreeMap<String, Vec<BarResp>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridWindow {
    pub s: i64,
    pub e: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayTradeResp {
    pub i: usize,
    pub ts: i64,
    pub p: f64,
    pub v: u64,
    pub side: String,
    pub id: String,
    pub src: String,
    pub syn: bool,
    pub auction: bool,
    pub flags: Vec<String>,
    pub bar_t: Option<i64>,
    pub seq: u64,
}

/// `GET /api/factors`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactorsResp {
    pub symbol: String,
    pub asset: String,
    pub rows: Vec<mk_core::FactorRow>,
    pub series: Vec<mk_core::FactorSeries>,
    pub definitions: std::collections::BTreeMap<String, String>,
}

/// `GET /api/anomalies`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnomaliesResp {
    pub total: usize,
    pub items: Vec<AnomalyResp>,
    pub by_kind: std::collections::BTreeMap<String, usize>,
    pub by_severity: std::collections::BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnomalyResp {
    pub id: String,
    pub ts: i64,
    pub hm: String,
    pub date: String,
    pub symbol: String,
    pub source: String,
    pub kind: String,
    pub severity: String,
    pub detail: String,
    pub trade_id: Option<String>,
    pub seq: Option<u64>,
    pub action: String,
    pub bar_t: Option<i64>,
}

impl AnomalyResp {
    pub fn from(a: &Anomaly) -> Self {
        AnomalyResp {
            id: a.id.clone(),
            ts: a.ts,
            hm: mk_core::time::ms_to_hm(a.ts),
            date: mk_core::time::ms_to_date_string(a.ts),
            symbol: a.symbol.clone(),
            source: a.source.clone(),
            kind: a.kind.as_str().to_string(),
            severity: a.severity.as_str().to_string(),
            detail: a.detail.clone(),
            trade_id: a.trade_id.clone(),
            seq: a.seq,
            action: a.action.clone(),
            bar_t: a.bar_t,
        }
    }
}

/// `GET /api/sources`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcesResp {
    pub items: Vec<SourceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceItem {
    pub symbol: String,
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

/// `GET /api/continuous`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinuousResp {
    pub product: String,
    pub period: String,
    pub main: Vec<mk_core::MainRecord>,
    pub rolls: Vec<mk_core::RollEvent>,
    pub bars: Vec<mk_core::ContinuousBar>,
}

/// `GET /api/consistency`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsistencyResp {
    pub summary: ConsistencySummary,
    pub items: Vec<ConsistencyItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsistencySummary {
    pub checked: usize,
    pub ok: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsistencyItem {
    pub symbol: String,
    pub date: String,
    pub kind: String,
    pub volume_1d: u64,
    pub volume_1m: u64,
    pub turnover_1d: f64,
    pub turnover_1m: f64,
    pub ok: bool,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResp {
    pub error: String,
    pub message: String,
}
