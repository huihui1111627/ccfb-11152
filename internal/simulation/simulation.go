// Package simulation 生成几百个容器几十天的合成用量曲线并驱动推荐器，
// 同时保留部分容器的全部原始样本，用直接加权分位数（暴力法）核对分桶结果，
// 最后统计推荐省下的资源与 OOM 次数的变化。
package simulation

import (
	"fmt"
	"math"
	"math/rand"
	"sort"

	"zooresourcer/internal/recommender"
)

// Profile 容器用量曲线类型。
type Profile string

const (
	ProfileStable Profile = "stable" // 平稳
	ProfileDaily  Profile = "daily"  // 按天周期
	ProfileBurst  Profile = "burst"  // 突发
	ProfileOOM    Profile = "oom"    // 内存吃紧、会被杀
)

// TimelinePoint 某一时刻容器的推荐快照（供页面折线图）。
type TimelinePoint struct {
	AtSec        float64 `json:"atSec"`
	CPUCurrent   float64 `json:"cpuCurrent"`
	CPUTarget    float64 `json:"cpuTarget"`
	CPULower     float64 `json:"cpuLower"`
	CPUUpper     float64 `json:"cpuUpper"`
	MemCurrent   float64 `json:"memCurrent"`
	MemTarget    float64 `json:"memTarget"`
	MemLower     float64 `json:"memLower"`
	MemUpper     float64 `json:"memUpper"`
	CPUUsage     float64 `json:"cpuUsage"`
	MemUsage     float64 `json:"memUsage"`
	BoundsFactor float64 `json:"boundsFactor"`
	HistoryDays  float64 `json:"historyDays"`
	CPUChange    bool    `json:"cpuChange"`
	MemChange    bool    `json:"memChange"`
	CPUCapped    bool    `json:"cpuCapped"`
	MemCapped    bool    `json:"memCapped"`
	MemOOMDriven bool    `json:"memOomDriven"`
}

// OOMInfo 页面用的 OOM 事件。
type OOMInfo struct {
	ContainerID string  `json:"containerId"`
	Name        string  `json:"name"`
	AtSec       float64 `json:"atSec"`
	Usage       float64 `json:"usage"`
	Amplified   float64 `json:"amplified"`
	Prevented   bool    `json:"prevented"` // true=仅基线世界发生（推荐后被避免）
}

// Container 一个模拟容器及其推荐器状态。
type Container struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Profile Profile `json:"profile"`

	rec *recommender.Recommender

	// 用量曲线参数。
	cpuBase   float64
	cpuAmp    float64
	cpuNoise  float64
	memBase   float64
	memAmp    float64
	memNoise  float64
	burstRate float64 // 每 tick 发生突发的概率
	oomRate   float64 // 每 tick 触发内存峰值的概率（OOM 型）
	phase     float64 // 日周期相位

	// 基线世界：全程不应用任何推荐，用来统计不治理时的 OOM。
	baselineMemLimit  float64
	baselineOOMArmed  bool    // 基线世界是否处于“未超限”状态（只在越界瞬间计一次）
	cooldownUntilSec  float64 // 实际 OOM 后的重启冷却，期内不观测、不再计 OOM
	baseCooldownUntil float64 // 基线世界 OOM 后的重启冷却

	// 原始样本（仅校验子集保留，用于暴力加权分位数）。
	keepRaw         bool
	rawCPU          []weightedSample
	rawMemPeaks     []weightedSample // 已结算聚合周期的内存峰值
	rawOOMAmplified []weightedSample

	// 与推荐器同口径的原始侧内存周期峰值聚合状态。
	rawPeakArmed bool
	rawPeakIdx   int64
	rawPeak      float64
	rawPeakAt    float64

	Timeline []TimelinePoint `json:"-"`
	OOMs     []OOMInfo       `json:"-"`

	// 统计。
	actualOOMs     int
	preventedOOMs  int
	recommendCount int
}

type weightedSample struct {
	value float64
	atSec float64
}

