package swim

import "sort"

// Entry is one member's knowledge about another member.
type Entry struct {
	Status       Status
	Inc          uint64
	Since        int64
	SuspectSince int64
}

type probeState struct {
	seq     uint64
	target  int
	started int64
	acked   bool
	relays  []int
	nacks   int
}

type relayTask struct {
	origin int
	target int
	seq    uint64
	nacked bool
}

// Suspicion is the local timer attached to a Suspect entry.
type Suspicion struct {
	target      int
	inc         uint64
	raisedAt    int64
	deadline    int64
	independent map[int]bool
	timer       uint64
	// partitioned is set when this suspicion was raised while a network
	// partition separated us from the target: the detector's evidence was
	// corrupted by the partition, so a later confirmation is a partition
	// artifact rather than a detector error.
	partitioned bool
}

type gossipItem struct {
	upd   Update
	order uint64
	// sentTo records which peers already received this record from us, so the
	// selector can prefer each peer's unseen records and spread the buffer.
	sentTo map[int]struct{}
	// sent counts selections, for the "fewest transmissions first" tie-break.
	sent int
}

// Node is one SWIM process.
type Node struct {
	sim *Sim
	id  int
	rng *PRNG

	// inc is incremented only by this node: to refute a suspicion about
	// itself, and when a crashed process restarts.
	inc uint64

	members map[int]*Entry
	order   []int
	cursor  int

	pseq uint64
	gseq uint64

	pending map[uint64]*probeState
	relays  map[uint64]*relayTask

	suspicions map[int]*Suspicion

	gossip      []*gossipItem
	gossipDedup map[uint64]*gossipItem
	seen        map[uint64]struct{}
	gossipOrder uint64
	gossipCursor int
	suspForward map[int]int

	lhm int

	// Failure model.
	pauseUntil int64
	pauseMax   int64
	crashed    bool
	left       bool
	restarts   int

	// Join state.
	joined   bool
	contacts []int

	// Revival: dead members are re-probed occasionally so a transient
	// partition can heal. deadOrder holds the members this node believes dead.
	deadOrder  []int
	deadCursor int
	ticks      int

	// createdAt is when this process joined the simulation (0 for the initial
	// group), used to attribute dissemination latency.
	createdAt int64
}

func newMember(s *Sim, id int, rng *PRNG) *Node {
	return &Node{
		sim:         s,
		id:          id,
		rng:         rng,
		members:     map[int]*Entry{},
		pending:     map[uint64]*probeState{},
		relays:      map[uint64]*relayTask{},
		suspicions:  map[int]*Suspicion{},
		gossipDedup: map[uint64]*gossipItem{},
		seen:        map[uint64]struct{}{},
		suspForward: map[int]int{},
		joined:      true,
		createdAt:   s.now,
	}
}

// ---------------------------------------------------------------------------
// Membership list helpers

func (n *Node) rebuildOrder() {
	n.order = n.order[:0]
	for id, e := range n.members {
		if id == n.id {
			continue
		}
		if e.Status == StatusAlive || e.Status == StatusSuspect {
			n.order = append(n.order, id)
		}
	}
	sort.Ints(n.order)
	n.rng.Shuffle(len(n.order), func(i, j int) { n.order[i], n.order[j] = n.order[j], n.order[i] })
	n.cursor = 0
}

func (n *Node) insertOrder(id int) {
	for _, x := range n.order {
		if x == id {
			return
		}
	}
	pos := n.rng.Intn(len(n.order) + 1)
	n.order = append(n.order, 0)
	copy(n.order[pos+1:], n.order[pos:])
	n.order[pos] = id
	if pos < n.cursor {
		n.cursor++
	}
}

func (n *Node) removeOrder(id int) {
	for i, x := range n.order {
		if x != id {
			continue
		}
		n.order = append(n.order[:i], n.order[i+1:]...)
		if i < n.cursor {
			n.cursor--
		}
		if n.cursor > len(n.order) {
			n.cursor = 0
		}
		return
	}
}

func (n *Node) reshuffleOrder() {
	n.rng.Shuffle(len(n.order), func(i, j int) { n.order[i], n.order[j] = n.order[j], n.order[i] })
	n.cursor = 0
}

// nextTarget implements SWIM's round-robin probe target selection: the list is
// traversed exactly once and then re-randomised, and a newcomer is inserted at
// a uniformly random position. Any member is therefore probed by this node
// within at most 2n-1 protocol periods.
func (n *Node) nextTarget() int {
	for tries := 0; tries <= len(n.order); tries++ {
		if len(n.order) == 0 {
			return -1
		}
		if n.cursor >= len(n.order) {
			n.reshuffleOrder()
		}
		id := n.order[n.cursor]
		n.cursor++
		e := n.members[id]
		if e == nil || e.Status == StatusDead || e.Status == StatusLeft {
			n.removeOrder(id)
			if n.cursor > 0 {
				n.cursor--
			}
			continue
		}
		return id
	}
	return -1
}

func (n *Node) membershipSize() int {
	c := 1
	for _, e := range n.members {
		if e.Status != StatusLeft {
			c++
		}
	}
	return c
}

func (n *Node) interval() int64 {
	base := int64(n.sim.cfg.ProbeInterval)
	if n.sim.cfg.Lifeguard {
		return base * int64(n.lhm+1)
	}
	return base
}

func (n *Node) probeTimeout() int64 {
	base := int64(n.sim.cfg.ProbeTimeout)
	if n.sim.cfg.Lifeguard {
		return base * int64(n.lhm+1)
	}
	return base
}

