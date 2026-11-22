// Package recommender 按容器历史用量计算处理器/内存的推荐请求值与上下限。
//
// 实现的规则（与需求条目对应）：
//   - 处理器用量按指数桶直方图分桶、样本按时间指数衰减（见 histogram 包）。
//   - 内存每个聚合周期只记一个峰值样本（ObserveMemory 内部按周期落桶）。
//   - 推荐值 = 分位数 ×(1+安全余量)，再按平台粒度向上取整（处理器千分之一核、
//     内存兆字节），超过节点最大规格时截断并标记。
//   - 上下限随历史天数收敛：历史不足时放宽，历史够长后收敛到分位本身。
//   - OOM 时把当时用量放大后作为样本记入，并保证下次内存推荐一定更大。
//   - 容器启动头几分钟（可配）的样本不计入，避免启动尖峰抬高推荐。
//   - 上限与请求值之比保持原值；原未设上限则不设。
//   - 仅当当前请求值落在上下限之外时才建议调整。
package recommender

import (
	"math"

	"zooresourcer/internal/histogram"
)

const (
	// MilliCore 处理器粒度：千分之一核。
	MilliCore = 1.0 / 1000.0
	// MiB 内存粒度：兆字节（按 2^20 计）。
	MiB = 1 << 20
)

// Config 推荐器参数，全部时长单位为秒。
type Config struct {
	CPUFactor float64 // 处理器直方图桶宽增长因子
	MemFactor float64 // 内存直方图桶宽增长因子

	CPUHalfLifeSec float64 // 处理器样本权重半衰期
	MemHalfLifeSec float64 // 内存峰值样本权重半衰期

	StartupGraceSec         float64 // 启动保护期，期内样本不计入
	MemAggregationPeriodSec float64 // 内存聚合周期，每周期只记一个峰值

	SafetyMargin    float64 // 安全余量，如 0.15 表示在分位数上加 15%
	MinHistoryDay   float64 // 历史短于该天数时使用最宽上下限
	FullHistoryDay  float64 // 历史达到该天数后上下限收敛到分位本身
	MinBoundsFactor float64 // 历史最短时上下限相对分位数的放宽系数（如 0.5 表示 ±50%）

	CPUGranularity float64 // 处理器取整粒度（千分之一核）
	MemGranularity float64 // 内存取整粒度（兆字节）
	NodeMaxCPU     float64 // 节点可给的最大处理器规格（核）
	NodeMaxMem     float64 // 节点可给的最大内存规格（字节）

	OOMAmplification float64 // OOM 时用量放大比例（如 1.25）

	// ChangeDeadzone 变更死区：目标值与当前值相对差异小于该比例时不建议调整，
	// 避免在取整粒度/上下限边界附近来回抖动。OOM 驱动不受死区限制。
	ChangeDeadzone float64

	CPURequestQ   float64 // 处理器请求值分位
	CPUBoundLowQ  float64 // 处理器下限分位
	CPUBoundHighQ float64 // 处理器上限分位
	MemRequestQ   float64 // 内存请求值分位
	MemBoundLowQ  float64 // 内存下限分位
	MemBoundHighQ float64 // 内存上限分位
	MemSafetyQ    float64 // 内存安全地板分位：请求值不得低于近期峰值的该分位，防止下调后被 OOM
}

// DefaultConfig 返回一套可直接使用的默认参数。
func DefaultConfig() Config {
	return Config{
		CPUFactor:               1.05,
		MemFactor:               1.05,
		CPUHalfLifeSec:          24 * 3600,
		MemHalfLifeSec:          48 * 3600,
		StartupGraceSec:         5 * 60,
		MemAggregationPeriodSec: 60,
		SafetyMargin:            0.15,
		MinHistoryDay:           1,
		FullHistoryDay:          7,
		MinBoundsFactor:         0.5,
		CPUGranularity:          MilliCore,
		MemGranularity:          MiB,
		NodeMaxCPU:              8,
		NodeMaxMem:              16 * 1024 * MiB,
		OOMAmplification:        1.25,
		ChangeDeadzone:          0.10,
		CPURequestQ:             0.90,
		CPUBoundLowQ:            0.50,
		CPUBoundHighQ:           0.99,
		MemRequestQ:             0.95,
		MemBoundLowQ:            0.50,
		MemBoundHighQ:           0.999,
		MemSafetyQ:              0.99,
	}
}

