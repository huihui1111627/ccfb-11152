//! 仿真器的异常注入清单（真值）。
//!
//! 仿真器知道"真值"，因此每条注入都记录在 `dataset.json.injected_anomalies` 中，
//! 核对页面据此计算召回率（引擎是否真的识别到）。

use mk_core::dataset::InjectedAnomaly;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectKind {
    PriceJump,
    VolumeSpike,
    TimestampInversion,
    OutOfSession,
    DuplicateSeq,
    SeqGap,
    InvalidTick,
    LimitBreach,
    TradeDuringHalt,
    CancelUnknown,
    TradeCancel,
    TradeCorrect,
    OrderReject,
    SourceConflict,
    BadVolume,
}

impl InjectKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            InjectKind::PriceJump => "price_jump",
            InjectKind::VolumeSpike => "volume_spike",
            InjectKind::TimestampInversion => "timestamp_inversion",
            InjectKind::OutOfSession => "out_of_session",
            InjectKind::DuplicateSeq => "duplicate_seq",
            InjectKind::SeqGap => "seq_gap",
            InjectKind::InvalidTick => "invalid_tick",
            InjectKind::LimitBreach => "limit_breach",
            InjectKind::TradeDuringHalt => "trade_during_halt",
            InjectKind::CancelUnknown => "cancel_unknown",
            InjectKind::TradeCancel => "trade_cancel",
            InjectKind::TradeCorrect => "trade_correct",
            InjectKind::OrderReject => "order_reject",
            InjectKind::SourceConflict => "source_conflict",
            InjectKind::BadVolume => "bad_volume",
        }
    }
}

/// 注入清单。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InjectionReport {
    pub items: Vec<InjectedAnomaly>,
}

impl InjectionReport {
    pub fn push(
        &mut self,
        kind: InjectKind,
        symbol: &str,
        source: &str,
        trade_id: Option<String>,
        seq: Option<u64>,
        ts: i64,
        note: String,
    ) {
        self.items.push(InjectedAnomaly {
            kind: kind.as_str().to_string(),
            symbol: symbol.to_string(),
            source: source.to_string(),
            trade_id,
            seq,
            ts,
            note,
        });
    }
}
