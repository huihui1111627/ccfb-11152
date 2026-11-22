# SWIM / Lifeguard 成员协议仿真台

面向巡演控制网的成员协议实现与确定性网络仿真器:几十到几百台灯光、吊挂、票务闸机在
场馆里临时组网,任何一台卡顿都不能被误判为下线(否则整场吊挂联锁全停)。本仓库包含

- `internal/swim` — Go 实现的 SWIM 成员协议 + Lifeguard 扩展,跑在离散事件网络仿真器上;
- `cmd/swimsim` — 批量/对照实验,输出可复现的统计报告与论文理论值对照;
- `cmd/swimweb` + `web/` — 成员表 / 探测时间线 / 怀疑与确认事件 / 消息负载与误判 的可视化页面。

## 快速开始

```bash
# 单元测试(含确定性、误判、理论值校验)
go test ./...

# 单次详细仿真,写出带完整轨迹的 JSON
go run ./cmd/swimsim -mode detail -scenario crash -seed 1 -out run.json

# Lifeguard vs 基础 SWIM 对照,20 个种子
go run ./cmd/swimsim -mode compare -seeds 20 -out compare.json

# 可视化页面
go run ./cmd/swimweb -addr 127.0.0.1:8080
# 打开 http://127.0.0.1:8080
```

## 协议要点与实现位置

| 要求 | 实现 |
| --- | --- |
| 1. 每轮直接探测一个成员,超时后由 k 个成员间接探测 | `node.go` `startProbe` / `indirectPhase` / `handlePingReq` |
| 2. 探测失败先标怀疑,超过怀疑时限才确认下线 | `raiseSuspect` / `armSuspicion` / `suspicionExpired` |
| 3. 化身号;被怀疑者以更大化身号反驳 | `handleSelfUpdate` / `observeSender`；优先级见 `applyUpdate` |
| 4. 成员变化捎带在探测/应答中,按传播上限淘汰 | `pickGossip` / `gossipLearn` / `pruneGossip`,`maxTx = λ·log(n+1)` |
| 5. Lifeguard:慢节点降低自身怀疑力度;独立确认缩短怀疑时限 | `bumpLHM`、`interval`/`probeTimeout`、`noteIndependentSuspect` + `config.SuspicionTimeout` |
| 6. 打乱后轮转选择探测目标,有限轮内必被探测 | `nextTarget`(遍历一遍后重洗,新成员随机插入) |
| 7. 加入/主动离开快速传播 | `handleJoin` / `handleJoinAck`(握手 + 广播)、`leave`(推送 + 重新传播) |
| 8. 报文大小上限,放不下先放传播次数少的 | `Config.MaxPiggyback`、`pickGossip`(按 per-peer 未发送 + 发送次数排序) |

### 化身前缀与优先级(SWIM §4.2)

`Alive(inc=i)` 覆盖 `Suspect(inc=i)` 与所有更低化身号;`Suspect(inc=i)` 覆盖
`Alive(inc=i)`;`Confirm` **只能**被更高化身号的 `Alive` 覆盖——否则分区恢复后两侧会
在"死亡/存活"之间反复抖动。被误判死亡的成员通过收到关于自己的 `Suspect/Confirm`
或 `dead-notice` 得知,自增化身号后广播 `Alive`。

### Lifeguard 细节

- **Local Health Aware Probe**:探测成功 −1、失败 +1、反驳对自己 −1、间接探测未收到
  nack +1,计数器 LHM ∈ [0,8] 用来放大探测间隔与超时。
- **Local Health Aware Suspicion**:`SuspicionTimeout = max(Min, Max − (Max−Min)·log(C+1)/log(K+1))`,
  `Min = α·log10(n)·T`,`Max = β·Min`。默认 α=5、β=6(论文评测配置),K=3。
- **Buddy System**:捎带时优先把关于目标成员的怀疑直接推给它,使其尽早反驳。

## 确定性

同一场景 + 同一种子 ⇒ 逐字节一致的运行结果。手段:

- 自实现的 splitmix64 PRNG(`rand.go`),序列只由本文件源码决定;
- 事件队列按 `(时间, 调度序号)` 全序弹出,不存在平局歧义;
- 任何影响行为或输出的 `map` 遍历都必须先排序(已审计);网络丢包/延迟用
  `Hash01(seed, packetID, …)` 独立推导,不依赖处理顺序;
- 运行摘要 `digest` 对确认事件、每秒流量、计数器与每成员流量做 SHA-256。

`-verify-determinism` 会把每个仿真跑两遍并比对 digest。

## 场景与指标

`go run ./cmd/swimsim -mode list` 列出内置场景:无故障基线、单点宕机、单台/多台卡顿、
网络分区、加入/离开风暴、高丢包。

指标:确认下线的平均/中位/P95 时间、误判次数(区分随机丢包导致与分区导致)、
每台每秒消息数与字节数、加入/离开传播延迟。

### 与论文理论值对照

`Result.Theory` 字段给出:

- **首次探测**:`T' / (1 − e^{−qf})`(SWIM §3.1),qf 为健康成员比例;
- **确认时间**:首次探测时间 + 怀疑时限;
- **消息量**:每成员每周期 2 条(ping + ack);
- **误判概率**:`qf·(1−qml²)·(1−qf·qml⁴)^k·e^qf/(e^qf−1)`。

## 结果解读(默认参数:α=5、β=6,300 成员)

- **卡顿 / 间歇拥塞 / 丢包**:Lifeguard 把误判降到接近 0。最贴近场馆拥塞的「间歇拥塞」场景
  (12 台设备反复卡顿)基础 SWIM 每场仍有约 288 次误判,Lifeguard 约 3 次——这正是"一台卡顿
  就全停"问题的直接对照;丢包场景约 116 → 14。
- **真实宕机**:确认时间约 15 s = 首次探测 ~1.6 s + 怀疑计时(初始 β·Min,随独立确认按对数
  缩短);比固定时限的基础 SWIM(约 13.6 s)略慢 1.5 s,这是 Lifeguard 用少量检测延迟换
  误判的固有取舍,与论文一致。
- **网络分区**:分区期间两半互相确认对方成员下线属于"当时的真实不可达",单独统计为
  `isolated_confirms`(基础 SWIM 更多)。分区恢复后,各观察者会独立地对正在恢复的对端各误判
  一次(每次一对、不重复),20 个种子平均每场 Lifeguard 约 314 次、基础 SWIM 约 70 次——
  这是 SWIM 在分区愈合期的固有收敛行为(被误判成员需得知自己被判死并自增化身号),并非
  稳定态;提高 β(如 β=20)可进一步压低误判,代价是真故障检测略慢。

关于 LHA-Suspicion 的**怀疑再传播**:默认关闭。它会放大分区期间的怀疑风暴(每台都成为独立
来源),使分区误判从约 325 升到约 2000,而在本组场景里并未带来误判收益。需要复现论文完整
LHA-Suspicion 时把 `Config.ReGossipSuspect` 设为 true。

## 目录

```
internal/swim/   协议、仿真器、统计
cmd/swimsim/     批量/对照/详情命令行
cmd/swimweb/     页面服务
web/             index.html / style.css / app.js
```