// OOMEvent 一次内存不足被杀事件。
type OOMEvent struct {
	AtSec     float64 // 事件时间戳
	Usage     float64 // 当时的内存用量（字节）
	Amplified float64 // 放大后记入直方图的样本值
}

// Recommender 单个容器的资源推荐器。非并发安全，由调用方串行驱动。
type Recommender struct {
	cfg Config

	startSec float64 // 容器启动时间戳
	nowSec   float64 // 最近一次观测时间戳

	firstSampleSec float64 // 首个被采纳样本的时间戳（用于计算有效历史长度）
	hasSample      bool

	cpuHist *histogram.Histogram
	memHist *histogram.Histogram

	// 内存聚合周期内的峰值，周期切换时落一个样本。
	pendingPeak     float64
	pendingPeakAt   float64
	peakPeriodIndex int64
	peakArmed       bool

	// OOM 保证下限：内存推荐值不得低于该值（字节）。
	oomFloor  float64
	oomEvents []OOMEvent

	// 当前规格。
	cpuRequest float64
	cpuLimit   float64 // 0 表示未设上限
	memRequest float64
	memLimit   float64 // 0 表示未设上限
}

// New 创建推荐器。startSec 为容器启动时间，request/limit 为当前规格，
// limit 传 0 表示该资源未设上限。
func New(cfg Config, startSec float64, cpuRequest, cpuLimit, memRequest, memLimit float64) *Recommender {
	return &Recommender{
		cfg:        cfg,
		startSec:   startSec,
		nowSec:     startSec,
		cpuHist:    histogram.New(cfg.CPUFactor, cfg.CPUHalfLifeSec),
		memHist:    histogram.New(cfg.MemFactor, cfg.MemHalfLifeSec),
		cpuRequest: cpuRequest,
		cpuLimit:   cpuLimit,
		memRequest: memRequest,
		memLimit:   memLimit,
	}
}

// inGracePeriod 判断 atSec 是否仍处于启动保护期。
func (r *Recommender) inGracePeriod(atSec float64) bool {
	return r.cfg.StartupGraceSec > 0 && atSec < r.startSec+r.cfg.StartupGraceSec
}

// InGracePeriod 暴露启动保护期判断，供模拟侧留存原始样本时保持同一口径。
func (r *Recommender) InGracePeriod(atSec float64) bool { return r.inGracePeriod(atSec) }

// markSample 记录首个有效样本的时间戳。
func (r *Recommender) markSample(atSec float64) {
	if !r.hasSample {
		r.hasSample = true
		r.firstSampleSec = atSec
	}
}

// ObserveCPU 记入一个处理器用量样本（核）。启动保护期内的样本丢弃。
func (r *Recommender) ObserveCPU(usage, atSec float64) {
	if atSec > r.nowSec {
		r.nowSec = atSec
	}
	if r.inGracePeriod(atSec) {
		return
	}
	r.cpuHist.Observe(usage, atSec)
	r.markSample(atSec)
}

// ObserveMemory 记入一个内存用量采样（字节）。内存不逐采样落桶，而是在每个
// 聚合周期内取峰值，周期切换时把峰值作为一个样本记入直方图。
func (r *Recommender) ObserveMemory(usage, atSec float64) {
	if atSec > r.nowSec {
		r.nowSec = atSec
	}
	if r.inGracePeriod(atSec) {
		return
	}
	idx := int64(atSec / r.cfg.MemAggregationPeriodSec)
	if !r.peakArmed || idx != r.peakPeriodIndex {
		// 进入新周期：先把上一周期的峰值落桶（若尚未结算）。
		if r.peakArmed {
			r.memHist.Observe(r.pendingPeak, r.pendingPeakAt)
			r.markSample(r.pendingPeakAt)
		}
		r.peakPeriodIndex = idx
		r.pendingPeak = usage
		r.pendingPeakAt = atSec
		r.peakArmed = true
		return
	}
	if usage > r.pendingPeak {
		r.pendingPeak = usage
		r.pendingPeakAt = atSec
	}
}

