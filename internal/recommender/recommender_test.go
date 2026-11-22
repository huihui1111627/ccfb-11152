package recommender

import (
	"math"
	"testing"
)

func approx(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestStartupGraceDropsEarlySamples(t *testing.T) {
	cfg := DefaultConfig()
	cfg.StartupGraceSec = 300
	r := New(cfg, 0, 1, 0, 100*MiB, 0)
	for ts := 0.0; ts < 300; ts += 60 {
		r.ObserveCPU(0.9, ts) // 保护期内，全部丢弃
	}
	if r.HasSample() {
		t.Fatal("samples in grace period should not be accepted")
	}
	r.ObserveCPU(0.9, 300)
	if !r.HasSample() {
		t.Fatal("sample after grace period should be accepted")
	}
}

func TestMemoryOnePeakPerAggregationPeriod(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MemAggregationPeriodSec = 60
	r := New(cfg, 0, 1, 0, 100*MiB, 0)
	// 同一分钟内 3 个采样，只有峰值应进入直方图。
	r.ObserveMemory(100*MiB, 600)
	r.ObserveMemory(300*MiB, 620)
	r.ObserveMemory(200*MiB, 640)
	// 下一周期触发上一周期结算。
	r.ObserveMemory(50*MiB, 660)
	got := r.MemHistogram().Count()
	if got != 1 {
		t.Fatalf("histogram samples = %d, want 1 (single peak for first period)", got)
	}
	// 结算后分位数应反映峰值 300MiB 而非均值；指数桶内线性插值，
	// 允许一个桶宽（factor 1.05 时约 5%）的分桶误差。
	q := r.MemHistogram().Quantile(0.5, 660)
	if !approx(q, 300*MiB, r.MemHistogram().BucketWidthAt(300*MiB)) {
		t.Fatalf("peak quantile = %.0f MiB, want ~300 MiB", q/MiB)
	}
}

func TestRoundingGranularity(t *testing.T) {
	cfg := DefaultConfig()
	r := New(cfg, 0, 1, 0, 100*MiB, 0)
	// 给足 10 天平稳样本，让上下限收敛。
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r.ObserveCPU(0.1234, ts)
		r.ObserveMemory(123.4*MiB, ts)
	}
	a := r.Recommend(10 * 86400)
	// 处理器必须是千分之一核的整数倍。
	if m := math.Round(a.CPU.TargetRequest / MilliCore); !approx(a.CPU.TargetRequest, m*MilliCore, 1e-12) {
		t.Fatalf("cpu target %v not aligned to milli-core", a.CPU.TargetRequest)
	}
	// 内存必须是 MiB 的整数倍。
	if m := math.Round(a.Memory.TargetRequest / MiB); !approx(a.Memory.TargetRequest, m*MiB, 1e-6) {
		t.Fatalf("mem target %v not aligned to MiB", a.Memory.TargetRequest)
	}
	// 安全余量 15% 已包含。
	if a.CPU.TargetRequest < 0.1234*1.15 {
		t.Fatalf("cpu target %.4f below margin floor", a.CPU.TargetRequest)
	}
}

func TestNodeMaxCapAndFlag(t *testing.T) {
	cfg := DefaultConfig()
	cfg.NodeMaxCPU = 0.5
	cfg.NodeMaxMem = 200 * MiB
	r := New(cfg, 0, 0.1, 0, 50*MiB, 0)
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r.ObserveCPU(0.9, ts)
		r.ObserveMemory(500*MiB, ts)
	}
	a := r.Recommend(10 * 86400)
	if a.CPU.TargetRequest > cfg.NodeMaxCPU {
		t.Fatalf("cpu target %v exceeds node max", a.CPU.TargetRequest)
	}
	if a.Memory.TargetRequest > cfg.NodeMaxMem {
		t.Fatalf("mem target %v exceeds node max", a.Memory.TargetRequest)
	}
	if !a.CPU.Capped || !a.Memory.Capped {
		t.Fatalf("capped flags not set: cpu=%v mem=%v", a.CPU.Capped, a.Memory.Capped)
	}
}

func TestBoundsWidenWithShortHistoryAndConverge(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MinHistoryDay = 1
	cfg.FullHistoryDay = 7
	cfg.MinBoundsFactor = 0.5
	r := New(cfg, 0, 1, 0, 100*MiB, 0)
	r.ObserveCPU(0.5, 300)
	short := r.Recommend(300)
	if short.BoundsFactor != 0.5 {
		t.Fatalf("short-history factor = %v, want 0.5", short.BoundsFactor)
	}
	// 历史天数从首个采纳样本（300s）起算；满 4 天历史时落在 1~7 天区间中点，
	// 放宽系数应线性插值到 0.25。
	for ts := 360.0; ts < 4*86400+300; ts += 60 {
		r.ObserveCPU(0.5, ts)
	}
	mid := r.Recommend(4*86400 + 300)
	if !approx(mid.BoundsFactor, 0.25, 1e-9) {
		t.Fatalf("mid-history factor = %v, want 0.25", mid.BoundsFactor)
	}
	for ts := 4*86400 + 360.0; ts < 8*86400; ts += 60 {
		r.ObserveCPU(0.5, ts)
	}
	long := r.Recommend(8 * 86400)
	if long.BoundsFactor != 0 {
		t.Fatalf("long-history factor = %v, want 0 (converged)", long.BoundsFactor)
	}
	// 收敛后上下限应等于分位本身；分位受指数桶宽量化，允许一个桶宽的分桶误差，
	// 不再有历史放宽（对比短历史时的 ±50% 宽界）。
	tol := r.CPUHistogram().BucketWidthAt(0.5)
	if math.Abs(long.CPU.LowerBound-long.CPU.UpperBound) > tol {
		t.Fatalf("converged bounds differ by more than bucket width: lower=%v upper=%v tol=%v",
			long.CPU.LowerBound, long.CPU.UpperBound, tol)
	}
}

