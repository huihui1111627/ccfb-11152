//! 交易日历与交易时段定义（rules.md R01–R05）。

use crate::fixed::parse_dec;
use crate::time::*;
use chrono::Timelike;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SegmentKind {
    /// 集合竞价（开盘/收盘）
    Auction,
    /// 连续竞价 / 期货连续交易
    Continuous,
    /// 午休 / 盘间休息（不交易）
    Break,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AuctionAttach {
    /// 竞价成交单独成 bar（A 股开盘竞价）
    FirstBar,
    /// 竞价成交并入段首连续 bar
    IntoFirstContinuous,
    /// 竞价成交并入当日最后一根 bar（A 股收盘竞价）
    IntoLastBar,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub kind: SegmentKind,
    pub label: String,
    /// 本地时间戳（含）
    pub start: i64,
    /// 本地时间戳（含）
    pub end: i64,
    pub attach: Option<AuctionAttach>,
}

impl Segment {
    pub fn hm(&self) -> String {
        format!("{}-{}", hm_of(self.start), hm_of(self.end))
    }
    pub fn contains(&self, ts: i64) -> bool {
        ts >= self.start && ts <= self.end
    }
}

/// 某个交易日的完整时段表（已展开到具体的自然日时间戳）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDay {
    pub trade_date: String,
    /// 该交易日涉及的自然日（夜盘可能跨日）
    pub calendar_dates: Vec<String>,
    pub segments: Vec<Segment>,
    pub prev_close: Option<i64>,
}

impl SessionDay {
    pub fn auctions(&self) -> impl Iterator<Item = &Segment> {
        self.segments.iter().filter(|s| s.kind == SegmentKind::Auction)
    }
    pub fn continuous(&self) -> impl Iterator<Item = &Segment> {
        self.segments.iter().filter(|s| s.kind == SegmentKind::Continuous)
    }
    pub fn in_session(&self, ts: i64) -> bool {
        self.segments
            .iter()
            .any(|s| s.kind != SegmentKind::Break && s.contains(ts))
    }
}

/// 时段模板：以“交易日 08:00”为基准的分钟偏移定义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TradingScheduleId {
    /// A 股：09:15–09:25 竞价，09:30–11:30 / 13:00–14:57 连续，14:57–15:00 收盘竞价
    #[serde(rename = "equity_cn")]
    EquityCn,
    /// 商品期货：夜盘 20:55–21:00 竞价 + 21:00–23:00 / 08:55–09:00 竞价 + 09:00–10:15 / 10:30–11:30 / 13:30–15:00
    #[serde(rename = "future_night_2300")]
    FutureNight2300,
    /// 黄金：夜盘到次日 02:30
    #[serde(rename = "future_night_0230")]
    FutureNight0230,
    /// 股指期货：09:30–11:30 / 13:00–15:00，无夜盘
    #[serde(rename = "index_future")]
    IndexFuture,
}

impl TradingScheduleId {
    pub fn as_str(&self) -> &'static str {
        match self {
            TradingScheduleId::EquityCn => "equity_cn",
            TradingScheduleId::FutureNight2300 => "future_night_2300",
            TradingScheduleId::FutureNight0230 => "future_night_0230",
            TradingScheduleId::IndexFuture => "index_future",
        }
    }
    pub fn has_night(&self) -> bool {
        matches!(
            self,
            TradingScheduleId::FutureNight2300 | TradingScheduleId::FutureNight0230
        )
    }
}

/// 一段时段模板：`start`/`end` 为相对“交易日零点（本地 00:00）”的分钟数。
/// 夜盘起点为负数（前一自然日晚上 20:55 → -185）；黄金夜盘终点跨到交易日当天凌晨（+150 = 02:30）。
#[derive(Debug, Clone, Copy)]
struct SegTpl {
    kind: SegmentKind,
    label: &'static str,
    start_min: i64,
    end_min: i64,
    attach: Option<AuctionAttach>,
}

const EQUITY: &[SegTpl] = &[
    SegTpl { kind: SegmentKind::Auction, label: "开盘集合竞价", start_min: 555, end_min: 565, attach: Some(AuctionAttach::FirstBar) },
    SegTpl { kind: SegmentKind::Continuous, label: "上午连续竞价", start_min: 570, end_min: 690, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "下午连续竞价", start_min: 780, end_min: 897, attach: None },
    SegTpl { kind: SegmentKind::Auction, label: "收盘集合竞价", start_min: 897, end_min: 900, attach: Some(AuctionAttach::IntoLastBar) },
];