func (n *Node) alive() bool { return !n.crashed && !n.left }

func (n *Node) addDead(id int) {
	for _, x := range n.deadOrder {
		if x == id {
			return
		}
	}
	n.deadOrder = append(n.deadOrder, id)
}

func (n *Node) dropDead(id int) {
	for i, x := range n.deadOrder {
		if x != id {
			continue
		}
		n.deadOrder = append(n.deadOrder[:i], n.deadOrder[i+1:]...)
		if i < n.deadCursor {
			n.deadCursor--
		}
		if n.deadCursor > len(n.deadOrder) {
			n.deadCursor = 0
		}
		return
	}
}

// deferIfPaused re-schedules fn for when this process resumes scheduling. A
// stalled process does not run its own timers either, so nothing can fire
// while paused.
func (n *Node) deferIfPaused(fn func()) bool {
	if n.pauseUntil <= n.sim.now {
		return false
	}
	resume := n.pauseUntil
	n.sim.after(resume, fn)
	return true
}

// reviveEvery is how many protocol periods pass between revival sweeps.
const reviveEvery = 1

// revivePerTick bounds how many dead members one sweep re-probes, so a partition
// heal converges in O(dead/revivePerTick) periods without a message storm.
const revivePerTick = 6

// reviveProbe sends liveness queries to members this node believes dead. If one
// answers, the node tells it "I have you recorded dead" so it can refute with a
// higher incarnation; that is what repairs a healed partition, since an Alive
// record at the same incarnation may not override a confirmation.
func (n *Node) reviveProbe() {
	if len(n.deadOrder) == 0 {
		return
	}
	for k := 0; k < revivePerTick && len(n.deadOrder) > 0; k++ {
		if n.deadCursor >= len(n.deadOrder) {
			n.deadCursor = 0
		}
		id := n.deadOrder[n.deadCursor]
		n.deadCursor++
		if id == n.id {
			continue
		}
		e := n.members[id]
		if e == nil {
			continue
		}
		n.sendRaw(Message{Kind: MsgRevive, To: id, NoteInc: e.Inc})
	}
}

func (n *Node) handleRevive(m Message) {
	// A peer has us in its dead list. If it believes us dead at an incarnation at
	// or above our own, bump ours and announce it: a confirmation at incarnation
	// i may only be overridden at i+1 or above, which is how a healed partition
	// reconverges. If our incarnation already exceeds what the peer knows, do not
	// originate a fresh record on every revive sweep - that would pump out an
	// unbounded stream of Alive rumours after a heal.
	upd := Update{Kind: UpdateAlive, About: n.id, Inc: n.inc}
	if m.NoteInc >= n.inc {
		n.inc = m.NoteInc + 1
		upd.Inc = n.inc
		n.gossipOriginate(upd)
		n.sim.rec.OnRefute(n.sim, RefuteEvent{
			Member: n.id, Inc: n.inc, AboutKind: "revive", At: n.sim.now,
		})
		n.sim.rec.RecordRefute()
	}
	// Always hand the peer our current Alive record so it can correct its view.
	n.sendRaw(Message{Kind: MsgReviveAck, To: m.From, Piggy: []Update{upd}})
}

func (n *Node) handleReviveAck(m Message) {
	for _, u := range m.Piggy {
		n.applyUpdate(u)
	}
	e := n.members[m.From]
	if e == nil || e.Status != StatusDead {
		return
	}
	// Still believe it dead: prompt it to refute with a higher incarnation.
	n.sendRaw(Message{Kind: MsgDeadNotice, To: m.From, NoteInc: e.Inc})
}

func (n *Node) handleDeadNotice(m Message) {
	// A peer still considers us dead at NoteInc. Refute with inc+1 and re-send
	// the Alive record straight back so that peer can see it immediately.
	if m.NoteInc < n.inc {
		return
	}
	n.inc = m.NoteInc + 1
	upd := Update{Kind: UpdateAlive, About: n.id, Inc: n.inc}
	n.gossipOriginate(upd)
	n.sendRaw(Message{Kind: MsgReviveAck, To: m.From, Piggy: []Update{upd}})
	n.sim.rec.OnRefute(n.sim, RefuteEvent{
		Member: n.id, Inc: n.inc, AboutKind: "dead-notice", At: n.sim.now,
	})
	n.sim.rec.RecordRefute()
}

func (n *Node) bumpLHM(d int) {
	if !n.sim.cfg.Lifeguard {
		return
	}
	n.lhm += d
	if n.lhm < 0 {
		n.lhm = 0
	}
	if n.lhm > n.sim.cfg.LHMMax {
		n.lhm = n.sim.cfg.LHMMax
	}
}

// setStatus records a status transition for the page and applies it.
func (n *Node) setStatus(target int, to Status, inc uint64, cause string) {
	e := n.members[target]
	if e == nil {
		n.members[target] = &Entry{Status: to, Inc: inc, Since: n.sim.now}
		if to == StatusAlive {
			n.insertOrder(target)
		}
		n.sim.noteStatus(target, to, n.id)
		return
	}
	from := e.Status
	e.Status = to
	e.Inc = inc
	switch to {
	case StatusAlive:
		n.insertOrder(target)
		n.dropDead(target)
	case StatusDead:
		n.removeOrder(target)
		n.addDead(target)
	case StatusLeft:
		n.removeOrder(target)
		n.dropDead(target)
	}
	n.sim.noteTransition(MemberEvent{
		At: n.sim.now, Observer: n.id, Target: target, From: from, To: to, Inc: inc, Cause: cause,
	})
	n.sim.noteStatus(target, to, n.id)
}

