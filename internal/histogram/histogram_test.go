package histogram

import (
	"math"
	"testing"
)

// 手算衰减权重：w = 2^(-age/halfLife)
func handWeight(atSec, nowSec, halfLife float64) float64 {
	return math.Pow(2, -(nowSec-atSec)/halfLife)
}

func approx(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestObserveAndBucketIndex(t *testing.T) {
	h := New(2.0, 0) // 不衰减，桶 k 覆盖 [2^k, 2^(k+1))
	h.Observe(1.0, 0)
	h.Observe(1.5, 0) // 与 1.0 同桶 k=0：[1,2)
	h.Observe(3.0, 0) // 桶 k=1：[2,4)
	h.Observe(0, 0)   // 零桶

	snap := h.Snapshot(0)
	var gotZero, gotK0, gotK1 float64
	for _, b := range snap {
		switch {
		case b.Upper == 0:
			gotZero = b.Weight
		case b.Lower == 1.0 && b.Upper == 2.0:
			gotK0 = b.Weight
		case b.Lower == 2.0 && b.Upper == 4.0:
			gotK1 = b.Weight
		}
	}
	if gotZero != 1 || gotK0 != 2 || gotK1 != 1 {
		t.Fatalf("bucket weights wrong: zero=%v k0=%v k1=%v, snap=%+v", gotZero, gotK0, gotK1, snap)
	}
	if h.Count() != 4 {
		t.Fatalf("count = %d, want 4", h.Count())
	}
}

func TestDecayWeightsMatchFormula(t *testing.T) {
	const halfLife = 100.0
	h := New(1.5, halfLife)
	h.Observe(10, 0)
	h.Observe(10, 50)
	h.Observe(10, 100)

	const now = 200.0
	want := handWeight(0, now, halfLife) + handWeight(50, now, halfLife) + handWeight(100, now, halfLife)
	// 三个样本都在同一个桶，桶的有效权重即总有效权重。
	got := h.effectiveTotal(now)
	if math.Abs(got-want) > 1e-10 {
		t.Fatalf("effective total = %.10f, want %.10f", got, want)
	}
	// 手算核对：2^-2 + 2^-1.5 + 2^-1 = 0.25 + 0.353553... + 0.5
	if !approx(got, 0.25+math.Pow(2, -1.5)+0.5, 1e-12) {
		t.Fatalf("hand formula mismatch: %.10f", got)
	}
	// 单点核对：0 时刻样本在 200 时刻恰好经过两个半衰期，权重应为 0.25。
	h2 := New(1.5, halfLife)
	h2.Observe(10, 0)
	if w := h2.effectiveTotal(200); math.Abs(w-0.25) > 1e-12 {
		t.Fatalf("two-half-life weight = %.6f, want 0.25", w)
	}

	// 双桶区分性核对：不同桶的样本各自折算，期望值用独立硬编码手算数字。
	h3 := New(1.5, halfLife)
	h3.Observe(10, 0)    // 桶 A
	h3.Observe(100, 150) // 桶 B
	const now3 = 250.0
	wantA := math.Pow(2, -2.5) // 2^(-250/100)
	wantB := 0.5               // 2^(-100/100)
	for _, b := range h3.Snapshot(now3) {
		var want float64
		switch {
		case b.Lower <= 10 && 10 < b.Upper:
			want = wantA
		case b.Lower <= 100 && 100 < b.Upper:
			want = wantB
		default:
			continue
		}
		if math.Abs(b.Weight-want) > 1e-12 {
			t.Fatalf("bucket [%.2f,%.2f) weight = %.10f, want %.10f", b.Lower, b.Upper, b.Weight, want)
		}
	}
}

func TestNoDecayKeepsFullWeight(t *testing.T) {
	h := New(1.5, 0)
	for i := 0; i < 10; i++ {
		h.Observe(1, float64(i*1000))
	}
	if got := h.effectiveTotal(1e9); got != 10 {
		t.Fatalf("no-decay total = %v, want 10", got)
	}
}

func TestQuantileMonotonicAndKnownValues(t *testing.T) {
	h := New(1.01, 0)
	// 100 个等权样本，值 1..100，分位数应单调且接近经验分位。
	for v := 1; v <= 100; v++ {
		h.Observe(float64(v), 0)
	}
	prev := 0.0
	for _, q := range []float64{0.1, 0.25, 0.5, 0.75, 0.9, 0.99} {
		got := h.Quantile(q, 0)
		if got < prev {
			t.Fatalf("quantile not monotonic at q=%v: %v < %v", q, got, prev)
		}
		prev = got
	}
	med := h.Quantile(0.5, 0)
	// 桶宽因子 1.01 时桶很窄，中位数误差应在真实中位数 50 的 2% 以内。
	if math.Abs(med-50) > 1.0 {
		t.Fatalf("median = %.4f, want ~50", med)
	}
	if q0 := h.Quantile(0, 0); q0 < 0.99 || q0 > 1.02 {
		t.Fatalf("q0 = %.4f, want ~1", q0)
	}
}

func TestQuantileEmpty(t *testing.T) {
	h := New(1.5, 100)
	if got := h.Quantile(0.9, 50); got != 0 {
		t.Fatalf("empty quantile = %v, want 0", got)
	}
}

func TestRescalePreservesWeights(t *testing.T) {
	// 触发重缩放后，有效权重应与不触发时一致。
	h1 := New(1.2, 10.0)
	h2 := New(1.2, 10.0)
	for i := 0; i < 50; i++ {
		at := float64(i) * 30 // scale 会超过 1e12 触发 rescale
		h1.Observe(float64(i+1), at)
		h2.Observe(float64(i+1), at)
	}
	// h2 手动 rescale 一次再对比。
	h2.rescale(49 * 30)
	a, b := h1.effectiveTotal(49*30), h2.effectiveTotal(49*30)
	if math.Abs(a-b) > a*1e-9 {
		t.Fatalf("rescale changed weights: %.8f vs %.8f", a, b)
	}
	q1, q2 := h1.Quantile(0.9, 49*30), h2.Quantile(0.9, 49*30)
	if math.Abs(q1-q2) > q1*1e-9 {
		t.Fatalf("rescale changed quantile: %.8f vs %.8f", q1, q2)
	}
}

func TestZeroAndNegativeGoZeroBucket(t *testing.T) {
	h := New(2.0, 0)
	h.Observe(0, 0)
	h.Observe(-3, 0)
	if got := h.Quantile(0.5, 0); got != 0 {
		t.Fatalf("zero bucket quantile = %v, want 0", got)
	}
}
