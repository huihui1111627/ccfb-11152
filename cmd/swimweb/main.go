// Command swimweb serves the membership visualisation page and runs detail
// simulations on demand.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"swimsim/internal/swim"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir("web")))
	mux.HandleFunc("/api/catalog", handleCatalog)
	mux.HandleFunc("/api/run", handleRun)
	mux.HandleFunc("/api/batch", handleBatch)

	log.Printf("swimweb listening on http://%s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func handleCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"scenarios": swim.Catalog(),
		"default":   swim.DefaultConfig(),
	})
}

// runCache memoises detail runs: they are deterministic, so the same request
// always yields the same bytes.
type cacheEntry struct {
	at  time.Time
	res *swim.Result
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cacheEntry{}
)

func handleRun(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := q.Get("scenario")
	if key == "" {
		key = "crash"
	}
	seed, _ := strconv.ParseUint(def(q.Get("seed"), "1"), 10, 64)
	members, _ := strconv.Atoi(def(q.Get("members"), "0"))
	duration, _ := strconv.ParseFloat(def(q.Get("duration"), "0"), 64)
	lifeguard := q.Get("lifeguard") != "0"

	cacheKey := fmt.Sprintf("%s|%d|%d|%g|%v", key, seed, members, duration, lifeguard)
	cacheMu.Lock()
	if e, ok := cache[cacheKey]; ok && time.Since(e.at) < 10*time.Minute {
		cacheMu.Unlock()
		writeJSON(w, e.res)
		return
	}
	cacheMu.Unlock()

	sc, err := swim.BuildScenario(key, seed)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sc.Detail = true
	sc.Config.Lifeguard = lifeguard
	if members > 0 {
		sc.Members = members
	}
	if duration > 0 {
		sc.Duration = swim.Seconds(duration)
	}
	// Keep the JSON payload browsable.
	if sc.Members > 400 {
		sc.Duration = swim.Seconds(60)
	}
	start := time.Now()
	res := swim.NewSim(sc).Run()
	res.WallSeconds = time.Since(start).Seconds()
	cacheMu.Lock()
	cache[cacheKey] = cacheEntry{at: time.Now(), res: res}
	cacheMu.Unlock()
	writeJSON(w, res)
}

func handleBatch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := q.Get("scenario")
	seeds, _ := strconv.Atoi(def(q.Get("seeds"), "20"))
	start, _ := strconv.Atoi(def(q.Get("seed_start"), "1"))
	var keys []string
	if key == "" {
		for _, e := range swim.Catalog() {
			keys = append(keys, e.Key)
		}
	} else {
		keys = []string{key}
	}
	type pair struct {
		Lifeguard swim.Aggregate `json:"lifeguard"`
		Baseline  swim.Aggregate `json:"baseline"`
	}
	out := map[string]pair{}
	for _, k := range keys {
		var lgRuns, baseRuns []*swim.Result
		for i := 0; i < seeds; i++ {
			seed := start + i
			for _, lg := range []bool{true, false} {
				sc, err := swim.BuildScenario(k, uint64(seed))
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				sc.Config.Lifeguard = lg
				r := swim.NewSim(sc).Run()
				if lg {
					lgRuns = append(lgRuns, r)
				} else {
					baseRuns = append(baseRuns, r)
				}
			}
		}
		out[k] = pair{
			Lifeguard: swim.Summarize(k, lgRuns),
			Baseline:  swim.Summarize(k, baseRuns),
		}
	}
	writeJSON(w, out)
}

func def(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
