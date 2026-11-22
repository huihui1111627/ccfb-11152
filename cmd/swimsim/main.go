// Command swimsim runs SWIM/Lifeguard membership simulations over a control
// network of stage equipment and writes either a batch summary, a detailed
// trace for the visualisation page, or a paper-comparison report.
//
// Everything is deterministic: the same scenario and seed produce a
// byte-identical result, which `-verify-determinism` re-checks by running each
// simulation twice and comparing digests.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"swimsim/internal/swim"
)

func main() {
	var (
		mode      = flag.String("mode", "batch", "batch | compare | detail | list")
		scenario  = flag.String("scenario", "", "scenario key (empty = all)")
		seeds     = flag.Int("seeds", 20, "number of seeds")
		seedStart = flag.Int("seed-start", 1, "first seed")
		out       = flag.String("out", "", "output file (default stdout)")
		seed      = flag.Uint64("seed", 1, "seed for -mode detail")
		lifeguard = flag.Bool("lifeguard", true, "enable Lifeguard")
		alpha     = flag.Float64("alpha", 5, "Lifeguard alpha (min suspicion timeout)")
		beta      = flag.Float64("beta", 6, "Lifeguard beta (max = beta*min)")
		members   = flag.Int("members", 0, "override member count")
		duration  = flag.Float64("duration", 0, "override duration in seconds")
		loss      = flag.Float64("loss", -1, "override loss probability")
		verify    = flag.Bool("verify-determinism", false, "re-run each simulation and compare digests")
		markdown  = flag.String("md", "", "optional Markdown report path (compare/batch modes)")
	)
	flag.Parse()

	switch *mode {
	case "list":
		writeJSON(os.Stdout, swim.Catalog())
	case "detail":
		runDetail(*scenario, *seed, *out, *lifeguard, *alpha, *beta, *members, *duration, *loss)
	case "batch":
		rep := runBatch(*scenario, *seeds, *seedStart, *out, *verify, *lifeguard, *alpha, *beta, *members, *duration, *loss)
		if *markdown != "" {
			writeMarkdown(*markdown, rep, false)
		}
	case "compare":
		rep := runCompare(*scenario, *seeds, *seedStart, *out, *verify, *alpha, *beta, *members, *duration, *loss)
		if *markdown != "" {
			writeMarkdown(*markdown, rep, true)
		}
	default:
		fail(fmt.Errorf("unknown mode %q", *mode))
	}
}

func applyOverrides(sc *swim.Scenario, lifeguard bool, alpha, beta float64, members int, duration, loss float64) {
	sc.Config.Lifeguard = lifeguard
	sc.Config.Alpha = alpha
	sc.Config.Beta = beta
	if members > 0 {
		sc.Members = members
	}
	if duration > 0 {
		sc.Duration = swim.Seconds(duration)
	}
	if loss >= 0 {
		sc.Config.Loss = loss
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func writeJSON(w *os.File, v any) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fail(err)
	}
}

func openOut(path string) *os.File {
	if path == "" || path == "-" {
		return os.Stdout
	}
	f, err := os.Create(path)
	if err != nil {
		fail(err)
	}
	return f
}

func detailRun(sc swim.Scenario, lifeguard bool, alpha, beta float64, members int, duration, loss float64, verify bool) *swim.Result {
	applyOverrides(&sc, lifeguard, alpha, beta, members, duration, loss)
	start := time.Now()
	res := swim.NewSim(sc).Run()
	res.WallSeconds = time.Since(start).Seconds()
	if verify {
		again := swim.NewSim(sc).Run()
		if again.Digest != res.Digest {
			fail(fmt.Errorf("non-deterministic run: %s seed=%d\n  %s\n  %s", sc.Name, sc.Seed, res.Digest, again.Digest))
		}
	}
	fmt.Fprintf(os.Stderr, "%s\n", res.SummaryLine())
	return res
}

func runDetail(key string, seed uint64, out string, lifeguard bool, alpha, beta float64, members int, duration, loss float64) {
	if key == "" {
		key = "crash"
	}
	sc, err := swim.BuildScenario(key, seed)
	if err != nil {
		fail(err)
	}
	sc.Detail = true
	res := detailRun(sc, lifeguard, alpha, beta, members, duration, loss, false)
	f := openOut(out)
	defer f.Close()
	writeJSON(f, res)
}

func scenarioKeys(key string) []string {
	if key != "" {
		return []string{key}
	}
	var keys []string
	for _, e := range swim.Catalog() {
		keys = append(keys, e.Key)
	}
	return keys
}

func runBatch(key string, seedsN, seedStart int, out string, verify, lifeguard bool, alpha, beta float64, members int, duration, loss float64) swim.BatchReport {
	rep := swim.BatchReport{Seeds: seedsN, SeedStart: seedStart, GeneratedBy: "swimsim"}
	for _, k := range scenarioKeys(key) {
		var runs []*swim.Result
		for i := 0; i < seedsN; i++ {
			sc, err := swim.BuildScenario(k, uint64(seedStart+i))
			if err != nil {
				fail(err)
			}
			runs = append(runs, detailRun(sc, lifeguard, alpha, beta, members, duration, loss, verify))
		}
		rep.Aggregates = append(rep.Aggregates, swim.Summarize(k, runs))
	}
	swim.SortAggregates(rep.Aggregates)
	f := openOut(out)
	defer f.Close()
	writeJSON(f, rep)
	printBatchSummary(rep)
	return rep
}

