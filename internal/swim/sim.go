package swim

import (
	"container/heap"
	"math"
	"time"
)

// ---------------------------------------------------------------------------
// Deterministic event queue

type simEvent struct {
	at  int64
	seq uint64
	fn  func()
}

type eventHeap []*simEvent

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].at != h[j].at {
		return h[i].at < h[j].at
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(*simEvent)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return e
}

// ---------------------------------------------------------------------------
// Simulator

// Sim owns the event queue, the members and the injected faults. Every state
// change is triggered by an event popped in (time, scheduling-order) order, so
// a run is a pure function of its Scenario.
type Sim struct {
	cfg      Config
	scenario Scenario
	seed     uint64

	now  int64
	seq  uint64
	heap eventHeap

	nodes []*Node

	packetID uint64
	sendSeq  uint64

	// Traffic accounting.
	msgsSent int64
	bytesSent int64
	kindSent map[MessageKind]int64
	perNode  []NodeTraffic
	bucket   []TrafficBucket
	truncated int64

	confirmations []Confirmation
	partitions    []partitionWindow
	changes       []*spreadTracker
	// lastAlive[observer][target] is the last simulated time the observer's view
	// of the target became Alive. A later confirmation is partition-induced if a
	// partition window separated the two since then.
	lastAlive map[[2]int]int64

	started int64
	done    int64

	rec *Recorder
}

// NodeTraffic counts protocol messages a member put on the wire.
type NodeTraffic struct {
	Sent  int64 `json:"sent"`
	Bytes int64 `json:"bytes"`
}

// TrafficBucket is one second of aggregate traffic.
type TrafficBucket struct {
	Second int     `json:"second"`
	Msgs   int64   `json:"msgs"`
	Bytes  int64   `json:"bytes"`
	Sizes  [8]int64 `json:"sizes"` // 32-byte buckets, last one is >=224
}

// Confirmation records the first moment an observer declared a target dead or
// left, plus whether the target really was down at that instant.
type Confirmation struct {
	At        int64  `json:"at"`
	Observer  int    `json:"observer"`
	Target    int    `json:"target"`
	Kind      string `json:"kind"`  // dead | left
	Cause     string `json:"cause"` // timeout | gossip | ...
	TrueDown  bool   `json:"true_down"`
	Isolated  bool   `json:"isolated"` // network partition, not a detector error
	// PartitionTainted marks a confirmation whose underlying suspicion was raised
	// while the observer was cut off from the target. It is grouped with
	// Isolated when counting detector false positives.
	PartitionTainted bool `json:"partition_tainted"`
	TargetInc uint64 `json:"target_inc"`
}

// NewSim builds a simulator for a scenario.
func NewSim(sc Scenario) *Sim {
	s := &Sim{
		cfg:      sc.Config,
		scenario: sc,
		seed:     sc.Seed,
		rec:      NewRecorder(sc),
		kindSent:     map[MessageKind]int64{},
		lastAlive:    map[[2]int]int64{},
	}
	heap.Init(&s.heap)
	seconds := int(sc.Duration/time.Second) + 1
	s.bucket = make([]TrafficBucket, seconds)
	for i := range s.bucket {
		s.bucket[i].Second = i
	}
	s.started = int64(sc.Warmup)
	s.done = int64(sc.Duration)

	for i := 0; i < sc.Members; i++ {
		n := newMember(s, i, NewPRNG(Mix(sc.Seed, uint64(i))))
		s.nodes = append(s.nodes, n)
		s.perNode = append(s.perNode, NodeTraffic{})
	}
	// The cluster starts fully converged, as if every controller booted with
	// the same inventory.
	for _, n := range s.nodes {
		for _, other := range s.nodes {
			if other.id == n.id {
				continue
			}
			n.members[other.id] = &Entry{Status: StatusAlive, Inc: 0}
		}
		n.rebuildOrder()
	}
	return s
}

// Now returns the current simulated time in nanoseconds.
func (s *Sim) Now() int64 { return s.now }

// after schedules fn at absolute time t.
func (s *Sim) after(t int64, fn func()) {
	if t < s.now {
		t = s.now
	}
	s.seq++
	heap.Push(&s.heap, &simEvent{at: t, seq: s.seq, fn: fn})
}

// afterDur schedules fn after d.
func (s *Sim) afterDur(d int64, fn func()) { s.after(s.now+d, fn) }

// spreadTracker records when each live member first learned about one
// membership change, without requiring the full detail trace.
type spreadTracker struct {
	at     int64
	target int
	kind   string // join | leave
	learned []int64
	seen    []bool
}

// noteStatus lets the lightweight spread trackers observe a status transition.
func (s *Sim) noteStatus(target int, to Status, observer int) {
	for i, t := range s.changes {
		if t == nil || t.target != target || observer < 0 || observer >= len(t.seen) || t.seen[observer] {
			continue
		}
		switch t.kind {
		case "join":
			if to == StatusAlive && s.now >= t.at {
				s.noteSpread(i, observer)
			}
		case "leave":
			if to == StatusLeft {
				s.noteSpread(i, observer)
			}
		}
	}
}

