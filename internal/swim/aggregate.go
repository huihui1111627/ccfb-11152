package swim

import (
	"fmt"
	"sort"
)

// Aggregate summarises one scenario across seeds.
type Aggregate struct {
	Scenario string   `json:"scenario"`
	Config   string   `json:"config,omitempty"` // "lifeguard" | "baseline"
	Title    string   `json:"title"`
	Runs     int      `json:"runs"`
	Members  int      `json:"members"`

	DetectionMean   float64 `json:"detection_mean"`
	DetectionMedian float64 `json:"detection_median"`
	DetectionP95    float64 `json:"detection_p95"`
	DetectionMax    float64 `json:"detection_max"`
	DetectedRate    float64 `json:"detected_rate"`

	FPTotal    int     `json:"fp_total"`
	FPPerRun   float64 `json:"fp_per_run"`
	FPPerSec   float64 `json:"fp_per_sec"`
	IsolatedTotal int `json:"isolated_total"`

	MsgsPerMemberSec  float64 `json:"msgs_per_member_sec"`
	BytesPerMemberSec float64 `json:"bytes_per_member_sec"`

	JoinMedian  float64 `json:"join_median"`
	LeaveMedian float64 `json:"leave_median"`

	Theory Theory `json:"theory"`
}

// Comparison is one scenario measured under both configurations, so the paper's
// central claim (Lifeguard cuts false positives without hurting detection) can
// be read directly off the batch report.
type Comparison struct {
	Scenario  string    `json:"scenario"`
	Title     string    `json:"title"`
	Members   int       `json:"members"`
	Lifeguard Aggregate `json:"lifeguard"`
	Baseline  Aggregate `json:"baseline"`
	FPFactor  float64   `json:"fp_factor"` // baseline FP / Lifeguard FP (>=1 is better)
}

// BatchReport is the JSON written by the batch command.
type BatchReport struct {
	Seeds       int          `json:"seeds"`
	SeedStart   int          `json:"seed_start"`
	GeneratedBy string       `json:"generated_by"`
	Aggregates  []Aggregate  `json:"aggregates"`
	Comparisons []Comparison `json:"comparisons"`
}

// Summarize combines a scenario's per-seed results.
func Summarize(key string, runs []*Result) Aggregate {
	a := Aggregate{Scenario: key, Runs: len(runs)}
	if len(runs) > 0 {
		if runs[0].Lifeguard {
			a.Config = "lifeguard"
		} else {
			a.Config = "baseline"
		}
	}
	if len(runs) == 0 {
		return a
	}
	a.Title = runs[0].Title
	a.Members = runs[0].Members
	a.Theory = runs[0].Theory
	var lats []float64
	var joinLat, leaveLat []float64
	totalDetected, totalFailures := 0, 0
	var fpSum, isoSum int
	var fpPerSec, msgs, bytesSum float64
	for _, r := range runs {
		totalDetected += r.DetectedFailures
		totalFailures += r.TrueFailures
		fpSum += r.FalsePositives
		isoSum += r.IsolatedConfirms
		fpPerSec += r.FalsePosPerSecond
		msgs += r.MsgsPerMemberSec
		bytesSum += r.BytesPerMemberSec
		for _, td := range r.DetectionByTarget {
			if td.Detected {
				lats = append(lats, td.Latency)
			}
		}
		if r.JoinLatency.N > 0 {
			joinLat = append(joinLat, r.JoinLatency.Median)
		}
		if r.LeaveLatency.N > 0 {
			leaveLat = append(leaveLat, r.LeaveLatency.Median)
		}
	}
	if totalFailures > 0 {
		a.DetectedRate = float64(totalDetected) / float64(totalFailures)
	}
	st := computeLatency(lats)
	a.DetectionMean = st.Mean
	a.DetectionMedian = st.Median
	a.DetectionP95 = st.P95
	a.DetectionMax = st.Max
	a.FPTotal = fpSum
	a.IsolatedTotal = isoSum
	a.FPPerRun = float64(fpSum) / float64(len(runs))
	a.FPPerSec = fpPerSec / float64(len(runs))
	a.MsgsPerMemberSec = msgs / float64(len(runs))
	a.BytesPerMemberSec = bytesSum / float64(len(runs))
	a.JoinMedian = computeLatency(joinLat).Median
	a.LeaveMedian = computeLatency(leaveLat).Median
	return a
}

// CompareReport contrasts Lifeguard against baseline SWIM for a scenario.
type CompareReport struct {
	Scenario  string    `json:"scenario"`
	Lifeguard Aggregate `json:"lifeguard"`
	Baseline  Aggregate `json:"baseline"`
}

func (c CompareReport) String() string {
	return fmt.Sprintf("%s: Lifeguard FP/run=%.2f, SWIM FP/run=%.2f", c.Scenario, c.Lifeguard.FPPerRun, c.Baseline.FPPerRun)
}

// SortAggregates orders by scenario key for stable output.
func SortAggregates(as []Aggregate) {
	sort.Slice(as, func(i, j int) bool { return as[i].Scenario < as[j].Scenario })
}
