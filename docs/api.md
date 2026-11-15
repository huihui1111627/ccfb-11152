# 行情加工引擎 — HTTP API 契约 (v1)

所有响应均为 `application/json; charset=utf-8`。

**时间戳约定（重要）**：所有 `ts` / `t` / `s` / `e` 字段都是 **“本地时间戳”**——把交易所本地时间
（UTC+8，无夏令时）当作 UTC 直接换算得到的 epoch 毫秒。它等于真实 epoch 毫秒 **减 8 小时**。
这样任何时刻都可以用 `new Date(ts).toISOString()` 直接得到 `YYYY-MM-DDTHH:MM:SS`，
前端**不要**再做时区转换（不要用 `getHours()` 等本地时间方法，用 `getUTC*`）。
示例：`2026-03-02 09:31:00` → `1772443860000`（本地）→ 真实 epoch 为 `1772383860000`。

服务默认监听 `http://127.0.0.1:8899`。静态页面位于 `/`。

## 1. `GET /api/meta`

```json
{
  "dataset": "sim-2026-03-02",
  "generated_at": "2026-03-06T15:30:00+08:00",
  "engine_version": "0.1.0",
  "periods": ["1m", "5m", "15m", "30m", "60m", "1d"],
  "adjust_modes": ["none", "forward", "backward"],
  "trading_days": ["2026-02-27", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"],
  "instruments": [
    {
      "symbol": "600000.SH",
      "name": "浦发银行",
      "exchange": "SSE",
      "asset": "equity",
      "product": "600000",
      "price_tick": 0.01,
      "price_decimals": 2,
      "multiplier": 1.0,
      "lot_size": 100,
      "limit_pct": 0.1,
      "schedule_id": "equity_sse",
      "sources": ["A", "B"],
      "contracts": null
    },
    {
      "symbol": "rb2601",
      "name": "螺纹钢2601",
      "exchange": "SHFE",
      "asset": "future",
      "product": "rb",
      "price_tick": 1.0,
      "price_decimals": 0,
      "multiplier": 10.0,
      "lot_size": 1,
      "limit_pct": null,
      "schedule_id": "shfe_night_2300",
      "sources": ["A", "B"],
      "contracts": ["rb2601", "rb2605", "rb2610"]
    }
  ]
}
```

`instruments[].contracts` 仅期货品种（同一 product 的合约列表），用于主力连续。

## 2. `GET /api/sessions?symbol=600000.SH&date=2026-03-02`

交易日（trade_date）的时段结构；夜盘时段的 `calendar_date` 可能是前一自然日。

```json
{
  "symbol": "600000.SH",
  "trade_date": "2026-03-02",
  "calendar_dates": ["2026-03-02"],
  "prev_close": 10.00,
  "segments": [
    {"kind": "auction", "label": "开盘集合竞价", "start": 1772442900000, "end": 1772443500000, "hm": "09:15-09:25", "attach": "first_bar"},
    {"kind": "continuous", "label": "上午", "start": 1772443800000, "end": 1772451000000, "hm": "09:30-11:30", "attach": null},
    {"kind": "continuous", "label": "下午", "start": 1772456400000, "end": 1772463600000, "hm": "13:00-15:00", "attach": null},
    {"kind": "auction", "label": "收盘集合竞价", "start": 1772463420000, "end": 1772463600000, "hm": "14:57-15:00", "attach": "last_bar"}
  ],
  "halts": [
    {"start": 1772446800000, "end": 1772448600000, "hm": "10:20-10:50", "label": "临时停牌"}
  ]
}
```

## 3. `GET /api/bars`

Query:

| 参数 | 必填 | 说明 |
|---|---|---|
| `symbol` | 是 | 合约代码 |
| `period` | 是 | `1m`/`5m`/`15m`/`30m`/`60m`/`1d` |
| `date` | 否 | 交易日 `YYYY-MM-DD`；缺省返回全部 |
| `date_from`,`date_to` | 否 | 闭区间 |
| `adjust` | 否 | `none`(默认)/`forward`/`backward`；期货忽略 |
| `limit` | 否 | 最大条数（默认 2000，从最新往回截断） |

