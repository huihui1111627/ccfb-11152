//! HTTP 服务：把 `mk-app::Analysis` 暴露成 docs/api.md 定义的 JSON 接口，并托管前端。

use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use clap::Parser;
use mk_app::Analysis;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

#[derive(Parser, Debug)]
#[command(name = "mkd", version, about = "行情核对服务")]
struct Cli {
    /// 数据目录（含 dataset.json 与 messages/）
    #[arg(long, default_value = "data/sim")]
    data: PathBuf,
    /// 监听地址
    #[arg(long, default_value = "127.0.0.1:8899")]
    addr: String,
    /// 前端静态目录
    #[arg(long, default_value = "web")]
    web: PathBuf,
}

#[derive(Clone)]
struct AppState {
    analysis: Arc<Analysis>,
}

type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.code, "message": self.message})),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        let msg = e.to_string();
        let (status, code) = if msg.starts_with("unknown symbol") {
            (StatusCode::NOT_FOUND, "unknown_symbol")
        } else if msg.starts_with("adjust_not_supported") {
            (StatusCode::BAD_REQUEST, "adjust_not_supported")
        } else if msg.starts_with("invalid period") {
            (StatusCode::BAD_REQUEST, "invalid_period")
        } else if msg.starts_with("not a trading day") {
            (StatusCode::BAD_REQUEST, "invalid_date")
        } else if msg.starts_with("unknown product") {
            (StatusCode::NOT_FOUND, "unknown_product")
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
        };
        ApiError { status, code, message: msg }
    }
}

fn q_get<'a>(q: &'a Params, key: &str) -> Option<&'a str> {
    q.get(key).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

impl Params {
    fn get(&self, key: &str) -> Option<&String> {
        match key {
            "symbol" => self.symbol.as_ref(),
            "period" => self.period.as_ref(),
            "date" => self.date.as_ref(),
            "date_from" => self.date_from.as_ref(),
            "date_to" => self.date_to.as_ref(),
            "adjust" => self.adjust.as_ref(),
            "kind" => self.kind.as_ref(),
            "severity" => self.severity.as_ref(),
            "product" => self.product.as_ref(),
            _ => None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct Params {
    symbol: Option<String>,
    period: Option<String>,
    date: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    adjust: Option<String>,
    limit: Option<usize>,
    kind: Option<String>,
    severity: Option<String>,
    product: Option<String>,
}

async fn meta(State(st): State<AppState>) -> ApiResult<mk_app::model::MetaResp> {
    Ok(Json(st.analysis.meta()))
}

async fn sessions(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::SessionsResp> {
    let symbol = q_get(&q, "symbol").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing symbol".into(),
    })?;
    Ok(Json(st.analysis.sessions(symbol, q_get(&q, "date"))?))
}

async fn bars(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::BarsResp> {
    let symbol = q_get(&q, "symbol").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing symbol".into(),
    })?;
    let period = q_get(&q, "period").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing period".into(),
    })?;
    Ok(Json(st.analysis.bars(
        symbol,
        period,
        q_get(&q, "date"),
        q_get(&q, "date_from"),
        q_get(&q, "date_to"),
        q_get(&q, "adjust").unwrap_or("none"),
        q.limit,
    )?))
}

async fn replay(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::ReplayResp> {
    let symbol = q_get(&q, "symbol").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing symbol".into(),
    })?;
    Ok(Json(st.analysis.replay(symbol, q_get(&q, "date"))?))
}

async fn factors(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::FactorsResp> {
    let symbol = q_get(&q, "symbol").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing symbol".into(),
    })?;
    Ok(Json(st.analysis.factors(symbol)?))
}

async fn anomalies(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::AnomaliesResp> {
    Ok(Json(st.analysis.anomalies(
        q_get(&q, "kind"),
        q_get(&q, "symbol"),
        q_get(&q, "severity"),
        q_get(&q, "date"),
        q.limit.unwrap_or(500),
    )))
}

async fn sources(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::SourcesResp> {
    Ok(Json(st.analysis.sources(q_get(&q, "symbol"))))
}

async fn continuous(
    State(st): State<AppState>,
    Query(q): Query<Params>,
) -> ApiResult<mk_app::model::ContinuousResp> {
    let product = q_get(&q, "product").ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_request",
        message: "missing product".into(),
    })?;
    Ok(Json(
        st.analysis
            .continuous(product, q_get(&q, "period").unwrap_or("1d"))?,
    ))
}

async fn consistency(State(st): State<AppState>) -> ApiResult<mk_app::model::ConsistencyResp> {
    Ok(Json(st.analysis.consistency()))
}