// ---------------------------------------------------------------------------
// Protocol period

func (n *Node) schedulePeriod(delay int64) {
	if !n.alive() {
		return
	}
	n.sim.afterDur(delay, n.tick)
}

func (n *Node) tick() {
	if !n.alive() {
		return
	}
	if n.pauseUntil > n.sim.now {
		n.schedulePeriod(n.pauseUntil - n.sim.now)
		return
	}
	if !n.joined {
		n.attemptJoin()
		n.schedulePeriod(n.interval())
		return
	}
	n.startProbe()
	n.ticks++
	if n.ticks%reviveEvery == 0 {
		n.reviveProbe()
	}
	n.schedulePeriod(n.interval())
}

func (n *Node) startProbe() {
	target := n.nextTarget()
	if target < 0 {
		return
	}
	n.pseq++
	p := &probeState{seq: n.pseq, target: target, started: n.sim.now}
	n.pending[p.seq] = p
	n.sendProbe(MsgPing, target, p.seq, n.id, target, 0)
	timeout := n.probeTimeout()
	n.sim.afterDur(timeout, func() { n.indirectPhase(p.seq) })
}

func (n *Node) indirectPhase(seq uint64) {
	if n.deferIfPaused(func() { n.indirectPhase(seq) }) {
		return
	}
	p := n.pending[seq]
	if p == nil || p.acked {
		return
	}
	exclude := map[int]bool{n.id: true, p.target: true}
	p.relays = n.sim.kRandom(n.rng, n.sim.cfg.IndirectK, exclude)
	for _, r := range p.relays {
		n.sendProbe(MsgPingReq, r, p.seq, n.id, p.target, 0)
	}
	timeout := n.probeTimeout()
	n.sim.afterDur(timeout, func() { n.probeFinal(seq) })
}

func (n *Node) probeFinal(seq uint64) {
	if n.deferIfPaused(func() { n.probeFinal(seq) }) {
		return
	}
	p := n.pending[seq]
	if p == nil {
		return
	}
	delete(n.pending, seq)
	if p.acked {
		return
	}
	if n.sim.cfg.Lifeguard {
		n.bumpLHM(1) // failed probe
		if len(p.relays) > 0 && p.nacks == 0 {
			n.bumpLHM(1) // probe with a missed nack
		}
	}
	e := n.members[p.target]
	if e != nil && (e.Status == StatusAlive || e.Status == StatusSuspect) {
		n.raiseSuspect(p.target, e.Inc, "probe", true)
	}
	n.sim.rec.OnProbe(n.sim, ProbeRecord{
		Initiator: n.id, Target: p.target, Start: p.started, End: n.sim.now,
		Outcome: "timeout", Relays: p.relays, Nacks: p.nacks,
	})
}

// ---------------------------------------------------------------------------
// Suspicion

func (n *Node) raiseSuspect(target int, inc uint64, cause string, originate bool) {
	if target == n.id {
		return
	}
	e := n.members[target]
	if e == nil || e.Status == StatusDead || e.Status == StatusLeft {
		return
	}
	if inc < e.Inc {
		return
	}
	if e.Status == StatusSuspect && e.Inc == inc {
		return
	}
	n.setStatus(target, StatusSuspect, inc, cause)
	e.SuspectSince = n.sim.now
	s := &Suspicion{
		target: target, inc: inc, raisedAt: n.sim.now, independent: map[int]bool{},
		partitioned: n.sim.partitioned(n.id, target),
	}
	n.suspicions[target] = s
	n.armSuspicion(s)
	if originate {
		upd := Update{Kind: UpdateSuspect, About: target, Inc: inc}
		n.gossipOriginate(upd)
		// Lifeguard's Buddy System: make sure the suspected member hears of the
		// suspicion promptly. Waiting for round-robin to happen to probe it takes
		// O(n) periods at group scale, during which it could be confirmed
		// without ever getting the chance to refute.
		n.sendRaw(Message{Kind: MsgSuspectNotice, To: target, Piggy: []Update{upd}})
	}
	n.sim.rec.OnSuspicion(n.sim, SuspicionEvent{
		Observer: n.id, Target: target, Inc: inc, Kind: "raised", Cause: cause,
		Independent: 0, Timeout: seconds(s.deadline - s.raisedAt),
	})
}

func (n *Node) armSuspicion(s *Suspicion) {
	size := n.membershipSize()
	period := seconds(int64(n.sim.cfg.ProbeInterval))
	to := n.sim.cfg.SuspicionTimeout(size, period, len(s.independent))
	s.deadline = s.raisedAt + toNanos(to)
	s.timer++
	tok := s.timer
	delay := s.deadline - n.sim.now
	if delay < 0 {
		delay = 0
	}
	n.sim.afterDur(delay, func() { n.suspicionExpired(s.target, s.inc, tok) })
}

func (n *Node) suspicionExpired(target int, inc uint64, tok uint64) {
	if n.deferIfPaused(func() { n.suspicionExpired(target, inc, tok) }) {
		return
	}
	s := n.suspicions[target]
	if s == nil || s.inc != inc || s.timer != tok {
		return
	}
	e := n.members[target]
	if e == nil || e.Status != StatusSuspect || e.Inc != inc {
		return
	}
	n.confirm(target, inc, "timeout", false)
}

