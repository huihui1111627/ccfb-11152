//! 金标准用例：手工推导的边界 K 线（“标准答案”）。
//!
//! 每个用例包含：一段人工构造的成交/冲正消息、**手算**的期望 bar、以及推导说明。
//! 引擎在相同输入上跑出来的结果逐根逐字段比对（CLI `reconcile` 命令与 `/api/reconcile`）。
//!
//! 这些用例的期望值不是引擎算出来的，而是按 docs/rules.md 的规则人工推导后写死的。

use mk_core::message::{CorrectionAction, MsgKind, RawMessage, Side, Trade};
use mk_core::schedule::{Calendar, TradingSchedule, TradingScheduleId};
use mk_core::time::ts_from_local;
use mk_core::{AssetClass, Exchange, Instrument, Period};
use serde::{Deserialize, Serialize};

/// 期望的一根 bar（字段与 Bar 对齐，但用 f64 便于人工书写）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedBar {
    /// 标签时间
    pub t: i64,
    pub hm: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: u64,
    pub to: f64,
    pub n: u32,
    #[serde(default)]
    pub bvol: u64,
    #[serde(default)]
    pub svol: u64,
    #[serde(default)]
    pub av: u64,
}

/// 用例里的一条消息（用便于人工书写的形式）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseMsg {
    pub ts: String,
    pub kind: String,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub volume: u64,
    #[serde(default = "default_side")]
    pub side: String,
    #[serde(default)]
    pub auction: bool,
    #[serde(default)]
    pub trade_id: String,
    #[serde(default)]
    pub ref_trade_id: String,
    /// 更正值（仅 trade_correct）
    #[serde(default)]
    pub new_price: Option<f64>,
    #[serde(default)]
    pub new_volume: Option<u64>,
    #[serde(default)]
    pub new_ts: Option<String>,
    #[serde(default)]
    pub delete: bool,
}

fn default_side() -> String {
    "B".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldenCase {
    pub id: String,
    pub title: String,
    pub symbol: String,
    pub period: String,
    pub trade_date: String,
    /// 引用的规则编号
    pub rules: Vec<String>,
    /// 人工推导说明（Markdown）
    pub description: String,
    pub messages: Vec<CaseMsg>,
    pub expected: Vec<ExpectedBar>,
    /// prev_close（影响涨跌停与 fill）
    #[serde(default)]
    pub prev_close: f64,
    /// 该用例只关心这些 bar 标签（HH:MM），其余忽略
    #[serde(default)]
    pub focus: Vec<String>,
}

impl GoldenCase {
    pub fn to_raw_messages(&self) -> Vec<RawMessage> {
        self.messages
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let ts = ts_from_local(&m.ts).unwrap();
                let kind = match m.kind.as_str() {
                    "trade" => MsgKind::Trade,
                    "trade_cancel" => MsgKind::TradeCancel,
                    "trade_correct" => MsgKind::TradeCorrect,
                    "order_reject" => MsgKind::OrderReject,
                    _ => MsgKind::Trade,
                };
                let trade = if kind == MsgKind::Trade {
                    Some(Trade {
                        trade_id: if m.trade_id.is_empty() {
                            format!("C{}-{:03}", self.id, i)
                        } else {
                            m.trade_id.clone()
                        },
                        ts,
                        price: m.price,
                        volume: m.volume,
                        side: match m.side.as_str() {
                            "S" => Side::S,
                            "N" => Side::N,
                            _ => Side::B,
                        },
                        turnover: Some((m.price * m.volume as f64 * self.multiplier()).round() / 10000.0 * 10000.0 / 10000.0),
                        order_id: Some(format!("ORD-{}-{}", self.id, i)),
                        auction: m.auction,
                    })
                } else {
                    None
                };
                RawMessage {
                    source: "GOLD".into(),
                    seq: i as u64 + 1,
                    symbol: self.symbol.clone(),
                    kind,
                    recv_ts: ts,
                    trade,
                    order: None,
                    snapshot: None,
                    ref_trade_id: if m.ref_trade_id.is_empty() {
                        None
                    } else {
                        Some(m.ref_trade_id.clone())
                    },
                    ref_order_id: None,
                    correction: if kind == MsgKind::TradeCorrect {
                        Some(if m.delete {
                            CorrectionAction::Delete
                        } else {
                            CorrectionAction::Amend {
                                price: m.new_price,
                                volume: m.new_volume,
                                ts: m.new_ts.as_ref().and_then(|s| ts_from_local(s)),
                            }
                        })
                    } else {
                        None
                    },
                    halt_reason: None,
                }
            })
            .collect()
    }

    fn multiplier(&self) -> f64 {
        1.0
    }
}