async fn reconcile(State(st): State<AppState>) -> ApiResult<mk_app::reconcile::ReconcileResp> {
    st.analysis
        .reconcile()
        .map(|r| Json(r.clone()))
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            code: "no_reconcile",
            message: "未加载金标准".into(),
        })
}

async fn reconcile_case(
    State(st): State<AppState>,
    Path(case_id): Path<String>,
) -> ApiResult<mk_app::reconcile::CaseDetailResp> {
    let case = st
        .analysis
        .golden
        .iter()
        .find(|c| c.id == case_id)
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            code: "unknown_case",
            message: format!("未找到用例 {case_id}"),
        })?;
    Ok(Json(mk_app::reconcile::case_detail(case, &st.analysis)))
}

/// 注入真值 vs 引擎识别（异常召回）。
async fn injections(State(st): State<AppState>) -> ApiResult<serde_json::Value> {
    let rows = st.analysis.injection_recall();
    let total = rows.len();
    let hit = rows.iter().filter(|r| r.detected).count();
    Ok(Json(json!({
        "total": total,
        "detected": hit,
        "recall": if total == 0 { 1.0 } else { hit as f64 / total as f64 },
        "items": rows,
    })))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "service": "mkd", "version": env!("CARGO_PKG_VERSION")}))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .with_target(false)
        .init();
    let cli = Cli::parse();

    let t0 = std::time::Instant::now();
    let ds = load_dataset(&cli.data)?;
    let golden = load_golden(&cli.data);
    let analysis = Analysis::build(ds, golden).context("构建分析视图")?;
    tracing::info!(
        "数据集 {} 加载完成：{} 品种 / {} 消息 / {} 金标准用例，耗时 {:?}",
        analysis.dataset.meta.dataset,
        analysis.dataset.meta.instruments.len(),
        analysis.dataset.messages.len(),
        analysis.golden.len(),
        t0.elapsed()
    );

    let state = AppState { analysis: Arc::new(analysis) };
    let api = Router::new()
        .route("/meta", get(meta))
        .route("/sessions", get(sessions))
        .route("/bars", get(bars))
        .route("/replay", get(replay))
        .route("/factors", get(factors))
        .route("/anomalies", get(anomalies))
        .route("/sources", get(sources))
        .route("/continuous", get(continuous))
        .route("/consistency", get(consistency))
        .route("/reconcile", get(reconcile))
        .route("/reconcile/{case_id}", get(reconcile_case))
        .route("/injections", get(injections))
        .route("/health", get(health))
        .with_state(state);

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(&cli.web).append_index_html_on_directories(true))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(&cli.addr)
        .await
        .with_context(|| format!("绑定 {} 失败", cli.addr))?;
    println!("行情核对服务已启动：http://{}", cli.addr);
    println!("前端目录：{}", cli.web.display());
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_dataset(data: &std::path::Path) -> Result<mk_core::Dataset> {
    let meta_text = std::fs::read_to_string(data.join("dataset.json"))
        .with_context(|| format!("读取 {}/dataset.json 失败（先运行 mk gen）", data.display()))?;
    let meta: mk_core::dataset::DatasetMeta = serde_json::from_str(&meta_text)?;
    let mut messages = Vec::new();
    let msg_dir = data.join("messages");
    if msg_dir.exists() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&msg_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
            .collect();
        files.sort();
        for f in files {
            let text = std::fs::read_to_string(&f)?;
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                messages.push(serde_json::from_str::<mk_core::RawMessage>(line)?);
            }
        }
    }
    let factors = build_factors(&meta);
    Ok(mk_core::Dataset { meta, messages, factors })
}

fn build_factors(meta: &mk_core::dataset::DatasetMeta) -> Vec<(String, mk_core::FactorSet)> {
    let mut by_symbol: std::collections::BTreeMap<String, Vec<mk_core::CorporateAction>> =
        std::collections::BTreeMap::new();
    for (symbol, action) in meta.corporate_actions.iter() {
        by_symbol.entry(symbol.clone()).or_default().push(action.clone());
    }
    let days = meta.calendar.trading_days.clone();
    by_symbol
        .into_iter()
        .map(|(symbol, actions)| (symbol, mk_core::FactorSet::build(&actions, &days)))
        .collect()
}

fn load_golden(data: &std::path::Path) -> Vec<mk_sim::golden::GoldenCase> {
    let dir = data.join("golden");
    if !dir.exists() {
        return Vec::new();
    }
    let mut files: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    let mut out = Vec::new();
    for f in files {
        if let Ok(text) = std::fs::read_to_string(&f) {
            if let Ok(c) = serde_json::from_str(&text) {
                out.push(c);
            }
        }
    }
    out
}
