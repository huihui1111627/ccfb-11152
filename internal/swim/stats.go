package swim

import (
	"fmt"
	"sort"
)

// LatencyStats summarises a set of detection latencies in seconds.
type LatencyStats struct {
	N      int     `json:"n"`
	Mean   float64 `json:"mean"`
	Median float64 `json:"median"`
	P95    float64 `json:"p95"`
	P99    float64 `json:"p99"`
	Max    float64 `json:"max"`
}

func computeLatency(xs []float64) LatencyStats {
	if len(xs) == 0 {
		return LatencyStats{}
	}
	sort.Float64s(xs)
	n := len(xs)
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	pct := func(p float64) float64 {
		idx := int(p * float64(n-1))
		if idx < 0 {
			idx = 0
		}
		if idx >= n {
			idx = n - 1
		}
		return xs[idx]
	}
	return LatencyStats{
		N: n, Mean: sum / float64(n), Median: pct(0.5),
		P95: pct(0.95), P99: pct(0.99), Max: xs[n-1],
	}
}

// Theory holds the analytic values the run is compared against.
type Theory struct {
	FirstProbeSeconds  float64 `json:"first_probe_seconds"`
	SuspicionSeconds   float64 `json:"suspicion_seconds"`
	DetectionSeconds   float64 `json:"detection_seconds"`
	MsgsPerMemberSec   float64 `json:"msgs_per_member_sec"`
	BytesPerMemberSec  float64 `json:"bytes_per_member_sec"`
	FalsePosPerPeriod  float64 `json:"false_pos_per_period"`
	FalsePosPerMemberSec float64 `json:"false_pos_per_member_sec"`
	Qf                 float64 `json:"qf"`
	Qml                float64 `json:"qml"`
	Note               string  `json:"note"`
}

// Result is the reproducible outcome of one simulation run.
type Result struct {
	Scenario   string  `json:"scenario"`
	Title      string  `json:"title"`
	Seed       uint64  `json:"seed"`
	Members    int     `json:"members"`
	Duration   float64 `json:"duration"`
	Lifeguard  bool    `json:"lifeguard"`
	Loss       float64 `json:"loss"`

	// Detection of true failures.
	TrueFailures      int          `json:"true_failures"`
	DetectedFailures  int          `json:"detected_failures"`
	DetectionLatency  LatencyStats `json:"detection_latency"`
	DetectionByTarget []TargetDetection `json:"detection_by_target,omitempty"`

	// False positives. IsolatedConfirms counts declarations that were true from
	// the observer's vantage point (a network partition) and are therefore not
	// counted as detector errors.
	FalsePositives    int     `json:"false_positives"`
	IsolatedConfirms  int     `json:"isolated_confirms"`
	IsolatedConfirmsPerSec float64 `json:"isolated_per_sec"`
	FPUniqueMembers   int     `json:"fp_unique_members"`
	FalsePosPerSecond float64 `json:"false_pos_per_second"`
	FPMembers         []int   `json:"fp_members,omitempty"`

	// Dissemination.
	JoinLatency     LatencyStats `json:"join_latency"`
	LeaveLatency    LatencyStats `json:"leave_latency"`
	Joins           int          `json:"joins"`
	Leaves          int          `json:"leaves"`

	// Traffic.
	MsgsSent        int64         `json:"msgs_sent"`
	BytesSent       int64         `json:"bytes_sent"`
	MsgsPerMemberSec float64      `json:"msgs_per_member_sec"`
	BytesPerMemberSec float64     `json:"bytes_per_member_sec"`
	Traffic         []TrafficBucket `json:"traffic,omitempty"`

	// Probe accounting.
	Probes          int     `json:"probes"`
	DirectProbes    int     `json:"direct_probes"`
	IndirectProbes  int     `json:"indirect_probes"`
	TimeoutProbes   int     `json:"timeout_probes"`

	// Dissemination payload accounting.
	Truncations int64 `json:"truncations"`
	ByKind map[string]int64 `json:"by_kind,omitempty"`
	Refutations int64 `json:"refutations"`
	DropLoss    int64 `json:"drop_loss"`
	DropPartition int64 `json:"drop_partition"`

	WallSeconds float64 `json:"wall_seconds"`

	Theory Theory `json:"theory"`
	Digest string `json:"digest"`

	Detail *Detail `json:"detail,omitempty"`
}

