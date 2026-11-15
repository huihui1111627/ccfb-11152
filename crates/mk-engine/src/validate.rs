//! 成交合法性校验（rules.md R40–R47）。
//!
//! 纯函数风格：调用方维护参考价/滚动窗口状态，这里只做判定。

use mk_core::{AnomalyKind, Bar, Instrument};

/// 校验结果。
#[derive(Debug, Clone)]
pub struct Reject {
    pub kind: AnomalyKind,
    pub detail: String,
}

/// 价格类校验。
pub fn check_price(
    inst: &Instrument,
    price_fixed: i64,
    volume: u64,
    ref_price: i64,
    jump_fixed: i64,
    limit_dn: Option<i64>,
    limit_up: Option<i64>,
) -> Option<Reject> {
    if price_fixed <= 0 {
        return Some(Reject {
            kind: AnomalyKind::BadPrice,
            detail: format!("成交价 {} 非正", mk_core::fixed::round4(price_fixed)),
        });
    }
    if volume == 0 {
        return Some(Reject {
            kind: AnomalyKind::BadVolume,
            detail: "成交量为 0".to_string(),
        });
    }
    if inst.is_equity() && volume % inst.lot_size != 0 {
        return Some(Reject {
            kind: AnomalyKind::BadVolume,
            detail: format!("股票成交量 {} 不是 {} 股的整数倍", volume, inst.lot_size),
        });
    }
    if !mk_core::fixed::tick_align(price_fixed, inst.price_tick_fixed()) {
        return Some(Reject {
            kind: AnomalyKind::InvalidTick,
            detail: format!(
                "成交价 {:.4} 不是最小变动价位 {} 的整数倍",
                mk_core::fixed::round4(price_fixed),
                inst.price_tick
            ),
        });
    }
    if let (Some(dn), Some(up)) = (limit_dn, limit_up) {
        if price_fixed > up || price_fixed < dn {
            return Some(Reject {
                kind: AnomalyKind::LimitBreach,
                detail: format!(
                    "成交价 {:.4} 超出涨跌停区间 [{:.4}, {:.4}]",
                    mk_core::fixed::round4(price_fixed),
                    mk_core::fixed::round4(dn),
                    mk_core::fixed::round4(up)
                ),
            });
        }
    }
    if ref_price > 0 && jump_fixed > 0 {
        let dev = ((price_fixed - ref_price).abs() as f64) / ref_price as f64;
        if dev > (jump_fixed as f64) / mk_core::fixed::SCALE as f64 {
            return Some(Reject {
                kind: AnomalyKind::PriceJump,
                detail: format!(
                    "成交价 {:.4} 相对参考价 {:.4} 偏离 {:+.2}%，超过阈值 {:.2}%",
                    mk_core::fixed::round4(price_fixed),
                    mk_core::fixed::round4(ref_price),
                    (price_fixed as f64 / ref_price as f64 - 1.0) * 100.0,
                    (jump_fixed as f64) / mk_core::fixed::SCALE as f64 * 100.0
                ),
            });
        }
    }
    None
}

/// 成交量异常：`v > max(min_volume, multiple × median(最近 window 笔))`。
pub fn check_volume_spike(
    volume: u64,
    window: &[u64],
    min_volume: u64,
    multiple: u64,
) -> Option<Reject> {
    // R44：阈值 = max(绝对下限, multiple × 中位数)。
    // 样本不足时**中位数项不可靠**，但绝对下限仍然生效——
    // 否则开盘前几笔的超大成交量（真实的坏数据）会被漏掉。
    let threshold = if window.len() < 8 {
        min_volume
    } else {
        let mut v = window.to_vec();
        v.sort_unstable();
        let median = v[v.len() / 2];
        (median.saturating_mul(multiple)).max(min_volume)
    };
    let median = if window.len() >= 8 {
        let mut v = window.to_vec();
        v.sort_unstable();
        v[v.len() / 2]
    } else {
        0
    };
    if volume > threshold {
        return Some(Reject {
            kind: AnomalyKind::VolumeSpike,
            detail: format!(
                "成交量 {} 超过阈值 {}（近 {} 笔中位数 {} × {}，绝对下限 {}）",
                volume,
                threshold,
                window.len(),
                median,
                multiple,
                min_volume
            ),
        });
    }
    None
}

/// 判断 bar 窗口是否与停牌区间重叠。
pub fn overlaps_halt(bar: &Bar, halts: &[(i64, i64)]) -> bool {
    halts.iter().any(|(s, e)| bar.t > *s && bar.t <= *e)
}
