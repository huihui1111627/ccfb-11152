package swim

import (
	"fmt"
	"time"
)

// InjectionKind enumerates the faults the simulator can inject.
type InjectionKind string

const (
	InjectPause     InjectionKind = "pause"     // one or more members stop scheduling
	InjectCrash     InjectionKind = "crash"     // one or more members die and later restart
	InjectPartition InjectionKind = "partition" // split by parity
	InjectJoin      InjectionKind = "join"      // one new member joins
	InjectSpawn     InjectionKind = "spawn"     // Count new members join
	InjectLeave     InjectionKind = "leave"     // one or more members leave voluntarily
)

// Injection is a scheduled fault or membership change.
type Injection struct {
	Kind     InjectionKind `json:"kind"`
	At       time.Duration `json:"at"`
	Duration time.Duration `json:"duration,omitempty"`
	Members  []int         `json:"members,omitempty"`
	Group    int           `json:"group,omitempty"`
	Count    int           `json:"count,omitempty"`
	Note     string        `json:"note,omitempty"`
}

// Scenario is one complete, reproducible simulation run.
type Scenario struct {
	Name       string        `json:"name"`
	Title      string        `json:"title"`
	Desc       string        `json:"desc"`
	Seed       uint64        `json:"seed"`
	Members    int           `json:"members"`
	Warmup     time.Duration `json:"warmup"`
	Duration   time.Duration `json:"duration"`
	Config     Config        `json:"config"`
	Injections []Injection   `json:"injections"`

	// Detail asks the recorder to keep the per-event trace used by the
	// visualisation page. Batch runs leave it off to keep results small.
	Detail bool `json:"detail"`
}

// Seconds is a convenience for building scenarios in Go.
func Seconds(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }

// Downtime returns the ground-truth down intervals per member: crash windows
// plus the moment a member leaves (to the end of the run).
func (sc Scenario) Downtime() map[int][]Interval {
	out := map[int][]Interval{}
	for _, inj := range sc.Injections {
		switch inj.Kind {
		case InjectCrash:
			for _, id := range inj.Members {
				out[id] = append(out[id], Interval{Start: int64(inj.At), End: int64(inj.At + inj.Duration)})
			}
		case InjectLeave:
			for _, id := range inj.Members {
				out[id] = append(out[id], Interval{Start: int64(inj.At), End: int64(sc.Duration)})
			}
		}
	}
	return out
}

// Interval is a half-open ground-truth interval.
type Interval struct{ Start, End int64 }

// DownAt reports whether id is truly unreachable at time t.
func DownAt(ivs []Interval, t int64) bool {
	for _, iv := range ivs {
		if t >= iv.Start && t < iv.End {
			return true
		}
	}
	return false
}

// Catalog scenarios. Each is deterministic for a given seed.

// CatalogEntry describes a selectable scenario to the web UI.
type CatalogEntry struct {
	Key        string   `json:"key"`
	Title      string   `json:"title"`
	Desc       string   `json:"desc"`
	Members    int      `json:"members"`
	Duration   string   `json:"duration"`
	Seeds      int      `json:"seeds"`
	ConfigNote string   `json:"config_note"`
	Detail     bool     `json:"detail"`
	Tags       []string `json:"tags"`
}

// Catalog returns the built-in scenarios.
func Catalog() []CatalogEntry {
	return []CatalogEntry{
		{
			Key: "steady", Title: "无故障基线 (300 台)", Desc: "全健康集群,用于验证每台每秒消息数与探测轮转。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 0%", Tags: []string{"baseline", "message-load"},
		},
		{
			Key: "crash", Title: "单点硬件宕机 (300 台)", Desc: "第 30 秒 1 台吊挂控制器彻底宕机,统计确认下线时间与误判。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 1%", Tags: []string{"detection", "false-positive"},
		},
		{
			Key: "slow", Title: "单台卡顿 (300 台)", Desc: "第 30 秒起 1 台设备卡顿 8 秒(不崩溃,只是不调度),复现心跳误判场景。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 1%", Tags: []string{"slow", "false-positive"},
		},
		{
			Key: "slow-many", Title: "多台同时卡顿 (300 台 × 8)", Desc: "8 台设备在第 30 秒同时卡顿 6 秒,对应全场灯光/吊挂短时拥塞。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 2%", Tags: []string{"slow", "false-positive"},
		},
		{
			Key: "congested", Title: "间歇拥塞 · 反复卡顿 (300 台)", Desc: "12 台设备每 12 秒卡顿 6 秒,持续整场——最贴近场馆实际拥塞,也是 Lifeguard 的主场。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 3%", Tags: []string{"slow", "false-positive", "lifeguard"},
		},
		{
			Key: "partition", Title: "网络分区 (300 台)", Desc: "按机柜奇偶分成两半,分区 15 秒后恢复。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 1%", Tags: []string{"partition", "false-positive"},
		},
		{
			Key: "churn", Title: "加入/离开风暴 (300 台)", Desc: "第 20/35/50 秒各有 8 台新设备接入,第 65/80 秒各 5 台主动离场。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开, 丢包 2%", Tags: []string{"churn", "dissemination"},
		},
		{
			Key: "loss", Title: "高丢包 (300 台, 10%)", Desc: "10% 单向丢包,对比 Lifeguard 与基础 SWIM 的误判。",
			Members: 300, Duration: "2m", Seeds: 20, ConfigNote: "Lifeguard 开/关对照", Tags: []string{"loss", "false-positive"},
		},
	}
}