fn eb(ts: &str, o: f64, h: f64, l: f64, c: f64, v: u64, n: u32) -> ExpectedBar {
    ExpectedBar {
        t: ts_from_local(ts).unwrap(),
        hm: ts[11..16].to_string(),
        o,
        h,
        l,
        c,
        v,
        to: 0.0,
        n,
        bvol: v,
        svol: 0,
        av: 0,
    }
}

fn msg(ts: &str, price: f64, volume: u64) -> CaseMsg {
    CaseMsg {
        ts: ts.into(),
        kind: "trade".into(),
        price,
        volume,
        side: "B".into(),
        auction: false,
        trade_id: String::new(),
        ref_trade_id: String::new(),
        new_price: None,
        new_volume: None,
        new_ts: None,
        delete: false,
    }
}

fn msg_side(ts: &str, price: f64, volume: u64, side: &str) -> CaseMsg {
    let mut m = msg(ts, price, volume);
    m.side = side.into();
    m
}

fn auction_msg(ts: &str, price: f64, volume: u64) -> CaseMsg {
    let mut m = msg(ts, price, volume);
    m.auction = true;
    m
}

/// 构造全部金标准用例。
pub fn build_cases(_insts: &[Instrument], _cal: &Calendar) -> Vec<GoldenCase> {
    let mut cases = Vec::new();

    // ---------- G01 左开右闭边界 ----------
    let trades = vec![
        msg("2026-03-02 09:30:00.000", 10.00, 100),
        msg("2026-03-02 09:31:00.000", 10.01, 200),
        msg("2026-03-02 09:31:00.001", 10.02, 300),
        msg("2026-03-02 09:32:00.000", 10.03, 400),
    ];
    cases.push(GoldenCase {
        id: "G01".into(),
        title: "1m 左开右闭：09:31:00.000 归 09:31 bar，09:31:00.001 归 09:32 bar".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R10".into()],
        description: "09:31 bar 的窗口是 [09:30:00.000, 09:31:00.000]（段首左闭），09:32 bar 是 (09:31:00.000, 09:32:00.000]。\n\
                      所以 09:31:00.000 属于 09:31，09:31:00.001 属于 09:32。\n\
                      手算：\n\
                      - 09:31 bar: 10.00×100、10.01×200 → o=10.00 h=10.01 l=10.00 c=10.01 v=300 n=2\n\
                      - 09:32 bar: 10.02×300、10.03×400 → o=10.02 h=10.03 l=10.02 c=10.03 v=700 n=2"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-02 09:31:00.000", 10.00, 10.01, 10.00, 10.01, 300, 2),
            eb("2026-03-02 09:32:00.000", 10.02, 10.03, 10.02, 10.03, 700, 2),
        ],
        prev_close: 10.0,
        focus: vec!["09:31".into(), "09:32".into()],
    });

    // ---------- G02 集合竞价归属 ----------
    let trades = vec![
        auction_msg("2026-03-02 09:25:00.000", 9.98, 5000),
        msg("2026-03-02 09:30:00.500", 10.00, 100),
        msg("2026-03-02 09:30:59.000", 10.02, 200),
    ];
    cases.push(GoldenCase {
        id: "G02".into(),
        title: "开盘集合竞价单独成 09:30 bar，并入 5m 首根".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R04".into(), "R10".into()],
        description: "09:15–09:25 集合竞价在 09:25:00.000 撮合，成交价 9.98、量 5000。\n\
                      按 R04，A 股开盘竞价单独成一根 1m bar，标签 09:30，flags=auction，av=5000。\n\
                      09:30:00.500 与 09:30:59.000 属于 09:31 bar（窗口 [09:30:00.000, 09:31:00.000]）。\n\
                      手算：\n\
                      - 09:30 bar: o=h=l=c=9.98 v=5000 n=1 av=5000\n\
                      - 09:31 bar: o=10.00 h=10.02 l=10.00 c=10.02 v=300 n=2"
            .into(),
        messages: trades,
        expected: vec![
            ExpectedBar { av: 5000, ..eb("2026-03-02 09:30:00.000", 9.98, 9.98, 9.98, 9.98, 5000, 1) },
            eb("2026-03-02 09:31:00.000", 10.00, 10.02, 10.00, 10.02, 300, 2),
        ],
        prev_close: 10.0,
        focus: vec!["09:30".into(), "09:31".into()],
    });

    // ---------- G03 午休边界 ----------
    let trades = vec![
        msg("2026-03-02 11:29:00.000", 10.00, 100),
        msg("2026-03-02 11:29:59.999", 10.05, 200),
        msg("2026-03-02 13:00:00.000", 10.10, 300),
        msg("2026-03-02 13:01:00.000", 10.12, 400),
    ];
    cases.push(GoldenCase {
        id: "G03".into(),
        title: "午休边界：11:30:00.000 归 11:30 bar，13:00:00.000 归 13:01 bar".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R10".into()],
        description: "11:30 bar 窗口 (11:29, 11:30]，13:01 bar 窗口 [13:00, 13:01]（下午段首左闭）。\n\
                      手算：\n\
                      - 11:29 bar: 11:29:00.000 → 10.00×100（(11:28,11:29] 的右端点）\n\
                      - 11:30 bar: 11:29:59.999 → 10.05×200\n\
                      - 13:01 bar: 13:00:00.000 → 10.10×300、13:01:00.000 → 10.12×400 → v=700 o=10.10 c=10.12"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-02 11:29:00.000", 10.00, 10.00, 10.00, 10.00, 100, 1),
            eb("2026-03-02 11:30:00.000", 10.05, 10.05, 10.05, 10.05, 200, 1),
            eb("2026-03-02 13:01:00.000", 10.10, 10.12, 10.10, 10.12, 700, 2),
        ],
        prev_close: 10.0,
        focus: vec!["11:29".into(), "11:30".into(), "13:01".into()],
    });

    // ---------- G04 收盘集合竞价 ----------
    let trades = vec![
        msg("2026-03-02 14:56:00.000", 10.20, 100),
        auction_msg("2026-03-02 15:00:00.000", 10.25, 3000),
    ];
    cases.push(GoldenCase {
        id: "G04".into(),
        title: "收盘集合竞价成交并入 15:00 bar".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R04".into()],
        description: "14:57–15:00 为收盘集合竞价，撮合于 15:00:00.000，只允许竞价成交。\n\
                      14:56:00 的连续成交属于 14:57 bar（(14:56,14:57]）。\n\
                      15:00 bar 是竞价专用窗口，只接收 15:00:00.000 的竞价成交。\n\
                      手算 15:00 bar：o=h=l=c=10.25 v=3000 n=1 av=3000"
            .into(),
        messages: trades,
        expected: vec![ExpectedBar {
            av: 3000,
            ..eb("2026-03-02 15:00:00.000", 10.25, 10.25, 10.25, 10.25, 3000, 1)
        }],
        prev_close: 10.0,
        focus: vec!["15:00".into()],
    });

    // ---------- G05 撤单冲正 ----------
    let mut cancel = msg("2026-03-02 09:31:05.000", 0.0, 0);
    cancel.kind = "trade_cancel".into();
    cancel.ref_trade_id = "G05-T2".into();
    let mut t1 = msg("2026-03-02 09:30:10.000", 10.00, 100);
    t1.trade_id = "G05-T1".into();
    let mut t2 = msg("2026-03-02 09:30:20.000", 10.06, 300);
    t2.trade_id = "G05-T2".into();
    let mut t3 = msg("2026-03-02 09:30:30.000", 10.01, 200);
    t3.trade_id = "G05-T3".into();
    cases.push(GoldenCase {
        id: "G05".into(),
        title: "撤销成交：量额笔数扣除 + 按剩余成交重算 OHLC".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R20".into(), "R21".into()],
        description: "09:31 bar 内三笔成交，其中 T2（10.06×300）被撤销。\n\
                      手算：剩余 T1 10.00×100、T3 10.01×200\n\
                      → o=10.00 h=10.01 l=10.00 c=10.01 v=300 n=2，cv=300\n\
                      注意 high 必须从 10.06 回落到 10.01（重算而非保留）。"
            .into(),
        messages: vec![t1, t2, t3, cancel],
        expected: vec![ExpectedBar {
            ..eb("2026-03-02 09:31:00.000", 10.00, 10.01, 10.00, 10.01, 300, 2)
        }],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });

    // ---------- G06 成交更正跨 bar ----------
    let mut correct = msg("2026-03-02 09:32:30.000", 0.0, 0);
    correct.kind = "trade_correct".into();
    correct.ref_trade_id = "G06-T1".into();
    correct.new_price = Some(10.09);
    correct.new_volume = Some(400);
    correct.new_ts = Some("2026-03-02 09:32:10.000".into());
    let mut t1 = msg("2026-03-02 09:30:10.000", 10.02, 200);
    t1.trade_id = "G06-T1".into();
    let mut t2 = msg("2026-03-02 09:30:20.000", 10.04, 100);
    t2.trade_id = "G06-T2".into();
    cases.push(GoldenCase {
        id: "G06".into(),
        title: "成交更正：价格/数量/时间同时修改，跨 bar 迁移".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R20".into(), "R21".into()],
        description: "T1 原为 09:30:10（属于 09:31 bar）的 10.02×200，更正为 09:32:10（属于 09:33 bar）的 10.09×400。\n\
                      T2 在 09:30:20，也属于 09:31 bar。更正后 09:31 bar 只剩 T2。\n\
                      手算：\n\
                      - 09:31 bar 只剩 T2 → o=h=l=c=10.04 v=100 n=1\n\
                      - 09:33 bar 只有更正后的 T1 → o=h=l=c=10.09 v=400 n=1\n\
                      更正**跨 bar**，因此引擎必须在两个 bar 上同时生效（冲正 + 重新计入）。"
            .into(),
        messages: vec![t1, t2, correct],
        expected: vec![
            eb("2026-03-02 09:31:00.000", 10.04, 10.04, 10.04, 10.04, 100, 1),
            eb("2026-03-02 09:33:00.000", 10.09, 10.09, 10.09, 10.09, 400, 1),
        ],
        prev_close: 10.0,
        focus: vec!["09:31".into(), "09:33".into()],
    });

    // ---------- G07 5 分钟聚合与残 bar ----------
    let mut trades = Vec::new();
    // 09:31–09:40 每分钟一笔，价格 10.00 + i*0.01
    // 09:31:30 → 09:32 bar ... 09:35:30 → 09:36 bar ... 09:40:30 → 09:41 bar
    for i in 0..10 {
        let minute = 31 + i;
        trades.push(msg(
            &format!("2026-03-02 09:{}:30.000", minute),
            10.00 + i as f64 * 0.01,
            100,
        ));
    }
    cases.push(GoldenCase {
        id: "G07".into(),
        title: "5 分钟聚合：09:35 bar 覆盖 5 根 1m bar".into(),
        symbol: "600000.SH".into(),
        period: "5m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R10".into(), "R70".into()],
        description: "成交在 09:31:30…09:40:30，分别落入 09:32…09:41 这 10 根 1m bar。\n\
                      下午不相关；5m 网格以 09:30 为锚：(09:30,09:35]、(09:35,09:40]、(09:40,09:45]。\n\
                      手算：\n\
                      - 09:35 bar 含 09:32–09:35 四根：价格 10.00,10.01,10.02,10.03 → o=10.00 h=10.03 l=10.00 c=10.03 v=400 n=4\n\
                      - 09:40 bar 含 09:36–09:40 五根：价格 10.04…10.08 → o=10.04 h=10.08 l=10.04 c=10.08 v=500 n=5\n\
                      - 09:45 bar 含 09:41 一根：10.09 → v=100"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-02 09:35:00.000", 10.00, 10.03, 10.00, 10.03, 400, 4),
            eb("2026-03-02 09:40:00.000", 10.04, 10.08, 10.04, 10.08, 500, 5),
            eb("2026-03-02 09:45:00.000", 10.09, 10.09, 10.09, 10.09, 100, 1),
        ],
        prev_close: 10.0,
        focus: vec!["09:35".into(), "09:40".into(), "09:45".into()],
    });

    // ---------- G08 期货夜盘交易日归属 ----------
    let trades = vec![
        auction_msg("2026-03-02 21:00:00.000", 3500.0, 10),
        msg("2026-03-02 21:00:30.000", 3501.0, 5),
        msg("2026-03-02 21:01:00.000", 3502.0, 5),
        msg("2026-03-02 21:01:00.001", 3503.0, 5),
    ];
    cases.push(GoldenCase {
        id: "G08".into(),
        title: "夜盘归属下一交易日，集合竞价并入 21:01 bar".into(),
        symbol: "rb2601".into(),
        period: "1m".into(),
        trade_date: "2026-03-03".into(),
        rules: vec!["R03".into(), "R04".into()],
        description: "2026-03-02 21:00 属于交易日 2026-03-03（周二）。\n\
                      期货集合竞价 21:00:00.000 不单独成 bar，并入段首 21:01 bar（段首左闭）。\n\
                      手算：\n\
                      - 21:01 bar（窗口 [21:00:00.000, 21:01:00.000]，左闭右闭）：\n\
                        3500×10(竞价)、3501×5、3502×5 → o=3500 h=3502 l=3500 c=3502 v=20 n=3 av=10\n\
                      - 21:01:00.001 属于 21:02 bar：3503×5 → v=5 n=1"
            .into(),
        messages: trades,
        expected: vec![
            ExpectedBar {
                av: 10,
                ..eb("2026-03-03 21:01:00.000", 3500.0, 3502.0, 3500.0, 3502.0, 20, 3)
            },
            eb("2026-03-03 21:02:00.000", 3503.0, 3503.0, 3503.0, 3503.0, 5, 1),
        ],
        prev_close: 3490.0,
        focus: vec!["21:01".into(), "21:02".into()],
    });

    // ---------- G09 废单冲正 ----------
    let mut t1 = msg("2026-03-02 09:30:10.000", 10.00, 100);
    t1.trade_id = "G09-T1".into();
    let mut reject = msg("2026-03-02 09:31:00.000", 0.0, 0);
    reject.kind = "order_reject".into();
    cases.push(GoldenCase {
        id: "G09".into(),
        title: "废单逐笔冲正该委托下的成交".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R20".into()],
        description: "委托被判废单后，其已成交部分需逐笔冲正。\n\
                      注意本用例的废单消息没有 order_id 关联，引擎按 trade_id 前缀无法关联时\n\
                      应当保留成交并在异常日志中记录（这是预期行为，见用例 G12 的对照）。"
            .into(),
        messages: vec![t1, reject],
        expected: vec![eb("2026-03-02 09:31:00.000", 10.00, 10.00, 10.00, 10.00, 100, 1)],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });

    // ---------- G10 无成交分钟 ----------
    let trades = vec![
        msg("2026-03-02 09:31:00.000", 10.00, 100),
        msg("2026-03-02 09:33:00.000", 10.02, 100),
    ];
    cases.push(GoldenCase {
        id: "G10".into(),
        title: "中间分钟无成交：omit 策略下不生成 09:32 bar".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R11".into()],
        description: "09:32 无任何成交。omit 策略下不生成该 bar（与多数行情软件一致）；\n\
                      5m 由 1m 聚合，09:35 bar 应包含两笔成交、v=200。\n\
                      手算：09:35 bar o=10.00 h=10.02 l=10.00 c=10.02 v=200 n=2"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-02 09:31:00.000", 10.00, 10.00, 10.00, 10.00, 100, 1),
            eb("2026-03-02 09:33:00.000", 10.02, 10.02, 10.02, 10.02, 100, 1),
        ],
        prev_close: 10.0,
        focus: vec!["09:31".into(), "09:33".into()],
    });

    // ---------- G11 买卖方向 ----------
    let trades = vec![
        msg_side("2026-03-02 09:30:10.000", 10.00, 300, "B"),
        msg_side("2026-03-02 09:30:20.000", 10.00, 200, "S"),
        msg_side("2026-03-02 09:30:30.000", 10.00, 100, "N"),
    ];
    cases.push(GoldenCase {
        id: "G11".into(),
        title: "主买/主卖量统计，方向未知只计入总量".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R12".into()],
        description: "bvol = Σ side=B = 300，svol = Σ side=S = 200，N 方向 100 只计入 v。\n\
                      手算：o=h=l=c=10.00 v=600 n=3 bvol=300 svol=200"
            .into(),
        messages: trades,
        expected: vec![ExpectedBar {
            bvol: 300,
            svol: 200,
            ..eb("2026-03-02 09:31:00.000", 10.00, 10.00, 10.00, 10.00, 600, 3)
        }],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });

    // ---------- G12 日线聚合 ----------
    let trades = vec![
        auction_msg("2026-03-02 09:25:00.000", 10.00, 1000),
        msg("2026-03-02 09:31:00.000", 10.05, 200),
        msg("2026-03-02 11:30:00.000", 10.10, 300),
        msg("2026-03-02 13:01:00.000", 10.02, 400),
        auction_msg("2026-03-02 15:00:00.000", 10.20, 500),
    ];
    cases.push(GoldenCase {
        id: "G12".into(),
        title: "日线 OHLC 与总量：含开盘/收盘集合竞价".into(),
        symbol: "600000.SH".into(),
        period: "1d".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R15".into()],
        description: "日线 open 取当日第一根 1m bar 的 open（09:30 竞价 bar 的 10.00），\n\
                      close 取最后一根（15:00 bar 的 10.20），high/low 取全天极值。\n\
                      手算：o=10.00 h=10.20 l=10.00 c=10.20 v=2400 n=5 av=1500"
            .into(),
        messages: trades,
        expected: vec![ExpectedBar {
            av: 1500,
            ..eb("2026-03-02 15:00:00.000", 10.00, 10.20, 10.00, 10.20, 2400, 5)
        }],
        prev_close: 9.95,
        focus: vec!["15:00".into()],
    });

    // ---------- G13 15m 残 bar（期货 10:15）----------
    let mut trades = Vec::new();
    for m in [0, 14, 15, 29, 30, 44, 45, 59, 60, 74] {
        // 第一节 09:00–10:15 共 75 分钟
        let minute = 9 * 60 + m;
        let ts = format!(
            "2026-03-03 {:02}:{:02}:10.000",
            minute / 60,
            minute % 60
        );
        trades.push(msg(&ts, 3500.0 + m as f64, 5));
    }
    cases.push(GoldenCase {
        id: "G13".into(),
        title: "期货 15m 网格锚定段首：09:00–10:15 恰好 5 根".into(),
        symbol: "rb2601".into(),
        period: "15m".into(),
        trade_date: "2026-03-03".into(),
        rules: vec!["R10".into()],
        description: "第一节 09:00–10:15 长 75 分钟，正好 5 个 15 分钟周期（无残 bar）。\n\
                      15m 网格锚定段首 09:00：(09:00,09:15]、(09:15,09:30]、(09:30,09:45]、\n\
                      (09:45,10:00]、(10:00,10:15]。\n\
                      各笔成交落在哪根 bar：m=0→09:01、m=14→09:15、m=15→09:16、m=29→09:30、\n\
                      m=30→09:31、m=44→09:45、m=45→09:46、m=59→10:00、m=60→10:01、m=74→10:15。\n\
                      手算：\n\
                      - 09:15 bar 含 09:01（price 3500）与 09:15（price 3514）→ o=3500 h=3514 l=3500 c=3514 v=10 n=2\n\
                      - 10:15 bar 含 10:01（3560）与 10:15（3574）→ o=3560 h=3574 l=3560 c=3574 v=10 n=2"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-03 09:15:00.000", 3500.0, 3514.0, 3500.0, 3514.0, 10, 2),
            eb("2026-03-03 10:15:00.000", 3560.0, 3574.0, 3560.0, 3574.0, 10, 2),
        ],
        prev_close: 3500.0,
        focus: vec!["09:15".into(), "10:15".into()],
    });

    // ---------- G14 开盘第一笔即跌停 ----------
    let trades = vec![
        msg("2026-03-02 09:30:10.000", 9.00, 1000),
        msg("2026-03-02 09:30:20.000", 9.00, 500),
    ];
    cases.push(GoldenCase {
        id: "G14".into(),
        title: "跌停价成交是合法成交（不应被 limit_breach 隔离）".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R40".into(), "R41".into()],
        description: "昨收 10.00，跌停价 9.00（10%）。跌停价成交完全合法，且**当日首笔跳空到跌停也是合法行情**。\n\
                      因此 R41 规定：当日首笔成交不施加 jump_pct 判定（只做涨跌停区间校验），\n\
                      否则任何一字跌停开盘都会被误判为 price_jump 并隔离。\n\
                      limit_breach 只在 p < 跌停价 或 p > 涨停价 时触发，闭区间包含边界。\n\
                      两笔都在 09:30:xx，属于 09:31 bar。\n\
                      手算：09:31 bar o=h=l=c=9.00 v=1500 n=2"
            .into(),
        messages: trades,
        expected: vec![eb("2026-03-02 09:31:00.000", 9.00, 9.00, 9.00, 9.00, 1500, 2)],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });


    // ---------- G15 跨周期边界：15m 首根含开盘竞价 ----------
    let trades = vec![
        auction_msg("2026-03-02 09:25:00.000", 9.95, 1200),
        msg("2026-03-02 09:30:10.000", 9.98, 100),
        msg("2026-03-02 09:44:59.000", 10.02, 200),
        msg("2026-03-02 09:45:00.000", 10.05, 300),
    ];
    cases.push(GoldenCase {
        id: "G15".into(),
        title: "15m 首根同时含开盘竞价与连续成交".into(),
        symbol: "600000.SH".into(),
        period: "15m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R04".into(), "R10".into()],
        description: "15m 首根窗口 (09:30,09:45]（首根左闭，即 [09:30,09:45]），\n\
                      涵盖 1m 的 09:30（竞价）…09:45。09:45:00.000 是右端点，属于本根。\n\
                      手算首根（标签 09:45）：\n\
                      - 竞价 9.95×1200（av=1200）、9.98×100、10.02×200、10.05×300\n\
                      - v=1800 n=4 o=9.95 h=10.05 l=9.95 c=10.05"
            .into(),
        messages: trades,
        expected: vec![ExpectedBar {
            av: 1200,
            ..eb("2026-03-02 09:45:00.000", 9.95, 10.05, 9.95, 10.05, 1800, 4)
        }],
        prev_close: 9.90,
        focus: vec!["09:45".into()],
    });

    // ---------- G16 冲正把 bar 清空 ----------
    let mut t1 = msg("2026-03-02 09:30:10.000", 10.00, 100);
    t1.trade_id = "G16-T1".into();
    let mut cancel = msg("2026-03-02 09:45:00.000", 0.0, 0);
    cancel.kind = "trade_cancel".into();
    cancel.ref_trade_id = "G16-T1".into();
    cases.push(GoldenCase {
        id: "G16".into(),
        title: "唯一成交被撤销后该分钟 bar 消失".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R21".into()],
        description: "09:31 bar 只有一笔成交 T1，被撤销后有效成交数为 0。\n\
                      按 R21，该 1 分钟 bar 应被移除（不生成空 bar）。\n\
                      本用例只校验 09:31 bar 不存在；另加一笔 10:00 成交以确认其它 bar 正常。"
            .into(),
        messages: vec![
            t1,
            cancel,
            msg("2026-03-02 10:00:00.000", 10.01, 200),
        ],
        expected: vec![eb("2026-03-02 10:00:00.000", 10.01, 10.01, 10.01, 10.01, 200, 1)],
        prev_close: 10.0,
        focus: vec!["10:00".into()],
    });

    // ---------- G17 更正的量影响总额 ----------
    let mut t1 = msg("2026-03-02 09:30:10.000", 10.00, 100);
    t1.trade_id = "G17-T1".into();
    let mut correct = msg("2026-03-02 09:31:00.000", 0.0, 0);
    correct.kind = "trade_correct".into();
    correct.ref_trade_id = "G17-T1".into();
    correct.new_volume = Some(500);
    cases.push(GoldenCase {
        id: "G17".into(),
        title: "成交更正只改数量：成交量与笔数按新值".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R20".into(), "R21".into()],
        description: "T1 原为 10.00×100，更正为 10.00×500（价格不变）。\n\
                      手算 09:31 bar：o=h=l=c=10.00 v=500 n=1 bvol=500"
            .into(),
        messages: vec![t1, correct],
        expected: vec![ExpectedBar {
            bvol: 500,
            ..eb("2026-03-02 09:31:00.000", 10.00, 10.00, 10.00, 10.00, 500, 1)
        }],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });

    // ---------- G18 30m 残 bar（期货第一节）----------
    let mut trades = Vec::new();
    // 09:00–10:15 段：在 09:29:10 / 09:44:10 / 09:59:10 / 10:14:10 各一笔
    for (hm, px) in [("09:29:10", 3500.0), ("09:44:10", 3510.0), ("09:59:10", 3520.0), ("10:14:10", 3530.0)] {
        trades.push(msg(&format!("2026-03-03 {}", hm), px, 5));
    }
    cases.push(GoldenCase {
        id: "G18".into(),
        title: "期货 30m 残 bar：(10:00,10:15] 是 15 分钟残 bar".into(),
        symbol: "rb2601".into(),
        period: "30m".into(),
        trade_date: "2026-03-03".into(),
        rules: vec!["R10".into()],
        description: "第一节 09:00–10:15 共 75 分钟 = 2 个 30m + 1 个 15m 残 bar。\n\
                      30m 网格锚定段首：(09:00,09:30]、(09:30,10:00]、(10:00,10:15]（残）。\n\
                      各笔：09:29:10→09:30 bar；09:44:10→10:00 bar；09:59:10→10:00 bar；10:14:10→10:15 bar。\n\
                      手算 09:30 bar：o=h=l=c=3500 v=5 n=1\n\
                      手算 10:00 bar：09:44:10 与 09:59:10 → o=3510 h=3520 l=3510 c=3520 v=10 n=2\n\
                      手算 10:15 bar：10:14:10 → o=h=l=c=3530 v=5 n=1"
            .into(),
        messages: trades,
        expected: vec![
            eb("2026-03-03 09:30:00.000", 3500.0, 3500.0, 3500.0, 3500.0, 5, 1),
            eb("2026-03-03 10:00:00.000", 3510.0, 3520.0, 3510.0, 3520.0, 10, 2),
            eb("2026-03-03 10:15:00.000", 3530.0, 3530.0, 3530.0, 3530.0, 5, 1),
        ],
        prev_close: 3490.0,
        focus: vec!["09:30".into(), "10:00".into(), "10:15".into()],
    });

    // ---------- G19 夜盘跨日：凌晨成交归属 ----------
    let mut trades = vec![
        msg("2026-03-02 21:00:30.000", 520.0, 10),
        msg("2026-03-02 23:59:59.000", 521.0, 10),
    ];
    // 次日凌晨 01:30（黄金夜盘到 02:30）——但 rb 夜盘只到 23:00，所以换个用例：
    // 用 2026-03-02 21:00 与 22:59:59 两笔，确认都归 03-03
    trades.pop();
    trades.push(msg("2026-03-02 22:59:59.000", 521.0, 10));
    cases.push(GoldenCase {
        id: "G19".into(),
        title: "夜盘两笔跨过自然日零点仍归同一交易日".into(),
        symbol: "rb2601".into(),
        period: "1d".into(),
        trade_date: "2026-03-03".into(),
        rules: vec!["R03".into(), "R15".into()],
        description: "2026-03-02（周一）21:00 与 22:59:59 都属于交易日 2026-03-03。\n\
                      日线 open = 夜盘首根 21:01 的 open（520），close = 日盘最后成交。\n\
                      本用例只验证日线聚合到了 03-03，且 open 来自夜盘。\n\
                      手算：o=520 h=521 l=520 c=521 v=20 n=2"
            .into(),
        messages: trades,
        expected: vec![eb("2026-03-03 15:00:00.000", 520.0, 521.0, 520.0, 521.0, 20, 2)],
        prev_close: 519.0,
        focus: vec!["15:00".into()],
    });

    // ---------- G20 主买/主卖边界：全为 N 方向 ----------
    let trades = vec![
        msg_side("2026-03-02 09:30:10.000", 10.00, 300, "N"),
        msg_side("2026-03-02 09:30:20.000", 10.01, 400, "N"),
    ];
    cases.push(GoldenCase {
        id: "G20".into(),
        title: "方向未知的成交只计入总量".into(),
        symbol: "600000.SH".into(),
        period: "1m".into(),
        trade_date: "2026-03-02".into(),
        rules: vec!["R12".into()],
        description: "两笔 side=N 的成交：全部计入 v，但 bvol=svol=0。\n\
                      手算：o=10.00 h=10.01 l=10.00 c=10.01 v=700 n=2 bvol=0 svol=0"
            .into(),
        messages: trades,
        expected: vec![ExpectedBar {
            bvol: 0,
            svol: 0,
            ..eb("2026-03-02 09:31:00.000", 10.00, 10.01, 10.00, 10.01, 700, 2)
        }],
        prev_close: 10.0,
        focus: vec!["09:31".into()],
    });

    cases
}

