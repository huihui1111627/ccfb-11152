//! 端到端 API 测试：直接调用 mk-app 的载荷构造函数（HTTP 层只是薄封装）。

use mk_app::Analysis;

fn load() -> Option<Analysis> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/sim");
    if !dir.join("dataset.json").exists() {
        return None;
    }
    let meta: mk_core::dataset::DatasetMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("dataset.json")).unwrap()).unwrap();
    let mut messages = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(dir.join("messages"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    files.sort();
    for f in files {
        let t = std::fs::read_to_string(&f).unwrap();
        for l in t.lines() {
            if !l.trim().is_empty() {
                messages.push(serde_json::from_str::<mk_core::RawMessage>(l).unwrap());
            }
        }
    }
    let mut by_symbol: std::collections::BTreeMap<String, Vec<mk_core::CorporateAction>> =
        Default::default();
    for (sym, act) in meta.corporate_actions.iter() {
        by_symbol.entry(sym.clone()).or_default().push(act.clone());
    }
    let factors = by_symbol
        .into_iter()
        .map(|(s, a)| (s, mk_core::FactorSet::build(&a, &meta.calendar.trading_days)))
        .collect();
    let ds = mk_core::Dataset { meta, messages, factors };
    Some(Analysis::build(ds, Vec::new()).expect("build"))
}

#[test]
fn api_payloads_are_well_formed() {
    let Some(a) = load() else {
        eprintln!("跳过：data/sim 未生成");
        return;
    };
    let meta = a.meta();
    assert!(!meta.instruments.is_empty());
    assert_eq!(meta.periods.len(), 6);

    let sym = meta.instruments[0].symbol.clone();
    let day = meta.trading_days[1].clone();

    let s = a.sessions(&sym, Some(&day)).unwrap();
    assert!(!s.segments.is_empty());
    assert_eq!(s.trade_date, day);

    let bars = a.bars(&sym, "1m", Some(&day), None, None, "none", Some(50)).unwrap();
    assert!(!bars.bars.is_empty());
    assert!(bars.bars.len() <= 50);
    for w in bars.bars.windows(2) {
        assert!(w[0].t <= w[1].t);
    }
    for (i, b) in bars.bars.iter().enumerate() {
        assert_eq!(b.i, i);
    }

    let rep = a.replay(&sym, Some(&day)).unwrap();
    assert!(!rep.grids.is_empty());
    assert_eq!(rep.trade_date, day);

    let f = a.factors(&sym).unwrap();
    assert_eq!(f.asset, "equity");

    let an = a.anomalies(None, Some(&sym), None, None, 100);
    assert!(an.total >= an.items.len().min(100));

    let src = a.sources(Some(&sym));
    assert_eq!(src.items.len(), 2, "A/B 两个源");

    let cons = a.consistency();
    assert_eq!(cons.summary.failed, 0, "跨周期必须一致");

    let cont = a.continuous("rb", "1d").unwrap();
    assert!(!cont.main.is_empty());
}

#[test]
fn futures_reject_adjust() {
    let Some(a) = load() else { return; };
    let err = a
        .bars("rb2601", "1m", None, None, None, "forward", Some(10))
        .unwrap_err();
    assert!(err.to_string().contains("adjust_not_supported"));
}

#[test]
fn unknown_symbol_is_error() {
    let Some(a) = load() else { return; };
    assert!(a.bars("NOPE", "1m", None, None, None, "none", None).is_err());
    assert!(a.sessions("NOPE", None).is_err());
}

#[test]
fn adjust_prices_differ_from_raw() {
    let Some(a) = load() else { return; };
    let day = a.meta().trading_days[0].clone();
    let raw = a.bars("600000.SH", "1d", Some(&day), None, None, "none", None).unwrap();
    let fwd = a.bars("600000.SH", "1d", Some(&day), None, None, "forward", None).unwrap();
    if let (Some(r), Some(f)) = (raw.bars.first(), fwd.bars.first()) {
        assert!(f.c < r.c, "除权前的前复权价应低于原始价: {} vs {}", f.c, r.c);
        assert_eq!(f.v, r.v, "成交量不复权");
    }
}

#[test]
fn continuous_has_roll_and_adjustment() {
    let Some(a) = load() else { return; };
    let cont = a.continuous("rb", "1d").unwrap();
    assert!(!cont.main.is_empty());
    if !cont.rolls.is_empty() {
        let r = &cont.rolls[0];
        assert_ne!(r.from, r.to);
        assert!(r.ratio > 0);
    }
    // 复权价必须连续：相邻两日 o_adj 相对前一日 c_adj 的跳空应在合理范围内
    for w in cont.bars.windows(2) {
        let prev = mk_core::fixed::round4(w[0].c_adj_fixed);
        let cur = mk_core::fixed::round4(w[1].o_adj);
        if prev > 0.0 {
            let jump = (cur / prev - 1.0).abs();
            assert!(jump < 0.15, "连续合约复权后在切换处应平滑，实际跳空 {:.2}%", jump * 100.0);
        }
    }
}