// BuildScenario instantiates a catalog scenario for a seed.
func BuildScenario(key string, seed uint64) (Scenario, error) {
	cfg := DefaultConfig()
	sc := Scenario{
		Name:     key,
		Seed:     seed,
		Members:  300,
		Warmup:   Seconds(10),
		Duration: Seconds(120),
		Config:   cfg,
	}
	switch key {
	case "steady":
		sc.Title, sc.Desc = "无故障基线", "全健康集群"
		sc.Config.Loss = 0
	case "crash":
		sc.Title, sc.Desc = "单点硬件宕机", "1 台成员彻底宕机"
		sc.Config.Loss = 0.01
		sc.Injections = append(sc.Injections, Injection{
			Kind: InjectCrash, At: Seconds(30), Duration: Seconds(80), Members: []int{7}, Note: "hoist-07 断电",
		})
	case "slow":
		sc.Title, sc.Desc = "单台卡顿", "1 台成员卡顿 8 秒"
		sc.Config.Loss = 0.01
		sc.Injections = append(sc.Injections, Injection{
			Kind: InjectPause, At: Seconds(30), Duration: Seconds(8), Members: []int{7}, Note: "hoist-07 CPU 饱和",
		})
	case "slow-many":
		sc.Title, sc.Desc = "多台同时卡顿", "8 台成员卡顿 6 秒"
		sc.Config.Loss = 0.02
		var ids []int
		for i := 0; i < 8; i++ {
			ids = append(ids, 10+i*17)
		}
		sc.Injections = append(sc.Injections, Injection{
			Kind: InjectPause, At: Seconds(30), Duration: Seconds(6), Members: ids, Note: "灯光机柜短时拥塞",
		})
	case "congested":
		sc.Title, sc.Desc = "间歇拥塞 · 反复卡顿", "12 台设备每 12 秒卡顿 6 秒"
		sc.Config.Loss = 0.03
		var ids []int
		for i := 0; i < 12; i++ {
			ids = append(ids, i*17)
		}
		for at := 20.0; at < 110; at += 12 {
			sc.Injections = append(sc.Injections, Injection{
				Kind: InjectPause, At: Seconds(at), Duration: Seconds(6), Members: ids, Note: "间歇拥塞",
			})
		}
	case "partition":
		sc.Title, sc.Desc = "网络分区", "两半互不可达 15 秒"
		sc.Config.Loss = 0.01
		sc.Injections = append(sc.Injections, Injection{
			Kind: InjectPartition, At: Seconds(30), Duration: Seconds(15), Group: 0, Note: "主干交换机 A/B 分裂",
		})
	case "churn":
		sc.Title, sc.Desc = "加入/离开风暴", "24 台加入, 10 台离开"
		sc.Config.Loss = 0.02
		sc.Injections = append(sc.Injections,
			Injection{Kind: InjectSpawn, At: Seconds(20), Count: 8, Note: "新入场灯光台"},
			Injection{Kind: InjectSpawn, At: Seconds(35), Count: 8, Note: "新入场吊挂台"},
			Injection{Kind: InjectSpawn, At: Seconds(50), Count: 8, Note: "新入场闸机"},
			Injection{Kind: InjectLeave, At: Seconds(65), Members: []int{3, 41, 77, 113, 149}, Note: "撤场"},
			Injection{Kind: InjectLeave, At: Seconds(80), Members: []int{5, 47, 83, 119, 155}, Note: "撤场"},
		)
	case "loss":
		sc.Title, sc.Desc = "高丢包", "10% 丢包"
		sc.Config.Loss = 0.10
		sc.Injections = append(sc.Injections, Injection{
			Kind: InjectPause, At: Seconds(30), Duration: Seconds(6), Members: []int{7, 71, 137}, Note: "弱网设备",
		})
	default:
		return Scenario{}, fmt.Errorf("unknown scenario %q", key)
	}
	return sc, nil
}

// AllScenarios builds every catalog scenario for a seed (used by the batch
// command and tests).
func AllScenarios(seed uint64) []Scenario {
	var out []Scenario
	for _, e := range Catalog() {
		sc, err := BuildScenario(e.Key, seed)
		if err == nil {
			out = append(out, sc)
		}
	}
	return out
}
