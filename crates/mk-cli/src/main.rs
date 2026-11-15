//! `mk` 命令行：生成仿真数据、跑引擎、核对金标准、导出报告。

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use mk_app::Analysis;
use mk_sim::sim::{SimConfig, Simulator};
use std::path::PathBuf;

mod store;
mod report;

#[derive(Parser, Debug)]
#[command(name = "mk", version, about = "行情加工引擎 CLI")]
struct Cli {
    /// 数据目录
    #[arg(long, global = true, default_value = "data/sim")]
    data: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// 生成仿真数据（消息 + dataset.json + 金标准）
    Gen {
        #[arg(long, default_value_t = 20260302)]
        seed: u64,
        #[arg(long, default_value = "2026-02-27")]
        start: String,
        #[arg(long, default_value = "2026-03-06")]
        end: String,
        /// 每分钟成交笔数
        #[arg(long, default_value_t = 30)]
        trades_per_minute: u64,
        /// 单源（关闭 B 源）
        #[arg(long)]
        single_source: bool,
        /// 不注入异常
        #[arg(long)]
        no_inject: bool,
        /// 不生成金标准
        #[arg(long)]
        no_golden: bool,
        /// A 源丢包率
        #[arg(long, default_value_t = 0.002)]
        primary_loss: f64,
        /// B 源丢包率
        #[arg(long, default_value_t = 0.003)]
        peer_loss: f64,
    },
    /// 跑引擎并打印摘要
    Run {
        /// 输出派生结果到 <data>/derived.json
        #[arg(long)]
        save: bool,
    },
    /// 金标准核对
    Reconcile {
        /// 有差异时以非零码退出
        #[arg(long)]
        strict: bool,
        /// JSON 输出
        #[arg(long)]
        json: bool,
    },
    /// 一致性核对（跨周期）
    Check,
    /// 导出 CSV（bars）
    Export {
        #[arg(long)]
        symbol: String,
        #[arg(long, default_value = "1m")]
        period: String,
        #[arg(long)]
        date: Option<String>,
        #[arg(long, default_value = "none")]
        adjust: String,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// 数据集摘要
    Info,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();
    let cli = Cli::parse();
    let dir = store::DataDir::new(&cli.data);

    match cli.cmd {
        Cmd::Gen {
            seed,
            start,
            end,
            trades_per_minute,
            single_source,
            no_inject,
            no_golden,
            primary_loss,
            peer_loss,
        } => {
            let cfg = SimConfig {
                seed,
                start,
                end,
                trades_per_minute,
                dual_source: !single_source,
                primary_loss_rate: primary_loss,
                peer_loss_rate: peer_loss,
                inject_anomalies: !no_inject,
                golden: !no_golden,
                ..Default::default()
            };
            tracing::info!(?cfg, "开始生成仿真数据");
            let t0 = std::time::Instant::now();
            let out = Simulator::new(cfg).run();
            dir.save_sim(&out).context("保存数据集")?;
            let msgs: usize = out.messages_by_symbol.values().map(|s| s.lines().count()).sum();
            let injected = out.meta.injected_anomalies.len();
            println!(
                "生成完成：{} 个品种，{} 条消息，{} 个交易日，{} 条注入异常，{} 个金标准用例，耗时 {:?}",
                out.meta.instruments.len(),
                msgs,
                out.meta.calendar.trading_days.len(),
                injected,
                out.golden.len(),
                t0.elapsed()
            );
            println!("输出目录：{}", dir.root.display());
        }
        Cmd::Run { save } => {
            let ds = dir.load()?;
            let golden = dir.load_golden().unwrap_or_default();
            let t0 = std::time::Instant::now();
            let analysis = Analysis::build(ds, golden)?;
            let elapsed = t0.elapsed();
            report::print_summary(&analysis, elapsed);
            if save {
                let mut rows = Vec::new();
                for s in analysis.engine_out.symbols.iter() {
                    for (date, per) in s.bars.iter() {
                        for (period, bars) in per.iter() {
                            for b in bars {
                                rows.push(report::BarRow::new(&s.symbol, date, period, b));
                            }
                        }
                    }
                }
                dir.save_derived(&rows)?;
                println!("派生结果已写入 {}", dir.derived_json().display());
            }
        }
        Cmd::Reconcile { strict, json } => {
            let ds = dir.load()?;
            let golden = dir.load_golden()?;
            let analysis = Analysis::build(ds, golden)?;
            let rep = analysis.reconcile().expect("reconcile");
            if json {
                println!("{}", serde_json::to_string_pretty(rep)?);
            } else {
                report::print_reconcile(rep);
            }
            if strict && rep.summary.mismatched > 0 {
                std::process::exit(1);
            }
        }
        Cmd::Check => {
            let ds = dir.load()?;
            let golden = dir.load_golden().unwrap_or_default();
            let analysis = Analysis::build(ds, golden)?;
            report::print_consistency(&analysis);
        }
        Cmd::Export { symbol, period, date, adjust, out } => {
            let ds = dir.load()?;
            let golden = dir.load_golden().unwrap_or_default();
            let analysis = Analysis::build(ds, golden)?;
            let resp = analysis.bars(
                &symbol,
                &period,
                date.as_deref(),
                None,
                None,
                &adjust,
                None,
            )?;
            let csv = report::to_csv(&resp);
            match out {
                Some(p) => {
                    std::fs::write(&p, &csv)?;
                    println!("已写入 {}（{} 根 bar）", p.display(), resp.bars.len());
                }
                None => print!("{}", csv),
            }
        }
        Cmd::Info => {
            let meta = dir.load_meta()?;
            report::print_info(&meta);
        }
    }
    Ok(())
}