// Stats 汇总统计。
type Stats struct {
	ContainerCount      int     `json:"containerCount"`
	DurationDays        float64 `json:"durationDays"`
	TotalActualOOM      int     `json:"totalActualOom"`
	TotalPreventedOOM   int     `json:"totalPreventedOom"`
	TotalBaselineOOM    int     `json:"totalBaselineOom"`
	OOMReductionPercent float64 `json:"oomReductionPercent"`

	CPURequestsBefore float64 `json:"cpuRequestsBefore"` // 核
	CPURequestsAfter  float64 `json:"cpuRequestsAfter"`
	CPUSavedCores     float64 `json:"cpuSavedCores"`
	CPUSavedPercent   float64 `json:"cpuSavedPercent"`
	MemRequestsBefore float64 `json:"memRequestsBefore"` // 字节
	MemRequestsAfter  float64 `json:"memRequestsAfter"`
	MemSavedBytes     float64 `json:"memSavedBytes"`
	MemSavedPercent   float64 `json:"memSavedPercent"`

	RecommendationEvents int `json:"recommendationEvents"`
}

// CheckIssue 暴力校验发现的一条不一致。
type CheckIssue struct {
	ContainerID string
	AtSec       float64
	Resource    string
	Q           float64
	HistValue   float64
	BruteValue  float64
	Tolerance   float64
}

func (i CheckIssue) Error() string {
	return fmt.Sprintf("%s %s @%.0f q=%.3f hist=%.6g brute=%.6g tol=%.6g",
		i.ContainerID, i.Resource, i.AtSec, i.Q, i.HistValue, i.BruteValue, i.Tolerance)
}

// Options 模拟参数。
type Options struct {
	ContainerCount int
	Days           int
	Seed           int64
	VerifyEvery    int // 每隔多少个推荐周期做一次暴力校验
	VerifySampleN  int // 保留原始样本参与校验的容器数
}

// DefaultOptions 默认模拟参数。
func DefaultOptions() Options {
	return Options{
		ContainerCount: 300,
		Days:           28,
		Seed:           20261123,
		VerifyEvery:    4,
		VerifySampleN:  24,
	}
}

// Result 模拟产出。
type Result struct {
	Containers []*Container
	Stats      Stats
	Issues     []CheckIssue
	StartSec   float64
	EndSec     float64
	Cfg        recommender.Config
}

const (
	tickSec        = 60  // 用量采样间隔（内存聚合周期与 tick 对齐，同为 1 分钟）
	recommendEvery = 60  // 每 60 个 tick（1 小时）算一次推荐
	snapshotEvery  = 30  // 每 30 个 tick 记录一次折线点
	oomCooldownSec = 300 // OOM 后重启冷却 5 分钟，期内不观测、不重复计数
)

var profileNames = map[Profile][]string{
	ProfileStable: {"票务网关", "年卡核验服务", "园内导览 API", "售票结算 Worker"},
	ProfileDaily:  {"票务高峰服务", "入口闸机核验", "投喂预约后台", "客流大屏"},
	ProfileBurst:  {"秒杀售票服务", "节假日弹性售票", "活动报名服务", "弹幕互动服务"},
	ProfileOOM:    {"投喂图片处理", "导览地图渲染", "票务报表导出", "视频巡检缓存"},
}

