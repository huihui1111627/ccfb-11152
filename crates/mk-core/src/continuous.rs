//! 主力合约切换与连续合约（rules.md R60–R63）。

use crate::bar::Bar;
use crate::fixed::{mul_div, SCALE};
use crate::time::ms_to_date_string;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MainRecord {
    pub date: String,
    pub contract: String,
    pub oi: u64,
    pub volume: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollEvent {
    pub date: String,
    pub from: String,
    pub to: String,
    /// ratio = close_new(d-1) / close_old(d-1)
    #[serde(serialize_with = "crate::fixed::ser_4dp")]
    pub ratio: i64,
    #[serde(serialize_with = "crate::fixed::ser_4dp")]
    pub old_close: i64,
    #[serde(serialize_with = "crate::fixed::ser_4dp")]
    pub new_close: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinuousBar {
    pub t: i64,
    pub date: String,
    pub contract: String,
    /// 原始价格
    #[serde(serialize_with = "crate::fixed::ser_4dp")]
    pub o: i64,
    #[serde(rename = "h", serialize_with = "crate::fixed::ser_4dp")]
    pub high: i64,
    #[serde(rename = "l", serialize_with = "crate::fixed::ser_4dp")]
    pub low: i64,
    #[serde(rename = "c", serialize_with = "crate::fixed::ser_4dp")]
    pub close: i64,
    pub v: u64,
    pub oi: u64,
    /// 复权后价格（以最新合约为基准）
    #[serde(rename = "o_adj", serialize_with = "crate::fixed::ser_4dp")]
    pub o_adj: i64,
    #[serde(rename = "h_adj", serialize_with = "crate::fixed::ser_4dp")]
    pub h_adj: i64,
    #[serde(rename = "l_adj", serialize_with = "crate::fixed::ser_4dp")]
    pub l_adj: i64,
    #[serde(rename = "c_adj", serialize_with = "crate::fixed::ser_4dp")]
    pub c_adj_fixed: i64,
    pub roll: bool,
}

impl ContinuousBar {
    pub fn c_adj(&self) -> f64 {
        crate::fixed::round4(self.c_adj_fixed)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContinuousSeries {
    pub main: Vec<MainRecord>,
    pub rolls: Vec<RollEvent>,
    pub bars: Vec<ContinuousBar>,
}

/// 按持仓量确定主力合约（R60/R61）。
///
/// 输入：每个 (交易日, 合约) 的 (oi, volume)。当前主力在新候选持仓超过其 5%
/// 且连续 2 个交易日满足时于**次日**切换；主力持仓为 0 或合约到期则立即切换。
/// 实现见 [`build_main`]。
pub fn build_main(
    trading_days: &[String],
    contracts: &[String],
    oi: &dyn Fn(&str, &str) -> Option<(u64, u64)>,
) -> Vec<MainRecord> {
    let mut mains: Vec<MainRecord> = Vec::new();
    let mut current: Option<String> = None;
    let mut challenger: Option<(String, usize)> = None;

    for d in trading_days {
        let mut cands: Vec<(String, u64, u64)> = contracts
            .iter()
            .filter_map(|c| oi(d, c).map(|(o, v)| (c.clone(), o, v)))
            .filter(|(_, o, _)| *o > 0)
            .collect();
        cands.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let top = cands.first().cloned();

        let chosen = match (&current, &top) {
            (None, Some((c, _, _))) => Some(c.clone()),
            (Some(cur), Some((c, o, _))) => {
                if c == cur {
                    challenger = None;
                    Some(cur.clone())
                } else {
                    let cur_oi = oi(d, cur).map(|(o, _)| o).unwrap_or(0);
                    let better = cur_oi == 0 || (*o as f64) > cur_oi as f64 * 1.05;
                    if !better {
                        challenger = None;
                        Some(cur.clone())
                    } else {
                        let streak = match &challenger {
                            Some((cc, n)) if cc == c => n + 1,
                            _ => 1,
                        };
                        challenger = Some((c.clone(), streak));
                        if streak >= 2 || cur_oi == 0 {
                            challenger = None;
                            Some(c.clone())
                        } else {
                            Some(cur.clone())
                        }
                    }
                }
            }
            (Some(cur), None) => Some(cur.clone()),
            (None, None) => None,
        };

        if let Some(ch) = chosen {
            let (o, v) = oi(d, &ch).unwrap_or((0, 0));
            current = Some(ch.clone());
            mains.push(MainRecord { date: d.clone(), contract: ch, oi: o, volume: v });
        }
    }
    mains
}

/// 由主力序列 + 各合约日线构造连续合约（R62）。
pub fn build_continuous(
    mains: &[MainRecord],
    daily: &dyn Fn(&str, &str) -> Option<Bar>,
) -> ContinuousSeries {
    let mut rolls = Vec::new();
    for w in mains.windows(2) {
        let (prev, cur) = (&w[0], &w[1]);
        if prev.contract != cur.contract {
            let old_close = daily(&prev.date, &prev.contract).map(|b| b.close);
            let new_close = daily(&prev.date, &cur.contract).map(|b| b.close);
            if let (Some(oc), Some(nc)) = (old_close, new_close) {
                if oc != 0 {
                    let ratio = ((nc as i128 * SCALE as i128) / oc as i128) as i64;
                    rolls.push(RollEvent {
                        date: cur.date.clone(),
                        from: prev.contract.clone(),
                        to: cur.contract.clone(),
                        ratio,
                        old_close: oc,
                        new_close: nc,
                    });
                }
            }
        }
    }

    // 每个交易日之后累计的 ratio 乘积（用于把老合约价格换算到最新合约口径）
    let mut bars = Vec::new();
    for (i, m) in mains.iter().enumerate() {
        let Some(bar) = daily(&m.date, &m.contract) else { continue };
        let mut adj = SCALE;
        // 只对“该 bar 之后发生的切换”做复权（即以最新合约口径表达历史价格）
        for r in rolls.iter().filter(|r| r.date.as_str() > m.date.as_str()) {
            adj = mul_div(adj, r.ratio);
        }
        let roll_today = rolls.iter().any(|r| r.date == m.date);
        bars.push(ContinuousBar {
            t: bar.t,
            date: ms_to_date_string(bar.t),
            contract: m.contract.clone(),
            o: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            v: bar.volume,
            oi: m.oi,
            o_adj: mul_div(bar.open, adj),
            h_adj: mul_div(bar.high, adj),
            l_adj: mul_div(bar.low, adj),
            c_adj_fixed: mul_div(bar.close, adj),
            roll: roll_today,
        });
        let _ = i;
    }
    ContinuousSeries { main: mains.to_vec(), rolls, bars }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_requires_two_days() {
        let days: Vec<String> = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let contracts = vec!["rb2601".to_string(), "rb2605".to_string()];
        let oi = |d: &str, c: &str| -> Option<(u64, u64)> {
            let v = match (d, c) {
                ("2026-03-02", "rb2601") => (200_000, 100),
                ("2026-03-02", "rb2605") => (150_000, 100),
                ("2026-03-03", "rb2601") => (180_000, 100),
                ("2026-03-03", "rb2605") => (200_000, 100),
                ("2026-03-04", "rb2601") => (170_000, 100),
                ("2026-03-04", "rb2605") => (210_000, 100),
                ("2026-03-05", "rb2601") => (160_000, 100),
                ("2026-03-05", "rb2605") => (220_000, 100),
                _ => return None,
            };
            Some(v)
        };
        let mains = build_main(&days, &contracts, &oi);
        assert_eq!(mains[0].contract, "rb2601");
        assert_eq!(mains[1].contract, "rb2601", "首日超过但仅 1 天，不切");
        assert_eq!(mains[2].contract, "rb2605", "连续 2 日超过 5% → 切");
    }
}