func runCompare(key string, seedsN, seedStart int, out string, verify bool, alpha, beta float64, members int, duration, loss float64) swim.BatchReport {
	rep := swim.BatchReport{Seeds: seedsN, SeedStart: seedStart, GeneratedBy: "swimsim compare"}
	for _, k := range scenarioKeys(key) {
		var lgRuns, baseRuns []*swim.Result
		for i := 0; i < seedsN; i++ {
			seed := uint64(seedStart + i)
			scL, err := swim.BuildScenario(k, seed)
			if err != nil {
				fail(err)
			}
			scB := scL
			lgRuns = append(lgRuns, detailRun(scL, true, alpha, beta, members, duration, loss, verify))
			baseRuns = append(baseRuns, detailRun(scB, false, alpha, beta, members, duration, loss, verify))
		}
		lg := swim.Summarize(k, lgRuns)
		base := swim.Summarize(k, baseRuns)
		rep.Aggregates = append(rep.Aggregates, lg, base)
		cmp := swim.Comparison{Scenario: k, Title: lg.Title, Members: lg.Members, Lifeguard: lg, Baseline: base}
		if lg.FPPerRun > 0 {
			cmp.FPFactor = base.FPPerRun / lg.FPPerRun
		} else if base.FPPerRun > 0 {
			cmp.FPFactor = base.FPPerRun
		}
		rep.Comparisons = append(rep.Comparisons, cmp)
	}
	swim.SortAggregates(rep.Aggregates)
	f := openOut(out)
	defer f.Close()
	writeJSON(f, rep)
	printCompareSummary(rep)
	return rep
}

func printBatchSummary(rep swim.BatchReport) {
	fmt.Fprintf(os.Stderr, "\n%-12s %6s %8s %8s %8s %9s\n", "scenario", "runs", "det(med)", "det%", "fp/run", "msgs/m/s")
	for _, a := range rep.Aggregates {
		fmt.Fprintf(os.Stderr, "%-12s %6d %7.2fs %7.1f%% %8.2f %9.2f\n",
			a.Scenario, a.Runs, a.DetectionMedian, 100*a.DetectedRate, a.FPPerRun, a.MsgsPerMemberSec)
	}
}

func printCompareSummary(rep swim.BatchReport) {
	sort.Slice(rep.Comparisons, func(i, j int) bool { return rep.Comparisons[i].Scenario < rep.Comparisons[j].Scenario })
	fmt.Fprintf(os.Stderr, "\n%-12s %10s %10s %8s %10s %10s\n", "scenario", "LifeguardFP", "baselineFP", "factor", "lgDet(med)", "baseDet")
	for _, c := range rep.Comparisons {
		fmt.Fprintf(os.Stderr, "%-12s %10.2f %10.2f %7.1fx %9.2fs %9.2fs\n",
			c.Scenario, c.Lifeguard.FPPerRun, c.Baseline.FPPerRun, c.FPFactor,
			c.Lifeguard.DetectionMedian, c.Baseline.DetectionMedian)
	}
}

// writeMarkdown renders a human-readable report with the paper comparison baked
// in, so results can be read without parsing JSON.
func writeMarkdown(path string, rep swim.BatchReport, compare bool) {
	var b strings.Builder
	b.WriteString("# SWIM / Lifeguard 仿真报告\n\n")
	fmt.Fprintf(&b, "- 种子数:%d(起始 %d)\n", rep.Seeds, rep.SeedStart)
	if compare {
		b.WriteString("- 对照:每个场景分别以 Lifeguard 开 / 关运行\n\n")
		b.WriteString("| 场景 | Lifeguard 误判/次 | 基础 SWIM 误判/次 | 检测中位 Lifeguard | 检测中位 基础 |\n")
		b.WriteString("| --- | ---: | ---: | ---: | ---: |\n")
		for _, c := range rep.Comparisons {
			fmt.Fprintf(&b, "| %s | %.1f | %.1f | %.2fs | %.2fs |\n", c.Scenario,
				c.Lifeguard.FPPerRun, c.Baseline.FPPerRun,
				c.Lifeguard.DetectionMedian, c.Baseline.DetectionMedian)
		}
		b.WriteString("\n")
	}
	b.WriteString("| 场景 | 配置 | 运行数 | 检测中位 | 检测成功率 | 误判/次 | 分区确认 | 每台每秒消息 |\n")
	b.WriteString("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n")
	for _, a := range rep.Aggregates {
		cfg := a.Config
		if cfg == "" {
			cfg = "lifeguard"
		}
		fmt.Fprintf(&b, "| %s | %s | %d | %.2fs | %.0f%% | %.1f | %d | %.2f |\n", a.Scenario, cfg, a.Runs,
			a.DetectionMedian, 100*a.DetectedRate, a.FPPerRun, a.IsolatedTotal, a.MsgsPerMemberSec)
	}
	b.WriteString("\n> 检测中位 = 从故障发生到首个成员确认下线的中位时间;理论下限见 README(首探 + 怀疑计时)。\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		fail(err)
	}
}