// noteIndependentSuspect applies Lifeguard's LHA-Suspicion: each *distinct*
// member that independently suspects the same target at the same incarnation
// shortens the local timeout along the logarithmic curve.
func (n *Node) noteIndependentSuspect(target int, inc uint64, source int) {
	s := n.suspicions[target]
	if s == nil || s.inc != inc {
		return
	}
	if source < 0 || source == n.id || s.independent[source] {
		return
	}
	s.independent[source] = true
	if len(s.independent) <= n.sim.cfg.ConfirmK {
		n.armSuspicion(s)
		n.sim.rec.OnSuspicion(n.sim, SuspicionEvent{
			Observer: n.id, Target: target, Inc: inc, Kind: "shortened", Cause: "independent",
			Independent: len(s.independent), Timeout: seconds(s.deadline - s.raisedAt),
		})
	}
}

func (n *Node) confirm(target int, inc uint64, cause string, voluntary bool) {
	n.confirmFrom(target, inc, cause, voluntary, true)
}

// confirmFrom applies a confirmation. originate says whether this node should
// start a fresh Confirm rumour: only the member that detects the failure does.
// Members that merely learn a confirmation apply it and forward the *same*
// record, which is what infection-style dissemination prescribes; originating a
// new rumour at every hop would make confirmations fan out O(n) times.
func (n *Node) confirmFrom(target int, inc uint64, cause string, voluntary, originate bool) {
	if target == n.id {
		return
	}
	e := n.members[target]
	if e == nil || e.Status == StatusLeft {
		return
	}
	if inc < e.Inc {
		return
	}
	to := StatusDead
	kind := "dead"
	if voluntary {
		to = StatusLeft
		kind = "left"
	}
	prev := e.Status
	tainted := false
	if sp := n.suspicions[target]; sp != nil {
		tainted = sp.partitioned
	}
	delete(n.suspicions, target)
	n.setStatus(target, to, inc, cause)
	if prev == to {
		return
	}
	if originate {
		if voluntary {
			n.gossipOriginate(Update{Kind: UpdateLeave, About: target, Inc: inc})
		} else {
			n.gossipOriginate(Update{Kind: UpdateConfirm, About: target, Inc: inc})
		}
	}
	n.sim.rec.OnConfirm(n.sim, Confirmation{
		At: n.sim.now, Observer: n.id, Target: target, Kind: kind,
		Cause: cause, TargetInc: inc, PartitionTainted: tainted,
	})
}

func (n *Node) clearSuspicion(target int, inc uint64, cause string) {
	s := n.suspicions[target]
	if s == nil || inc < s.inc {
		return
	}
	delete(n.suspicions, target)
	n.sim.rec.OnSuspicion(n.sim, SuspicionEvent{
		Observer: n.id, Target: target, Inc: s.inc, Kind: "cleared",
		Cause: cause, Independent: len(s.independent),
	})
}

// ---------------------------------------------------------------------------
// Sending

func (n *Node) sendProbe(kind MessageKind, to int, seq uint64, origin, target, relay int) {
	if !n.alive() {
		return
	}
	m := Message{
		Kind: kind, From: n.id, To: to, Seq: seq,
		Origin: origin, Target: target, Relay: relay, Inc: n.inc, MemberN: n.membershipSize(),
	}
	if kind != MsgNack {
		m.Piggy = n.pickGossip(to)
		m.Backlog = len(n.gossip)
	}
	n.sim.send(n.id, to, m)
}

func (n *Node) sendRaw(m Message) {
	m.From = n.id
	m.Inc = n.inc
	m.MemberN = n.membershipSize()
	n.sim.send(n.id, m.To, m)
}

// ---------------------------------------------------------------------------
// Receiving

func (n *Node) receive(m Message) {
	if !n.alive() || n.pauseUntil > n.sim.now {
		return
	}
	if m.From < 0 || m.From >= len(n.sim.nodes) || m.From == n.id {
		return
	}
	// Any datagram from a member is evidence it is running at incarnation m.Inc.
	n.observeSender(m.From, m.Inc)
	for _, u := range m.Piggy {
		n.applyUpdate(u)
	}
	switch m.Kind {
	case MsgPing:
		n.handlePing(m)
	case MsgPingReq:
		n.handlePingReq(m)
	case MsgAck:
		n.handleAck(m)
	case MsgNack:
		n.handleNack(m)
	case MsgJoin:
		n.handleJoin(m)
	case MsgJoinAck:
		n.handleJoinAck(m)
	case MsgRevive:
		n.handleRevive(m)
	case MsgReviveAck:
		n.handleReviveAck(m)
	case MsgDeadNotice:
		n.handleDeadNotice(m)
	case MsgSuspectNotice:
		// Piggybacked updates were already applied above; the self-update path
		// makes the member refute with a higher incarnation.
	case MsgLeavePush:
		// Piggybacked updates were already applied above.
	}
}

// observeSender treats a datagram from a member as proof of life. A member that
// was merely slow (or briefly partitioned) therefore returns to the group
// without having to restart.
func (n *Node) observeSender(from int, inc uint64) {
	e := n.members[from]
	if e == nil {
		n.setStatus(from, StatusAlive, inc, "message")
		return
	}
	if e.Status == StatusLeft || inc < e.Inc {
		return
	}
	if e.Status == StatusAlive {
		if inc > e.Inc {
			e.Inc = inc
		}
		return
	}
	if e.Status == StatusDead && inc == e.Inc {
		// SWIM's precedence rules: a confirmation may only be overridden by a
		// strictly larger incarnation. Tell the sender we think it is dead so it
		// can refute with inc+1; accepting the same incarnation here would let a
		// healed partition flap between dead and alive.
		n.sendRaw(Message{Kind: MsgDeadNotice, To: from, NoteInc: e.Inc,
			Piggy: []Update{{Kind: UpdateAlive, About: n.id, Inc: n.inc, Source: n.id, Seq: n.gseq + 1}}})
		return
	}
	// A suspected member (same incarnation) or a confirmed-dead member at a
	// larger incarnation is alive again as far as we can tell.
	n.clearSuspicion(from, inc, "message")
	n.setStatus(from, StatusAlive, inc, "message")
	n.gossipOriginate(Update{Kind: UpdateAlive, About: from, Inc: inc})
}

