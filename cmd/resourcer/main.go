// resourcer 是容器资源规格推荐器的命令行入口。
//
//	serve   运行模拟并启动可视化页面（默认）
//	verify  运行模拟与暴力加权分位数校验，打印核对结论与治理统计后退出
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"zooresourcer/internal/recommender"
	"zooresourcer/internal/simulation"
	"zooresourcer/internal/web"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
	case "verify":
		runVerify(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `容器资源规格推荐器

用法:
  resourcer serve   [--containers N] [--days N] [--seed S] [--addr :8080]
  resourcer verify  [--containers N] [--days N] [--seed S] [--verify-n N] [--verify-every K]

子命令:
  serve   生成模拟用量、驱动推荐器并启动可视化页面
  verify  用全部原始样本的暴力加权分位数核对分桶结果，打印统计后退出
`)
}

func commonFlags(fs *flag.FlagSet) (*int, *int, *int64) {
	c := fs.Int("containers", 300, "模拟容器数量")
	d := fs.Int("days", 28, "模拟天数")
	s := fs.Int64("seed", 20261123, "随机种子（相同种子结果可复现）")
	return c, d, s
}

func buildOptions(containers, days int, seed int64) (simulation.Options, recommender.Config) {
	opts := simulation.DefaultOptions()
	opts.ContainerCount = containers
	opts.Days = days
	opts.Seed = seed
	return opts, recommender.DefaultConfig()
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	c, d, s := commonFlags(fs)
	addr := fs.String("addr", ":8080", "HTTP 监听地址")
	_ = fs.Parse(args)

	opts, cfg := buildOptions(*c, *d, *s)
	result, err := runWithTiming(opts, cfg)
	if err != nil {
		log.Fatalf("模拟失败: %v", err)
	}
	printStats(result)

	srv := web.NewServer(result)
	log.Printf("可视化页面已启动: http://localhost%s （Ctrl-C 退出）", *addr)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

func runVerify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	c, d, s := commonFlags(fs)
	verifyN := fs.Int("verify-n", 24, "保留全部原始样本参与暴力校验的容器数")
	verifyEvery := fs.Int("verify-every", 4, "每隔多少个推荐周期抽样校验一次")
	_ = fs.Parse(args)

	opts, cfg := buildOptions(*c, *d, *s)
	opts.VerifySampleN = *verifyN
	opts.VerifyEvery = *verifyEvery

	result, err := runWithTiming(opts, cfg)
	if err != nil {
		log.Fatalf("模拟失败: %v", err)
	}
	printStats(result)

	fmt.Println("\n=== 暴力加权分位数校验 ===")
	fmt.Printf("校验容器数: %d，校验抽点数: 每 %d 个推荐周期一次\n", *verifyN, *verifyEvery)
	if len(result.Issues) == 0 {
		fmt.Printf("✅ 全部抽点的直方图分位数与暴力加权分位数在分桶误差以内一致（0 条不一致）\n")
	} else {
		fmt.Printf("❌ 发现 %d 条超出分桶误差的不一致:\n", len(result.Issues))
		for _, is := range result.Issues {
			fmt.Println("  -", is)
		}
		os.Exit(1)
	}
}

func runWithTiming(opts simulation.Options, cfg recommender.Config) (*simulation.Result, error) {
	start := time.Now()
	res, err := simulation.Run(opts, cfg)
	if err != nil {
		return nil, err
	}
	log.Printf("模拟完成: %d 容器 × %d 天，耗时 %s", opts.ContainerCount, opts.Days, time.Since(start).Round(time.Millisecond))
	return res, nil
}

func printStats(r *simulation.Result) {
	s := r.Stats
	mib := float64(recommender.MiB)
	fmt.Println("\n=== 治理效果统计 ===")
	fmt.Printf("容器数: %d，模拟天数: %.0f\n", s.ContainerCount, s.DurationDays)
	fmt.Printf("CPU 请求总量: %.2f 核 → %.2f 核，节省 %.2f 核（%.1f%%）\n",
		s.CPURequestsBefore, s.CPURequestsAfter, s.CPUSavedCores, s.CPUSavedPercent)
	fmt.Printf("内存请求总量: %.1f GiB → %.1f GiB，节省 %.1f GiB（%.1f%%）\n",
		s.MemRequestsBefore/mib/1024, s.MemRequestsAfter/mib/1024,
		s.MemSavedBytes/mib/1024, s.MemSavedPercent)
	fmt.Printf("OOM: 基线世界 %d 次，治理后实际 %d 次，被避免 %d 次（减少 %.1f%%）\n",
		s.TotalBaselineOOM, s.TotalActualOOM, s.TotalPreventedOOM, s.OOMReductionPercent)
	fmt.Printf("推荐调整事件: %d 次\n", s.RecommendationEvents)
}
