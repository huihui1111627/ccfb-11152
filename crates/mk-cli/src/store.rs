//! 数据集读写与派生产物（bars/anomalies/reconcile）。

use anyhow::{Context, Result};
use mk_core::dataset::DatasetMeta;
use mk_core::{Dataset, FactorSet, RawMessage};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 数据目录结构：
/// ```text
/// data/<name>/
///   dataset.json
///   messages/<symbol>.jsonl
///   golden/<case_id>.json
///   derived.json      (引擎输出缓存)
/// ```
#[derive(Debug, Clone)]
pub struct DataDir {
    pub root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self { root: root.as_ref().to_path_buf() }
    }

    pub fn dataset_json(&self) -> PathBuf {
        self.root.join("dataset.json")
    }
    pub fn messages_dir(&self) -> PathBuf {
        self.root.join("messages")
    }
    pub fn golden_dir(&self) -> PathBuf {
        self.root.join("golden")
    }
    pub fn derived_json(&self) -> PathBuf {
        self.root.join("derived.json")
    }

    pub fn save_sim(&self, out: &mk_sim::sim::SimOutput) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(self.messages_dir())?;
        std::fs::create_dir_all(self.golden_dir())?;
        let meta = serde_json::to_string_pretty(&out.meta)?;
        std::fs::write(self.dataset_json(), meta).context("write dataset.json")?;
        for (symbol, text) in out.messages_by_symbol.iter() {
            let name = symbol.replace(['/', '.'], "_");
            std::fs::write(self.messages_dir().join(format!("{}.jsonl", name)), text)
                .with_context(|| format!("write messages for {}", symbol))?;
        }
        for case in out.golden.iter() {
            let text = serde_json::to_string_pretty(case)?;
            std::fs::write(self.golden_dir().join(format!("{}.json", case.id)), text)?;
        }
        Ok(())
    }

    pub fn load_meta(&self) -> Result<DatasetMeta> {
        let text = std::fs::read_to_string(self.dataset_json()).context("read dataset.json")?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn load(&self) -> Result<Dataset> {
        let meta = self.load_meta()?;
        let mut messages: Vec<RawMessage> = Vec::new();
        if self.messages_dir().exists() {
            let mut files: Vec<PathBuf> = std::fs::read_dir(self.messages_dir())?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
                .collect();
            files.sort();
            for f in files {
                let text = std::fs::read_to_string(&f)
                    .with_context(|| format!("read {}", f.display()))?;
                for (lineno, line) in text.lines().enumerate() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let m: RawMessage = serde_json::from_str(line).with_context(|| {
                        format!("{}:{} 解析失败", f.display(), lineno + 1)
                    })?;
                    messages.push(m);
                }
            }
        }
        let factors = build_factors(&meta);
        Ok(Dataset { meta, messages, factors })
    }

    pub fn load_golden(&self) -> Result<Vec<mk_sim::golden::GoldenCase>> {
        let dir = self.golden_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        files.sort();
        let mut out = Vec::new();
        for f in files {
            let text = std::fs::read_to_string(&f)?;
            out.push(serde_json::from_str(&text).with_context(|| format!("parse {}", f.display()))?);
        }
        Ok(out)
    }

    pub fn save_derived<T: Serialize>(&self, v: &T) -> Result<()> {
        let text = serde_json::to_string(v)?;
        std::fs::write(self.derived_json(), text)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn load_derived<T: for<'de> Deserialize<'de>>(&self) -> Result<T> {
        let text = std::fs::read_to_string(self.derived_json())?;
        Ok(serde_json::from_str(&text)?)
    }
}

/// 根据除权事件构造每品种的因子表。
pub fn build_factors(meta: &DatasetMeta) -> Vec<(String, FactorSet)> {
    let mut by_symbol: BTreeMap<String, Vec<mk_core::factor::CorporateAction>> = BTreeMap::new();
    for (symbol, action) in meta.corporate_actions.iter() {
        by_symbol.entry(symbol.clone()).or_default().push(action.clone());
    }
    let days = meta.calendar.trading_days.clone();
    by_symbol
        .into_iter()
        .map(|(symbol, actions)| {
            // 因子只对股票有意义
            let set = FactorSet::build(&actions, &days);
            (symbol, set)
        })
        .collect()
}
