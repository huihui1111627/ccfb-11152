//! 周期聚合：1m → 5/15/30/60/1d（rules.md R10/R70）。
//!
//! 所有高周期都由 1m bar 聚合，保证跨周期恒等：
//! `Σ1m.v == 5m.v == 15m.v == ... == 1d.v`。

use mk_core::bar::{Bar, BarFlags};
use mk_core::period::{label_window, session_windows, Period, Window};
use mk_core::SessionDay;

/// 把一个交易日的 1m bar 聚合到指定周期。
///
/// `windows` 为该周期当日全部窗口（含空窗口）。空窗口在 `fill` 策略下用
/// 前一周期收盘价填充；`omit` 策略下跳过。
pub fn aggregate_bars(
    day: &SessionDay,
    minute_bars: &[Bar],
    period: Period,
    fill_empty: bool,
) -> Vec<Bar> {
    if period == Period::Min1 {
        return minute_bars.to_vec();
    }
    if period == Period::Day {
        return daily_bar(day, minute_bars).into_iter().collect();
    }
    let windows = session_windows(day, period);
    let mut out: Vec<Bar> = Vec::with_capacity(windows.len());
    let mut buckets: Vec<Vec<&Bar>> = vec![Vec::new(); windows.len()];
    for b in minute_bars {
        if let Some(i) = label_window(&windows, b.t) {
            buckets[i].push(b);
        }
    }
    let mut prev_close: Option<i64> = None;
    for (i, w) in windows.iter().enumerate() {
        if buckets[i].is_empty() {
            if fill_empty {
                let px = prev_close.unwrap_or(0);
                if px > 0 {
                    let mut b = Bar::new(w.label, day.trade_date.clone(), period);
                    b.open = px;
                    b.high = px;
                    b.low = px;
                    b.close = px;
                    b.flags = BarFlags::default().with(BarFlags::EMPTY_FILL);
                    out.push(b);
                }
            }
            continue;
        }
        let b = merge_window(minute_bars, &buckets[i], *w, period, &day.trade_date);
        prev_close = Some(b.close);
        out.push(b);
    }
    out
}

/// 合并同一窗口内的 1m bar。
fn merge_window(
    all_minute: &[Bar],
    parts: &[&Bar],
    w: Window,
    period: Period,
    trade_date: &str,
) -> Bar {
    let _ = all_minute;
    let first = parts.first().unwrap();
    let last = parts.last().unwrap();
    let mut b = Bar::new(w.label, trade_date.to_string(), period);
    b.open = first.open;
    b.close = last.close;
    b.high = parts.iter().map(|x| x.high).max().unwrap_or(0);
    b.low = parts.iter().map(|x| x.low).min().unwrap_or(0);
    b.volume = parts.iter().map(|x| x.volume).sum();
    b.turnover = parts.iter().map(|x| x.turnover).sum();
    b.count = parts.iter().map(|x| x.count).sum();
    b.buy_volume = parts.iter().map(|x| x.buy_volume).sum();
    b.sell_volume = parts.iter().map(|x| x.sell_volume).sum();
    b.auction_volume = parts.iter().map(|x| x.auction_volume).sum();
    b.synthetic_volume = parts.iter().map(|x| x.synthetic_volume).sum();
    b.canceled_volume = parts.iter().map(|x| x.canceled_volume).sum();
    b.seq0 = parts.iter().filter(|x| x.seq0 > 0).map(|x| x.seq0).min().unwrap_or(0);
    b.seq1 = parts.iter().map(|x| x.seq1).max().unwrap_or(0);
    b.oi = parts.iter().rev().find_map(|x| x.oi);
    let mut flags = BarFlags::default();
    for p in parts {
        flags = BarFlags(flags.0 | p.flags.0);
    }
    b.flags = flags;
    b
}

/// 日线：当日全部 1m bar 的聚合。
pub fn daily_bar(day: &SessionDay, minute_bars: &[Bar]) -> Option<Bar> {
    let bars: Vec<&Bar> = minute_bars
        .iter()
        .filter(|b| b.trade_date == day.trade_date)
        .collect();
    if bars.is_empty() {
        return None;
    }
    let first = bars.first().unwrap();
    let last = bars.last().unwrap();
    let end = day
        .segments
        .iter()
        .map(|s| s.end)
        .max()
        .unwrap_or(last.t);
    let mut b = Bar::new(end, day.trade_date.clone(), Period::Day);
    b.open = first.open;
    b.close = last.close;
    b.high = bars.iter().map(|x| x.high).max().unwrap_or(0);
    b.low = bars.iter().map(|x| x.low).min().unwrap_or(0);
    b.volume = bars.iter().map(|x| x.volume).sum();
    b.turnover = bars.iter().map(|x| x.turnover).sum();
    b.count = bars.iter().map(|x| x.count).sum();
    b.buy_volume = bars.iter().map(|x| x.buy_volume).sum();
    b.sell_volume = bars.iter().map(|x| x.sell_volume).sum();
    b.auction_volume = bars.iter().map(|x| x.auction_volume).sum();
    b.synthetic_volume = bars.iter().map(|x| x.synthetic_volume).sum();
    b.canceled_volume = bars.iter().map(|x| x.canceled_volume).sum();
    b.seq0 = bars.iter().filter(|x| x.seq0 > 0).map(|x| x.seq0).min().unwrap_or(0);
    b.seq1 = bars.iter().map(|x| x.seq1).max().unwrap_or(0);
    b.oi = bars.iter().rev().find_map(|x| x.oi);
    let mut flags = BarFlags::default();
    for p in &bars {
        flags = BarFlags(flags.0 | p.flags.0);
    }
    b.flags = flags;
    Some(b)
}

/// 连续合约需要日线（取主力合约的当日日线）。
pub fn daily_from_minutes(day: &SessionDay, minute_bars: &[Bar]) -> Option<Bar> {
    daily_bar(day, minute_bars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mk_core::schedule::{TradingSchedule, TradingScheduleId};

    fn mk_bar(t: i64, px: i64, v: u64, d: &str) -> Bar {
        let mut b = Bar::new(t, d.into(), Period::Min1);
        b.open = px;
        b.high = px + 10;
        b.low = px - 10;
        b.close = px + 5;
        b.volume = v;
        b.turnover = px * v as i64;
        b.count = 1;
        b.seq0 = 1;
        b.seq1 = 1;
        b
    }

    #[test]
    fn five_min_reconciles_with_minutes() {
        let day = TradingSchedule::new(
            TradingScheduleId::EquityCn,
            TradingSchedule::default_calendar(),
        )
        .session_day("2026-03-02", None)
        .unwrap();
        let w1 = session_windows(&day, Period::Min1);
        let bars: Vec<Bar> = w1
            .iter()
            .enumerate()
            .map(|(i, w)| mk_bar(w.label, 100_000 + i as i64, 100, "2026-03-02"))
            .collect();
        let a5 = aggregate_bars(&day, &bars, Period::Min5, false);
        assert_eq!(a5.len(), 48);
        let a1d = aggregate_bars(&day, &bars, Period::Day, false);
        assert_eq!(a1d.len(), 1);
        assert_eq!(a5.iter().map(|b| b.volume).sum::<u64>(), a1d[0].volume);
        assert_eq!(bars.iter().map(|b| b.volume).sum::<u64>(), a1d[0].volume);
    }
}
