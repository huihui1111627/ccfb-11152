use mk_core::schedule::TradingSchedule;

#[test]
fn all_golden_cases_match() {
    let cal = TradingSchedule::default_calendar();
    let cases = mk_sim::golden::build_cases(&[], &cal);
    let rep = mk_app::reconcile::reconcile(&cases);
    for c in rep.cases.iter() {
        println!("{} {:6} {:6} {:6} bar_count={} matched={} rejected={}",
            c.id, c.status, c.period, c.symbol, c.bar_count, c.matched_bars, c.rejected_bars);
    }
    for d in rep.diffs.iter() {
        println!("DIFF {} {} {} field={} exp={} act={} :: {}",
            d.case_id, d.period, d.bar_end, d.field, d.expected, d.actual, d.reason);
    }
    assert_eq!(rep.summary.mismatched, 0, "金标准必须全部匹配");
    assert!(rep.summary.cases >= 14);
}