func (n *Node) handlePing(m Message) {
	// A relayed ping carries m.Relay set to the forwarding member (which is also
	// m.From, since the relay addressed the ping to us). Its ack must go back to
	// that relay; the relay then forwards it to m.Origin.
	if m.Relay != 0 {
		n.sendProbe(MsgAck, m.Relay, m.Seq, m.Origin, n.id, m.Relay)
		return
	}
	n.sendProbe(MsgAck, m.From, m.Seq, m.Origin, n.id, 0)
}

func (n *Node) handlePingReq(m Message) {
	if m.Target == n.id {
		n.sendProbe(MsgAck, m.Origin, m.Seq, m.Origin, n.id, 0)
		return
	}
	key := Mix(m.Seq, uint64(m.Origin), uint64(m.Target))
	rt := &relayTask{origin: m.Origin, target: m.Target, seq: m.Seq}
	n.relays[key] = rt
	// Relay the ping. The target replies to us (the relay), carrying the origin
	// and our own ID in m.Relay so the ack finds its way home.
	n.sendProbe(MsgPing, m.Target, m.Seq, m.Origin, m.Target, n.id)
	n.sim.afterDur(n.probeTimeout()*8/10, func() { n.relayNack(key) })
}

func (n *Node) relayNack(key uint64) {
	rt := n.relays[key]
	if rt == nil || rt.nacked {
		return
	}
	rt.nacked = true
	n.sendProbe(MsgNack, rt.origin, rt.seq, rt.origin, rt.target, n.id)
}

func (n *Node) handleNack(m Message) {
	if m.Origin != n.id {
		return
	}
	p := n.pending[m.Seq]
	if p == nil || p.target != m.Target {
		return
	}
	p.nacks++
}

func (n *Node) handleAck(m Message) {
	// The originator always wins: if this ack completes one of our own probes,
	// consume it here.
	p := n.pending[m.Seq]
	if p != nil && p.target == m.Target && m.Origin == n.id {
		n.probeSucceeded(p, m)
		return
	}
	// Otherwise, if we are the relay, forward the ack on to the originator.
	if m.Origin != n.id && m.Relay == n.id {
		key := Mix(m.Seq, uint64(m.Origin), uint64(m.Target))
		if _, ok := n.relays[key]; ok {
			delete(n.relays, key)
			n.sendProbe(MsgAck, m.Origin, m.Seq, m.Origin, m.Target, n.id)
		}
	}
}

func (n *Node) probeSucceeded(p *probeState, m Message) {
	p.acked = true
	delete(n.pending, m.Seq)
	n.onProbeSuccess(p.target, m.Inc)
	outcome := "direct"
	if m.Relay != 0 {
		outcome = "indirect"
	}
	n.sim.rec.OnProbe(n.sim, ProbeRecord{
		Initiator: n.id, Target: p.target, Start: p.started, End: n.sim.now,
		Outcome: outcome, Relays: p.relays, Nacks: p.nacks,
	})
}

// onProbeSuccess un-marks a suspicion at the current incarnation and spreads an
// Alive message, exactly as the SWIM suspicion sub-protocol specifies.
func (n *Node) onProbeSuccess(target int, inc uint64) {
	e := n.members[target]
	if e == nil {
		n.setStatus(target, StatusAlive, inc, "ack")
		return
	}
	n.bumpLHM(-1)
	if e.Status == StatusAlive && inc > e.Inc {
		e.Inc = inc
	}
	if e.Status != StatusAlive || inc > e.Inc {
		useInc := e.Inc
		if inc > useInc {
			useInc = inc
		}
		n.clearSuspicion(target, useInc, "ack")
		n.setStatus(target, StatusAlive, useInc, "ack")
		n.gossipOriginate(Update{Kind: UpdateAlive, About: target, Inc: useInc})
	}
}

// ---------------------------------------------------------------------------
// Dissemination

// evictRank orders gossip records by how willing we are to drop them when the
// retransmit buffer overflows. Suspects are the most redundant; alive and
// confirm records carry the information that resolves suspicions.
func evictRank(u Update) int {
	switch u.Kind {
	case UpdateSuspect:
		// Under buffer pressure, drop the most redundant suspicions first and
		// keep the records that resolve them: an Alive refutation racing a
		// suspicion must survive. Leaving updates outrank everything because a
		// departure is a once-only event.
		return 0
	case UpdateConfirm:
		return 1
	case UpdateAlive:
		return 2
	case UpdateLeave:
		return 3
	}
	return 1
}

func (n *Node) maxTx() int { return n.sim.cfg.MaxTransmissions(n.membershipSize()) }

func (n *Node) gossipOriginate(u Update) {
	u.Source = n.id
	n.gseq++
	u.Seq = n.gseq
	n.seen[Mix(uint64(u.Source), u.Seq)] = struct{}{}
	n.enqueue(u)
}

// dedupKey collapses redundant queued squeals: only the newest incarnation of a
// given (kind, about) pair is worth carrying.
func dedupKey(u Update) uint64 {
	return Mix(uint64(u.Kind), uint64(u.About)+1)
}

