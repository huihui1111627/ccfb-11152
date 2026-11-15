//! 周期定义与时间窗计算（rules.md R10）。
//!
//! 关键设计：**高周期 bar 一律由 1 分钟 bar 聚合得到**（不是直接对成交再切一次），
//! 这样任意周期之间、周期与日线之间天然一致（R70）。
//! 1 分钟 bar 的构造负责处理时间窗归属、集合竞价挂靠、停牌与冲正。

use crate::schedule::{AuctionAttach, Segment, SegmentKind, SessionDay};
use crate::time::{ms_to_date_string, ms_to_hm, MINUTE_MS};
use serde::{Deserialize, Serialize};

/// bar 时间窗。`(start, end]`，`start_closed = true` 时左边界也包含。
/// `label` 是 bar 的时间标签（结束时间）；集合竞价 bar 的 `label` 与 `end` 可以不同
/// （A 股开盘竞价 `09:15–09:25` 的成交，bar 标签为 `09:30`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub start: i64,
    pub end: i64,
    pub start_closed: bool,
    pub label: i64,
    /// 仅接受集合竞价成交（A 股开盘集合竞价 bar）
    pub auction_only: bool,
}

impl Window {
    pub fn contains(&self, ts: i64) -> bool {
        let in_time = if self.start_closed {
            ts >= self.start && ts <= self.end
        } else {
            ts > self.start && ts <= self.end
        };
        in_time
    }
    pub fn label(&self) -> i64 {
        self.label
    }
    pub fn size_ms(&self) -> i64 {
        self.end - self.start
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize)]
pub enum Period {
    #[default]
    Min1,
    Min5,
    Min15,
    Min30,
    Min60,
    Day,
}

impl Period {
    pub fn as_str(&self) -> &'static str {
        match self {
            Period::Min1 => "1m",
            Period::Min5 => "5m",
            Period::Min15 => "15m",
            Period::Min30 => "30m",
            Period::Min60 => "60m",
            Period::Day => "1d",
        }
    }
    pub fn minutes(&self) -> Option<i64> {
        match self {
            Period::Min1 => Some(1),
            Period::Min5 => Some(5),
            Period::Min15 => Some(15),
            Period::Min30 => Some(30),
            Period::Min60 => Some(60),
            Period::Day => None,
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "1m" => Period::Min1,
            "5m" => Period::Min5,
            "15m" => Period::Min15,
            "30m" => Period::Min30,
            "60m" => Period::Min60,
            "1d" | "day" | "d" => Period::Day,
            _ => return None,
        })
    }
    pub fn all_minute() -> [Period; 5] {
        [Period::Min1, Period::Min5, Period::Min15, Period::Min30, Period::Min60]
    }
}

/// 某个交易日的窗口表（含空窗口）。1 分钟窗口直接由时段切分；
/// 高周期窗口只用于把 1 分钟 bar 的标签映射到高周期 bar（见 `label_window`）。
pub fn session_windows(day: &SessionDay, period: Period) -> Vec<Window> {
    if period == Period::Day {
        let start = day
            .segments
            .iter()
            .filter(|s| s.kind != SegmentKind::Break)
            .map(|s| s.start)
            .min();
        let end = day
            .segments
            .iter()
            .filter(|s| s.kind != SegmentKind::Break)
            .map(|s| s.end)
            .max();
        return match (start, end) {
            (Some(s), Some(e)) => vec![Window {
                start: s,
                end: e,
                start_closed: true,
                label: e,
                auction_only: false,
            }],
            _ => Vec::new(),
        };
    }

    let minutes = period.minutes().unwrap();
    let mut out = Vec::new();

    // 连续竞价段：段首左闭，正向按周期长度推进，段尾不足周期者成为残 bar。
    // 若某连续段之后紧接一个“并入最后一根 bar”的收盘竞价，则该段的 bar 网格
    // 延伸到竞价结束（A 股 14:57 收盘竞价 → 网格到 15:00，最后 3 格在 omit 策略下为空）。
    // 连续竞价段网格。若某段之后紧接“并入最后一根 bar”的收盘竞价（A 股 14:57–15:00），
    // 则该段的网格延伸到竞价撮合时刻 15:00——**但最后一格（14:59,15:00] 是竞价专用**：
    // 它只接受 15:00:00.000 的竞价成交，14:57–15:00 的连续成交按 R04 判 out_of_session。
    let mut grid: Vec<(i64, i64, bool)> = day
        .segments
        .iter()
        .filter(|s| s.kind == SegmentKind::Continuous)
        .map(|s| (s.start, s.end, false))
        .collect();
    for a in day.auctions() {
        if a.attach == Some(AuctionAttach::IntoLastBar) {
            if let Some(last) = grid.iter_mut().rev().find(|(_, e, _)| *e <= a.start) {
                if last.1 == a.start {
                    last.1 = a.end;
                    last.2 = true;
                }
            }
        }
    }

    for (start, end, closing_auction) in grid {
        let seg = Segment {
            kind: SegmentKind::Continuous,
            label: String::new(),
            start,
            end,
            attach: None,
        };
        let mut ws = segment_windows(&seg, minutes);
        if closing_auction && period == Period::Min1 {
            if let Some(last) = ws.last_mut() {
                last.auction_only = true;
            }
        }
        out.extend(ws);
    }

    // 1 分钟：A 股开盘集合竞价单独成 bar（attach = FirstBar）。
    // 竞价成交在撮合时刻 `seg.end`（09:25）产生，但按 R04 该 bar 的**标签是开盘时刻**
    // （09:30，即当日连续竞价起点），这样 5m/15m 聚合时它天然落入首根。
    // 窗口本身取 `[seg.start, seg.end]`（只含竞价撮合时刻之前的时间），不与 09:31 bar 重叠。
    if period == Period::Min1 {
        for seg in day.auctions() {
            if seg.attach == Some(AuctionAttach::FirstBar) {
                let open_label = day
                    .continuous()
                    .map(|s| s.start)
                    .min()
                    .filter(|s| *s >= seg.end)
                    .unwrap_or(seg.end);
                out.push(Window {
                    start: seg.start,
                    end: seg.end,
                    start_closed: true,
                    label: open_label,
                    auction_only: true,
                });
            }
        }
    }

    out.sort_by_key(|w| (w.label, w.start));
    out
}

