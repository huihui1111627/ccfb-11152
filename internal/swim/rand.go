// Package swim implements the SWIM membership protocol (Das, Gupta & Motivala,
// DSN 2002) together with the Lifeguard extensions (Dadgar et al., 2017) on top
// of a deterministic discrete-event network simulator.
//
// Everything in this package is single-threaded and seeded exclusively through
// integer PRNGs / hashes, so a run is a pure function of its Scenario. Map
// iteration is never allowed to influence behaviour or output ordering.
package swim

// PRNG is a splitmix64 generator. It is used instead of math/rand so that the
// exact sequence is fixed by this source file (and identical on every platform
// Go supports), which is a precondition for "same seed => bit-identical run".
type PRNG struct{ state uint64 }

// NewPRNG derives an independent stream from a seed.
func NewPRNG(seed uint64) *PRNG {
	p := &PRNG{state: seed + 0x9E3779B97F4A7C15}
	// Discard the first output so that nearby seeds diverge immediately.
	_ = p.next()
	return p
}

func (p *PRNG) next() uint64 {
	p.state += 0x9E3779B97F4A7C15
	z := p.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Uint64 returns the next 64 random bits.
func (p *PRNG) Uint64() uint64 { return p.next() }

// Float returns a uniform value in [0,1).
func (p *PRNG) Float() float64 { return float64(p.next()>>11) * (1.0 / (1 << 53)) }

// Intn returns a uniform integer in [0,n).
func (p *PRNG) Intn(n int) int {
	if n <= 0 {
		return 0
	}
	return int(p.next() % uint64(n))
}

// Shuffle performs an in-place Fisher-Yates shuffle.
func (p *PRNG) Shuffle(n int, swap func(i, j int)) {
	for i := n - 1; i > 0; i-- {
		j := p.Intn(i + 1)
		swap(i, j)
	}
}

// mix64 is the splitmix64 finalizer; it is a bijection over uint64.
func mix64(z uint64) uint64 {
	z += 0x9E3779B97F4A7C15
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Mix combines arbitrary integers into one well-mixed value.
func Mix(vals ...uint64) uint64 {
	h := uint64(0xCBF29CE484222325)
	for _, v := range vals {
		h = mix64(h ^ mix64(v))
	}
	return h
}

// Hash01 maps (seed, values...) to a uniform value in [0,1). It is used for
// per-packet network decisions, so those decisions are independent of the order
// in which packets happen to be processed.
func Hash01(seed uint64, vals ...uint64) float64 {
	return float64(Mix(append([]uint64{seed}, vals...)...)>>11) * (1.0 / (1 << 53))
}
