//! 除权除息因子（rules.md R30–R33）。
//!
//! 精度：q 与复权因子用 **1e8 定点**（`FSCALE`），价格用 1e4 定点（`SCALE`）。

use crate::fixed::{round4, SCALE};
use serde::{Deserialize, Serialize};

pub const FSCALE: i64 = 100_000_000;
pub const FSCALE_F: f64 = 100_000_000.0;

/// 1e-8 定点除法的四舍五入。
pub fn f_div(a: i128, b: i128) -> i64 {
    if b == 0 {
        return FSCALE;
    }
    let half = if b > 0 { b / 2 } else { -b / 2 };
    ((a + half) / b) as i64
}

pub fn f_mul(a: i64, b: i64) -> i64 {
    f_div(a as i128 * b as i128, FSCALE as i128)
}

pub fn to_f8(v: i64) -> f64 {
    (v as f64 / FSCALE_F * 1e8).round() / 1e8
}

fn ser_f8<S: serde::Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(to_f8(*v))
}
fn ser_4<S: serde::Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(round4(*v))
}

/// 一次除权除息事件（每股口径）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorporateAction {
    /// 除权除息日（该日起按新价交易）
    pub ex_date: String,
    /// 每股现金红利（元）
    pub cash_div: f64,
    /// 每股送股（股）
    pub bonus: f64,
    /// 每股配股（股）
    pub rights: f64,
    /// 配股价（元）
    pub rights_price: f64,
    /// 除权前收盘价（元）
    pub prev_close: f64,
    #[serde(default)]
    pub note: String,
}

impl CorporateAction {
    /// q = (P - D + R·RP) / (P·(1 + B + R))，返回 1e8 定点。
    pub fn q(&self) -> i64 {
        // 全部换算成 1e8 单位的整数做精确运算
        let f = |v: f64| (v * FSCALE_F).round() as i128;
        let p = f(self.prev_close);
        let d = f(self.cash_div);
        let r = f(self.rights);
        let rp = f(self.rights_price);
        let b = f(self.bonus);
        // num = P - D + R*RP/FSCALE   （1e8 单位）
        let num = p - d + f_div(r * rp, FSCALE as i128) as i128;
        // den = P * (FSCALE + B + R) / FSCALE
        let den = f_div(p * (FSCALE as i128 + b + r), FSCALE as i128) as i128;
        f_div(num * FSCALE as i128, den).max(0)
    }

