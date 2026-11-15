# MarketKit — 行情加工与核对引擎

一套用 Rust 写的证券/期货逐笔行情加工引擎：把交易所逐笔成交、快照合成为各周期 K 线，
处理集合竞价/停牌/撤单冲正/除权除息/夜盘归属/多源合并/主力连续，
并附带一个可回放、可核对、能定位“为什么和行情软件对不上”的页面。

## 快速开始

```bash
# 1. 生成仿真数据（5 个品种 + 2 个同品种合约，6 个交易日，约 80 万条消息）
cargo run -q -p mk-cli -- --data data/sim gen

# 2. 命令行核对
cargo run -q -p mk-cli -- --data data/sim run          # 引擎摘要 + 异常召回
cargo run -q -p mk-cli -- --data data/sim check        # 跨周期一致性
cargo run -q -p mk-cli -- --data data/sim reconcile    # 金标准逐字段核对

# 3. 启动页面（http://127.0.0.1:8899）
cargo run -q -p mk-web -- --data data/sim --web web
```

首次启动会加载全部消息并跑一遍引擎（约 10–25 秒，取决于数据规模）。

## 目录结构

```
crates/
  mk-core/    领域模型：定点数、时段与交易日历、周期窗口、消息、因子、连续合约
  mk-engine/  加工引擎：多源合并 → 校验隔离 → 1m 账本 → 聚合
  mk-sim/     仿真器：按交易所规则生成多源逐笔/快照 + 金标准用例 + 异常注入
  mk-app/     应用层：API 载荷（CLI 与 HTTP 共用，保证口径一致）
  mk-cli/     命令行 mk（gen / run / check / reconcile / export / info）
  mk-web/     HTTP 服务 mkd（docs/api.md 定义的接口 + 静态页面）
web/          前端（无构建步骤，原生 JS + Canvas）
docs/
  rules.md          权威规则（R01–R72），引擎/仿真器/金标准/页面共同遵守
  api.md            HTTP API 契约
  implementation.md 关键设计决策、踩过的坑、与行情软件对不上的原因分析
tools/
  crosscheck.py     独立 Python 实现，从原始消息重算 1m 并与引擎逐根比对
data/
  sim/        dataset.json + messages/*.jsonl + golden/*.json
```

## 规则要点（详见 docs/rules.md）

| 主题 | 规则 | 说明 |
|---|---|---|
| 时间窗 | R10 | **左开右闭** `(start, end]`；每段连续竞价首根左边界取闭 |
| 集合竞价 | R04 | A 股开盘竞价单独成 `09:30` bar；收盘竞价并入 `15:00` bar；期货竞价并入段首 bar |
| 临时停牌 | R05 | 停牌期间无 bar；停牌内成交隔离；复牌首根不插值 |
| 撤单/废单/更正 | R20–R24 | 冲正后按**剩余成交**重算 OHLC；跨 bar 更正两端同时生效 |
| 除权除息 | R30–R33 | q=(P−D+R·RP)/(P·(1+B+R))；前复权基准=最新日，后复权基准=最早日 |
| 夜盘归属 | R03 | ≥20:00 归下一交易日；<08:00 归当自然日 |
| 异常隔离 | R40–R47 | 跳变/异常量/倒挂/越界/非整手等，隔离成交不进 K 线且不更新参考价 |
| 多源与补数 | R50–R53 | 主源骨架 + 对源补缺 + 快照差额合成匿名成交 |
| 主力连续 | R60–R63 | 持仓量连续 2 日超 5% 才切换；以最新合约为基准向前复权 |
| 一致性 | R70–R72 | 所有高周期由 1m 聚合，`Σ1m == Σ5m == … == 1d` |

## 金标准（“手算标准答案”）

`crates/mk-sim/src/golden.rs` 内有 20 个手工推导的边界用例（G01–G20），
每个用例包含**人工写的消息**和**手算的期望 OHLCVA**，不经过引擎计算。
`mk reconcile` 会在相同输入上跑引擎，逐 bar 逐字段比对，差异必须为 0。

覆盖：左开右闭边界、开盘/收盘竞价归属、午休边界、撤单冲正、跨 bar 更正、
5 分钟与 15 分钟聚合、夜盘归属、废单、无成交分钟、买卖方向、日线聚合、
期货 15m/30m 网格与残 bar、跌停价合法性、冲正后 bar 消失、只改数量的更正、
方向未知的成交、跨自然日零点仍属同一交易日。

## 页面

- **行情回放**：按游标播放逐笔，实时聚合“正在形成”的 1m/5m/15m/1d bar，
  回放中可见停牌区间与隔离成交。
- **K 线查询**：周期/复权/范围切换，K 线 + 成交量（集合竞价量单独着色），
  明细表含主买/主卖/竞价量/冲正量/标记位。
- **复权因子**：q、除权参考价、前/后复权因子、三口径价格对照。
- **数据核对**：20 个金标准的 PASS/FAIL、逐字段差异与原因码、跨周期一致性、
  异常注入召回率，以及“常见对不上原因”清单。
- **异常日志**：按类型/级别筛选，区分“隔离/补数/保留”。
- **多源/连续**：各源收包/缺号/补数/倒挂统计，主力合约与复权连续序列。

## 测试

```bash
cargo test              # 全部单元 + 集成测试
cargo test -p mk-app --test golden_reconcile   # 金标准必须全过
cargo test -p mk-web --test api                # API 载荷契约（需先 gen）
```

独立交叉校验（需要一个运行中的 `mkd`）：

```bash
python3 -I tools/crosscheck.py --data data/sim --symbol 600000.SH --date 2026-03-06
```

`mk-engine/tests/engine_rules.rs` 是引擎的规则级测试（17 个用例），
`mk-engine/tests/reversal_edge.rs` 覆盖冲正的边界（乱序、重复、更正后再撤销、日线传导）。
`mk-app/tests/golden_reconcile.rs` 断言金标准零差异。

## 已知边界与取舍

- 时间戳统一用“本地时间戳”（本地时间当 UTC），前端用 `getUTC*` 展示，见 docs/api.md。
- 引擎是批处理语义：先合并全部消息再回放，因此已发布的 bar 支持“撤回重发”。
- 仿真器的异常注入记录真值，`/api/injections` 用它计算召回率；当前数据集为 100%。
- 期货不适用复权，`/api/bars` 对期货的 forward/backward 请求返回 400。
- 空 bar 策略：1m 用 `omit`（与多数行情软件一致），高周期始终 `fill` 保证网格完整。
