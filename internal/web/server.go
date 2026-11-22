// Package web 提供推荐过程可视化页面与配套 JSON API，静态资源通过 go:embed 内嵌。
package web

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"

	"zooresourcer/internal/histogram"
	"zooresourcer/internal/recommender"
	"zooresourcer/internal/simulation"
)

//go:embed static/*
var staticFS embed.FS

// Server 持有一次模拟的结果并对外提供页面与 API。
type Server struct {
	result *simulation.Result
}

// NewServer 用模拟结果构造服务。
func NewServer(result *simulation.Result) *Server {
	return &Server{result: result}
}

// Handler 注册全部路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /", http.FileServer(http.FS(sub)))
	mux.HandleFunc("GET /api/overview", s.handleOverview)
	mux.HandleFunc("GET /api/container", s.handleContainer)
	mux.HandleFunc("GET /api/oom", s.handleOOM)
	return mux
}

type containerSummary struct {
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	Profile  simulation.Profile `json:"profile"`
	CPUReq   float64            `json:"cpuRequest"`
	CPULim   float64            `json:"cpuLimit"`
	MemReq   float64            `json:"memRequest"`
	MemLim   float64            `json:"memLimit"`
	History  float64            `json:"historyDays"`
	OOMCount int                `json:"oomCount"`
	Changes  int                `json:"recommendChanges"`
}

type overviewResp struct {
	StartSec   float64            `json:"startSec"`
	EndSec     float64            `json:"endSec"`
	Config     recommender.Config `json:"config"`
	Stats      simulation.Stats   `json:"stats"`
	Containers []containerSummary `json:"containers"`
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	resp := overviewResp{
		StartSec: s.result.StartSec,
		EndSec:   s.result.EndSec,
		Config:   s.result.Cfg,
		Stats:    s.result.Stats,
	}
	for _, c := range s.result.Containers {
		cpuReq, cpuLim, memReq, memLim := c.Rec().CurrentSpec()
		resp.Containers = append(resp.Containers, containerSummary{
			ID: c.ID, Name: c.Name, Profile: c.Profile,
			CPUReq: cpuReq, CPULim: cpuLim, MemReq: memReq, MemLim: memLim,
			History: lastHistory(c), OOMCount: c.ActualOOMCount(),
			Changes: c.RecommendCount(),
		})
	}
	writeJSON(w, resp)
}

type containerDetail struct {
	ID       string                     `json:"id"`
	Name     string                     `json:"name"`
	Profile  simulation.Profile         `json:"profile"`
	StartSec float64                    `json:"startSec"`
	Timeline []simulation.TimelinePoint `json:"timeline"`
	CPUHist  []histogramBucket          `json:"cpuHistogram"`
	MemHist  []histogramBucket          `json:"memHistogram"`
	OOMs     []simulation.OOMInfo       `json:"ooms"`
}

type histogramBucket struct {
	Lower  float64 `json:"lower"`
	Upper  float64 `json:"upper"`
	Weight float64 `json:"weight"`
}

func (s *Server) handleContainer(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	for _, c := range s.result.Containers {
		if c.ID != id {
			continue
		}
		now := s.result.EndSec
		ooms := c.OOMs
		if ooms == nil {
			ooms = []simulation.OOMInfo{} // 序列化为 [] 而非 null，前端可直接 .length
		}
		detail := containerDetail{
			ID: c.ID, Name: c.Name, Profile: c.Profile,
			StartSec: s.result.StartSec, Timeline: c.Timeline,
			CPUHist: toBuckets(c.Rec().CPUHistogram().Snapshot(now)),
			MemHist: toBuckets(c.Rec().MemHistogram().Snapshot(now)),
			OOMs:    ooms,
		}
		writeJSON(w, detail)
		return
	}
	http.Error(w, "container not found", http.StatusNotFound)
}

func (s *Server) handleOOM(w http.ResponseWriter, r *http.Request) {
	type oomResp struct {
		Actual    []simulation.OOMInfo `json:"actual"`
		Prevented []simulation.OOMInfo `json:"prevented"`
		Stats     simulation.Stats     `json:"stats"`
	}
	out := oomResp{
		Stats:     s.result.Stats,
		Actual:    []simulation.OOMInfo{},
		Prevented: []simulation.OOMInfo{},
	}
	for _, c := range s.result.Containers {
		for _, ev := range c.OOMs {
			if ev.Prevented {
				out.Prevented = append(out.Prevented, ev)
			} else {
				out.Actual = append(out.Actual, ev)
			}
		}
	}
	writeJSON(w, out)
}

func toBuckets(bs []histogram.Bucket) []histogramBucket {
	out := make([]histogramBucket, len(bs))
	for i, b := range bs {
		out[i] = histogramBucket{Lower: b.Lower, Upper: b.Upper, Weight: b.Weight}
	}
	return out
}

func lastHistory(c *simulation.Container) float64 {
	if n := len(c.Timeline); n > 0 {
		return c.Timeline[n-1].HistoryDays
	}
	return 0
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