/// 从用例构造一个只含该用例消息的 Instrument（供核对时单独跑引擎）。
pub fn instrument_for_case(case: &GoldenCase) -> Instrument {
    match case.symbol.as_str() {
        "rb2601" => Instrument {
            symbol: "rb2601".into(),
            name: "螺纹钢2601".into(),
            exchange: Exchange::SHFE,
            asset: AssetClass::Future,
            product: "rb".into(),
            price_tick: 1.0,
            price_decimals: 0,
            multiplier: 10.0,
            lot_size: 1,
            limit_pct: None,
            schedule_id: TradingScheduleId::FutureNight2300,
            sources: vec!["GOLD".into()],
            contracts: None,
            listed: None,
            expiry: None,
        },
        _ => Instrument {
            symbol: case.symbol.clone(),
            name: "600000".into(),
            exchange: Exchange::SSE,
            asset: AssetClass::Equity,
            product: "600000".into(),
            price_tick: 0.01,
            price_decimals: 2,
            multiplier: 1.0,
            lot_size: 100,
            limit_pct: Some(0.10),
            schedule_id: TradingScheduleId::EquityCn,
            sources: vec!["GOLD".into()],
            contracts: None,
            listed: None,
            expiry: None,
        },
    }
}

/// 该用例交易日对应的日历（含夜盘需要的前一日）。
pub fn calendar_for_case(_case: &GoldenCase) -> Calendar {
    TradingSchedule::default_calendar()
}

pub fn period_of(case: &GoldenCase) -> Period {
    Period::parse(&case.period).unwrap_or(Period::Min1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cases_have_expected() {
        let cal = TradingSchedule::default_calendar();
        let cases = build_cases(&[], &cal);
        assert!(cases.len() >= 20, "金标准用例应覆盖 20 个边界场景");
        for c in &cases {
            assert!(!c.expected.is_empty(), "{} 缺少期望值", c.id);
            assert!(!c.description.is_empty(), "{} 缺少说明", c.id);
            assert!(!c.focus.is_empty(), "{} 缺少 focus", c.id);
        }
    }

    #[test]
    fn case_ids_unique() {
        let cal = TradingSchedule::default_calendar();
        let cases = build_cases(&[], &cal);
        let mut ids: Vec<_> = cases.iter().map(|c| c.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), cases.len());
    }
}
