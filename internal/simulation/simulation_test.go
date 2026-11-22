package simulation

import (
	"testing"

	"zooresourcer/internal/recommender"
)

func TestRunBruteForceConsistency(t *testing.T) {
	opts := DefaultOptions()
	opts.ContainerCount = 60
	opts.Days = 14
	opts.VerifySampleN = 12
	opts.VerifyEvery = 2

	res, err := Run(opts, recommender.DefaultConfig())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Containers) != 60 {
		t.Fatalf("container count = %d", len(res.Containers))
	}
	if len(res.Issues) != 0 {
		for _, is := range res.Issues {
			t.Errorf("brute-force mismatch: %v", is)
		}
	}
}

func TestStatsAreSane(t *testing.T) {
	opts := DefaultOptions()
	opts.ContainerCount = 120
	opts.Days = 21
	res, err := Run(opts, recommender.DefaultConfig())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	st := res.Stats
	if st.TotalBaselineOOM == 0 {
		t.Fatal("synthetic data should produce at least some baseline OOMs")
	}
	if st.TotalActualOOM > st.TotalBaselineOOM {
		t.Fatalf("actual OOM %d cannot exceed baseline %d", st.TotalActualOOM, st.TotalBaselineOOM)
	}
	if st.OOMReductionPercent < 0 || st.OOMReductionPercent > 100 {
		t.Fatalf("OOM reduction %.2f%% out of range", st.OOMReductionPercent)
	}
	// 拍脑袋的初始规格整体偏大，治理后总 request 应当下降。
	if st.CPUSavedPercent <= 0 {
		t.Errorf("expected CPU savings, got %.2f%%", st.CPUSavedPercent)
	}
	if st.MemSavedPercent <= 0 {
		t.Errorf("expected memory savings, got %.2f%%", st.MemSavedPercent)
	}
	if st.RecommendationEvents == 0 {
		t.Error("expected at least one recommendation event")
	}
}

func TestDeterministicWithSeed(t *testing.T) {
	opts := DefaultOptions()
	opts.ContainerCount = 40
	opts.Days = 7
	r1, _ := Run(opts, recommender.DefaultConfig())
	r2, _ := Run(opts, recommender.DefaultConfig())
	if r1.Stats != r2.Stats {
		t.Fatalf("same seed produced different stats: %+v vs %+v", r1.Stats, r2.Stats)
	}
}

func TestAllProfilesGenerated(t *testing.T) {
	opts := DefaultOptions()
	opts.ContainerCount = 200
	opts.Days = 5
	res, _ := Run(opts, recommender.DefaultConfig())
	seen := map[Profile]bool{}
	for _, c := range res.Containers {
		seen[c.Profile] = true
	}
	for _, p := range []Profile{ProfileStable, ProfileDaily, ProfileBurst, ProfileOOM} {
		if !seen[p] {
			t.Errorf("profile %s not generated", p)
		}
	}
}
