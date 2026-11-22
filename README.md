# 容器资源规格推荐器（zooresourcer）

为动物园的售票、年卡核验、投喂预约、园内导览等容器化服务，按历史用量推荐处理器与
内存的**请求值（request）和上下限**，并提供一个可观察完整推荐过程的页面。用量数据
在程序内模拟，无需外部依赖。

## 快速开始

```bash
# 启动可视化页面（默认 300 容器 × 28 天，监听 :8080）
go run ./cmd/resourcer serve
# 自定义规模与端口
go run ./cmd/resourcer serve --containers 200 --days 14 --addr :9000

# 跑模拟并做暴力加权分位数校验，打印结论后退出
go run ./cmd/resourcer verify --containers 300 --days 28 --verify-n 24

# 单元测试
go test ./...
```

打开 `http://localhost:8080`，页面分四块：

1. **容器列表**：画像、当前 CPU/内存请求、OOM 次数，可按画像过滤/排序；
2. **用量直方图**：处理器与内存的指数桶宽直方图，柱高为时间衰减后的有效权重；
3. **推荐值与上下限随时间变化**：CPU/内存两张折线图，含当前请求、推荐目标、
   上下限区间、实际用量，并标注节点上限截断点与 OOM 驱动上调点；
4. **内存被杀事件**：实际 OOM 与“被推荐避免的 OOM”时间线。

## 需求与实现对照

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 处理器按指数增长桶宽分桶、样本按时间指数衰减加权、半衰期可配 | `internal/histogram`，`Config.CPUHalfLifeSec` |
| 2 | 内存每个聚合周期只记一个峰值样本 | `Recommender.ObserveMemory`，`MemAggregationPeriodSec` |
| 3 | 安全余量后按粒度向上取整（CPU 千分之一核、内存 MiB），超节点最大规格截断并标记 | `recommendCPU/recommendMemory`，`MilliCore/MiB`、`Capped` |
| 4 | 历史越短上下限越宽，按历史天数系数放宽，够长后收敛到分位本身 | `boundsFactor`，`MinHistoryDay/FullHistoryDay/MinBoundsFactor` |
| 5 | OOM 时把当时用量放大后作为样本，保证下次内存推荐一定更大 | `RecordOOM` + 持久 `oomFloor`，`OOMAmplification` |
| 6 | 启动头几分钟样本不计入，时长可配 | `inGracePeriod`，`StartupGraceSec`（OOM 重启后重新计算） |
| 7 | 上限/请求之比保持不变，请求改了上限同比例跟随；原未设上限则不设 | `limitRatio` + 跟随逻辑；并强制 `limit ≥ request` |
| 8 | 仅当当前请求落在上下限之外才建议改，改时按目标值 | `outsideBounds`，另含变更死区防抖 |

### 关键设计说明

- **衰减记账**：桶内保存折算到固定锚点的权重，样本权重为 `g(anchor,t)`，读取时
  除以 `g(anchor,now)` 还原成当前有效权重，`g(a,b)=2^((b-a)/halfLife)`。锚点可
  推进（rescale），观测均摊 O(1)。
- **内存只读推荐**：`Recommend` 不改变直方图状态。当前未结算周期的峰值以一个权重
  为 1 的虚拟样本参与分位计算（`memQuantile`），因此频繁读取不会把一个周期拆成
  多个样本，保证与“每周期一个峰值”的口径严格一致。
- **内存安全地板**：内存不可压缩，请求（及其按比例跟随的上限）不得低于近期峰值的
  高分位（`MemSafetyQ`），避免下调后容器在正常高峰被 OOM。
- **limit ≥ request 硬约束**：保留原始比例的同时，绝不允许上限低于请求，否则会
  形成“请求越高、上限反而越低”的 OOM 死循环。
- **OOM 后立即重算**：模拟中容器被杀后立刻重新推荐并应用，不等下一个整点，使
  上调规格在同一高峰窗口内即生效。

## 暴力校验（verify）

对随机抽取的容器保留**全部原始样本**，在每个校验抽点用直接加权分位数（线性插值的
`bruteQuantile`）与直方图分位数对比，误差上界取该值所在桶的桶宽（即分桶误差）。
校验覆盖：

- 处理器逐采样序列、内存“每周期峰值 + OOM 放大样本”序列，口径与推荐器完全一致；
- 启动保护期（含 OOM 重启保护期）样本同样剔除；
- 衰减权重另有独立单测，与手算公式 `2^(-age/halfLife)` 逐项核对。

`verify` 通过时会打印 `✅ 全部抽点……在分桶误差以内一致`。

## 典型输出

```
CPU 请求总量: 483.19 核 → 239.02 核，节省 244.18 核（50.5%）
内存请求总量: 646.5 GiB → 459.8 GiB，节省 186.7 GiB（28.9%）
OOM: 基线世界 3798 次，治理后实际 183 次，被避免 3615 次（减少 95.2%）
推荐调整事件: 528 次
✅ 全部抽点的直方图分位数与暴力加权分位数在分桶误差以内一致（0 条不一致）
```

## 目录结构

```
cmd/resourcer/            CLI 入口（serve / verify）
internal/histogram/       指数桶宽 + 时间指数衰减直方图
internal/recommender/     单容器推荐器，实现全部 8 条规则
internal/simulation/      合成用量曲线、模拟驱动、暴力校验与统计
internal/web/             HTTP API 与 go:embed 内嵌的可视化页面
```

所有参数（半衰期、保护期、聚合周期、余量、分位、粒度、节点上限、放大比例、死区等）
集中在 `recommender.DefaultConfig()`，可按需调整。