```json
{
  "symbol": "600000.SH",
  "period": "1m",
  "adjust": "none",
  "source": "merged",
  "bars": [
    {
      "i": 0,
      "t": 1772443860000,
      "end": "09:31:00",
      "date": "2026-03-02",
      "o": 10.01, "h": 10.03, "l": 10.00, "c": 10.02,
      "v": 12800, "to": 128128.0,
      "oi": null,
      "n": 37,
      "bvol": 6200, "svol": 6600,
      "av": 4000, "syn": 0, "cv": 0,
      "flags": ["auction"],
      "seq0": 1001, "seq1": 1037
    }
  ],
  "meta": {
    "count": 241,
    "first": "2026-03-02 09:31:00",
    "last": "2026-03-02 15:00:00",
    "first_seq": 1001,
    "last_seq": 1241,
    "note": "前复权基于最近交易日为基准"
  }
}
```

字段：`i` 序号，`t` bar 结束时间（Unix ms，Bar 标签时间），`v` 成交量（股/手），`to` 成交额（元），
`oi` 持仓量（期货，日线/快照），`n` 成交笔数，`bvol`/`svol` 主买/主卖量，
`av` 集合竞价量，`syn` 补数合成量，`cv` 被撤单冲正量，`seq0`/`seq1` 消息序号范围。
`flags` 取值：`auction`、`synthetic`、`canceled`、`corrected`、`halt_overlap`、`gap_unfilled`、`empty_fill`。

## 4. `GET /api/replay?symbol=600000.SH&date=2026-03-02`

回放所需的全量数据（客户端按游标播放）。

```json
{
  "symbol": "600000.SH",
  "trade_date": "2026-03-02",
  "prev_close": 10.00,
  "sessions": [ /* 同 /api/sessions.segments */ ],
  "halts": [ /* 同上 */ ],
  "grids": {
    "1m": [{"s": 1772443800000, "e": 1772443860000}, {"s": 1772443860000, "e": 1772443920000}],
    "5m": [{"s": 1772443800000, "e": 1772444100000}]
  },
  "trades": [
    {"i": 0, "ts": 1772443800000, "p": 10.01, "v": 100, "side": "B",
     "id": "T1772443800000-1", "src": "A", "syn": false, "auction": false, "flags": []}
  ],
  "anomalies": [ /* 结构同 /api/anomalies.items，仅当日 */ ],
  "bars": {
    "1m": [ /* 结构同 /api/bars.bars，仅当日 */ ],
    "5m": [ ]
  }
}
```

`grids` 给出每个周期当日**全部** bar 窗口（含空窗口），前端据此把游标之后的成交聚合为“正在形成”的 bar。
窗口语义：`(s, e]`，第一个窗口为 `[s, e]`。

## 5. `GET /api/factors?symbol=600000.SH`

```json
{
  "symbol": "600000.SH",
  "asset": "equity",
  "rows": [
    {
      "ex_date": "2026-03-04",
      "cash_div": 0.35,
      "bonus": 0.3,
      "rights": 0.1,
      "rights_price": 5.0,
      "prev_close": 10.50,
      "q": 0.86285714,
      "p_ex": 9.06,
      "forward_factor": 0.86285714,
      "backward_factor": 1.0,
      "note": "10派3.5元送3股配1股@5元"
    }
  ],
  "series": [
    {"date": "2026-02-27", "forward": 0.86285714, "backward": 1.0},
    {"date": "2026-03-04", "forward": 1.0, "backward": 1.15942029}
  ],
  "definitions": {
    "q": "除权价/除权前收盘价 = (prev_close - cash_div + rights*rights_price) / (prev_close*(1+bonus+rights))",
    "forward": "前复权因子 P_adj(t)=P_raw(t)*∏_{ex_date>t}q；基准=最新交易日",
    "backward": "后复权因子 P_adj(t)=P_raw(t)/∏_{ex_date<=t}q；基准=最早交易日"
  }
}
```

## 6. `GET /api/reconcile`

```json
{
  "summary": {
    "cases": 12,
    "bars": 58,
    "matched": 56,
    "mismatched": 2,
    "field_diffs": 3,
    "generated_at": "2026-03-06T15:30:00+08:00"
  },
  "cases": [
    {
      "id": "G03",
      "title": "午休边界：11:30:00.000 归上午最后一根",
      "symbol": "600000.SH",
      "period": "1m",
      "status": "pass",
      "bar_count": 4,
      "mismatch_count": 0,
      "rules": ["left-open-right-closed", "11:30:00.000 -> 11:30 bar"],
      "fixture": "data/golden/G03_lunch_boundary.json"
    }
  ],
  "diffs": [
    {
      "case_id": "G07",
      "symbol": "600000.SH",
      "period": "1m",
      "trade_date": "2026-03-02",
      "bar_t": 1772443860000,
      "bar_end": "09:31:00",
      "field": "v",
      "expected": 300,
      "actual": 200,
      "reason": "成交 T3 (09:30:59.900) 被错误归入 09:31 bar：边界应为左开右闭",
      "trade_ids": ["T3"]
    }
  ]
}
```