/// 单个连续竞价段的 1 分钟窗口切分。
pub fn segment_windows(seg: &Segment, minutes: i64) -> Vec<Window> {
    let mut out = Vec::new();
    let mut cursor = seg.start;
    let mut first = true;
    // 若段长不是周期整数倍，残 bar 落在段尾
    while cursor < seg.end {
        let end = (cursor + minutes * MINUTE_MS).min(seg.end);
        out.push(Window {
            start: cursor,
            end,
            start_closed: first,
            label: end,
            auction_only: false,
        });
        first = false;
        cursor = end;
    }
    // 段首必须有一个左闭窗口；若段长为 0 则没有窗口
    out
}

/// 把 1 分钟 bar 的标签映射到给定周期的窗口下标。
/// 返回 `None` 表示该标签不属于当日该周期的任何窗口（理论上不该发生）。
pub fn label_window(windows: &[Window], label: i64) -> Option<usize> {
    windows.iter().position(|w| {
        if w.start_closed {
            label >= w.start && label <= w.end
        } else {
            label > w.start && label <= w.end
        }
    })
}

/// 窗口标签的展示字符串（结束时间 HH:MM:SS.mmm）。
pub fn window_label(w: &Window) -> String {
    ms_to_hm(w.label)
}

pub fn window_date(w: &Window) -> String {
    ms_to_date_string(w.label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::{TradingSchedule, TradingScheduleId};

    fn day(id: TradingScheduleId, date: &str) -> SessionDay {
        TradingSchedule::new(id, TradingSchedule::default_calendar())
            .session_day(date, None)
            .unwrap()
    }

    #[test]
    fn equity_one_minute_count() {
        let d = day(TradingScheduleId::EquityCn, "2026-03-02");
        let w = session_windows(&d, Period::Min1);
        assert_eq!(w.len(), 241, "A 股 1m 应为 241 根（含 09:30 竞价 bar）");
        assert_eq!(window_label(&w[0]), "09:30:00.000");
        assert!(w[0].auction_only);
        assert_eq!(window_label(&w[1]), "09:31:00.000");
        assert_eq!(window_label(&w[120]), "11:30:00.000");
        assert_eq!(window_label(&w[121]), "13:01:00.000");
        assert_eq!(window_label(&w[240]), "15:00:00.000");
        assert!(w[240].auction_only, "15:00 是收盘竞价专用窗口");
        assert!(!w[239].auction_only, "14:59 是正常连续竞价窗口");
    }

    #[test]
    fn equity_five_minute_count() {
        let d = day(TradingScheduleId::EquityCn, "2026-03-02");
        let w = session_windows(&d, Period::Min5);
        assert_eq!(w.len(), 48);
        assert_eq!(window_label(&w[0]), "09:35:00.000");
        assert_eq!(window_label(&w[23]), "11:30:00.000");
        assert_eq!(window_label(&w[24]), "13:05:00.000");
    }

    #[test]
    fn auction_label_maps_into_first_five_minute() {
        let d = day(TradingScheduleId::EquityCn, "2026-03-02");
        let w5 = session_windows(&d, Period::Min5);
        let auction_label = session_windows(&d, Period::Min1)[0].label;
        assert_eq!(auction_label, crate::time::ts_from_local("2026-03-02 09:30:00").unwrap());
        assert_eq!(label_window(&w5, auction_label), Some(0));
    }

    #[test]
    fn future_one_minute_count() {
        let d = day(TradingScheduleId::FutureNight2300, "2026-03-03");
        let w = session_windows(&d, Period::Min1);
        assert_eq!(w.len(), 345);
        assert_eq!(window_label(&w[0]), "21:01:00.000");
        assert_eq!(window_label(&w[119]), "23:00:00.000");
        assert_eq!(window_label(&w[120]), "09:01:00.000");
        assert_eq!(window_label(&w[344]), "15:00:00.000");
    }

    #[test]
    fn future_residual_bars() {
        let d = day(TradingScheduleId::FutureNight2300, "2026-03-03");
        let w30 = session_windows(&d, Period::Min30);
        assert_eq!(w30.len(), 12);
        let labels: Vec<_> = w30.iter().map(window_label).collect();
        assert!(labels.contains(&"10:15:00.000".to_string()));
        let w60 = session_windows(&d, Period::Min60);
        assert_eq!(w60.len(), 7);
        let labels60: Vec<_> = w60.iter().map(window_label).collect();
        assert!(labels60.contains(&"10:00:00.000".to_string()));
        assert!(labels60.contains(&"10:15:00.000".to_string()));
    }

    #[test]
    fn window_semantics() {
        let w = Window { start: 1_772_443_800_000, end: 1_772_443_860_000, start_closed: true, label: 1_772_443_860_000, auction_only: false };
        assert!(w.contains(1_772_443_800_000));
        assert!(w.contains(1_772_443_860_000));
        let w2 = Window { start: 1_772_443_860_000, end: 1_772_443_920_000, start_closed: false, label: 1_772_443_920_000, auction_only: false };
        assert!(!w2.contains(1_772_443_860_000));
        assert!(w2.contains(1_772_443_860_001));
        assert!(w2.contains(1_772_443_920_000));
    }
}
