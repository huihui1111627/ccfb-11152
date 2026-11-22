package swim

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// ProbeRecord is one completed probe attempt as seen by its initiator.
type ProbeRecord struct {
	Initiator int    `json:"initiator"`
	Target    int    `json:"target"`
	Start     int64  `json:"start"`
	End       int64  `json:"end"`
	Outcome   string `json:"outcome"` // direct | indirect | timeout
	Relays    []int  `json:"relays,omitempty"`
	Nacks     int    `json:"nacks"`
}

// SuspicionEvent is a change in one observer's suspicion timer.
type SuspicionEvent struct {
	Observer    int     `json:"observer"`
	Target      int     `json:"target"`
	Inc         uint64  `json:"inc"`
	Kind        string  `json:"kind"` // raised | shortened | cleared
	Cause       string  `json:"cause"`
	Independent int     `json:"independent"`
	Timeout     float64 `json:"timeout,omitempty"` // seconds
	At          int64   `json:"at"`
}

// RefuteEvent records a member defending itself against a suspicion.
type RefuteEvent struct {
	Member    int    `json:"member"`
	Inc       uint64 `json:"inc"`
	AboutKind string `json:"about_kind"`
	At        int64  `json:"at"`
}

// MemberEvent is a status transition in one observer's view. The detail page
// replays these to rebuild the member table at any instant.
type MemberEvent struct {
	At       int64  `json:"t"`
	Observer int    `json:"observer"`
	Target   int    `json:"target"`
	From     Status `json:"from"`
	To       Status `json:"to"`
	Inc      uint64 `json:"inc"`
	Cause    string `json:"cause"`
}

// LifecycleEvent covers joins, leaves, crashes, restarts and pauses.
type LifecycleEvent struct {
	At    int64  `json:"t"`
	Kind  string `json:"kind"` // join | joined | leave | crash | rejoin | pause | resume
	ID    int    `json:"id"`
	Inc   uint64 `json:"inc,omitempty"`
	Until int64  `json:"until,omitempty"`
}

// MessageSample is a sampled protocol datagram kept for the payload viewer.
type MessageSample struct {
	At       int64       `json:"t"`
	Kind     MessageKind `json:"kind"`
	From     int         `json:"from"`
	To       int         `json:"to"`
	Size     int         `json:"size"`
	Budget   int         `json:"budget"`
	Carried  int         `json:"carried"`
	Backlog  int         `json:"backlog"` // sender's buffer size when sent
	Piggy    []Update    `json:"piggy,omitempty"`
}

// Recorder collects per-run observability data.
type Recorder struct {
	sc     Scenario
	detail bool

	probes       []ProbeRecord
	probeSeen    int
	probeStride  int
	suspicions   []SuspicionEvent
	refutes      []RefuteEvent
	memberEvents []MemberEvent
	lifecycle    []LifecycleEvent
	samples      []MessageSample
	dropLoss     int64
	dropPartition int64
	truncations  int64
	refuteCount  int64
	joinsDone    int64
}

// NewRecorder builds a recorder for a scenario.
func NewRecorder(sc Scenario) *Recorder {
	r := &Recorder{sc: sc, detail: sc.Detail, probeStride: 1}
	// One probe per member per protocol period on expectation.
	expected := float64(sc.Members) * sc.Duration.Seconds() / sc.Config.ProbeInterval.Seconds()
	if sc.Config.ProbeInterval > 0 && expected > probeCap {
		r.probeStride = int(expected / probeCap)
		if r.probeStride < 1 {
			r.probeStride = 1
		}
	}
	return r
}

// Per-array caps for the embedded trace. Probes and message samples dominate
// the payload, so they are capped tightly; member transitions are the backbone
// of the replay view and are kept in full up to a much larger bound.
const (
	probeCap       = 14000
	sampleCap      = 400
	memberEventCap = 220000
	suspicionCap   = 30000
	refuteCap      = 8000
)

func (r *Recorder) OnProbe(s *Sim, p ProbeRecord) {
	if !r.detail {
		return
	}
	r.probeSeen++
	// Keep a deterministic uniform sample across the whole run, so the timeline
	// tab shows late-run activity too. The acceptance probability targets
	// probeCap records out of the expected total.
	if r.probeStride > 1 && Mix(r.sc.Seed, uint64(r.probeSeen))%uint64(r.probeStride) != 0 {
		return
	}
	pp := p
	if len(p.Relays) > 0 {
		pp.Relays = append([]int(nil), p.Relays...)
	}
	r.probes = append(r.probes, pp)
}

func (r *Recorder) OnSuspicion(s *Sim, e SuspicionEvent) {
	e.At = s.now
	if !r.detail || len(r.suspicions) >= suspicionCap {
		return
	}
	r.suspicions = append(r.suspicions, e)
}

func (r *Recorder) OnRefute(s *Sim, e RefuteEvent) {
	if !r.detail || len(r.refutes) >= refuteCap {
		return
	}
	r.refutes = append(r.refutes, e)
}

func (r *Recorder) RecordRefute() { r.refuteCount++ }

func (r *Recorder) OnConfirm(s *Sim, c Confirmation) {
	c.At = s.now
	// Only a transition counts. confirmFrom already suppresses prev==to, but
	// record the guard here too for callers that bypass it.
	if !r.detail {
		// Keep counting in batch mode; confirmFrom's prev==to check is authoritative.
	}
	c.TrueDown = DownAt(s.scenario.Downtime()[c.Target], s.now)
	c.Isolated = s.partitionInduced(c.Observer, c.Target, c.At) || c.PartitionTainted
	s.confirmations = append(s.confirmations, c)
}