// Run 执行完整模拟并返回结果。
func Run(opts Options, cfg recommender.Config) (*Result, error) {
	rng := rand.New(rand.NewSource(opts.Seed))
	startSec := float64(0) // 相对时间，从 0 开始，页面按偏移展示
	totalTicks := opts.Days * 24 * 60

	containers := make([]*Container, 0, opts.ContainerCount)
	verifyIDs := make(map[int]bool)
	for opts.VerifySampleN > 0 && len(verifyIDs) < min(opts.VerifySampleN, opts.ContainerCount) {
		verifyIDs[rng.Intn(opts.ContainerCount)] = true
	}

	for i := 0; i < opts.ContainerCount; i++ {
		c := buildContainer(rng, i, startSec, cfg, verifyIDs[i])
		containers = append(containers, c)
	}

	res := &Result{
		Containers: containers,
		StartSec:   startSec,
		EndSec:     startSec + float64(totalTicks)*tickSec,
		Cfg:        cfg,
	}

	// 初始 request 总和（治理前基线），并记录各容器初始内存上限用于基线 OOM 统计。
	var cpuBefore, memBefore float64
	for _, c := range containers {
		cpuReq, _, memReq, memLimit := c.rec.CurrentSpec()
		cpuBefore += cpuReq
		memBefore += memReq
		c.baselineMemLimit = memLimit
	}

	for tick := 0; tick < totalTicks; tick++ {
		atSec := startSec + float64(tick)*tickSec

		for _, c := range containers {
			cpuUsage, memUsage := c.usageAt(rng, tick)

			// 实际 OOM 后处于重启冷却：不向推荐器观测、不判实际 OOM，
			// 但基线世界独立计时，仍照常统计。
			inActualCooldown := atSec < c.cooldownUntilSec
			if !inActualCooldown {
				c.rec.ObserveCPU(cpuUsage, atSec)
				c.rec.ObserveMemory(memUsage, atSec)
				if c.keepRaw && !c.rec.InGracePeriod(atSec) {
					// CPU 逐采样留存；内存按与推荐器相同的聚合周期留存峰值。
					c.rawCPU = append(c.rawCPU, weightedSample{cpuUsage, atSec})
					idx := int64(atSec / cfg.MemAggregationPeriodSec)
					if !c.rawPeakArmed || idx != c.rawPeakIdx {
						if c.rawPeakArmed {
							c.rawMemPeaks = append(c.rawMemPeaks, weightedSample{c.rawPeak, c.rawPeakAt})
						}
						c.rawPeakArmed, c.rawPeakIdx = true, idx
						c.rawPeak, c.rawPeakAt = memUsage, atSec
					} else if memUsage > c.rawPeak {
						c.rawPeak, c.rawPeakAt = memUsage, atSec
					}
				}
			}

			// 实际世界 OOM 判定：冷却结束后才可能再次被杀。
			_, _, _, memLimit := c.rec.CurrentSpec()
			actualOOM := !inActualCooldown && memLimit > 0 && memUsage > memLimit
			if actualOOM {
				ev := c.rec.RecordOOM(memUsage, atSec)
				c.actualOOMs++
				c.cooldownUntilSec = atSec + oomCooldownSec
				c.OOMs = append(c.OOMs, OOMInfo{
					ContainerID: c.ID, Name: c.Name, AtSec: atSec,
					Usage: ev.Usage, Amplified: ev.Amplified, Prevented: false,
				})
				// OOM 后立即重算并应用推荐，不等下一个整点周期：
				// 让上调后的规格在同一高峰窗口的后续冷却结束时就生效，
				// 避免窗口内每个冷却节拍重复被杀。
				if a := c.rec.Recommend(atSec); a.Memory.Change || a.CPU.Change {
					c.rec.Apply(a)
					c.recommendCount++
				}
				if c.keepRaw {
					c.rawOOMAmplified = append(c.rawOOMAmplified, weightedSample{ev.Amplified, atSec})
					// 与推荐器 RecordOOM 一致：重启后待结算周期峰值作废。
					c.rawPeakArmed = false
				}
			}

			// 基线世界：规格永不调整。用越界沿检测，一次持续超限只计一次 OOM；
			// 与治理世界采用相同的重启冷却节拍。治理世界在同一高峰因已上调规格而
			// 存活（actualOOM=false）、基线世界仍越界时，记一次“被推荐避免”。
			baseOver := c.baselineMemLimit > 0 && memUsage > c.baselineMemLimit
			if baseOver {
				if c.baselineOOMArmed {
					if !actualOOM {
						c.preventedOOMs++
						c.OOMs = append(c.OOMs, OOMInfo{
							ContainerID: c.ID, Name: c.Name, AtSec: atSec,
							Usage: memUsage, Amplified: memUsage * cfg.OOMAmplification, Prevented: true,
						})
					}
					// 无论治理世界是否被杀，基线世界都进入重启冷却。
					c.baseCooldownUntil = atSec + oomCooldownSec
					c.baselineOOMArmed = false
				}
			} else if atSec >= c.baseCooldownUntil {
				c.baselineOOMArmed = true
			}
		}

		// 周期性推荐。
		if tick > 0 && tick%recommendEvery == 0 {
			for _, c := range containers {
				a := c.rec.Recommend(atSec)
				if a.CPU.Change || a.Memory.Change {
					c.recommendCount++
					c.rec.Apply(a)
				}
				// 暴力校验（仅校验子集，且按 VerifyEvery 抽点）。
				if c.keepRaw && opts.VerifyEvery > 0 && (tick/recommendEvery)%opts.VerifyEvery == 0 {
					c.verifyAt(&res.Issues, a, cfg, atSec)
				}
			}
		}

		// 折线快照。
		if tick%snapshotEvery == 0 || tick == totalTicks-1 {
			for _, c := range containers {
				a := c.rec.Recommend(atSec)
				cpuReq, _, memReq, _ := c.rec.CurrentSpec()
				cpuUsage, memUsage := c.usageAt(rng, tick)
				c.Timeline = append(c.Timeline, TimelinePoint{
					AtSec: atSec, CPUCurrent: cpuReq, CPUTarget: a.CPU.TargetRequest,
					CPULower: a.CPU.LowerBound, CPUUpper: a.CPU.UpperBound,
					MemCurrent: memReq, MemTarget: a.Memory.TargetRequest,
					MemLower: a.Memory.LowerBound, MemUpper: a.Memory.UpperBound,
					CPUUsage: cpuUsage, MemUsage: memUsage,
					BoundsFactor: a.BoundsFactor, HistoryDays: a.HistoryDays,
					CPUChange: a.CPU.Change, MemChange: a.Memory.Change,
					CPUCapped: a.CPU.Capped, MemCapped: a.Memory.Capped,
					MemOOMDriven: a.Memory.OOMDriven,
				})
			}
		}
	}

	// 汇总统计。
	st := Stats{ContainerCount: len(containers), DurationDays: float64(opts.Days)}
	var cpuAfter, memAfter float64
	for _, c := range containers {
		cpuReq, _, memReq, _ := c.rec.CurrentSpec()
		cpuAfter += cpuReq
		memAfter += memReq
		st.TotalActualOOM += c.actualOOMs
		st.TotalPreventedOOM += c.preventedOOMs
		st.RecommendationEvents += c.recommendCount
	}
	st.TotalBaselineOOM = st.TotalActualOOM + st.TotalPreventedOOM
	st.CPURequestsBefore, st.CPURequestsAfter = cpuBefore, cpuAfter
	st.CPUSavedCores = cpuBefore - cpuAfter
	st.MemRequestsBefore, st.MemRequestsAfter = memBefore, memAfter
	st.MemSavedBytes = memBefore - memAfter
	if cpuBefore > 0 {
		st.CPUSavedPercent = st.CPUSavedCores / cpuBefore * 100
	}
	if memBefore > 0 {
		st.MemSavedPercent = st.MemSavedBytes / memBefore * 100
	}
	if st.TotalBaselineOOM > 0 {
		st.OOMReductionPercent = float64(st.TotalPreventedOOM) / float64(st.TotalBaselineOOM) * 100
	}
	res.Stats = st
	return res, nil
}

