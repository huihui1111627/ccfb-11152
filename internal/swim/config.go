package swim

import (
	"math"
	"time"
)

// Status is the knowledge a member has about another member.
type Status uint8

const (
	StatusAlive Status = iota
	StatusSuspect
	StatusDead
	StatusLeft
	StatusUnknown // only used by the viewer, never stored in an entry
)

func (s Status) String() string {
	switch s {
	case StatusAlive:
		return "alive"
	case StatusSuspect:
		return "suspect"
	case StatusDead:
		return "dead"
	case StatusLeft:
		return "left"
	}
	return "unknown"
}

// Config holds every tunable of the protocol and the simulated network.
type Config struct {
	// Failure detector.
	ProbeInterval time.Duration `json:"probe_interval"`
	ProbeTimeout  time.Duration `json:"probe_timeout"`
	IndirectK     int           `json:"indirect_k"`

	// Lifeguard.
	Lifeguard bool    `json:"lifeguard"`
	Alpha     float64 `json:"alpha"` // Min suspicion timeout = Alpha*log10(n)*T
	Beta      float64 `json:"beta"`  // Max = Beta*Min
	ConfirmK  int     `json:"confirm_k"`
	// ReGossipSuspect enables Lifeguard's re-gossip of the first ConfirmK
	// independent suspicions. It speeds up suspicion spread in a healthy group
	// but amplifies traffic enormously during a mass-suspicion event (a
	// partition): every member becomes an independent source, so the suspicion
	// flood outruns the Alive refutations. Left off by default because in the
	// scenarios here it bought no false-positive reduction but cost ~6x the
	// partition false positives. Enable it to reproduce the paper's full
	// LHA-Suspicion behaviour.
	ReGossipSuspect bool `json:"regossip_suspect"`
	LHMMax    int     `json:"lhm_max"`

	// Dissemination.
	MaxPacketBytes int     `json:"max_packet_bytes"`
	HeaderBytes    int     `json:"header_bytes"`
	EntryBytes     int     `json:"entry_bytes"`
	Lambda         float64 `json:"lambda"`

	// Network.
	BaseLatency time.Duration `json:"base_latency"`
	Jitter      time.Duration `json:"jitter"`
	Loss        float64       `json:"loss"`
}

// DefaultConfig is the paper's evaluation profile: Lifeguard with alpha=5 and
// beta=6 (Lifeguard §V-B/§V-C), a 1 s probe period and a sub-second probe
// timeout. That is the configuration whose false-positive and latency numbers
// are compared against SWIM-with-fixed-timeout (the same run with Lifeguard
// disabled). FastConfig is the lower-latency profile for the live page.
func DefaultConfig() Config {
	return Config{
		ProbeInterval:  1 * time.Second,
		ProbeTimeout:   400 * time.Millisecond,
		IndirectK:      4,
		Lifeguard:      true,
		Alpha:          5,
		Beta:           6,
		ConfirmK:       3,
		ReGossipSuspect: false,
		LHMMax:         8,
		MaxPacketBytes: 135, // SWIM prototype's piggybacked packet budget
		HeaderBytes:    24,
		EntryBytes:     16,
		Lambda:         3,
		BaseLatency:    3 * time.Millisecond,
		Jitter:         2 * time.Millisecond,
		Loss:           0,
	}
}

// PaperProfile returns the parameter set used in the Lifeguard evaluation.
func PaperProfile() Config {
	return DefaultConfig()
}

// FastConfig returns a lower-latency profile tuned for the visualisation page:
// confirmation in a few seconds, at the cost of more false positives under
// heavy packet loss.
func FastConfig() Config {
	c := DefaultConfig()
	c.Alpha, c.Beta = 2, 3
	return c
}

func cfgDuration(d time.Duration) int64 { return int64(d) }

// Clone returns a deep copy (Config is all value types).
func (c Config) Clone() Config { return c }