## 7. `GET /api/reconcile/{case_id}`

```json
{
  "case": { /* cases[] 中一项 */ },
  "description": "人工推导说明（Markdown 文本）",
  "trades": [
    {"id": "T1", "ts": 1772443800000, "hm": "09:30:00.000", "p": 10.00, "v": 100, "side": "B", "auction": false}
  ],
  "expected": [
    {"t": 1772443860000, "end": "09:31:00", "o": 10.0, "h": 10.1, "l": 10.0, "c": 10.1, "v": 300, "to": 0.0, "n": 3}
  ],
  "actual": [ /* 引擎输出同结构 */ ],
  "diffs": [ /* 同 reconcile.diffs 中该 case 的条目 */ ]
}
```

## 8. `GET /api/anomalies`

Query: `kind`(可选), `symbol`(可选), `severity`(可选), `limit`(默认 500), `date`(可选)。

```json
{
  "total": 37,
  "items": [
    {
      "id": "AN00017",
      "ts": 1772533800000,
      "hm": "10:30:00.000",
      "date": "2026-03-03",
      "symbol": "600000.SH",
      "source": "B",
      "kind": "price_jump",
      "severity": "warn",
      "detail": "成交价 12.30 相对参考价 10.00 偏离 +23.0%，超过阈值 11%",
      "trade_id": "B-00931",
      "seq": 5931,
      "action": "isolated"
    }
  ]
}
```

`kind` 取值：`price_jump`、`volume_spike`、`timestamp_inversion`、`out_of_session`、`duplicate_seq`、
`seq_gap`、`seq_gap_filled`、`invalid_tick`、`limit_breach`、`trade_during_halt`、`cancel_unknown`、
`correction_unknown`、`late_correction`、`source_conflict`、`bad_price`、`bad_volume`。
`severity`：`info`/`warn`/`error`。`action`：`isolated`/`filled`/`kept`/`ignored`。

## 9. `GET /api/sources`

```json
{
  "items": [
    {
      "symbol": "600000.SH", "source": "A", "channel": 1,
      "received": 48211, "duplicates": 2, "gaps": 3,
      "filled_trades": 7, "filled_volume": 2300, "unfilled": 0,
      "first_seq": 1, "last_seq": 48211
    }
  ]
}
```

## 10. `GET /api/continuous?product=rb&period=1d`

```json
{
  "product": "rb",
  "period": "1d",
  "main": [
    {"date": "2026-02-27", "contract": "rb2601", "oi": 182000, "volume": 51000},
    {"date": "2026-03-04", "contract": "rb2605", "oi": 205000, "volume": 64000}
  ],
  "rolls": [
    {"date": "2026-03-04", "from": "rb2601", "to": "rb2605", "ratio": 1.0132,
     "old_close": 3520.0, "new_close": 3566.0}
  ],
  "bars": [
    {"t": 1772443800000, "date": "2026-02-27", "contract": "rb2601",
     "o": 3500, "h": 3520, "l": 3490, "c": 3510, "v": 51000, "oi": 182000,
     "o_adj": 3465.1, "h_adj": 3484.9, "l_adj": 3455.2, "c_adj": 3475.0, "roll": false}
  ]
}
```

## 11. `GET /api/consistency`

内部一致性核对（日线 vs 分钟线汇总、各周期互相校验）。

```json
{
  "summary": {"checked": 24, "ok": 24, "failed": 0},
  "items": [
    {"symbol": "600000.SH", "date": "2026-03-02", "kind": "1d_vs_1m",
     "volume_1d": 12800000, "volume_1m": 12800000, "turnover_1d": 128600000.0,
     "turnover_1m": 128600000.0, "ok": true, "diff": ""}
  ]
}
```

## 12. 错误响应

HTTP 4xx/5xx，body：

```json
{"error": "unknown_symbol", "message": "symbol 600001.SH 未在数据集中"}
```