// TargetDetection explains one true failure's detection.
type TargetDetection struct {
	Target      int     `json:"target"`
	Kind        string  `json:"kind"` // crash | leave
	DownAt      float64 `json:"down_at"`
	DetectedAt  float64 `json:"detected_at"` // -1 if never
	Latency     float64 `json:"latency"`
	Detected    bool    `json:"detected"`
	Observer    int     `json:"observer"`
}

// finish computes all metrics from the completed run.
func (s *Sim) finish() *Result {
	res := &Result{
		Scenario:  s.scenario.Name,
		Title:     s.scenario.Title,
		Seed:      s.seed,
		Members:   s.scenario.Members,
		Duration:  seconds(s.done-s.started) + seconds(s.started),
		Lifeguard: s.cfg.Lifeguard,
		Loss:      s.cfg.Loss,
		Traffic:   s.bucket,
	}

	down := s.scenario.Downtime()
	// Detection latency per ground-truth failure: the first confirmation by a
	// member that is not the target itself after the failure began.
	firstByTarget := map[int]Confirmation{}
	fpSeen := map[[2]int]bool{}
	fpMembers := map[int]bool{}
	for _, c := range s.confirmations {
		if c.At < s.started {
			continue
		}
		if c.Isolated {
			res.IsolatedConfirms++
			continue
		}
		target := c.Target
		ivs := down[target]
		if len(ivs) == 0 {
			// Not a scheduled failure at all: a false positive.
			res.FalsePositives++
			key := [2]int{c.Observer, c.Target}
			if !fpSeen[key] {
				fpSeen[key] = true
				fpMembers[target] = true
			}
			continue
		}
		if DownAt(ivs, c.At) {
			if _, ok := firstByTarget[target]; !ok {
				firstByTarget[target] = c
			}
		} else {
			// The target was actually up when someone declared it dead.
			res.FalsePositives++
			key := [2]int{c.Observer, c.Target}
			if !fpSeen[key] {
				fpSeen[key] = true
				fpMembers[target] = true
			}
		}
	}
	res.FPUniqueMembers = len(fpMembers)
	for m := range fpMembers {
		res.FPMembers = append(res.FPMembers, m)
	}
	sort.Ints(res.FPMembers)
	window := seconds(s.done - s.started)
	if window > 0 {
		res.FalsePosPerSecond = float64(res.FalsePositives) / window
		res.IsolatedConfirmsPerSec = float64(res.IsolatedConfirms) / window
	}

	// Ground-truth failures.
	var latencies []float64
	for id, ivs := range down {
		for _, iv := range ivs {
			kind := "crash"
			if iv.End >= int64(s.scenario.Duration) {
				kind = "leave"
			}
			td := TargetDetection{Target: id, Kind: kind, DownAt: seconds(iv.Start), DetectedAt: -1}
			if c, ok := firstByTarget[id]; ok && c.At >= iv.Start && c.At < iv.End {
				td.Detected = true
				td.DetectedAt = seconds(c.At)
				td.Latency = seconds(c.At - iv.Start)
				td.Observer = c.Observer
				latencies = append(latencies, td.Latency)
				res.DetectedFailures++
			}
			res.TrueFailures++
			res.DetectionByTarget = append(res.DetectionByTarget, td)
		}
	}
	sort.Slice(res.DetectionByTarget, func(i, j int) bool {
		return res.DetectionByTarget[i].Target < res.DetectionByTarget[j].Target
	})
	res.DetectionLatency = computeLatency(latencies)

	// Dissemination: how long after a join/leave the whole (sampled) group knew.
	res.Joins, res.Leaves = s.disseminationLatency(res)

	// Traffic normalised by member count and by the measurement window.
	n := s.scenario.Members
	if n < 1 {
		n = 1
	}
	res.MsgsSent = s.msgsSent
	res.BytesSent = s.bytesSent
	if window > 0 {
		res.MsgsPerMemberSec = float64(s.msgsSent) / window / float64(n)
		res.BytesPerMemberSec = float64(s.bytesSent) / window / float64(n)
	}
	res.Truncations = s.rec.truncations
	res.Refutations = s.rec.refuteCount
	res.DropLoss = s.rec.dropLoss
	res.DropPartition = s.rec.dropPartition

	// Probe accounting.
	for _, p := range s.rec.probes {
		if p.Start < s.started {
			continue
		}
		res.Probes++
		if len(p.Relays) > 0 {
			res.IndirectProbes++
		} else {
			res.DirectProbes++
		}
		if p.Outcome == "timeout" {
			res.TimeoutProbes++
		}
	}

	// Theory: compare against the SWIM paper's analytic estimates.
	qf := 1.0
	if n > 0 {
		qf = 1.0 // baseline was fully healthy; failures are the exceptions
	}
	_ = qf
	qfHealthy := 1.0 - float64(res.TrueFailures)/float64(n)
	qml := 1 - s.cfg.Loss
	period := seconds(int64(s.cfg.ProbeInterval))
	suspicion := s.cfg.SuspicionTimeout(n, period, s.cfg.ConfirmK)
	res.Theory = Theory{
		FirstProbeSeconds: TheoryFirstProbe(period, qfHealthy),
		SuspicionSeconds:  suspicion,
		DetectionSeconds:  TheoryDetectionTime(period, qfHealthy, suspicion),
		MsgsPerMemberSec:  TheoryMessagesPerMemberPerSecond(period),
		FalsePosPerPeriod: TheoryFalsePositivePerPeriod(qfHealthy, qml, s.cfg.IndirectK),
		Qf:                qfHealthy,
		Qml:               qml,
	}
	// The paper reports 15-byte packets with no payload and 135 bytes with a
	// full piggyback; the mean load figure in Fig. 2 is ~2.0 messages per
	// member per period, i.e. one ping and one ack.
	res.Theory.BytesPerMemberSec = res.Theory.MsgsPerMemberSec * 40
	res.Theory.FalsePosPerMemberSec = res.Theory.FalsePosPerPeriod / period
	res.Theory.Note = "First probe: T'/(1-e^-qf) (SWIM §3.1). Confirmation adds the suspicion timeout. Messages: 2 per member per period. False positives: SWIM §3.1 per-period expression."

	res.ByKind = map[string]int64{}
	for k, v := range s.kindSent {
		res.ByKind[k.String()] = v
	}
	// The digest covers every confirmation, the per-second traffic, and the
	// aggregate counters. It is computed for every run (detail or not), so the
	// determinism guarantee can be checked cheaply.
	res.Digest = Digest(struct {
		Confirms    []Confirmation
		Traffic     []TrafficBucket
		Msgs        int64
		Bytes       int64
		MsgsPerNode []NodeTraffic
		Refutations int64
		Truncations int64
	}{s.confirmations, s.bucket, s.msgsSent, s.bytesSent, s.perNode, s.rec.refuteCount, s.rec.truncations})

	res.Detail = s.rec.BuildDetail(s)
	return res
}