// memQuantile 计算内存分位数：已结算周期峰值走直方图，当前未结算周期的
// 峰值作为一个权重为 1 的虚拟样本参与（与落桶后再算等价，但不改变直方图状态，
// 从而保证只读推荐不破坏“每周期一个峰值样本”的口径）。
func (r *Recommender) memQuantile(q float64) float64 {
	snap := r.memHist.Snapshot(r.nowSec)
	type bw struct{ lo, hi, w float64 }
	buckets := make([]bw, 0, len(snap)+1)
	var histTotal float64
	for _, b := range snap {
		buckets = append(buckets, bw{b.Lower, b.Upper, b.Weight})
		histTotal += b.Weight
	}
	// 虚拟样本：当前周期峰值，权重 1（它在 nowSec 时刻的自身权重）。
	vw := 1.0
	if !r.peakArmed {
		vw = 0
	}
	if histTotal+vw <= 0 {
		return r.pendingPeak
	}
	target := q * (histTotal + vw)

	// 零桶与各指数桶按值排序，虚拟样本按其值插入对应位置参与插值。
	var cum float64
	inserted := false
	flush := func(lo, hi, w float64) float64 {
		if w <= 0 {
			return -1
		}
		if target <= cum+w {
			frac := 0.0
			if w > 0 {
				frac = (target - cum) / w
			}
			return lo + frac*(hi-lo)
		}
		cum += w
		return -1
	}
	for _, b := range buckets {
		// 虚拟样本值落在当前桶之前（或零桶位置）时先并入。
		if r.peakArmed && !inserted && r.pendingPeak < b.lo {
			if x := flush(r.pendingPeak, r.pendingPeak, vw); x >= 0 {
				return x
			}
			inserted = true
		}
		lo, hi, w := b.lo, b.hi, b.w
		// 虚拟样本落在本桶内：把桶权重与虚拟样本合并到同一区间做插值。
		if r.peakArmed && !inserted && r.pendingPeak >= lo && r.pendingPeak < hi {
			w += vw
			inserted = true
		}
		if x := flush(lo, hi, w); x >= 0 {
			return x
		}
	}
	if r.peakArmed && !inserted {
		if x := flush(r.pendingPeak, r.pendingPeak, vw); x >= 0 {
			return x
		}
	}
	// 浮点兜底：返回最大已知值。
	if r.peakArmed {
		return r.pendingPeak
	}
	if len(buckets) > 0 {
		return buckets[len(buckets)-1].hi
	}
	return 0
}

// RecordOOM 处理一次内存不足被杀事件：把当时用量放大后作为样本记入直方图，
// 并抬高保证下限；重启后启动保护期重新计算。
func (r *Recommender) RecordOOM(usage, atSec float64) OOMEvent {
	amplified := usage * r.cfg.OOMAmplification
	ev := OOMEvent{AtSec: atSec, Usage: usage, Amplified: amplified}
	r.oomEvents = append(r.oomEvents, ev)
	// OOM 样本不受启动保护期限制：被杀本身就是必须响应的信号。
	r.memHist.Observe(amplified, atSec)
	r.markSample(atSec)
	if amplified > r.oomFloor {
		r.oomFloor = amplified
	}
	// 容器重启，启动保护期从头开始；未结算的周期峰值作废。
	r.startSec = atSec
	r.peakArmed = false
	r.pendingPeak = 0
	if atSec > r.nowSec {
		r.nowSec = atSec
	}
	return ev
}

// boundsFactor 按有效历史天数计算上下限放宽系数：
// 历史为 0 时取最宽的 MinBoundsFactor，随天数线性收敛，历史够长后为 0，
// 即上下限收敛到分位数本身。
func (r *Recommender) boundsFactor() float64 {
	if !r.hasSample || r.cfg.FullHistoryDay <= r.cfg.MinHistoryDay {
		return r.cfg.MinBoundsFactor
	}
	days := (r.nowSec - r.firstSampleSec) / 86400
	if days <= r.cfg.MinHistoryDay {
		return r.cfg.MinBoundsFactor
	}
	if days >= r.cfg.FullHistoryDay {
		return 0
	}
	t := (days - r.cfg.MinHistoryDay) / (r.cfg.FullHistoryDay - r.cfg.MinHistoryDay)
	return r.cfg.MinBoundsFactor * (1 - t)
}

func roundUp(v, granularity float64) float64 {
	return math.Ceil(v/granularity) * granularity
}

func roundDown(v, granularity float64) float64 {
	return math.Floor(v/granularity) * granularity
}

// outsideBounds 判断当前请求是否落在上下限之外，且偏离目标超过变更死区。
// force=true 时（OOM/安全地板驱动）短路返回 true，由调用方保证目标确实更高。
func (r *Recommender) outsideBounds(current, lower, upper, target float64, force bool) bool {
	if force {
		return true
	}
	if current < lower || current > upper {
		base := math.Max(current, 1e-12)
		return math.Abs(target-current)/base >= r.cfg.ChangeDeadzone
	}
	return false
}