func (r *Recorder) OnMember(s *Sim, e MemberEvent) {
	if !r.detail || len(r.memberEvents) >= memberEventCap {
		return
	}
	r.memberEvents = append(r.memberEvents, e)
}

func (r *Recorder) OnJoin(s *Sim, id int) {
	if !r.detail {
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "join", ID: id})
}

func (r *Recorder) OnJoinComplete(s *Sim, id int) {
	if !r.detail {
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "joined", ID: id, Inc: s.nodes[id].inc})
}

func (r *Recorder) RecordJoinComplete(id int) { r.joinsDone++ }

func (r *Recorder) OnLeave(s *Sim, id int) {
	if !r.detail {
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "leave", ID: id})
}

func (r *Recorder) OnCrash(s *Sim, id int) {
	if !r.detail {
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "crash", ID: id})
}

func (r *Recorder) OnRejoin(s *Sim, id int, inc uint64) {
	if !r.detail {
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "rejoin", ID: id, Inc: inc})
}

func (r *Recorder) OnPause(s *Sim, id int, until int64, resume bool) {
	if !r.detail {
		return
	}
	if resume {
		r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "resume", ID: id})
		return
	}
	r.lifecycle = append(r.lifecycle, LifecycleEvent{At: s.now, Kind: "pause", ID: id, Until: until})
}

func (r *Recorder) OnDrop(s *Sim, from, to int, m Message, reason string) {
	if reason == "loss" {
		r.dropLoss++
	} else {
		r.dropPartition++
	}
}

// sampleModulo controls the deterministic message-sampling rate. One in every
// `sampleModulo` datagrams is retained (plus every truncated one).
const sampleModulo = 211

func (r *Recorder) OnMessage(s *Sim, from, to int, m Message, size int) {
	if !r.detail {
		return
	}
	budget := s.cfg.MaxPiggyback()
	if len(r.samples) >= sampleCap {
		return
	}
	truncated := budget > 0 && len(m.Piggy) >= budget && m.Backlog > len(m.Piggy)
	h := Mix(s.seed, s.sendSeq)
	if truncated {
		if h%3 != 0 {
			return
		}
	} else if h%sampleModulo != 0 {
		return
	}
	ms := MessageSample{
		At: s.now, Kind: m.Kind, From: from, To: to, Size: size, Budget: budget,
		Carried: len(m.Piggy) + len(m.Sync), Backlog: m.Backlog,
	}
	if len(m.Piggy) > 0 {
		ms.Piggy = append([]Update(nil), m.Piggy...)
	}
	if len(m.Sync) > 0 {
		ms.Piggy = append(ms.Piggy, m.Sync...)
	}
	r.samples = append(r.samples, ms)
}

// OnTruncated records that a sender had more gossip than fit in the packet.
func (r *Recorder) OnTruncated(s *Sim, carried, backlog int) {
	if carried < backlog {
		r.truncations++
	}
}

// Digest hashes the reproducible observables of a run.
func Digest(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// BuildDetail assembles the embedded trace for the web page.
func (r *Recorder) BuildDetail(s *Sim) *Detail {
	if !r.detail {
		return nil
	}
	return &Detail{
		MemberEvents:  r.memberEvents,
		Probes:        r.probes,
		Suspicions:    r.suspicions,
		Confirms:      s.confirmations,
		Refutes:       r.refutes,
		Lifecycle:     r.lifecycle,
		Samples:       r.samples,
		Downtime:      downtimeView(r.sc),
		DropLoss:      r.dropLoss,
		DropPartition: r.dropPartition,
		Truncations:   r.truncations,
	}
}

// Detail is the embedded trace served to the visualisation page.
type Detail struct {
	MemberEvents  []MemberEvent    `json:"member_events"`
	Probes        []ProbeRecord    `json:"probes"`
	Suspicions    []SuspicionEvent `json:"suspicions"`
	Confirms      []Confirmation   `json:"confirms"`
	Refutes       []RefuteEvent    `json:"refutes"`
	Lifecycle     []LifecycleEvent `json:"lifecycle"`
	Samples       []MessageSample  `json:"samples"`
	Downtime      []ScheduledDown  `json:"downtime"`
	DropLoss      int64            `json:"drop_loss"`
	DropPartition int64            `json:"drop_partition"`
	Truncations   int64            `json:"truncations"`
}

// ScheduledDown is ground-truth downtime, exposed to the page.
type ScheduledDown struct {
	ID    int   `json:"id"`
	Start int64 `json:"start"`
	End   int64 `json:"end"`
	Leave bool  `json:"leave"`
}

func downtimeView(sc Scenario) []ScheduledDown {
	var out []ScheduledDown
	for _, inj := range sc.Injections {
		switch inj.Kind {
		case InjectCrash:
			for _, id := range inj.Members {
				out = append(out, ScheduledDown{ID: id, Start: int64(inj.At), End: int64(inj.At + inj.Duration)})
			}
		case InjectLeave:
			for _, id := range inj.Members {
				out = append(out, ScheduledDown{ID: id, Start: int64(inj.At), End: int64(sc.Duration), Leave: true})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Start != out[j].Start {
			return out[i].Start < out[j].Start
		}
		return out[i].ID < out[j].ID
	})
	return out
}
