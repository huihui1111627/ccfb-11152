//! 定点数工具与 tick/精度换算。

use serde::Serializer;

/// 内部定点 scale：1e4。
pub const SCALE: i64 = 10_000;
pub const SCALE_F: f64 = 10_000.0;

/// 解析十进制字符串/数字为定点 i64（四舍五入到 1e-4）。
pub fn parse_dec(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let neg = s.starts_with('-');
    let body = s.trim_start_matches(['-', '+']);
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f),
        None => (body, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    let int_v: i64 = if int_part.is_empty() { 0 } else { int_part.parse().ok()? };
    let mut frac = String::from(frac_part);
    if frac.len() > 4 {
        // 第 5 位四舍五入
        let round_up = frac.as_bytes().get(4).map(|c| *c >= b'5').unwrap_or(false);
        frac.truncate(4);
        let f: i64 = format!("{:0<4}", frac).parse().ok()?;
        let mut v = int_v * SCALE + f;
        if round_up {
            v += 1;
        }
        return Some(if neg { -v } else { v });
    }
    let f: i64 = format!("{:0<4}", frac).parse().ok()?;
    let v = int_v * SCALE + f;
    Some(if neg { -v } else { v })
}

/// f64 → 定点（四舍五入）。
pub fn from_f64(v: f64) -> i64 {
    (v * SCALE_F).round() as i64
}

/// 定点 → f64。
pub fn to_f64(v: i64) -> f64 {
    v as f64 / SCALE_F
}

/// 按 tick（同样定点）对齐，四舍五入到最近的合法价位。
pub fn round_to_tick(price_fixed: i64, tick_fixed: i64) -> i64 {
    if tick_fixed <= 0 {
        return price_fixed;
    }
    let n = (price_fixed as f64 / tick_fixed as f64).round() as i64;
    n * tick_fixed
}

/// 判断价格是否落在 tick 网格上（定点整除）。
pub fn tick_align(price_fixed: i64, tick_fixed: i64) -> bool {
    tick_fixed > 0 && price_fixed % tick_fixed == 0
}

/// 序列化定点为 4 位小数的 JSON 数字。
pub fn ser_4dp<S: Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(round4(*v))
}

pub fn round4(v: i64) -> f64 {
    (v as f64 / SCALE_F * 10_000.0).round() / 10_000.0
}

/// 序列化定点为 8 位小数的 JSON 数字（用于因子）。
pub fn ser_8dp<S: Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(round8(*v))
}

pub fn round8(v: i64) -> f64 {
    (v as f64 / SCALE_F * 100_000_000.0).round() / 100_000_000.0
}

/// 定点乘除：a * b / SCALE，带四舍五入。
pub fn mul_div(a: i64, b: i64) -> i64 {
    mul_div_r(a, b, SCALE)
}

/// a * b / denom，带四舍五入（denom > 0）。
pub fn mul_div_r(a: i64, b: i64, denom: i64) -> i64 {
    let prod = a as i128 * b as i128;
    let half = denom as i128 / 2;
    ((prod + if prod >= 0 { half } else { -half }) / denom as i128) as i64
}

/// 涨跌停价：按 tick 四舍五入到最小价位。
pub fn limit_price(prev_close: i64, pct_fixed: i64, tick: i64) -> (i64, i64) {
    let up_raw = (prev_close as i128 * (SCALE as i128 + pct_fixed as i128) / SCALE as i128) as i64;
    let dn_raw = (prev_close as i128 * (SCALE as i128 - pct_fixed as i128) / SCALE as i128) as i64;
    let up = round_to_tick(up_raw, tick);
    let dn = round_to_tick(dn_raw, tick);
    (dn, up)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dec_basic() {
        assert_eq!(parse_dec("10.01"), Some(100_100));
        assert_eq!(parse_dec("10"), Some(100_000));
        assert_eq!(parse_dec("0.5"), Some(5_000));
        assert_eq!(parse_dec("-1.2345"), Some(-12_345));
        assert_eq!(parse_dec("1.23456"), Some(12_346));
    }

    #[test]
    fn tick_rounding() {
        assert_eq!(round_to_tick(100_100, 100), 100_100);
        assert_eq!(round_to_tick(100_150, 100), 100_200);
        assert!(tick_align(100_100, 100));
        assert!(!tick_align(100_050, 100));
    }
}
