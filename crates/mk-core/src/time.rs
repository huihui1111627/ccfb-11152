//! 时间工具。
//!
//! 约定（见 docs/api.md）：对外所有时间戳都是“本地时间戳”——把交易所本地时间
//! （UTC+8，无夏令时）当作 UTC 换算成 epoch 毫秒。这样 `chrono` 的
//! `NaiveDateTime::and_utc()` 就是唯一正确的换算方式，前端用 `getUTC*` 即可展示。

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};

pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MS: i64 = 86_400_000;

/// 从 `YYYY-MM-DD HH:MM:SS[.mmm]` 的本地时间得到本地时间戳。
pub fn ts_from_local(s: &str) -> Option<i64> {
    let s = s.trim();
    let fmt = if s.len() >= 19 { "%Y-%m-%d %H:%M:%S" } else { "%Y-%m-%d %H:%M" };
    let base = NaiveDateTime::parse_from_str(&s[..19.min(s.len())], fmt).ok()?;
    let frac_ms = if s.len() > 20 {
        let frac = &s[20..];
        let digits: String = frac.chars().take(3).collect();
        let digits = format!("{:0<3}", digits);
        digits.parse::<i64>().ok()?
    } else {
        0
    };
    Some(base.and_utc().timestamp_millis() + frac_ms)
}

/// 本地日期 `YYYY-MM-DD` 的零点时间戳。
pub fn ts_of_date(date: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    let dt = d.and_hms_opt(0, 0, 0)?;
    Some(dt.and_utc().timestamp_millis())
}

/// 本地时间戳 → `YYYY-MM-DD`。
pub fn ms_to_date_string(ms: i64) -> String {
    let dt = local_dt(ms);
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// 本地时间戳 → `HH:MM:SS.mmm`。
pub fn ms_to_hm(ms: i64) -> String {
    let dt = local_dt(ms);
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        dt.hour(),
        dt.minute(),
        dt.second(),
        ms.rem_euclid(1000)
    )
}

/// 本地时间戳 → `HH:MM`。
pub fn hm_of(ms: i64) -> String {
    let dt = local_dt(ms);
    format!("{:02}:{:02}", dt.hour(), dt.minute())
}

/// 本地时间戳 → `YYYY-MM-DD HH:MM:SS`。
pub fn ms_to_iso_string(ms: i64) -> String {
    format!("{} {}", ms_to_date_string(ms), {
        let dt = local_dt(ms);
        format!("{:02}:{:02}:{:02}", dt.hour(), dt.minute(), dt.second())
    })
}

pub fn local_dt(ms: i64) -> NaiveDateTime {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("timestamp out of range")
        .naive_utc()
}

pub fn ms_add_minutes(ms: i64, minutes: i64) -> i64 {
    ms + minutes * MINUTE_MS
}

/// 解析 `YYYY-MM-DD` 为 NaiveDate。
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// 日期的下一个/上一个自然日字符串。
pub fn shift_date(date: &str, days: i64) -> String {
    let d = parse_date(date).expect("valid date");
    let nd = d + chrono::Duration::days(days);
    format!("{:04}-{:02}-{:02}", nd.year(), nd.month(), nd.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_ts_matches_contract() {
        assert_eq!(ts_from_local("2026-03-02 09:31:00"), Some(1_772_443_860_000));
        assert_eq!(ts_from_local("2026-03-02 15:00:00"), Some(1_772_463_600_000));
    }

    #[test]
    fn formats() {
        assert_eq!(ms_to_hm(1_772_443_860_000), "09:31:00.000");
        assert_eq!(hm_of(1_772_443_860_000), "09:31");
        assert_eq!(ms_to_date_string(1_772_443_860_000), "2026-03-02");
    }
}
