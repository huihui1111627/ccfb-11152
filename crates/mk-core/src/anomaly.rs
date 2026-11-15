//! 异常识别模型（rules.md R40–R47）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnomalyKind {
    PriceJump,
    VolumeSpike,
    TimestampInversion,
    OutOfSession,
    DuplicateSeq,
    SeqGap,
    SeqGapFilled,
    GapUnfilled,
    InvalidTick,
    LimitBreach,
    TradeDuringHalt,
    CancelUnknown,
    CorrectionUnknown,
    LateCorrection,
    SourceConflict,
    BadPrice,
    BadVolume,
    OrderRejected,
    HaltBegin,
    HaltEnd,
    /// 撤单冲正成功执行
    TradeCanceled,
    /// 成交更正成功执行
    TradeCorrected,
}

impl AnomalyKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AnomalyKind::PriceJump => "price_jump",
            AnomalyKind::VolumeSpike => "volume_spike",
            AnomalyKind::TimestampInversion => "timestamp_inversion",
            AnomalyKind::OutOfSession => "out_of_session",
            AnomalyKind::DuplicateSeq => "duplicate_seq",
            AnomalyKind::SeqGap => "seq_gap",
            AnomalyKind::SeqGapFilled => "seq_gap_filled",
            AnomalyKind::GapUnfilled => "gap_unfilled",
            AnomalyKind::InvalidTick => "invalid_tick",
            AnomalyKind::LimitBreach => "limit_breach",
            AnomalyKind::TradeDuringHalt => "trade_during_halt",
            AnomalyKind::CancelUnknown => "cancel_unknown",
            AnomalyKind::CorrectionUnknown => "correction_unknown",
            AnomalyKind::LateCorrection => "late_correction",
            AnomalyKind::SourceConflict => "source_conflict",
            AnomalyKind::BadPrice => "bad_price",
            AnomalyKind::BadVolume => "bad_volume",
            AnomalyKind::OrderRejected => "order_rejected",
            AnomalyKind::HaltBegin => "halt_begin",
            AnomalyKind::HaltEnd => "halt_end",
            AnomalyKind::TradeCanceled => "trade_canceled",
            AnomalyKind::TradeCorrected => "trade_corrected",
        }
    }

    pub fn severity(&self) -> Severity {
        match self {
            AnomalyKind::PriceJump
            | AnomalyKind::VolumeSpike
            | AnomalyKind::TimestampInversion
            | AnomalyKind::OutOfSession
            | AnomalyKind::DuplicateSeq
            | AnomalyKind::GapUnfilled
            | AnomalyKind::InvalidTick
            | AnomalyKind::LimitBreach
            | AnomalyKind::TradeDuringHalt
            | AnomalyKind::BadPrice
            | AnomalyKind::BadVolume
            | AnomalyKind::CorrectionUnknown => Severity::Error,
            AnomalyKind::SeqGap
            | AnomalyKind::CancelUnknown
            | AnomalyKind::LateCorrection
            | AnomalyKind::SourceConflict => Severity::Warn,
            AnomalyKind::SeqGapFilled
            | AnomalyKind::HaltBegin
            | AnomalyKind::HaltEnd
            | AnomalyKind::OrderRejected
            | AnomalyKind::TradeCanceled
            | AnomalyKind::TradeCorrected => Severity::Info,
        }
    }

    pub fn action(&self) -> &'static str {
        match self {
            AnomalyKind::PriceJump
            | AnomalyKind::VolumeSpike
            | AnomalyKind::TimestampInversion
            | AnomalyKind::OutOfSession
            | AnomalyKind::InvalidTick
            | AnomalyKind::LimitBreach
            | AnomalyKind::TradeDuringHalt
            | AnomalyKind::BadPrice
            | AnomalyKind::BadVolume => "isolated",
            AnomalyKind::SeqGapFilled => "filled",
            AnomalyKind::DuplicateSeq
            | AnomalyKind::CancelUnknown
            | AnomalyKind::CorrectionUnknown
            | AnomalyKind::LateCorrection
            | AnomalyKind::SourceConflict
            | AnomalyKind::SeqGap
            | AnomalyKind::GapUnfilled
            | AnomalyKind::OrderRejected
            | AnomalyKind::HaltBegin
            | AnomalyKind::HaltEnd
            | AnomalyKind::TradeCanceled
            | AnomalyKind::TradeCorrected => "kept",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anomaly {
    pub id: String,
    pub ts: i64,
    pub symbol: String,
    pub source: String,
    pub kind: AnomalyKind,
    pub severity: Severity,
    pub detail: String,
    pub trade_id: Option<String>,
    pub seq: Option<u64>,
    pub action: String,
    /// 关联 bar 标签时间（若已定位到 bar）
    pub bar_t: Option<i64>,
    /// 被隔离的成交是否已被后续冲正反转
    #[serde(default)]
    pub reversed: bool,
}