// ResourceAdvice 单个资源的推荐结果。
type ResourceAdvice struct {
	CurrentRequest float64 `json:"currentRequest"`
	CurrentLimit   float64 `json:"currentLimit"` // 0 表示未设上限
	TargetRequest  float64 `json:"targetRequest"`
	TargetLimit    float64 `json:"targetLimit"` // 0 表示不设上限
	LowerBound     float64 `json:"lowerBound"`
	UpperBound     float64 `json:"upperBound"`
	Quantile       float64 `json:"quantile"`     // 取整前的请求分位值
	LowQuantile    float64 `json:"lowQuantile"`  // 取整前的下限分位值
	HighQuantile   float64 `json:"highQuantile"` // 取整前的上限分位值
	Change         bool    `json:"change"`       // 是否建议调整
	Capped         bool    `json:"capped"`       // 是否因节点最大规格被截断
	OOMDriven      bool    `json:"oomDriven"`    // 是否由 OOM 保证下限驱动
}

// Advice 一次推荐计算的完整结果。
type Advice struct {
	AtSec        float64        `json:"atSec"`
	CPU          ResourceAdvice `json:"cpu"`
	Memory       ResourceAdvice `json:"memory"`
	HistoryDays  float64        `json:"historyDays"`
	BoundsFactor float64        `json:"boundsFactor"`
}

// limitRatio 计算上限/请求之比；未设上限返回 0。
func limitRatio(request, limit float64) float64 {
	if limit <= 0 || request <= 0 {
		return 0
	}
	return limit / request
}

// recommendCPU 计算处理器推荐。
func (r *Recommender) recommendCPU(bf float64) ResourceAdvice {
	a := ResourceAdvice{
		CurrentRequest: r.cpuRequest,
		CurrentLimit:   r.cpuLimit,
	}
	q := r.cpuHist.Quantile(r.cfg.CPURequestQ, r.nowSec)
	loQ := r.cpuHist.Quantile(r.cfg.CPUBoundLowQ, r.nowSec)
	hiQ := r.cpuHist.Quantile(r.cfg.CPUBoundHighQ, r.nowSec)
	a.Quantile, a.LowQuantile, a.HighQuantile = q, loQ, hiQ

	// 安全余量 + 平台粒度向上取整。
	target := roundUp(q*(1+r.cfg.SafetyMargin), r.cfg.CPUGranularity)
	// 上下限按分位数放宽（历史越短越宽），再向外取整。
	lower := roundDown(loQ*(1-bf), r.cfg.CPUGranularity)
	upper := roundUp(hiQ*(1+bf), r.cfg.CPUGranularity)

	// 超过节点最大规格时截断并标记。
	maxAlloc := roundDown(r.cfg.NodeMaxCPU, r.cfg.CPUGranularity)
	if target > maxAlloc {
		target = maxAlloc
		a.Capped = true
	}
	if upper > maxAlloc {
		upper = maxAlloc
		a.Capped = true
	}
	if lower > maxAlloc {
		lower = maxAlloc
	}

	a.TargetRequest, a.LowerBound, a.UpperBound = target, lower, upper

	// 上限与请求之比保持原值，请求改了上限按同比例跟随；原本没设就不设。
	// limit 永远不得低于 request。
	if ratio := limitRatio(r.cpuRequest, r.cpuLimit); ratio > 0 {
		if ratio < 1 {
			ratio = 1
		}
		a.TargetLimit = roundUp(target*ratio, r.cfg.CPUGranularity)
		if a.TargetLimit > maxAlloc {
			a.TargetLimit = maxAlloc
			a.Capped = true
		}
	}

	// 仅当当前请求值落在上下限之外、且偏离目标超过死区时才建议改。
	a.Change = r.outsideBounds(r.cpuRequest, lower, upper, target, false)
	return a
}