// MaxPiggyback is how many gossip entries fit in one protocol message.
func (c Config) MaxPiggyback() int {
	room := c.MaxPacketBytes - c.HeaderBytes
	if room <= 0 {
		return 0
	}
	return room / c.EntryBytes
}

// MaxTransmissions is lambda*log(n+1): how often one member re-sends an update
// before dropping it from its gossip buffer.
func (c Config) MaxTransmissions(n int) int {
	m := int(math.Ceil(c.Lambda * math.Log(float64(n)+1)))
	if m < 1 {
		m = 1
	}
	return m
}

// MinSuspicionTimeout returns the floor of the suspicion timeout.
// Lifeguard: Min = alpha*log10(n)*T. Plain SWIM: the prototype's fixed
// 5*log10(n+1) protocol periods, which is Lifeguard's alpha=5,beta=1 profile.
func (c Config) MinSuspicionTimeout(n int, t float64) float64 {
	if n < 2 {
		n = 2
	}
	if c.Lifeguard {
		return c.Alpha * math.Log10(float64(n)) * t
	}
	// Lifeguard's own baseline: alpha=5, beta=1 is exactly SWIM with a fixed
	// suspicion timeout (Lifeguard §V-C).
	return 5 * math.Log10(float64(n)) * t
}

// SuspicionTimeout applies Lifeguard's logarithmic decay:
//
//	max(Min, Max-(Max-Min)*log(C+1)/log(K+1))
//
// where C is the number of independent suspicions about the target since the
// local suspicion was raised. C=0 yields Max; C>=K yields Min.
func (c Config) SuspicionTimeout(n int, t float64, independent int) float64 {
	min := c.MinSuspicionTimeout(n, t)
	if !c.Lifeguard {
		return min
	}
	max := c.Beta * min
	if independent >= c.ConfirmK || c.ConfirmK <= 0 {
		return min
	}
	cv := float64(independent)
	return math.Max(min, max-(max-min)*math.Log(cv+1)/math.Log(float64(c.ConfirmK)+1))
}

// TheoryFirstProbe is the SWIM paper's bound on the expected time between the
// failure of an arbitrary member and the first probe that fails against it
// (Section 3.1): T'/(1-e^-qf), where qf is the fraction of non-faulty members.
// It is the *basic* detector's figure, before the suspicion delay.
func TheoryFirstProbe(periodSeconds, qf float64) float64 {
	if qf <= 0 {
		return math.Inf(1)
	}
	return periodSeconds / (1 - math.Exp(-qf))
}

// TheoryDetectionTime is the expected time to *confirm* a failure once the
// suspicion mechanism is in play: the first failing probe plus the suspicion
// timeout the detector waits before declaring the member dead. Lifeguard's
// paper reports a 12.44 s median first detection for alpha=5, beta=6.
func TheoryDetectionTime(periodSeconds, qf, suspicionTimeoutSeconds float64) float64 {
	return TheoryFirstProbe(periodSeconds, qf) + suspicionTimeoutSeconds
}

// TheoryFalsePositivePerPeriod is the SWIM paper's expression for the chance
// that an arbitrary non-faulty member is falsely declared failed within one
// protocol period:
//
//	qf*(1-qml^2)*(1-qf*qml^4)^k * e^qf/(e^qf-1)
//
// with qml the probability of timely packet delivery and k the indirect probe
// group size.
func TheoryFalsePositivePerPeriod(qf, qml float64, k int) float64 {
	if qf <= 0 || qml <= 0 {
		return 0
	}
	a := qf * (1 - qml*qml)
	b := math.Pow(1-qf*math.Pow(qml, 4), float64(k))
	c := math.Exp(qf) / (math.Exp(qf) - 1)
	return a * b * c
}

// TheoryMessagesPerMemberPerSecond is the paper's accounting for the basic
// detector: one ping sent plus one ack sent per protocol period on expectation
// (each member also receives a ping and sends its ack, which is the same ack).
func TheoryMessagesPerMemberPerSecond(periodSeconds float64) float64 {
	if periodSeconds <= 0 {
		return 0
	}
	return 2 / periodSeconds
}