// buildContainer 按随机画像生成容器与初始规格。
func buildContainer(rng *rand.Rand, idx int, startSec float64, cfg recommender.Config, keepRaw bool) *Container {
	roll := rng.Float64()
	var p Profile
	switch {
	case roll < 0.35:
		p = ProfileStable
	case roll < 0.65:
		p = ProfileDaily
	case roll < 0.85:
		p = ProfileBurst
	default:
		p = ProfileOOM
	}
	names := profileNames[p]
	name := fmt.Sprintf("%s-%03d", names[idx%len(names)], idx)
	id := fmt.Sprintf("ctr-%04d", idx)

	c := &Container{
		ID: id, Name: name, Profile: p, phase: rng.Float64() * 2 * math.Pi,
		keepRaw: keepRaw, baselineOOMArmed: true,
	}

	// 初始规格拍脑袋：普遍偏大，OOM 型内存上限卡得偏紧。
	switch p {
	case ProfileStable:
		c.cpuBase, c.cpuAmp, c.cpuNoise = 0.3+rng.Float64()*0.4, 0.05, 0.04
		c.memBase, c.memAmp, c.memNoise = (400+rng.Float64()*800)*recommender.MiB, 40*recommender.MiB, 30*recommender.MiB
	case ProfileDaily:
		c.cpuBase, c.cpuAmp, c.cpuNoise = 0.5+rng.Float64()*0.5, 0.35, 0.05
		c.memBase, c.memAmp, c.memNoise = (800+rng.Float64()*900)*recommender.MiB, 350*recommender.MiB, 40*recommender.MiB
	case ProfileBurst:
		c.cpuBase, c.cpuAmp, c.cpuNoise = 0.25+rng.Float64()*0.3, 0.15, 0.05
		c.memBase, c.memAmp, c.memNoise = (500+rng.Float64()*700)*recommender.MiB, 120*recommender.MiB, 50*recommender.MiB
		// 平均每 2~8 小时一次突发（tick=1 分钟）。
		c.burstRate = 0.002 + rng.Float64()*0.006
	case ProfileOOM:
		// 内存基线平稳（无日周期大振幅），保证常态低于上限；只有 oomRate 显式
		// 触发的冲高才越界，从而得到零星、可解释的 OOM 事件。
		c.cpuBase, c.cpuAmp, c.cpuNoise = 0.4+rng.Float64()*0.3, 0.1, 0.05
		c.memBase, c.memAmp, c.memNoise = (1400+rng.Float64()*700)*recommender.MiB, 60*recommender.MiB, 40*recommender.MiB
		// 内存冲高平均每 8~16 小时一次，匹配真实业务的零星 OOM 节奏。
		c.oomRate = 0.001 + rng.Float64()*0.001
	}

	// 初始规格拍脑袋：普通型普遍偏大；OOM 型内存 request 贴近常态、limit 卡在
	// 常态峰值与每日复发高峰之间（常态峰值 ×1.15 左右，而高峰约为 ×1.28）。
	cpuReq := roundUpGran((1.5+rng.Float64()*1.5)*(c.cpuBase+c.cpuAmp), cfg.CPUGranularity)
	var memReq float64
	if p == ProfileOOM {
		memReq = roundUpGran((c.memBase+c.memAmp)*(1.05+rng.Float64()*0.05), cfg.MemGranularity)
	} else {
		memReq = roundUpGran((1.6+rng.Float64()*0.8)*(c.memBase+c.memAmp), cfg.MemGranularity)
	}
	var cpuLimit, memLimit float64
	if rng.Float64() < 0.7 {
		cpuLimit = roundUpGran(cpuReq*(1.5+rng.Float64()), cfg.CPUGranularity)
	}
	if rng.Float64() < 0.85 {
		if p == ProfileOOM {
			// 常态峰值 ≈ base+amp；每日高峰在此之上再叠加约 0.28~0.30×base。
			// 取中间地带，保证常态不越界、每日高峰必越界，而推荐器学到并按
			// 1.25 倍放大后的目标上限能盖住后续高峰。limit >= request。
			normalPeak := c.memBase + c.memAmp
			memLimit = roundUpGran(normalPeak*1.15, cfg.MemGranularity)
			if memLimit < memReq {
				memLimit = roundUpGran(memReq, cfg.MemGranularity)
			}
		} else {
			memLimit = roundUpGran(memReq*(1.5+rng.Float64()), cfg.MemGranularity)
		}
	}
	if cpuLimit > cfg.NodeMaxCPU {
		cpuLimit = cfg.NodeMaxCPU
	}
	if memLimit > cfg.NodeMaxMem {
		memLimit = cfg.NodeMaxMem
	}

	c.rec = recommender.New(cfg, startSec, cpuReq, cpuLimit, memReq, memLimit)
	return c
}