func (n *Node) enqueue(u Update) {
	dk := dedupKey(u)
	if it, ok := n.gossipDedup[dk]; ok {
		// Replace in place if this record is newer; otherwise ignore.
		if u.Inc >= it.upd.Inc {
			it.upd = u
			it.order = n.bumpOrder()
		}
		return
	}
	n.gossipOrder++
	it := &gossipItem{upd: u, order: n.gossipOrder}
	// New items are placed at the cursor so they ride the very next datagram,
	// mirroring SWIM's preference for younger buffer elements.
	pos := n.gossipCursor
	if pos > len(n.gossip) {
		pos = len(n.gossip)
	}
	n.gossip = append(n.gossip, nil)
	copy(n.gossip[pos+1:], n.gossip[pos:])
	n.gossip[pos] = it
	n.gossipDedup[dk] = it
	n.pruneGossip()
}

func (n *Node) bumpOrder() uint64 {
	n.gossipOrder++
	return n.gossipOrder
}

func (n *Node) shouldForward(u Update) bool {
	if u.Kind != UpdateSuspect {
		return true
	}
	if !n.sim.cfg.Lifeguard {
		// Without Lifeguard, only the member's own suspicion is re-gossiped.
		return u.Source == n.id
	}
	if !n.sim.cfg.ReGossipSuspect {
		return u.Source == n.id
	}
	// Lifeguard re-gossips only the first ConfirmK independent suspicions about a
	// target, then reverts to forwarding only its own. The per-observer counter
	// bounds each node's contribution; because a mass-suspicion event (partition)
	// makes every node an independent source, we additionally cap the counter at
	// a small constant so the aggregate stays O(n) rather than O(n*K).
	return n.suspForward[u.About] < n.sim.cfg.ConfirmK
}

func (n *Node) gossipLearn(u Update) {
	key := Mix(uint64(u.Source), u.Seq)
	if _, ok := n.seen[key]; ok {
		return
	}
	n.seen[key] = struct{}{}
	if len(n.seen) > 200000 {
		// Bound the dedup set. Keys are only ever consulted for records that are
		// still inside the retransmit window (seconds), so clearing it is safe
		// and prevents unbounded memory growth over a long run.
		n.seen = map[uint64]struct{}{key: {}}
	}
	if !n.shouldForward(u) {
		return
	}
	if u.Kind == UpdateSuspect {
		n.suspForward[u.About]++
	}
	// The retransmission count is per member: a rumour we adopt starts fresh.
	u.Transmit = 0
	n.enqueue(u)
}

// purgeStale removes buffered rumours about `about` at incarnations below
// `inc`, which the Alive record just superseded.
func (n *Node) purgeStale(about int, inc uint64) {
	kept := n.gossip[:0]
	for _, it := range n.gossip {
		if it.upd.About == about && it.upd.Inc < inc {
			delete(n.gossipDedup, dedupKey(it.upd))
			continue
		}
		kept = append(kept, it)
	}
	n.gossip = kept
	if n.gossipCursor > len(n.gossip) {
		n.gossipCursor = 0
	}
}

func (n *Node) pruneGossip() {
	limit := n.maxTx()
	kept := n.gossip[:0]
	for _, it := range n.gossip {
		if it.upd.Transmit >= limit {
			delete(n.gossipDedup, dedupKey(it.upd))
			continue
		}
		kept = append(kept, it)
	}
	n.gossip = kept
	// Keep the retransmit buffer bounded. SWIM prefers younger buffer elements
	// when the buffer overflows, so the oldest entries are dropped first. This
	// cannot starve a fresh rumour: a new one is always younger than the backlog
	// it is competing with.
	const capItems = 96
	if len(n.gossip) > capItems {
		// Eviction order under buffer pressure: drop the most redundant
		// suspicions first, keep the records that resolve them (alive, confirm,
		// leave) longest. A mass-suspicion storm (e.g. one side of a partition
		// suspecting the other) otherwise evicts the refutations that would end
		// it, leaving healthy members stuck as suspects.
		sort.SliceStable(n.gossip, func(i, j int) bool {
			a, b := n.gossip[i].upd, n.gossip[j].upd
			ra, rb := evictRank(a), evictRank(b)
			if ra != rb {
				return ra < rb // lower rank = evicted first
			}
			return n.gossip[i].order < n.gossip[j].order
		})
		drop := len(n.gossip) - capItems
		for _, it := range n.gossip[:drop] {
			delete(n.gossipDedup, dedupKey(it.upd))
		}
		n.gossip = n.gossip[drop:]
	}
	if n.gossipCursor >= len(n.gossip) {
		n.gossipCursor = 0
	}
}