// disseminationLatency measures how long each join or leave took to reach the
// group. Reporting the time to 90% coverage (rather than 100%) matches how the
// SWIM paper characterises dissemination ("a few protocol periods" for nearly
// all members) and avoids a long tail from a few members that only ever hear a
// rumour through their own round-robin probe, which takes O(n) periods.
func (s *Sim) disseminationLatency(res *Result) (joins, leaves int) {
	const coverage = 0.90
	var joinLat, leaveLat []float64
	for _, t := range s.changes {
		if t == nil {
			continue
		}
		var times []int64
		seen := 0
		for _, n := range s.nodes {
			if n.id == t.target || n.id >= len(t.seen) || !n.alive() || n.createdAt > t.at {
				continue
			}
			seen++
			if t.seen[n.id] && t.learned[n.id] >= t.at {
				times = append(times, t.learned[n.id])
			}
		}
		if seen == 0 || len(times) < int(coverage*float64(seen)) {
			continue
		}
		sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
		idx := int(coverage*float64(seen)) - 1
		if idx < 0 {
			idx = 0
		}
		d := seconds(times[idx] - t.at)
		if t.kind == "join" {
			joins++
			joinLat = append(joinLat, d)
		} else {
			leaves++
			leaveLat = append(leaveLat, d)
		}
	}
	res.JoinLatency = computeLatency(joinLat)
	res.LeaveLatency = computeLatency(leaveLat)
	return joins, leaves
}

// SummaryLine renders a compact human-readable digest.
func (r *Result) SummaryLine() string {
	return fmt.Sprintf("%-10s seed=%d n=%d detect=%d/%d med=%.2fs fp=%d msgs/member/s=%.2f",
		r.Scenario, r.Seed, r.Members, r.DetectedFailures, r.TrueFailures,
		r.DetectionLatency.Median, r.FalsePositives, r.MsgsPerMemberSec)
}
