//! 应用层：加载数据集、跑引擎、产出所有 API 载荷。
//!
//! CLI 与 HTTP 服务共用这一层，保证两边口径一致。

pub mod model;
pub mod reconcile;
pub mod analysis;

pub use analysis::Analysis;