    /// 除权参考价（交易所口径）= prev_close × q，返回 1e4 定点。
    pub fn p_ex(&self, q: i64) -> i64 {
        let p = (self.prev_close * SCALE as f64).round() as i128;
        (((p * q as i128) + FSCALE as i128 / 2) / FSCALE as i128) as i64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactorRow {
    pub ex_date: String,
    pub cash_div: f64,
    pub bonus: f64,
    pub rights: f64,
    pub rights_price: f64,
    pub prev_close: f64,
    /// 除权因子 q（1e8）
    #[serde(serialize_with = "ser_f8")]
    pub q: i64,
    /// 除权参考价（1e4）
    #[serde(serialize_with = "ser_4")]
    pub p_ex: i64,
    /// 前复权因子（除权日当天及以后 = 1）
    #[serde(serialize_with = "ser_f8")]
    pub forward_factor: i64,
    #[serde(serialize_with = "ser_f8")]
    pub backward_factor: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactorSeries {
    pub date: String,
    #[serde(serialize_with = "ser_f8")]
    pub forward: i64,
    #[serde(serialize_with = "ser_f8")]
    pub backward: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FactorSet {
    pub rows: Vec<FactorRow>,
    pub series: Vec<FactorSeries>,
}

impl FactorSet {
    /// 前复权：基准为**最新交易日**，`forward(t) = Π_{ex_date > t} q`
    /// 后复权：基准为**最早交易日**，`backward(t) = Π_{ex_date <= t} 1/q`
    pub fn build(actions: &[CorporateAction], trading_days: &[String]) -> Self {
        let mut acts: Vec<&CorporateAction> = actions.iter().collect();
        acts.sort_by(|a, b| a.ex_date.cmp(&b.ex_date));
        let mut rows = Vec::new();
        for (i, a) in acts.iter().enumerate() {
            let q = a.q();
            let p_ex = a.p_ex(q);
            let mut fwd = FSCALE;
            for later in acts.iter().skip(i + 1) {
                fwd = f_mul(fwd, later.q());
            }
            let mut bwd = FSCALE;
            for upto in acts.iter().take(i + 1) {
                bwd = f_mul(bwd, inv_q(upto.q()));
            }
            rows.push(FactorRow {
                ex_date: a.ex_date.clone(),
                cash_div: a.cash_div,
                bonus: a.bonus,
                rights: a.rights,
                rights_price: a.rights_price,
                prev_close: a.prev_close,
                q,
                p_ex,
                forward_factor: fwd,
                backward_factor: bwd,
                note: a.note.clone(),
            });
        }
        let mut series = Vec::new();
        for d in trading_days {
            let mut fwd = FSCALE;
            for a in acts.iter() {
                if a.ex_date.as_str() > d.as_str() {
                    fwd = f_mul(fwd, a.q());
                }
            }
            let mut bwd = FSCALE;
            for a in acts.iter() {
                if a.ex_date.as_str() <= d.as_str() {
                    bwd = f_mul(bwd, inv_q(a.q()));
                }
            }
            series.push(FactorSeries { date: d.clone(), forward: fwd, backward: bwd });
        }
        Self { rows, series }
    }

    pub fn forward_for(&self, date: &str) -> i64 {
        self.series.iter().find(|s| s.date == date).map(|s| s.forward).unwrap_or(FSCALE)
    }
    pub fn backward_for(&self, date: &str) -> i64 {
        self.series.iter().find(|s| s.date == date).map(|s| s.backward).unwrap_or(FSCALE)
    }

    /// 对 1e4 定点价格应用 1e8 因子。
    pub fn apply(price: i64, factor: i64) -> i64 {
        (((price as i128 * factor as i128) + FSCALE as i128 / 2) / FSCALE as i128) as i64
    }
}

/// 1/q（1e8 定点）。
pub fn inv_q(q: i64) -> i64 {
    f_div(FSCALE as i128 * FSCALE as i128, q as i128)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action() -> CorporateAction {
        CorporateAction {
            ex_date: "2026-03-04".into(),
            cash_div: 0.35,
            bonus: 0.3,
            rights: 0.1,
            rights_price: 5.0,
            prev_close: 10.5,
            note: String::new(),
        }
    }

    #[test]
    fn q_formula() {
        // 除权参考价 = (10.50 - 0.35 + 0.1×5) / (1 + 0.3 + 0.1) = 10.65/1.4 = 7.607142857
        // q = 7.607142857/10.50 = 0.7244897959
        let a = action();
        assert!((to_f8(a.q()) - 0.7244898).abs() < 5e-8, "q={}", to_f8(a.q()));
        assert!((round4(a.p_ex(a.q())) - 7.6071).abs() < 1e-4);
    }

    #[test]
    fn ex_price_cash_only() {
        let a = CorporateAction { cash_div: 2.0, bonus: 0.0, rights: 0.0, rights_price: 0.0, prev_close: 100.0, ..action() };
        assert!((to_f8(a.q()) - 0.98).abs() < 1e-9);
    }

    #[test]
    fn forward_backward() {
        let days = vec!["2026-03-02".to_string(), "2026-03-04".to_string()];
        let set = FactorSet::build(&[action()], &days);
        // 除权前：前复权因子 = q
        assert!((to_f8(set.forward_for("2026-03-02")) - 0.7244898).abs() < 5e-8);
        assert!((to_f8(set.forward_for("2026-03-04")) - 1.0).abs() < 1e-9);
        assert!((to_f8(set.backward_for("2026-03-02")) - 1.0).abs() < 1e-9);
        // 后复权因子 = 1/q = 1.38028169
        assert!((to_f8(set.backward_for("2026-03-04")) - 1.38028169).abs() < 1e-7);
        // 复权价：7.6071 * 1.38028169 = 10.50
        let adj = FactorSet::apply((7.6071 * SCALE as f64).round() as i64, set.backward_for("2026-03-04"));
        assert!((round4(adj) - 10.50).abs() < 1e-4);
    }
}
