//! 定点数、时间与 tick 约束。
//!
//! 引擎内部所有价格/金额用 i64 定点（scale 1e4），避免浮点误差；
//! 输出 JSON 时再转换成 f64（保留 4 位小数）。

pub mod time;
pub mod calendar;
pub mod fixed;
pub mod schedule;
pub mod instrument;
pub mod message;
pub mod period;
pub mod bar;
pub mod anomaly;
pub mod factor;
pub mod continuous;
pub mod dataset;
pub mod error;

pub use anomaly::{Anomaly, AnomalyKind, Severity};
pub use bar::{Bar, BarFlags};
pub use continuous::{ContinuousBar, ContinuousSeries, MainRecord, RollEvent};
pub use dataset::Dataset;
pub use error::{CoreError, Result};
pub use factor::{CorporateAction, FactorRow, FactorSeries, FactorSet};
pub use fixed::{parse_dec, round_to_tick, ser_4dp, ser_8dp, tick_align};
pub use instrument::{AssetClass, Instrument, Exchange, Product};
pub use message::{CorrectionAction, MsgKind, Order, OrderStatus, RawMessage, Side, Snapshot, Trade};
pub use period::{Period, Window};
pub use schedule::{Calendar, Segment, SegmentKind, SessionDay, TradingSchedule, TradingScheduleId};
pub use time::{hm_of, ms_add_minutes, ms_to_date_string, ms_to_hm, ms_to_iso_string, parse_date, ts_from_local};