func roundUpGran(v, g float64) float64 {
	return math.Ceil(v/g) * g
}

// usageAt 生成第 tick 个采样时刻的处理器/内存用量。
func (c *Container) usageAt(rng *rand.Rand, tick int) (cpu, mem float64) {
	t := float64(tick) * tickSec
	dayCycle := math.Sin((t/86400)*2*math.Pi + c.phase) // 按天周期
	cpu = c.cpuBase + c.cpuAmp*dayCycle + (rng.Float64()-0.5)*2*c.cpuNoise
	mem = c.memBase + c.memAmp*dayCycle + (rng.Float64()-0.5)*2*c.memNoise

	if c.Profile == ProfileBurst && rng.Float64() < c.burstRate {
		mult := 2 + rng.Float64()*2
		cpu *= mult
		mem *= 1 + rng.Float64()*0.6
	}
	if c.Profile == ProfileOOM {
		// 周期性内存高峰：每天业务高峰（相位由容器决定）出现一次，增量稳定可复现，
		// 幅度明确高于偏紧的初始上限、低于推荐器学到并放大后的目标上限。
		// 第一天首次高峰触发 OOM 并教会推荐器；之后每天复发时，治理世界已上调规格
		// 而存活，不治理的基线世界仍越界被杀——由此产生“被推荐避免的 OOM”。
		dayPhase := math.Sin((t/86400)*2*math.Pi + c.phase)
		if dayPhase > 0.93 { // 每天约 1.5 小时的高峰窗口
			mem += c.memBase * (0.28 + rng.Float64()*0.02)
		}
		if rng.Float64() < c.oomRate {
			mem += c.memBase * (0.22 + rng.Float64()*0.13)
			cpu *= 1.2 + rng.Float64()*0.4
		}
	}
	if cpu < 0.02 {
		cpu = 0.02
	}
	if mem < recommender.MiB {
		mem = recommender.MiB
	}
	return cpu, mem
}