func TestOOMForcesLargerMemoryNextTime(t *testing.T) {
	cfg := DefaultConfig()
	cfg.OOMAmplification = 1.25
	r := New(cfg, 0, 1, 2, 1000*MiB, 1200*MiB)
	for ts := 300.0; ts < 2*86400; ts += 60 {
		r.ObserveMemory(800*MiB, ts)
	}
	before := r.Recommend(2 * 86400)
	// 在 1500MiB 处被杀（超过上限 1200MiB）。
	ev := r.RecordOOM(1500*MiB, 2*86400)
	if !approx(ev.Amplified, 1875*MiB, 1e-6) {
		t.Fatalf("amplified sample = %.0f MiB, want 1875 MiB", ev.Amplified/MiB)
	}
	after := r.Recommend(2*86400 + 60)
	if !after.Memory.Change {
		t.Fatal("memory recommendation should change after OOM")
	}
	if after.Memory.TargetRequest <= 1500*MiB {
		t.Fatalf("post-OOM target %.1f MiB must exceed OOM usage 1500 MiB", after.Memory.TargetRequest/MiB)
	}
	if after.Memory.TargetRequest <= before.Memory.TargetRequest {
		t.Fatalf("post-OOM target %.1f MiB must be greater than pre-OOM %.1f MiB",
			after.Memory.TargetRequest/MiB, before.Memory.TargetRequest/MiB)
	}
	if !after.Memory.OOMDriven {
		t.Fatal("OOMDriven flag should be set when floor dominates")
	}
}

func TestLimitRatioPreserved(t *testing.T) {
	cfg := DefaultConfig()
	r := New(cfg, 0, 1.0, 2.0, 1000*MiB, 2500*MiB) // 比例 2.0 / 2.5
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r.ObserveCPU(0.2, ts)
		r.ObserveMemory(200*MiB, ts)
	}
	a := r.Recommend(10 * 86400)
	if a.CPU.TargetLimit == 0 || a.Memory.TargetLimit == 0 {
		t.Fatal("limits should be kept when originally set")
	}
	if !approx(a.CPU.TargetLimit/a.CPU.TargetRequest, 2.0, 1e-9) {
		t.Fatalf("cpu limit ratio = %v, want 2.0", a.CPU.TargetLimit/a.CPU.TargetRequest)
	}
	// 内存上限按 MiB 向上取整，比例允许一个粒度级的偏差。
	if !approx(a.Memory.TargetLimit/a.Memory.TargetRequest, 2.5, 2*MiB/a.Memory.TargetRequest) {
		t.Fatalf("mem limit ratio = %v, want 2.5", a.Memory.TargetLimit/a.Memory.TargetRequest)
	}
}

func TestNoLimitStaysNoLimit(t *testing.T) {
	cfg := DefaultConfig()
	r := New(cfg, 0, 1.0, 0, 1000*MiB, 0) // 两边都没设上限
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r.ObserveCPU(0.2, ts)
		r.ObserveMemory(200*MiB, ts)
	}
	a := r.Recommend(10 * 86400)
	if a.CPU.TargetLimit != 0 || a.Memory.TargetLimit != 0 {
		t.Fatalf("unset limits must stay unset: cpu=%v mem=%v", a.CPU.TargetLimit, a.Memory.TargetLimit)
	}
}

func TestChangeOnlyWhenCurrentOutsideBounds(t *testing.T) {
	cfg := DefaultConfig()
	r := New(cfg, 0, 0.5, 0, 500*MiB, 0) // 当前 request 落在中部，大概率在界内
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r.ObserveCPU(0.4, ts)
		r.ObserveMemory(400*MiB, ts)
	}
	a := r.Recommend(10 * 86400)
	// 当前 0.5 核，用量 0.4 核上下，界内应不建议改。
	if a.CPU.Change {
		lo, hi := a.CPU.LowerBound, a.CPU.UpperBound
		if r.cpuRequest >= lo && r.cpuRequest <= hi {
			t.Fatalf("change flagged although request %v inside [%v,%v]", r.cpuRequest, lo, hi)
		}
	}
	// 给一个明显过大的 request，应建议下调。
	r2 := New(cfg, 0, 4.0, 0, 4000*MiB, 0)
	for ts := 300.0; ts < 10*86400; ts += 60 {
		r2.ObserveCPU(0.2, ts)
		r2.ObserveMemory(200*MiB, ts)
	}
	a2 := r2.Recommend(10 * 86400)
	if !a2.CPU.Change || !a2.Memory.Change {
		t.Fatalf("oversized requests should trigger change: cpu=%v mem=%v", a2.CPU.Change, a2.Memory.Change)
	}
	if a2.CPU.TargetRequest >= r2.cpuRequest || a2.Memory.TargetRequest >= r2.memRequest {
		t.Fatal("target should be smaller than current oversized request")
	}
}

func TestOOMRestartRestartsGrace(t *testing.T) {
	cfg := DefaultConfig()
	cfg.StartupGraceSec = 300
	r := New(cfg, 0, 1, 2, 1000*MiB, 1200*MiB)
	r.RecordOOM(1500*MiB, 5000)
	if !r.InGracePeriod(5100) {
		t.Fatal("grace period should restart after OOM restart")
	}
	if r.InGracePeriod(5400) {
		t.Fatal("grace period should end 300s after restart")
	}
}