// noteSpread records that `observer` now reflects change `idx`.
func (s *Sim) noteSpread(idx, observer int) {
	t := s.changes[idx]
	if t == nil || observer < 0 || observer >= len(t.seen) || t.seen[observer] {
		return
	}
	t.seen[observer] = true
	t.learned[observer] = s.now
}

// noteTransition feeds the detail page's per-member history and tracks when
// each observer last considered each target alive.
func (s *Sim) noteTransition(e MemberEvent) {
	if e.To == StatusAlive {
		s.lastAlive[[2]int{e.Observer, e.Target}] = e.At
	}
	s.rec.OnMember(s, e)
}

// partitionInduced reports whether a partition separated observer from target
// at some point since the observer last saw the target as alive. Such a
// confirmation is a true statement about the observer's reachability, not a
// detector error.
func (s *Sim) partitionInduced(observer, target int, at int64) bool {
	since := s.lastAlive[[2]int{observer, target}]
	for _, w := range s.partitions {
		if w.end < since || w.start > at {
			continue
		}
		if (observer%2 == w.group) != (target%2 == w.group) {
			return true
		}
	}
	return false
}

// Run executes the scenario to completion and returns its result.
func (s *Sim) Run() *Result {
	s.registerChanges()
	s.installInjections()
	for _, n := range s.nodes {
		delay := int64(s.cfg.ProbeInterval) * int64(n.rng.Intn(1000)) / 1000
		n.schedulePeriod(delay)
	}
	for s.heap.Len() > 0 {
		e := heap.Pop(&s.heap).(*simEvent)
		if e.at > s.done {
			break
		}
		s.now = e.at
		e.fn()
	}
	s.now = s.done
	return s.finish()
}

func (s *Sim) registerChanges() {
	// IDs are assigned in injection order, starting from the initial member
	// count; the trackers' observer arrays must span the final group size.
	nextID := s.scenario.Members
	total := s.scenario.Members
	for _, inj := range s.scenario.Injections {
		switch inj.Kind {
		case InjectSpawn:
			total += inj.Count
		case InjectJoin:
			total++
		}
	}
	nextID = s.scenario.Members
	for _, inj := range s.scenario.Injections {
		switch inj.Kind {
		case InjectSpawn:
			for i := 0; i < inj.Count; i++ {
				id := nextID
				nextID++
				s.changes = append(s.changes, &spreadTracker{
					at: int64(inj.At), target: id, kind: "join",
					seen: make([]bool, total), learned: make([]int64, total),
				})
			}
		case InjectJoin:
			id := nextID
			nextID++
			s.changes = append(s.changes, &spreadTracker{
				at: int64(inj.At), target: id, kind: "join",
				seen: make([]bool, total), learned: make([]int64, total),
			})
		case InjectLeave:
			for _, id := range inj.Members {
				s.changes = append(s.changes, &spreadTracker{
					at: int64(inj.At), target: id, kind: "leave",
					seen: make([]bool, total), learned: make([]int64, total),
				})
			}
		}
	}
}

func (s *Sim) installInjections() {
	for _, inj := range s.scenario.Injections {
		inj := inj
		switch inj.Kind {
		case InjectPause:
			for _, id := range inj.Members {
				id := id
				s.after(int64(inj.At), func() { s.nodes[id].beginPause(int64(inj.At + inj.Duration)) })
				s.after(int64(inj.At+inj.Duration), func() { s.nodes[id].endPause() })
			}
		case InjectCrash:
			for _, id := range inj.Members {
				id := id
				s.after(int64(inj.At), func() { s.nodes[id].crash() })
				s.after(int64(inj.At+inj.Duration), func() { s.nodes[id].rejoin() })
			}
		case InjectPartition:
			// Partitions are pure network policy; partitioned() reads the window.
			s.partitions = append(s.partitions, partitionWindow{
				start: int64(inj.At), end: int64(inj.At + inj.Duration), group: inj.Group,
			})
		case InjectJoin:
			s.after(int64(inj.At), func() { s.addMember() })
		case InjectSpawn:
			for i := 0; i < inj.Count; i++ {
				s.after(int64(inj.At), func() { s.addMember() })
			}
		case InjectLeave:
			for _, id := range inj.Members {
				id := id
				s.after(int64(inj.At), func() { s.nodes[id].leave() })
			}
		}
	}
}

type partitionWindow struct {
	start, end int64
	group      int
}

// wasPartitioned reports whether the two members could not exchange packets at
// time t (used to classify confirmations that are true from the observer's
// vantage point).
func (s *Sim) wasPartitioned(a, b int, t int64) bool {
	for _, w := range s.partitions {
		if t < w.start || t >= w.end {
			continue
		}
		if (a%2 == w.group) != (b%2 == w.group) {
			return true
		}
	}
	return false
}

