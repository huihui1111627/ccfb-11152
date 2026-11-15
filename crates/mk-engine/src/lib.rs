//! 行情加工引擎。
//!
//! 数据流（每个 symbol 独立）：
//! ```text
//! RawMessage 流
//!   └─ ingest   去重、多源合并、序号缺口补全        (merge.rs)
//!   └─ validate 时间戳/时段/跳变/停牌/涨跌停 判定与隔离 (validate.rs)
//!   └─ build    1m bar 归属、冲正账本、重算          (builder.rs)
//!   └─ agg      1m → 5/15/30/60/1d               (aggregate.rs)
//! ```
//!
//! 批处理语义：先全量 ingest 得到“规范化成交事件”，再按消息序号顺序回放，
//! 冲正会重算受影响的 1m bar 并向上重聚合。这样乱序/迟到的冲正也能正确传导。

pub mod aggregate;
pub mod builder;
pub mod config;
pub mod engine;
pub mod merge;
pub mod metrics;
pub mod validate;

pub use config::{EngineConfig, InstrumentPolicy};
pub use engine::{Engine, EngineOutput, SymbolOutput};