// pickGossip chooses a piggyback payload for a datagram addressed to `to`.
//
// Outbound dissemination is per peer: every peer should hear each rumour at
// least once, but a record should not be re-sent to a peer that has already
// heard it from us. The selector therefore ranks candidates by
// (already sent to this peer, times sent overall, queue age) and packs them in
// that order until the packet budget is full. That is SWIM's "fewest
// transmissions first" rule, realized with the peer dimension made explicit.
// Whatever does not fit stays queued for the next datagram.
//
// Lifeguard's Buddy System lifts a non-alive update about the addressed member
// to the front so a suspected member can refute sooner.
func (n *Node) pickGossip(to int) []Update {
	limit := n.sim.cfg.MaxPiggyback()
	if limit <= 0 || len(n.gossip) == 0 {
		return nil
	}
	n.pruneGossip()
	if len(n.gossip) == 0 {
		return nil
	}
	order := make([]*gossipItem, len(n.gossip))
	copy(order, n.gossip)
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		// Prefer items not yet sent to this peer, then fewest overall sends,
		// then oldest.
		_, aSent := a.sentTo[to]
		_, bSent := b.sentTo[to]
		if aSent != bSent {
			return !aSent
		}
		if a.sent != b.sent {
			return a.sent < b.sent
		}
		return a.order < b.order
	})

	out := make([]Update, 0, limit)
	used := map[*gossipItem]bool{}
	take := func(it *gossipItem) {
		it.sent++
		if it.sentTo == nil {
			it.sentTo = map[int]struct{}{}
		}
		it.sentTo[to] = struct{}{}
		out = append(out, it.upd)
		used[it] = true
	}
	if n.sim.cfg.Lifeguard {
		for _, it := range order {
			if it.upd.About == to && it.upd.Kind != UpdateAlive {
				take(it)
				break
			}
		}
	}
	for _, it := range order {
		if len(out) >= limit {
			break
		}
		if used[it] {
			continue
		}
		dup := false
		for _, u := range out {
			if u.Kind == it.upd.Kind && u.About == it.upd.About && u.Inc == it.upd.Inc {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		take(it)
	}
	n.sim.rec.OnTruncated(n.sim, len(out), len(n.gossip))
	return out
}

// applyUpdate merges one gossiped membership record using SWIM's
// incarnation-number precedence rules.
func (n *Node) applyUpdate(u Update) {
	if u.About == n.id {
		n.handleSelfUpdate(u)
		return
	}
	if u.Kind == UpdateAlive {
		// Hearing any Alive record for a member is enough to have learned that
		// it joined, even if we already had it as alive.
		n.sim.noteStatus(u.About, StatusAlive, n.id)
	}
	e := n.members[u.About]
	if e == nil {
		// Route through setStatus so the transition is recorded and the
		// lightweight dissemination trackers observe it.
		n.setStatus(u.About, StatusAlive, u.Inc, "learn")
		e = n.members[u.About]
	}
	if e.Status == StatusLeft {
		n.gossipLearn(u)
		return
	}
	switch u.Kind {
	case UpdateAlive:
		// SWIM precedence: an Alive record overrides a Suspect at the same or a
		// higher incarnation, but a confirmation may only be overridden by a
		// strictly higher incarnation. Otherwise a stale Alive from before a
		// partition would resurrect a member the other half still believes dead,
		// and a healed partition would flap forever.
		revive := u.Inc > e.Inc || (u.Inc == e.Inc && e.Status == StatusSuspect)
		if revive {
			n.clearSuspicion(u.About, u.Inc, "alive")
			n.setStatus(u.About, StatusAlive, u.Inc, "alive")
			// A refutation supersedes older rumours about the same member.
			// Dropping them from the retransmit buffer stops stale Suspect and
			// Confirm records from out-running the Alive record after a healed
			// partition, which would otherwise re-kill the member elsewhere.
			n.purgeStale(u.About, u.Inc)
		}
	case UpdateSuspect:
		// Suspect overrides Alive at the same or a higher incarnation, and may
		// itself be overridden by Alive at the same incarnation (a successful
		// probe or a refutation clears it).
		switch {
		case u.Inc > e.Inc:
			n.raiseSuspect(u.About, u.Inc, "gossip", false)
			n.noteIndependentSuspect(u.About, u.Inc, u.Source)
		case u.Inc == e.Inc && e.Status == StatusAlive:
			n.raiseSuspect(u.About, u.Inc, "gossip", false)
			n.noteIndependentSuspect(u.About, u.Inc, u.Source)
		case u.Inc == e.Inc && e.Status == StatusSuspect:
			n.noteIndependentSuspect(u.About, u.Inc, u.Source)
		}
	case UpdateConfirm:
		// A confirmation is authoritative only while we hold a suspicion at that
		// incarnation. An entry we already consider Alive at the same
		// incarnation was refuted after the confirmation was created, so the
		// stale record must not re-kill it.
		if u.Inc > e.Inc || (u.Inc == e.Inc && e.Status == StatusSuspect) {
			n.confirmFrom(u.About, u.Inc, "gossip", false, false)
		}
	case UpdateLeave:
		// A voluntary departure is authoritative: the member itself announced
		// it, so it applies at the same incarnation, unlike a failure
		// confirmation which needs a matching suspicion.
		if u.Inc >= e.Inc {
			n.confirmFrom(u.About, u.Inc, "gossip", true, false)
		}
	}
	// Forward the record we just learned, unless we already originated one for
	// this change (confirmFrom's originate path queues that separately).
	n.gossipLearn(u)
}

// handleSelfUpdate is the refutation rule: a suspicion or confirmation about
// this member at an incarnation at least as large as its own makes it increment
// its incarnation and announce itself alive.
func (n *Node) handleSelfUpdate(u Update) {
	switch u.Kind {
	case UpdateSuspect, UpdateConfirm:
		if u.Inc < n.inc {
			return
		}
		n.inc = u.Inc + 1
		n.bumpLHM(1)
		n.sim.rec.OnRefute(n.sim, RefuteEvent{
			Member: n.id, Inc: n.inc, AboutKind: u.Kind.String(), At: n.sim.now,
		})
		n.gossipOriginate(Update{Kind: UpdateAlive, About: n.id, Inc: n.inc})
		n.sim.rec.RecordRefute()
	}
}

// ---------------------------------------------------------------------------
// Join / leave / restart

func (n *Node) bootstrapContacts() []int {
	var out []int
	for i := 0; i < len(n.sim.nodes) && len(out) < 3; i++ {
		if i == n.id || !n.sim.nodes[i].alive() {
			continue
		}
		out = append(out, i)
	}
	return out
}

func (n *Node) attemptJoin() {
	if n.contacts == nil {
		n.contacts = n.bootstrapContacts()
	}
	for _, c := range n.contacts {
		n.sendRaw(Message{Kind: MsgJoin, To: c})
	}
}

func (n *Node) handleJoin(m Message) {
	e := n.members[m.From]
	if e == nil {
		n.setStatus(m.From, StatusAlive, m.Inc, "join")
	} else if m.Inc > e.Inc {
		n.setStatus(m.From, StatusAlive, m.Inc, "join")
	}
	// Originate *and* push directly to the joiner: the newcomer must learn of
	// itself, and its presence must reach the group promptly (requirement 7).
	upd := Update{Kind: UpdateAlive, About: m.From, Inc: m.Inc}
	n.gossipOriginate(upd)
	n.sendRaw(Message{Kind: MsgJoinAck, To: m.From, Piggy: []Update{upd}})

	// Reply with the full membership, chunked so each datagram respects the
	// packet size cap. This is a handshake state sync, not periodic gossip.
	per := n.sim.cfg.MaxPiggyback()
	if per <= 0 {
		per = 1
	}
	ids := make([]int, 0, len(n.members))
	for id := range n.members {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	var sync []Update
	sync = append(sync, Update{Kind: UpdateAlive, About: n.id, Inc: n.inc})
	for _, id := range ids {
		e := n.members[id]
		var kind UpdateKind
		switch e.Status {
		case StatusAlive:
			kind = UpdateAlive
		case StatusSuspect:
			kind = UpdateSuspect
		case StatusDead:
			kind = UpdateConfirm
		case StatusLeft:
			kind = UpdateLeave
		}
		sync = append(sync, Update{Kind: kind, About: id, Inc: e.Inc})
	}
	for i := 0; i < len(sync); i += per {
		end := i + per
		if end > len(sync) {
			end = len(sync)
		}
		chunk := make([]Update, end-i)
		copy(chunk, sync[i:end])
		for j := range chunk {
			n.gseq++
			chunk[j].Seq = n.gseq
			chunk[j].Source = n.id
		}
		n.sendRaw(Message{Kind: MsgJoinAck, To: m.From, Sync: chunk})
	}
}

func (n *Node) handleJoinAck(m Message) {
	for _, u := range m.Sync {
		n.applyUpdate(u)
	}
	if !n.joined {
		n.joined = true
		n.contacts = nil
		// Announce the newcomer to the whole group: a direct push to every
		// member it now knows makes a join visible in one round instead of
		// waiting for it to diffuse through the periodic probe traffic
		// (requirement 7: joins must spread quickly).
		upd := Update{Kind: UpdateAlive, About: n.id, Inc: n.inc}
		n.gossipOriginate(upd)
		n.broadcastAlive(upd)
		n.sim.rec.OnJoinComplete(n.sim, n.id)
	}
	n.sim.rec.RecordJoinComplete(n.id)
}

// broadcastAlive pushes one Alive record directly to every live member. It is
// used for the one-off join announcement, which a pure gossip diffusion would
// stretch to O(n) protocol periods.
func (n *Node) broadcastAlive(upd Update) {
	ids := make([]int, 0, len(n.members))
	for id := range n.members {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		e := n.members[id]
		if id == n.id || e == nil || e.Status == StatusLeft {
			continue
		}
		n.sendRaw(Message{Kind: MsgSuspectNotice, To: id, Piggy: []Update{upd}})
	}
}

func (n *Node) leave() {
	if n.left || n.crashed {
		return
	}
	var targets []int
	for _, id := range n.order {
		if len(targets) >= 8 {
			break
		}
		if e := n.members[id]; e != nil && e.Status == StatusAlive {
			targets = append(targets, id)
		}
	}
	upd := Update{Kind: UpdateLeave, About: n.id, Inc: n.inc, Source: n.id}
	n.gseq++
	upd.Seq = n.gseq
	for _, t := range targets {
		n.sendRaw(Message{Kind: MsgLeavePush, To: t, Piggy: []Update{upd}})
	}
	n.left = true
	n.sim.rec.OnLeave(n.sim, n.id)
}

// beginPause freezes this process until the given deadline. While frozen it
// neither sends nor receives application messages.
func (n *Node) beginPause(until int64) {
	if !n.alive() {
		return
	}
	if until > n.pauseMax {
		n.pauseMax = until
	}
	n.pauseUntil = n.pauseMax
	n.sim.rec.OnPause(n.sim, n.id, until, false)
}

func (n *Node) endPause() {
	if n.pauseUntil == 0 || n.sim.now < n.pauseMax {
		return
	}
	n.pauseUntil = 0
	n.pauseMax = 0
	n.sim.rec.OnPause(n.sim, n.id, 0, true)
}

func (n *Node) crash() {
	if n.left {
		return
	}
	n.crashed = true
	n.pending = map[uint64]*probeState{}
	n.relays = map[uint64]*relayTask{}
	n.sim.rec.OnCrash(n.sim, n.id)
}

func (n *Node) rejoin() {
	n.restarts++
	n.crashed = false
	n.pauseUntil = 0
	n.pauseMax = 0
	n.inc++
	n.joined = false
	n.contacts = nil
	n.pending = map[uint64]*probeState{}
	n.relays = map[uint64]*relayTask{}
	n.suspicions = map[int]*Suspicion{}
	n.schedulePeriod(0)
	n.sim.rec.OnRejoin(n.sim, n.id, n.inc)
}