// recommendMemory 计算内存推荐。
func (r *Recommender) recommendMemory(bf float64) ResourceAdvice {
	a := ResourceAdvice{
		CurrentRequest: r.memRequest,
		CurrentLimit:   r.memLimit,
	}
	q := r.memQuantile(r.cfg.MemRequestQ)
	loQ := r.memQuantile(r.cfg.MemBoundLowQ)
	hiQ := r.memQuantile(r.cfg.MemBoundHighQ)
	a.Quantile, a.LowQuantile, a.HighQuantile = q, loQ, hiQ

	target := roundUp(q*(1+r.cfg.SafetyMargin), r.cfg.MemGranularity)
	lower := roundDown(loQ*(1-bf), r.cfg.MemGranularity)
	upper := roundUp(hiQ*(1+bf), r.cfg.MemGranularity)

	// 安全地板：内存是不可压缩资源，请求（及其按比例跟随的上限）不得低于
	// 近期峰值的高分位，否则下调后容器会在正常高峰时被 OOM 杀掉。
	// 地板同时托住 target、lower，并在当前请求低于地板时强制触发调整。
	safetyForced := false
	if r.cfg.MemSafetyQ > 0 {
		safety := roundUp(r.memQuantile(r.cfg.MemSafetyQ), r.cfg.MemGranularity)
		if safety > target {
			target = safety
		}
		if safety > lower {
			lower = safety
		}
		if r.memRequest < safety {
			safetyForced = true
		}
	}

	maxAlloc := roundDown(r.cfg.NodeMaxMem, r.cfg.MemGranularity)
	if target > maxAlloc {
		target = maxAlloc
		a.Capped = true
	}
	if upper > maxAlloc {
		upper = maxAlloc
		a.Capped = true
	}
	if lower > maxAlloc {
		lower = maxAlloc
	}

	// OOM 双重保证：放大样本已进入直方图，再用保证下限兜底，
	// 确保下次推荐的内存一定比 OOM 时的用量大。
	if r.oomFloor > 0 {
		floor := roundUp(r.oomFloor, r.cfg.MemGranularity)
		if floor > target {
			target = floor
			a.OOMDriven = true
		}
		if floor > maxAlloc {
			target = maxAlloc
			a.Capped = true
		}
	}

	a.TargetRequest, a.LowerBound, a.UpperBound = target, lower, upper

	// 上限按原 request/limit 比例跟随，但 limit 永远不得低于 request（否则
	// 容器在请求额度内就会被杀，形成 OOM 死循环）。
	if ratio := limitRatio(r.memRequest, r.memLimit); ratio > 0 {
		if ratio < 1 {
			ratio = 1
		}
		a.TargetLimit = roundUp(target*ratio, r.cfg.MemGranularity)
		if a.TargetLimit > maxAlloc {
			a.TargetLimit = maxAlloc
			a.Capped = true
		}
	}

	force := (safetyForced || a.OOMDriven) && target > r.memRequest
	a.Change = r.outsideBounds(r.memRequest, lower, upper, target, force)
	return a
}

// Recommend 在 nowSec 时刻计算一次推荐结果。只读，不改变直方图状态：
// 当前未结算的内存周期峰值以虚拟样本参与分位计算。
func (r *Recommender) Recommend(nowSec float64) Advice {
	if nowSec > r.nowSec {
		r.nowSec = nowSec
	}
	bf := r.boundsFactor()
	days := 0.0
	if r.hasSample {
		days = (r.nowSec - r.firstSampleSec) / 86400
	}
	return Advice{
		AtSec:        r.nowSec,
		CPU:          r.recommendCPU(bf),
		Memory:       r.recommendMemory(bf),
		HistoryDays:  days,
		BoundsFactor: bf,
	}
}

// Apply 把一次建议的目标值写回当前规格（模拟调参后容器的新 request/limit）。
func (r *Recommender) Apply(a Advice) {
	r.cpuRequest = a.CPU.TargetRequest
	if a.CPU.TargetLimit > 0 {
		r.cpuLimit = a.CPU.TargetLimit
	}
	r.memRequest = a.Memory.TargetRequest
	if a.Memory.TargetLimit > 0 {
		r.memLimit = a.Memory.TargetLimit
	}
}

// OOMEvents 返回已记录的 OOM 事件副本。
func (r *Recommender) OOMEvents() []OOMEvent {
	out := make([]OOMEvent, len(r.oomEvents))
	copy(out, r.oomEvents)
	return out
}

// CPUHistogram 暴露处理器直方图快照（供页面展示）。
func (r *Recommender) CPUHistogram() *histogram.Histogram { return r.cpuHist }

// MemHistogram 暴露内存直方图快照（供页面展示）。
func (r *Recommender) MemHistogram() *histogram.Histogram { return r.memHist }

// CurrentSpec 返回当前 (cpuRequest, cpuLimit, memRequest, memLimit)。
func (r *Recommender) CurrentSpec() (float64, float64, float64, float64) {
	return r.cpuRequest, r.cpuLimit, r.memRequest, r.memLimit
}

// HasSample 返回是否已采纳过任何有效样本。
func (r *Recommender) HasSample() bool { return r.hasSample }