// bruteQuantile 用全部原始样本直接计算时间衰减加权分位数（线性插值）。
func bruteQuantile(samples []weightedSample, halfLife, nowSec, q float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	type ws struct {
		v, w float64
	}
	ss := make([]ws, len(samples))
	var total float64
	for i, s := range samples {
		w := 1.0
		if halfLife > 0 {
			w = math.Pow(2, -(nowSec-s.atSec)/halfLife)
		}
		ss[i] = ws{s.value, w}
		total += w
	}
	sort.Slice(ss, func(i, j int) bool { return ss[i].v < ss[j].v })
	target := q * total
	var cum float64
	prevV := 0.0
	for _, s := range ss {
		if target <= cum+s.w {
			frac := 0.0
			if s.w > 0 {
				frac = (target - cum) / s.w
			}
			return prevV + frac*(s.v-prevV)
		}
		cum += s.w
		prevV = s.v
	}
	return ss[len(ss)-1].v
}

// verifyAt 在 atSec 时刻把直方图分位数与暴力加权分位数核对，
// 误差上界取直方图对应桶宽（分桶误差）。
func (c *Container) verifyAt(issues *[]CheckIssue, a recommender.Advice, cfg recommender.Config, atSec float64) {
	// 内存样本 = 已结算周期峰值 + 当前进行中周期的峰值（虚拟样本，与
	// 推荐器 memQuantile 的只读合并口径一致）+ OOM 放大样本。
	memSamples := make([]weightedSample, 0, len(c.rawMemPeaks)+len(c.rawOOMAmplified)+1)
	memSamples = append(memSamples, c.rawMemPeaks...)
	if c.rawPeakArmed {
		memSamples = append(memSamples, weightedSample{c.rawPeak, c.rawPeakAt})
	}
	memSamples = append(memSamples, c.rawOOMAmplified...)

	checks := []struct {
		res      string
		q        float64
		histVal  float64
		samples  []weightedSample
		halfLife float64
		tol      float64
	}{
		{"cpu", cfg.CPURequestQ, a.CPU.Quantile, c.rawCPU, cfg.CPUHalfLifeSec,
			c.rec.CPUHistogram().BucketWidthAt(maxNonZero(c.rawCPU))},
		{"memory", cfg.MemRequestQ, a.Memory.Quantile, memSamples, cfg.MemHalfLifeSec,
			c.rec.MemHistogram().BucketWidthAt(maxNonZero(memSamples))},
	}
	for _, ck := range checks {
		bv := bruteQuantile(ck.samples, ck.halfLife, atSec, ck.q)
		if math.Abs(ck.histVal-bv) > ck.tol {
			*issues = append(*issues, CheckIssue{
				ContainerID: c.ID, AtSec: atSec, Resource: ck.res, Q: ck.q,
				HistValue: ck.histVal, BruteValue: bv, Tolerance: ck.tol,
			})
		}
	}
}

func maxNonZero(ss []weightedSample) float64 {
	m := 0.0
	for _, s := range ss {
		if s.value > m {
			m = s.value
		}
	}
	return m
}

// Rec 暴露容器的推荐器（供 web 层读取直方图快照与当前规格）。
func (c *Container) Rec() *recommender.Recommender { return c.rec }

// ActualOOMCount 返回治理世界中真实发生的 OOM 次数。
func (c *Container) ActualOOMCount() int { return c.actualOOMs }

// RecommendCount 返回该容器触发的推荐调整次数。
func (c *Container) RecommendCount() int { return c.recommendCount }
