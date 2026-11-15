#!/usr/bin/env python3
"""
独立交叉校验：用 Python 从原始消息重新聚合 1m K 线，与引擎输出逐根比对。

这个脚本 **不引用 Rust 引擎的任何代码** —— 它按 docs/rules.md 独立实现：
窗口切分（R10）、集合竞价归属（R04）、交易日归属（R03）、
多源合并与缺口补数（R50/R51）、冲正（R20/R21）、异常隔离（R40/R42）。

用途：确认 bar 构造算法本身与实现无关、可被第三方复现。

已知**不覆盖**的细节（因此会有 0-1 根 bar 的差异，均属预期）：
- 多源合并后事件的精确排序（引擎用全局重排的 seq，本脚本用原始 seq）；
- 迟到冲正、冲正后再更正等复杂时序；
- 除权日的前收盘基准（本脚本不读除权事件）。

用法：
    python3 -I tools/crosscheck.py --data data/sim --symbol 600000.SH --date 2026-03-03
    python3 -I tools/crosscheck.py --all
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

MS = 1
MINUTE = 60_000


def ts_of(s):
    """本地时间字符串 -> 本地时间戳（当作 UTC）"""
    s = s.strip()
    fmts = ["%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
    for f in fmts:
        try:
            dt = datetime.strptime(s, f).replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(s)


def hm(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")


def date_of(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


# 交易日 -> 时段（分钟偏移，相对交易日本地零点）
SESSIONS = {
    "equity": {
        "auctions": [(555, 565, "open"), (897, 900, "close")],   # 09:15-09:25, 14:57-15:00
        "continuous": [(570, 690), (780, 897)],                    # 09:30-11:30, 13:00-14:57
        "night": False,
    },
    "future_2300": {
        "auctions": [(-185, -180, "open"), (535, 540, "open")],    # 20:55-21:00, 08:55-09:00
        "continuous": [(-180, -60), (540, 615), (630, 690), (810, 900)],
        "night": True,
    },
    "future_0230": {
        "auctions": [(-185, -180, "open"), (535, 540, "open")],
        "continuous": [(-180, 150), (540, 615), (630, 690), (810, 900)],
        "night": True,
    },
    "index_future": {
        "auctions": [],
        "continuous": [(570, 690), (780, 900)],
        "night": False,
    },
}


def windows_for(day_start, sched):
    """返回 (1m 窗口列表, 竞价窗口) —— 按 R10/R04 独立推导。

    窗口 = (start, end]，每个连续段首根左闭。
    """
    out = []       # (start, end, label, start_closed, auction_only)
    auctions = []
    for (a, b, kind) in sched["auctions"]:
        auctions.append((day_start + a * MINUTE, day_start + b * MINUTE, kind))
    # 连续段（A 股收盘竞价段并入网格尾部）
    conts = []
    for (a, b) in sched["continuous"]:
        s, e = day_start + a * MINUTE, day_start + b * MINUTE
        conts.append([s, e, False])
    for (as_, ae, kind) in auctions:
        if kind == "close":
            for c in reversed(conts):
                if c[1] == as_:
                    c[1] = ae
                    c[2] = True
                    break
    for (s, e, closing) in conts:
        cur = s
        first = True
        ws = []
        while cur < e:
            nxt = min(cur + MINUTE, e)
            ws.append((cur, nxt, nxt, first, closing and nxt == e))
            first = False
            cur = nxt
        out.extend(ws)
    # 开盘竞价单独成 bar（只对 A 股式：attach=first_bar）
    for (as_, ae, kind) in auctions:
        if kind == "open" and sched is SESSIONS["equity"]:
            label = min(c[0] for c in conts)
            out.append((as_, ae, label, True, True))
    out.sort(key=lambda w: (w[2], w[0]))
    return out, auctions


def assign_trade_date(ts, sched, trading_days):
    """R03：夜盘归属。"""
    d = date_of(ts)
    if not sched["night"]:
        return d
    m = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    hhmm = m.hour * 60 + m.minute
    if hhmm >= 20 * 60:
        # 下一个交易日
        for td in trading_days:
            if td > d:
                return td
        return d
    return d


def in_segment(ts, day_start, sched):
    """是否在任一交易时段（含竞价撮合时刻）。"""
    m = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    hhmm = m.hour * 60 + m.minute + m.second / 60.0
    for (a, b) in sched["continuous"]:
        if a <= hhmm <= b:
            return True
    for (a, b, _) in sched["auctions"]:
        # 只有撮合时刻允许成交（b 分钟整点）
        if abs(hhmm - b) < 1e-9:
            return True
    return False


def apply_reversals(trades, msgs, date):
    """独立实现的冲正（R20/R21）：撤销、废单、更正。

    注意：只处理引用到的成交；更正按新值替换。
    """
    # trades 里的每项需要 trade_id —— 在合并时带上
    by_id = {t["trade_id"]: t for t in trades if "trade_id" in t}
    order_of_trade = {m["trade"]["trade_id"]: m["trade"].get("order_id")
                      for m in msgs if m["kind"] == "trade" and m.get("trade")}
    for t in trades:
        t.setdefault("trade_id", "")
    removed = set()
    replaced = {}
    # 只处理**本交易日**的冲正：跨交易日的冲正（如 03-02 的撤单引用 03-03 的成交）在
    # 这里是另一天的账本，本脚本按单日独立处理。
    for m in msgs:
        if m["source"] != "A":
            continue
        if m["kind"] == "trade_cancel" and m.get("ref_trade_id"):
            removed.add(m["ref_trade_id"])
        elif m["kind"] == "order_reject" and m.get("ref_order_id"):
            # 该委托下的全部成交
            for tid, oid in order_of_trade.items():
                if oid == m["ref_order_id"]:
                    removed.add(tid)
        elif m["kind"] == "trade_correct" and m.get("ref_trade_id"):
            ref = m["ref_trade_id"]
            corr = m.get("correction") or {}
            if corr.get("action") == "delete":
                removed.add(ref)
            elif corr.get("action") == "amend" and ref in by_id:
                t = dict(by_id[ref])
                if corr.get("price") is not None:
                    t["price"] = corr["price"]
                if corr.get("volume") is not None:
                    t["volume"] = corr["volume"]
                if corr.get("ts") is not None:
                    t["ts"] = corr["ts"]
                replaced[ref] = t
    out = []
    for t in trades:
        tid = t["trade_id"]
        if tid in removed:
            continue
        out.append(replaced.get(tid, t))
    return out


def apply_reversals_scoped(trades, msgs):
    """按单日账本处理冲正：只冲正**本日 trades 列表内**存在的成交。

    这与引擎的 DayLedger 语义一致——冲正只能作用于已入账的成交。
    """
    by_id = {t["trade_id"]: t for t in trades if t.get("trade_id")}
    order_of_trade = {m["trade"]["trade_id"]: m["trade"].get("order_id")
                      for m in msgs if m["kind"] == "trade" and m.get("trade")}
    removed, replaced = set(), {}
    for m in msgs:
        if m["source"] != "A":
            continue
        k = m["kind"]
        if k == "trade_cancel" and m.get("ref_trade_id") in by_id:
            removed.add(m["ref_trade_id"])
        elif k == "order_reject" and m.get("ref_order_id"):
            oid = m["ref_order_id"]
            for tid in list(by_id):
                if order_of_trade.get(tid) == oid:
                    removed.add(tid)
        elif k == "trade_correct" and m.get("ref_trade_id") in by_id:
            ref = m["ref_trade_id"]
            corr = m.get("correction") or {}
            if corr.get("action") == "delete":
                removed.add(ref)
            elif corr.get("action") == "amend" and ref in by_id:
                t = dict(by_id[ref])
                if corr.get("price") is not None:
                    t["price"] = corr["price"]
                if corr.get("volume") is not None:
                    t["volume"] = corr["volume"]
                if corr.get("ts") is not None:
                    t["ts"] = corr["ts"]
                replaced[ref] = t
    return [replaced.get(t["trade_id"], t) for t in trades if t["trade_id"] not in removed]


def filter_anomalies(trades, prev_close, jump_pct=0.05, limit_pct=0.10):
    """独立实现的异常隔离（R40-R42）：跳变 + 涨跌停。

    注意：这是交叉校验器的**独立**实现，不是调用引擎。
    参考价取当日上一笔有效成交，首笔用昨收。
    """
    out = []
    ref = prev_close
    for t in trades:
        p = t["price"]
        # 涨跌停（股票，10%）
        if prev_close and limit_pct:
            up = round(prev_close * (1 + limit_pct) + 1e-9, 2)
            dn = round(prev_close * (1 - limit_pct) + 1e-9, 2)
            if p > up + 1e-6 or p < dn - 1e-6:
                continue
        # 跳变（相对参考价）
        if ref and abs(p / ref - 1) > jump_pct:
            continue
        out.append(t)
        ref = p
    return out


def build_1m(trades, day_start, sched):
    """用独立实现的窗口归属构造 1m bar。"""
    windows, auctions = windows_for(day_start, sched)
    slots = {i: [] for i in range(len(windows))}
    for t in trades:
        ts = t["ts"]
        # 竞价 = 消息自带 auction 标记，或时间戳恰为撮合时刻（竞价段终点）
        auction = t.get("auction", False) or any(abs(ts - ae) < 1 for (_, ae, _) in auctions)
        placed = False
        for i, (s, e, label, closed, auc_only) in enumerate(windows):
            ok = (ts >= s and ts <= e) if closed else (ts > s and ts <= e)
            if not ok:
                continue
            if auc_only and not auction:
                continue
            if not auc_only and auction and auc_only is False:
                pass
            slots[i].append(t)
            placed = True
            break
        if not placed:
            # 竞价窗口之外的竞价成交（期货 pattern，时间恰在段首）已由上方处理
            continue
    bars = []
    for i, (s, e, label, closed, auc_only) in enumerate(windows):
        ts_list = slots[i]
        if not ts_list:
            continue
        ts_list.sort(key=lambda t: t["seq"])
        o = ts_list[0]["price"]
        c = ts_list[-1]["price"]
        prices = [t["price"] for t in ts_list]
        v = sum(t["volume"] for t in ts_list)
        # 竞价量：消息标记为 auction，或时间戳恰为竞价撮合时刻（引擎同口径）
        match_instants = [ae for (_, ae, _) in auctions]
        av = sum(t["volume"] for t in ts_list
                 if t.get("auction") or any(abs(t["ts"] - ae) < 1 for ae in match_instants))
        n = len(ts_list)
        to = sum(t["price"] * t["volume"] * 1 for t in ts_list)
        bvol = sum(t["volume"] for t in ts_list if t["side"] == "B")
        svol = sum(t["volume"] for t in ts_list if t["side"] == "S")
        bars.append(dict(t=label, end=hm(label), o=o, h=max(prices), l=min(prices), c=c,
                         v=v, to=round(to, 4), n=n, bvol=bvol, svol=svol, av=av,
                         auction_only=auc_only))
    bars.sort(key=lambda b: b["t"])
    return bars


def load_messages(data, symbol):
    fn = os.path.join(data, "messages", symbol.replace(".", "_") + ".jsonl")
    out = []
    with open(fn) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def a_msg_ts(a_msgs, seq):
    """某条 A 源消息的事件时间。"""
    for m in a_msgs:
        if m["seq"] == seq:
            if m.get("trade"):
                return m["trade"]["ts"]
            if m.get("snapshot"):
                return m["snapshot"]["ts"]
            return m["recv_ts"]
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/sim")
    ap.add_argument("--symbol", default="600000.SH")
    ap.add_argument("--date", default="2026-03-03")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--api", default="http://127.0.0.1:8911")
    args = ap.parse_args()

    import urllib.request

    meta = json.load(open(os.path.join(args.data, "dataset.json")))
    inst = next(i for i in meta["instruments"] if i["symbol"] == args.symbol)
    sched_id = inst["schedule_id"]
    # 兼容两种序列化形式（EquityCn / equity_cn）
    key = sched_id.lower() if sched_id[0].isupper() else sched_id
    key = {"equitycn": "equity_cn", "futurenight2300": "future_night_2300",
           "futurenight0230": "future_night_0230", "indexfuture": "index_future"}.get(key, key)
    sched = {"equity_cn": SESSIONS["equity"],
             "future_night_2300": SESSIONS["future_2300"],
             "future_night_0230": SESSIONS["future_0230"],
             "index_future": SESSIONS["index_future"]}[key]
    trading_days = meta["calendar"]["trading_days"]
    prev_closes = {p["trade_date"]: p["price"] for p in meta["prev_closes"] if p["symbol"] == args.symbol}

    # 引擎输出
    url = f"{args.api}/api/bars?symbol={urllib.parse.quote(args.symbol)}&period=1m&date={args.date}"
    engine = json.load(urllib.request.urlopen(url))["bars"]

    # 独立计算
    msgs = load_messages(args.data, args.symbol)
    # 多源合并（R50/R51）：主源 A 骨架。
    # B 源只在 **A 有真实序号缺口** 的时间窗内补数（R51），
    # 否则 B 独有的成交不并入（A 源没缺说明它本就该没有这条）。
    a_msgs = [m for m in msgs if m["source"] == "A"]
    a_seqs = sorted({m["seq"] for m in a_msgs})
    # 缺口窗口：(gap_lo_seq, gap_hi_seq) -> (prev_ts, next_ts)
    gap_windows = []
    for prev, cur in zip(a_seqs, a_seqs[1:]):
        if cur > prev + 1:
            pt = a_msg_ts(a_msgs, prev)
            nt = a_msg_ts(a_msgs, cur)
            gap_windows.append((pt, nt))
    a_tids = {m["trade"]["trade_id"] for m in a_msgs
              if m["kind"] == "trade" and m.get("trade")}

    def in_gap_window(ts):
        return any(lo < ts <= hi for (lo, hi) in gap_windows)

    trades = []
    seen = set()
    for m in msgs:
        if m["kind"] != "trade":
            continue
        t = m["trade"]
        if t["trade_id"] in seen:
            continue
        if m["source"] != "A":
            # B 源：只补 A 缺失的 trade_id，且必须落在 A 的缺口时间窗内
            if t["trade_id"] in a_tids or not in_gap_window(t["ts"]):
                continue
        seen.add(t["trade_id"])
        td = assign_trade_date(t["ts"], sched, trading_days)
        if td != args.date:
            continue
        trades.append(dict(ts=t["ts"], price=t["price"], volume=t["volume"],
                           side=t["side"], auction=t.get("auction", False), seq=m["seq"],
                           trade_id=t["trade_id"]))
    day_start = ts_of(args.date + " 00:00:00")
    prev = prev_closes.get(args.date)
    trades = apply_reversals_scoped(trades, msgs)
    # 冲正后需要按 (ts, seq) 重新排序
    trades = filter_anomalies(trades, prev)
    mine = build_1m(trades, day_start, sched)

    # 比对
    emap = {b["end"][:5]: b for b in engine}
    mmap = {b["end"][:5]: b for b in mine}
    keys = sorted(set(emap) | set(mmap))
    mism = 0
    for k in keys:
        e, m = emap.get(k), mmap.get(k)
        if not e or not m:
            print(f"  缺 bar {k}: engine={e is not None} mine={m is not None}")
            mism += 1
            continue
        for f in ["o", "h", "l", "c", "v", "n", "bvol", "svol", "av"]:
            ev, mv = e[f], m[f]
            if isinstance(ev, float):
                ok = abs(ev - mv) < 1e-6
            else:
                ok = ev == mv
            if not ok:
                print(f"  差异 {k} {f}: engine={ev} mine={mv}")
                mism += 1
                break
    print(f"{args.symbol} {args.date}: engine {len(engine)} bars, python {len(mine)} bars, 差异 {mism}")
    return 0 if mism == 0 else 1


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
