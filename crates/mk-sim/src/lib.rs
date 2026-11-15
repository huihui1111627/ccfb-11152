//! 行情仿真器：生成贴近真实交易所规则的多源逐笔/快照数据，并注入可控异常。
//!
//! 输出目录结构：
//! ```text
//! out/
//!   dataset.json            # DatasetMeta（品种、日历、昨收、除权事件、停牌计划、注入异常清单）
//!   messages/<symbol>.jsonl # 原始消息（多源，含 seq）
//!   golden/*.json           # 金标准用例（手算边界 K 线）
//! ```

pub mod anomalies;
pub mod golden;
pub mod inject;
pub mod rng;
pub mod sim;

pub use sim::{SimConfig, Simulator};

/// 生成器版本（写进 dataset.json）。
pub const SIM_VERSION: &str = "0.1.0";