// partitioned reports whether the two members cannot exchange packets now.
// The group is split by member-id parity: IDs matching group are in the "odd"
// side, everyone else in the "even" side.
func (s *Sim) partitioned(a, b int) bool {
	for _, w := range s.partitions {
		if s.now < w.start || s.now >= w.end {
			continue
		}
		if (a%2 == w.group) != (b%2 == w.group) {
			return true
		}
	}
	return false
}

// addMember integrates one new controller.
func (s *Sim) addMember() {
	id := len(s.nodes)
	n := newMember(s, id, NewPRNG(Mix(s.seed, uint64(id), 0x1031)))
	s.nodes = append(s.nodes, n)
	s.perNode = append(s.perNode, NodeTraffic{})
	// The newcomer bootstraps from one live coordinator and learns the group
	// through the join handshake (MsgJoin -> chunked MsgJoinAck).
	n.joined = false
	n.rebuildOrder()
	n.schedulePeriod(0)
	s.rec.OnJoin(s, id)
}

// ---------------------------------------------------------------------------
// Network

// send puts a protocol message on the wire. A paused sender holds the packet
// until it is scheduling again, mirroring a process that is not running.
func (s *Sim) send(from, to int, m Message) {
	if from == to || from < 0 || to < 0 || from >= len(s.nodes) || to >= len(s.nodes) {
		return
	}
	src := s.nodes[from]
	if !src.alive() {
		return
	}
	if src.pauseUntil > s.now {
		resume := src.pauseUntil
		s.after(resume, func() { s.send(from, to, m) })
		return
	}
	s.sendNow(from, to, m)
}

func (s *Sim) sendNow(from, to int, m Message) {
	src, dst := s.nodes[from], s.nodes[to]
	if !src.alive() || !dst.alive() {
		return
	}
	if s.partitioned(from, to) {
		s.rec.OnDrop(s, from, to, m, "partition")
		return
	}
	s.sendSeq++
	pid := s.sendSeq
	if s.cfg.Loss > 0 && Hash01(s.seed, pid, uint64(from)<<32|uint64(to)) < s.cfg.Loss {
		s.rec.OnDrop(s, from, to, m, "loss")
		return
	}
	latency := int64(s.cfg.BaseLatency) + int64(Hash01(s.seed, pid^0xA5A5A5A5, uint64(from)) * float64(s.cfg.Jitter))
	s.after(s.now+latency, func() { s.deliver(to, m) })

	size := int64(m.Size(s.cfg))
	s.msgsSent++
	s.kindSent[m.Kind]++
	s.bytesSent += size
	s.perNode[from].Sent++
	s.perNode[from].Bytes += size
	sec := int(s.now / 1e9)
	if sec >= 0 && sec < len(s.bucket) {
		b := &s.bucket[sec]
		b.Msgs++
		b.Bytes += size
		idx := size / 32
		if idx >= int64(len(b.Sizes)) {
			idx = int64(len(b.Sizes)) - 1
		}
		b.Sizes[idx]++
	}
	s.rec.OnMessage(s, from, to, m, int(size))
}

func (s *Sim) deliver(to int, m Message) {
	if to < 0 || to >= len(s.nodes) {
		return
	}
	dst := s.nodes[to]
	if !dst.alive() {
		return
	}
	if s.partitioned(m.From, to) {
		s.rec.OnDrop(s, m.From, to, m, "partition")
		return
	}
	if dst.pauseUntil > s.now {
		resume := dst.pauseUntil
		s.after(resume, func() { s.deliver(to, m) })
		return
	}
	dst.receive(m)
}

// kRandom returns up to k distinct live member IDs drawn uniformly, excluding
// any ID in exclude. Used to pick the indirect probe group.
func (s *Sim) kRandom(rng *PRNG, k int, exclude map[int]bool) []int {
	if k <= 0 {
		return nil
	}
	pool := make([]int, 0, len(s.nodes))
	for _, n := range s.nodes {
		if !n.alive() || exclude[n.id] {
			continue
		}
		pool = append(pool, n.id)
	}
	if len(pool) <= k {
		return pool
	}
	for i := 0; i < k; i++ {
		j := i + rng.Intn(len(pool)-i)
		pool[i], pool[j] = pool[j], pool[i]
	}
	return pool[:k]
}

// seconds converts nanoseconds to seconds.
func seconds(ns int64) float64 { return float64(ns) / 1e9 }

// toNanos converts seconds to nanoseconds deterministically.
func toNanos(sec float64) int64 {
	if sec < 0 || math.IsNaN(sec) {
		return 0
	}
	if sec > 1e12 {
		return int64(1e18)
	}
	return int64(math.Round(sec * 1e9))
}