const FUTURE_2300: &[SegTpl] = &[
    SegTpl { kind: SegmentKind::Auction, label: "夜盘集合竞价", start_min: -185, end_min: -180, attach: Some(AuctionAttach::IntoFirstContinuous) },
    SegTpl { kind: SegmentKind::Continuous, label: "夜盘", start_min: -180, end_min: -60, attach: None },
    SegTpl { kind: SegmentKind::Auction, label: "日盘集合竞价", start_min: 535, end_min: 540, attach: Some(AuctionAttach::IntoFirstContinuous) },
    SegTpl { kind: SegmentKind::Continuous, label: "第一节", start_min: 540, end_min: 615, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "第二节", start_min: 630, end_min: 690, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "第三节", start_min: 810, end_min: 900, attach: None },
];

const FUTURE_0230: &[SegTpl] = &[
    SegTpl { kind: SegmentKind::Auction, label: "夜盘集合竞价", start_min: -185, end_min: -180, attach: Some(AuctionAttach::IntoFirstContinuous) },
    SegTpl { kind: SegmentKind::Continuous, label: "夜盘", start_min: -180, end_min: 150, attach: None },
    SegTpl { kind: SegmentKind::Auction, label: "日盘集合竞价", start_min: 535, end_min: 540, attach: Some(AuctionAttach::IntoFirstContinuous) },
    SegTpl { kind: SegmentKind::Continuous, label: "第一节", start_min: 540, end_min: 615, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "第二节", start_min: 630, end_min: 690, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "第三节", start_min: 810, end_min: 900, attach: None },
];

const INDEX_FUTURE: &[SegTpl] = &[
    SegTpl { kind: SegmentKind::Continuous, label: "上午", start_min: 570, end_min: 690, attach: None },
    SegTpl { kind: SegmentKind::Continuous, label: "下午", start_min: 780, end_min: 900, attach: None },
];

/// 交易日历。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calendar {
    /// 有序交易日（升序）
    pub trading_days: Vec<String>,
    pub holidays: Vec<String>,
}

impl Calendar {
    pub fn new(trading_days: Vec<String>, holidays: Vec<String>) -> Self {
        let mut t = trading_days;
        t.sort();
        Self { trading_days: t, holidays }
    }

    pub fn is_trading_day(&self, date: &str) -> bool {
        self.trading_days.iter().any(|d| d == date)
    }

    pub fn next_trading_day(&self, date: &str) -> Option<&String> {
        self.trading_days.iter().find(|d| d.as_str() >= date)
    }

    pub fn prev_trading_day(&self, date: &str) -> Option<&String> {
        self.trading_days.iter().rev().find(|d| d.as_str() < date)
    }

    pub fn index_of(&self, date: &str) -> Option<usize> {
        self.trading_days.iter().position(|d| d == date)
    }
}

/// 交易时段（模板 + 日历）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingSchedule {
    pub id: TradingScheduleId,
    pub calendar: Calendar,
    #[serde(skip)]
    segs: Vec<SegTpl>,
}

impl TradingSchedule {
    pub fn new(id: TradingScheduleId, calendar: Calendar) -> Self {
        let segs = match id {
            TradingScheduleId::EquityCn => EQUITY.to_vec(),
            TradingScheduleId::FutureNight2300 => FUTURE_2300.to_vec(),
            TradingScheduleId::FutureNight0230 => FUTURE_0230.to_vec(),
            TradingScheduleId::IndexFuture => INDEX_FUTURE.to_vec(),
        };
        Self { id, calendar, segs }
    }

    /// 由默认日历（2026-02-27 与 2026-03-02..06）构造。
    pub fn default_calendar() -> Calendar {
        Calendar::new(
            vec![
                "2026-02-27".into(),
                "2026-03-02".into(),
                "2026-03-03".into(),
                "2026-03-04".into(),
                "2026-03-05".into(),
                "2026-03-06".into(),
            ],
            vec![],
        )
    }

    /// 把自然时间归属到交易日（R03）。
    pub fn trade_date_of(&self, ts: i64) -> String {
        let date = ms_to_date_string(ts);
        if !self.id.has_night() {
            return date;
        }
        let dt = local_dt(ts);
        let hm = dt.hour() * 60 + dt.minute();
        if hm >= 20 * 60 {
            // 晚上 ≥ 20:00 → 下一交易日
            if let Some(next) = self.calendar.next_trading_day(&shift_date(&date, 1)) {
                return next.clone();
            }
            // 非交易日晚上：归到其后第一个交易日
            return self
                .calendar
                .trading_days
                .iter()
                .find(|d| d.as_str() > date.as_str())
                .cloned()
                .unwrap_or(date);
        }
        if hm < 8 * 60 {
            // 凌晨 → 当自然日（前一晚的夜盘）
            return date;
        }
        date
    }

