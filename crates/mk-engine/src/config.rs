//! 引擎配置与告警阈值。

use mk_core::fixed::parse_dec;
use serde::{Deserialize, Serialize};

/// 单品种的策略参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentPolicy {
    /// 价格跳变阈值（相对参考价的百分比，如 0.05）
    pub jump_pct: f64,
    /// 成交量异常绝对下限（股 / 手）
    pub spike_min_volume: u64,
    /// 成交量异常回看窗口（笔）
    pub spike_window: usize,
    /// 成交量异常倍数
    pub spike_multiple: u64,
    /// 超过多少个序号才视为迟到冲正
    pub late_correction_seq_gap: u64,
    /// 空 bar 策略
    pub empty_bar_policy: EmptyBarPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmptyBarPolicy {
    /// 无成交不生成 bar
    Omit,
    /// 用前收填充（o=h=l=c=前收，量 0）
    Fill,
}

impl Default for InstrumentPolicy {
    fn default() -> Self {
        Self {
            jump_pct: 0.05,
            spike_min_volume: 1_000_000,
            spike_window: 64,
            spike_multiple: 100,
            late_correction_seq_gap: 4096,
            empty_bar_policy: EmptyBarPolicy::Omit,
        }
    }
}

impl InstrumentPolicy {
    pub fn jump_fixed(&self) -> i64 {
        parse_dec(&format!("{:.4}", self.jump_pct)).unwrap_or(500)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub policy: InstrumentPolicy,
    /// 期货的跳变阈值单独放宽（2%）
    pub future_jump_pct: f64,
    pub future_spike_min_volume: u64,
    /// 主力切换的持仓量优势阈值
    pub roll_oi_advantage: f64,
    /// 主力切换需连续满足的天数
    pub roll_confirm_days: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            policy: InstrumentPolicy::default(),
            future_jump_pct: 0.02,
            future_spike_min_volume: 5_000,
            roll_oi_advantage: 0.05,
            roll_confirm_days: 2,
        }
    }
}

impl EngineConfig {
    pub fn for_instrument(&self, is_future: bool) -> InstrumentPolicy {
        let mut p = self.policy.clone();
        if is_future {
            p.jump_pct = self.future_jump_pct;
            p.spike_min_volume = self.future_spike_min_volume;
        }
        p
    }
}
