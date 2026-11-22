// Package histogram 实现按指数增长桶宽分桶、按时间指数衰减加权的直方图。
//
// 桶宽按指数增长：第 k 个桶覆盖 [factor^k, factor^(k+1))，另设一个零桶
// 容纳恰好为 0 的样本。每个样本以 2^(-age/halfLife) 的权重累加到对应桶中，
// 历史越久权重越小（半衰期 halfLife 可配）。
//
// 记账方式：桶内保存的是“折算到固定锚点 anchorSec 的权重”。在 atSec 到来的
// 样本（其在 atSec 自身权重为 1），锚点权重为 g(anchor,atSec)，其中
// g(a,b)=2^((b-a)/halfLife)；读取 nowSec 时刻的有效权重 2^(-(now-at)/hl)
// 时再统一除以 g(anchor,now) 还原。锚点可随时向前推进（rescale），
// 推进时全部桶值除以 g(oldAnchor,newAnchor)。
package histogram

import (
	"math"
	"sort"
)

// Histogram 指数桶宽 + 时间指数衰减直方图。非并发安全，由调用方加锁。
type Histogram struct {
	factor   float64 // 桶宽增长因子，> 1
	halfLife float64 // 权重半衰期（时间单位与传入的时间戳一致），<=0 表示不衰减

	anchorSec  float64           // 记账锚点时间戳
	buckets    map[int32]float64 // 桶序号 -> 折算到锚点的累计权重
	zeroBucket float64           // 零桶累计权重（同样折算到锚点）
	count      int64             // 累计观测次数（含已衰减样本，仅用于展示）
}

// New 创建直方图。factor 为桶宽增长因子（必须 >1），halfLife 为权重半衰期，
// halfLife<=0 表示权重不随时间衰减。
func New(factor, halfLife float64) *Histogram {
	if factor <= 1 {
		panic("histogram: factor must be > 1")
	}
	return &Histogram{
		factor:    factor,
		halfLife:  halfLife,
		anchorSec: 0,
		buckets:   make(map[int32]float64),
	}
}

// growth 返回从 fromSec 到 toSec 的权重增长因子 g(a,b)=2^((b-a)/halfLife)。
func (h *Histogram) growth(fromSec, toSec float64) float64 {
	if h.halfLife <= 0 || toSec <= fromSec {
		return 1
	}
	return math.Pow(2, (toSec-fromSec)/h.halfLife)
}

// rescale 把记账锚点推进到 nowSec：同一份历史在更晚锚点下权重变小，
// 全部桶值除以 g(oldAnchor, newAnchor)。
func (h *Histogram) rescale(nowSec float64) {
	if nowSec <= h.anchorSec {
		return
	}
	g := h.growth(h.anchorSec, nowSec)
	if g == 1 {
		h.anchorSec = nowSec
		return
	}
	inv := 1 / g
	for k, v := range h.buckets {
		h.buckets[k] = v * inv
	}
	h.zeroBucket *= inv
	h.anchorSec = nowSec
}

// Observe 在时间戳 atSec 加入一个值为 v 的样本。
func (h *Histogram) Observe(v, atSec float64) {
	if math.IsNaN(v) {
		return
	}
	h.count++
	// 锚点始终不晚于观测时刻；长期运行后锚点过旧时推进一次，避免记账值过小。
	if atSec-h.anchorSec > 40*h.halfLife {
		h.rescale(atSec)
	}
	// 样本折算到锚点的权重 = g(anchor, atSec)。
	w := h.growth(h.anchorSec, atSec)
	if v <= 0 {
		h.zeroBucket += w
		return
	}
	// 第 k 个桶覆盖 [factor^k, factor^(k+1))
	k := int32(math.Floor(math.Log(v) / math.Log(h.factor)))
	h.buckets[k] += w
}

// weightAt 把锚点记账值还原成 nowSec 时刻的有效权重。
func (h *Histogram) weightAt(anchorValue, nowSec float64) float64 {
	g := h.growth(h.anchorSec, nowSec)
	if g == 1 {
		return anchorValue
	}
	return anchorValue / g
}

// effectiveTotal 返回 nowSec 时刻所有样本的有效权重之和。
func (h *Histogram) effectiveTotal(nowSec float64) float64 {
	total := h.weightAt(h.zeroBucket, nowSec)
	for _, v := range h.buckets {
		total += h.weightAt(v, nowSec)
	}
	return total
}

// Quantile 返回 nowSec 时刻的加权分位数（q∈[0,1]），桶内按桶宽线性插值。
// 没有样本时返回 0。
func (h *Histogram) Quantile(q, nowSec float64) float64 {
	if q < 0 {
		q = 0
	} else if q > 1 {
		q = 1
	}
	if len(h.buckets) == 0 && h.zeroBucket == 0 {
		return 0
	}
	target := q * h.effectiveTotal(nowSec)

	// 零桶覆盖值恰好为 0 的样本。
	if h.zeroBucket > 0 {
		zeroW := h.weightAt(h.zeroBucket, nowSec)
		if target <= zeroW {
			return 0
		}
		target -= zeroW
	}

	keys := make([]int32, 0, len(h.buckets))
	for k := range h.buckets {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	var cum float64
	for _, k := range keys {
		w := h.weightAt(h.buckets[k], nowSec)
		lo := math.Pow(h.factor, float64(k))
		hi := math.Pow(h.factor, float64(k)+1)
		if target <= cum+w {
			frac := 0.0
			if w > 0 {
				frac = (target - cum) / w
			}
			return lo + frac*(hi-lo)
		}
		cum += w
	}
	// 浮点误差兜底：落在最后一个桶的上界。
	last := keys[len(keys)-1]
	return math.Pow(h.factor, float64(last)+1)
}

// BucketWidthAt 返回值 v 所在桶的桶宽，用于校验时的误差上界。
func (h *Histogram) BucketWidthAt(v float64) float64 {
	if v <= 0 {
		return 0
	}
	k := math.Floor(math.Log(v) / math.Log(h.factor))
	lo := math.Pow(h.factor, k)
	return lo*(h.factor-1) + 1e-15 // 小量余量，容纳浮点舍入
}

// Bucket 桶快照，供页面画用量直方图。
type Bucket struct {
	Lower float64 `json:"lower"`
	Upper float64 `json:"upper"`
	// Weight 该桶在 nowSec 时刻的有效权重（已折算衰减）。
	Weight float64 `json:"weight"`
}

// Snapshot 返回 nowSec 时刻按桶序号排序的非空桶快照。
func (h *Histogram) Snapshot(nowSec float64) []Bucket {
	keys := make([]int32, 0, len(h.buckets))
	for k := range h.buckets {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	out := make([]Bucket, 0, len(keys)+1)
	if h.zeroBucket > 0 {
		out = append(out, Bucket{Lower: 0, Upper: 0, Weight: h.weightAt(h.zeroBucket, nowSec)})
	}
	for _, k := range keys {
		out = append(out, Bucket{
			Lower:  math.Pow(h.factor, float64(k)),
			Upper:  math.Pow(h.factor, float64(k)+1),
			Weight: h.weightAt(h.buckets[k], nowSec),
		})
	}
	return out
}

// Count 返回累计观测次数（不扣除已衰减样本，仅用于展示与测试）。
func (h *Histogram) Count() int64 { return h.count }