    /// 构造某交易日的完整时段表。
    pub fn session_day(&self, trade_date: &str, prev_close: Option<i64>) -> Option<SessionDay> {
        let idx = self.calendar.index_of(trade_date)?;
        let base = ts_of_date(trade_date).expect("date");
        let mut segments = Vec::new();
        let mut calendar_dates = Vec::new();
        for tpl in &self.segs {
            let start = base + tpl.start_min * MINUTE_MS;
            let end = base + tpl.end_min * MINUTE_MS;
            for t in [start, end] {
                let d = ms_to_date_string(t);
                if !calendar_dates.contains(&d) {
                    calendar_dates.push(d);
                }
            }
            segments.push(Segment {
                kind: tpl.kind,
                label: tpl.label.to_string(),
                start,
                end,
                attach: tpl.attach,
            });
        }
        calendar_dates.sort();
        let _ = idx;
        Some(SessionDay {
            trade_date: trade_date.to_string(),
            calendar_dates,
            segments,
            prev_close,
        })
    }

    /// 全部交易日的时段表。
    pub fn all_session_days(&self, closes: &dyn Fn(&str) -> Option<i64>) -> Vec<SessionDay> {
        let days = self.calendar.trading_days.clone();
        days.iter()
            .enumerate()
            .filter_map(|(i, d)| {
                let prev = if i > 0 {
                    closes(&days[i - 1])
                } else {
                    None
                };
                self.session_day(d, prev)
            })
            .collect()
    }
}

/// 从 dataset 配置构建涨跌停百分比定点。
pub fn pct_from_f64(p: f64) -> i64 {
    parse_dec(&format!("{:.4}", p)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched(id: TradingScheduleId) -> TradingSchedule {
        TradingSchedule::new(id, TradingSchedule::default_calendar())
    }

    #[test]
    fn equity_segments() {
        let s = sched(TradingScheduleId::EquityCn);
        let day = s.session_day("2026-03-02", Some(100_000)).unwrap();
        assert_eq!(day.segments.len(), 4); // 开盘竞价 + 上午 + 下午 + 收盘竞价
        assert_eq!(day.calendar_dates, vec!["2026-03-02".to_string()]);
        assert!(day.segments[0].start == ts_from_local("2026-03-02 09:15:00").unwrap());
    }

    #[test]
    fn future_night_trade_date() {
        let s = sched(TradingScheduleId::FutureNight2300);
        // 周一晚 21:00 → 周二交易日
        let ts = ts_from_local("2026-03-02 21:00:00").unwrap();
        assert_eq!(s.trade_date_of(ts), "2026-03-03");
        // 周二凌晨 01:30 → 周二
        let ts = ts_from_local("2026-03-03 01:30:00").unwrap();
        assert_eq!(s.trade_date_of(ts), "2026-03-03");
        // 周二白天 → 周二
        let ts = ts_from_local("2026-03-03 10:00:00").unwrap();
        assert_eq!(s.trade_date_of(ts), "2026-03-03");
    }

    #[test]
    fn future_session_day_spans_calendar() {
        let s = sched(TradingScheduleId::FutureNight2300);
        let day = s.session_day("2026-03-03", None).unwrap();
        assert_eq!(day.calendar_dates, vec!["2026-03-02".to_string(), "2026-03-03".to_string()]);
        let night = &day.segments[1];
        assert_eq!(night.start, ts_from_local("2026-03-02 21:00:00").unwrap());
        assert_eq!(night.end, ts_from_local("2026-03-02 23:00:00").unwrap());
    }

    #[test]
    fn gold_night_spans_two_days() {
        let s = TradingScheduleId::FutureNight0230;
        let sch = sched(s);
        let day = sch.session_day("2026-03-03", None).unwrap();
        let night = &day.segments[1];
        assert_eq!(night.end, ts_from_local("2026-03-03 02:30:00").unwrap());
    }

    #[test]
    fn friday_night_to_monday() {
        let s = sched(TradingScheduleId::FutureNight2300);
        let ts = ts_from_local("2026-02-27 21:00:00").unwrap();
        // 周五夜盘归属下周一
        assert_eq!(s.trade_date_of(ts), "2026-03-02");
    }
}
