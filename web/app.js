/* SWIM membership simulator — visualisation front-end.
 *
 * The Go simulator returns a fully deterministic trace:
 *   member_events : every status transition in every observer's view
 *   probes        : every completed probe attempt
 *   suspicions    : raise / shorten / clear of suspicion timers
 *   confirms      : every confirmation (with a ground-truth false-positive flag)
 *   lifecycle     : join / leave / crash / pause
 *   samples       : sampled datagrams with their piggyback payloads
 * We replay those here; no protocol logic lives in the browser.
 */
"use strict";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

const STATUS = ["alive", "suspect", "dead", "left"];
const STATUS_ZH = { alive: "存活", suspect: "怀疑", dead: "确认下线", left: "离开" };
const KIND_NAME = ["ping", "ack", "ping-req", "nack", "join", "join-ack", "leave", "revive", "revive-ack", "dead-notice"];
const UPD_NAME = ["alive", "suspect", "confirm", "leave"];

const state = {
  run: null,
  catalog: [],
  observers: [],
  observer: 0,
  scrubTime: 0,
  t0: 0,
  t1: 0,
  filter: "",
};

/* ------------------------------------------------------------------ helpers */

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const fmtTime = (ns) => (ns / 1e9).toFixed(2) + "s";
const name = (id) => "n" + String(id).padStart(3, "0");

/* Status of `target` in `observer`'s view at time t, rebuilt from the trace. */
function viewAt(observer, target, t, baseStatus = "alive") {
  // member_events are grouped per observer in emission order; we keep a
  // per-observer running snapshot updated as the scrub bar moves, but a direct
  // scan is cheap enough for the panel sizes we serve.
  let st = baseStatus;
  let inc = 0;
  const evs = state.byObserver.get(observer);
  if (evs) {
    for (const e of evs) {
      if (e.t > t) break;
      if (e.target !== target) continue;
      st = STATUS[e.to];
      inc = e.inc;
    }
  }
  return { status: st, inc };
}

/* --------------------------------------------------------------- data fetch */

async function loadCatalog() {
  const res = await fetch("/api/catalog");
  const data = await res.json();
  state.catalog = data.scenarios || [];
  const sel = $("#scenario");
  sel.innerHTML = "";
  for (const s of state.catalog) {
    const o = el("option", null, `${s.title}`);
    o.value = s.key;
    o.title = s.desc;
    sel.appendChild(o);
  }
  sel.value = "crash";
}

async function runSim() {
  const btn = $("#run");
  btn.disabled = true;
  btn.textContent = "运行中…";
  try {
    const p = new URLSearchParams({
      scenario: $("#scenario").value,
      seed: $("#seed").value || "1",
      lifeguard: $("#lifeguard").checked ? "1" : "0",
    });
    if ($("#members").value) p.set("members", $("#members").value);
    const res = await fetch("/api/run?" + p.toString());
    if (!res.ok) throw new Error(await res.text());
    const run = await res.json();
    ingest(run);
    renderAll();
  } catch (e) {
    console.error(e);
    alert("运行失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "运行";
  }
}

/* ------------------------------------------------------------------ ingest */

function ingest(run) {
  state.run = run;
  const d = run.detail || {};
  const members = run.members;

  // Per-observer event lists (they arrive sorted by time already).
  state.byObserver = new Map();
  for (const e of d.member_events || []) {
    if (!state.byObserver.has(e.observer)) state.byObserver.set(e.observer, []);
    state.byObserver.get(e.observer).push(e);
  }

  state.t0 = 0;
  state.t1 = run.duration * 1e9;
  // Default the scrubber to just after the first confirmation (or the first
  // injected fault), so the interesting moment is on screen immediately.
  state.scrubTime = state.t1;
  const firstConfirm = (d.confirms || [])[0];
  const firstInject = (d.downtime || [])[0];
  if (firstConfirm) state.scrubTime = Math.min(state.t1, firstConfirm.at + 0.5e9);
  else if (firstInject) state.scrubTime = Math.min(state.t1, firstInject.start + 1e9);
  // For stall scenarios (no downtime, but pauses), land on the first pause.
  const firstPause = (d.lifecycle || []).find((e) => e.kind === "pause");
  if (firstPause) state.scrubTime = Math.min(state.t1, firstPause.t + 2e9);

  // Ground-truth injected fault spans, keyed by member.
  state.downtime = new Map();
  for (const w of d.downtime || []) {
    if (!state.downtime.has(w.id)) state.downtime.set(w.id, []);
    state.downtime.get(w.id).push(w);
  }
  state.lifecycle = d.lifecycle || [];

  // Build the observer selector.
  const obsSel = $("#observer");
  const focusSel = $("#tl-focus");
  obsSel.innerHTML = "";
  focusSel.innerHTML = el("option", null, "全部");
  focusSel.firstChild.value = "-1";
  for (let i = 0; i < members; i++) {
    const o = el("option", null, name(i));
    o.value = i;
    obsSel.appendChild(o);
    const f = el("option", null, name(i));
    f.value = i;
    focusSel.appendChild(f);
  }
  obsSel.value = String(Math.min(7, members - 1));
  state.observer = Number(obsSel.value);

  const scrub = $("#scrub-time");
  scrub.min = 0;
  scrub.max = 1000;
  scrub.value = String(Math.round((state.scrubTime / state.t1) * 1000));
}

/* ---------------------------------------------------------------- summary */

function renderSummary() {
  const r = state.run;
  const th = r.theory || {};
  const det = r.detection_latency || {};
  $("#m-detect").textContent =
    det.n > 0 ? fmt(det.median, 2) + "s" : "无故障";
  $("#m-detect").parentElement.title = det.n > 1 ? `均值 ${fmt(det.mean)}s · P95 ${fmt(det.p95)}s` : "";
  $("#m-detect-theory").textContent =
    `理论 ≈ ${fmt(th.detection_seconds, 1)}s = 首探 ${fmt(th.first_probe_seconds, 1)}s + 怀疑计时 ${fmt(th.suspicion_seconds, 1)}s`;

  const fp = r.false_positives || 0;
  $("#m-fp").textContent = fp.toLocaleString();
  $("#m-fp").parentElement.classList.toggle("bad", fp > 0);
  $("#m-fp").parentElement.classList.toggle("good", fp === 0);
  const iso = r.isolated_confirms || 0;
  $("#m-fp-theory").textContent = iso > 0
    ? `另有 ${iso.toLocaleString()} 次分区导致的确认为真不可达`
    : `理论每周期概率 ${(th.false_pos_per_period ?? 0).toExponential(1)}`;

  const msgs = r.msgs_per_member_sec || 0;
  $("#m-msgs").textContent = fmt(msgs, 2);
  $("#m-msgs-theory").textContent = `论文: ${fmt(th.msgs_per_member_sec, 1)} 条/成员/周期`;

  const jd = r.join_latency?.n ? r.join_latency.median : null;
  const ld = r.leave_latency?.n ? r.leave_latency.median : null;
  const parts = [];
  if (jd != null) parts.push("加入 " + fmt(jd, 2) + "s");
  if (ld != null) parts.push("离开 " + fmt(ld, 2) + "s");
  $("#m-diss").textContent = parts.length ? parts.join(" / ") : "无成员变化";

  $("#m-iso").textContent = (r.isolated_confirms || 0).toLocaleString();

  $("#digest").textContent = "digest " + (r.digest || "").slice(0, 32);
}

/* ------------------------------------------------------------ member table */

function renderMembers() {
  const r = state.run;
  const t = state.scrubTime;
  const obs = state.observer;
  const grid = $("#member-grid");
  grid.innerHTML = "";

  const frag = document.createDocumentFragment();
  const counts = { alive: 0, suspect: 0, dead: 0, left: 0 };
  const filter = state.filter.toLowerCase();

  for (let i = 0; i < r.members; i++) {
    const v = viewAt(obs, i, t);
    counts[v.status]++;
    if (filter && !name(i).includes(filter) && String(i) !== filter) continue;

    const cell = el("div", "cell " + v.status);
    if (i === obs) cell.classList.add("self");
    cell.appendChild(el("div", "id", name(i)));
    cell.appendChild(el("div", "inc", "@" + v.inc));

    // Ground-truth injection marker.
    const spans = state.downtime.get(i);
    if (spans) {
      for (const w of spans) {
        if (t >= w.start && t < w.end) {
          cell.classList.add("injected");
          cell.appendChild(el("div", "tag", w.leave ? "已离场" : "注入故障"));
          break;
        }
      }
    }
    cell.title =
      `${name(i)} · 观察者 ${name(obs)} 眼中: ${STATUS_ZH[v.status]}\n` +
      `化身号 @${v.inc}`;
    frag.appendChild(cell);
  }
  grid.appendChild(frag);

  $("#view-counts").innerHTML =
    `<span>存活 <b>${counts.alive}</b></span>` +
    `<span>怀疑 <b>${counts.suspect}</b></span>` +
    `<span>确认下线 <b>${counts.dead}</b></span>` +
    `<span>离开 <b>${counts.left}</b></span>`;
  $("#scrub-label").textContent = fmtTime(t);
}

/* ---------------------------------------------------------- probe timeline */

function renderTimeline() {
  const canvas = $("#timeline-canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const r = state.run;
  const probes = (r.detail?.probes || []);
  const focus = Number($("#tl-focus").value);
  const focusId = focus < 0 ? 0 : focus;
  const win = Number($("#tl-window").value) * 1e9;
  const tEnd = state.t1;
  const tStart = Math.max(0, tEnd - win);

  // Probes initiated by the selected member inside the window, oldest first.
  const mine = probes
    .filter((p) => p.initiator === focusId && p.end >= tStart && p.start <= tEnd)
    .sort((a, b) => a.start - b.start);

  const padL = 64, padR = 20, padT = 16, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const sx = (t) => padL + ((Math.min(Math.max(t, tStart), tEnd) - tStart) / (tEnd - tStart)) * plotW;

  // Grid & time axis.
  ctx.strokeStyle = "#2b3442";
  ctx.fillStyle = "#8b98a8";
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.lineWidth = 1;
  const tickStep = Math.max(1, Math.round(win / 1e9 / 7));
  for (let s = Math.ceil(tStart / 1e9); s <= tEnd / 1e9; s++) {
    const x = sx(s * 1e9);
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (s % tickStep === 0) ctx.fillText(s + "s", x - 9, H - 8);
  }
  ctx.fillStyle = "#8b98a8";
  ctx.fillText("发起者 " + name(focusId), 6, padT + 10);

  if (!mine.length) {
    ctx.fillStyle = "#6e7681";
    ctx.font = "13px -apple-system, sans-serif";
    ctx.fillText("该成员在所选窗口内没有探测记录", padL + 20, padT + plotH / 2);
    return;
  }

  const maxRows = Math.max(1, Math.floor(plotH / 12));
  const shown = mine.slice(-maxRows);
  const rowH = plotH / shown.length;

  for (let i = 0; i < shown.length; i++) {
    const p = shown[i];
    const y = padT + i * rowH + rowH / 2;
    const x0 = sx(p.start);
    const x1 = Math.max(x0 + 2, sx(p.end));
    let color = "#3fb950", label = "直接";
    if (p.outcome === "timeout") { color = "#f85149"; label = "超时"; }
    else if (p.relays && p.relays.length) { color = "#e3b341"; label = "间接"; }

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1.5, rowH * 0.42);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Target label at the bar's end.
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#c9d1d9";
    ctx.fillText(name(p.target), x1 + 4, y + 3);

    // Indirect fan-out.
    if (p.outcome === "timeout" && p.relays && p.relays.length) {
      ctx.strokeStyle = "#e3b341";
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      for (const rl of p.relays.slice(0, 6)) {
        const yy = padT + ((rl % 5) - 2) * (rowH / 5) + y;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, yy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#e3b341";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText("ping-req×" + p.relays.length, x1 + 52, y + 3);
    }
    timelineHits.push({ x: (x0 + x1) / 2, y, r: Math.max(4, rowH / 2), info: p });
  }

  // Scrub cursor.
  if (state.scrubTime >= tStart && state.scrubTime <= tEnd) {
    const x = sx(state.scrubTime);
    ctx.strokeStyle = "#58a6ff";
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

let timelineHits = [];

function wireTimelineTooltip() {
  const canvas = $("#timeline-canvas");
  const tip = $("#tl-tooltip");
  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    let best = null, bestD = 64;
    for (const h of timelineHits) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best) { tip.style.display = "none"; return; }
    const p = best.info;
    const lines = [
      `${name(p.initiator)} → ${name(p.target)}`,
      `${p.outcome}${p.relays && p.relays.length ? " · 经 " + p.relays.map(name).join(",") : ""}`,
      `耗时 ${((p.end - p.start) / 1e6).toFixed(1)}ms`,
      p.nacks ? `nack ${p.nacks}` : "",
    ].filter(Boolean);
    tip.textContent = lines.join("\n");
    tip.style.display = "block";
    tip.style.left = ev.clientX + 14 + "px";
    tip.style.top = ev.clientY + 12 + "px";
  });
  canvas.addEventListener("mouseleave", () => { $("#tl-tooltip").style.display = "none"; });
}

/* ------------------------------------------------------------- event lists */

function renderEvents() {
  const r = state.run;
  const d = r.detail || {};
  const tEnd = state.t1;

  // Show a window around the scrubber so the tab follows the member table.
  const winStart = Math.max(0, state.scrubTime - 12e9);
  const winEnd = Math.min(state.t1, state.scrubTime + 2e9);
  const inWindow = (t) => t >= winStart && t <= winEnd;

  // Suspicion list: newest first, capped.
  const susp = (d.suspicions || []).filter((e) => inWindow(e.at));
  const list = $("#suspicion-list");
  list.innerHTML = "";
  const shown = susp.slice(-140).reverse();
  if (!shown.length) {
    list.appendChild(el("div", "empty",
      "所选时间窗内没有怀疑计时器。对「间歇拥塞」场景,这意味着卡顿的成员在怀疑时限内被探活,没有被误判——正是 Lifeguard 要达到的效果。"));
  }
  for (const e of shown) {
    const row = el("div", "ev");
    row.appendChild(el("span", "t", fmtTime(e.at)));
    row.appendChild(el("span", "kind " + e.kind, e.kind === "raised" ? "怀疑" : e.kind === "shortened" ? "缩短" : "澄清"));
    let body;
    if (e.kind === "cleared") {
      body = `${name(e.observer)} 对 ${name(e.target)} 的怀疑被 ${e.cause === "ack" ? "探测应答" : e.cause === "alive" ? "存活消息" : e.cause} 澄清`;
    } else {
      body = `${name(e.observer)} ${e.kind === "raised" ? "怀疑" : "继续怀疑"} ${name(e.target)} (inc @${e.inc})`;
    }
    row.appendChild(el("span", "body", body));
    if (e.timeout) row.appendChild(el("span", "extra", `计时 ${fmt(e.timeout, 2)}s · 独立 ${e.independent}`));
    list.appendChild(row);
  }

  // Confirmations.
  const confirms = (d.confirms || []).filter((c) => inWindow(c.at));
  const cList = $("#confirm-list");
  cList.innerHTML = "";
  const cShown = confirms.slice(-120).reverse();
  if (!cShown.length) cList.appendChild(el("div", "empty", "所选时间窗内没有确认下线事件。"));
  for (const c of cShown) {
    const fp = !c.true_down && !c.isolated;
    const row = el("div", "ev" + (fp ? " fp" : ""));
    row.appendChild(el("span", "t", fmtTime(c.at)));
    row.appendChild(el("span", "kind confirm", c.kind === "left" ? "离开" : "下线"));
    row.appendChild(el("span", "body",
      `${name(c.observer)} 确认 ${name(c.target)} ${c.kind === "left" ? "主动离开" : "下线"} (inc @${c.target_inc})`));
    const extra = el("span", "extra", c.isolated ? "分区内" : c.cause);
    row.appendChild(extra);
    if (fp) row.appendChild(el("span", "fp-badge", "误判"));
    cList.appendChild(row);
  }

  renderConfirmChart((d.confirms || []).filter((c) => c.at <= tEnd));
}

function renderConfirmChart(confirms) {
  const canvas = $("#confirm-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const dur = state.run.duration;
  const bins = new Array(Math.ceil(dur) + 1).fill(0);
  const fpBins = new Array(bins.length).fill(0);
  const isoBins = new Array(bins.length).fill(0);
  for (const c of confirms) {
    const s = Math.floor(c.at / 1e9);
    if (s < 0 || s >= bins.length) continue;
    if (!c.true_down && !c.isolated) fpBins[s]++;
    else if (c.isolated) isoBins[s]++;
    else bins[s]++;
  }
  const maxV = Math.max(1, ...bins, ...fpBins, ...isoBins);
  const padL = 30, padB = 18, padT = 8;
  const plotW = W - padL - 8, plotH = H - padT - padB;
  const bw = plotW / bins.length;

  ctx.fillStyle = "#8b98a8";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(String(maxV), 4, padT + 8);
  ctx.fillText("0", 4, padT + plotH);

  for (let i = 0; i < bins.length; i++) {
    const x = padL + i * bw;
    let y = padT + plotH;
    const stack = [
      [bins[i], "#3fb950"],
      [isoBins[i], "#6e7681"],
      [fpBins[i], "#f85149"],
    ];
    for (const [v, col] of stack) {
      if (!v) continue;
      const h = (v / maxV) * plotH;
      ctx.fillStyle = col;
      ctx.fillRect(x + 0.5, y - h, Math.max(1, bw - 1), h);
      y -= h;
    }
  }
  ctx.strokeStyle = "#2b3442";
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  ctx.fillStyle = "#8b98a8";
  for (let s = 0; s < bins.length; s += Math.max(1, Math.round(bins.length / 8))) {
    ctx.fillText(s + "s", padL + s * bw, H - 4);
  }
}

/* --------------------------------------------------- traffic and samples */

function renderMessages() {
  const r = state.run;
  const d = r.detail || {};

  // Traffic chart.
  const canvas = $("#traffic-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const traffic = (r.traffic || []).slice(0, Math.floor(r.duration) + 1);
  const maxMsgs = Math.max(1, ...traffic.map((t) => t.msgs));
  const padL = 38, padB = 18, padT = 8;
  const plotW = W - padL - 10, plotH = H - padT - padB;
  const bw = plotW / Math.max(1, traffic.length);

  ctx.fillStyle = "#8b98a8";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(maxMsgs.toLocaleString(), 4, padT + 8);
  for (let i = 0; i < traffic.length; i++) {
    const h = (traffic[i].msgs / maxMsgs) * plotH;
    ctx.fillStyle = "#58a6ff";
    ctx.globalAlpha = 0.75;
    ctx.fillRect(padL + i * bw + 0.5, padT + plotH - h, Math.max(1, bw - 1), h);
  }
  ctx.globalAlpha = 1;
  // Theory line: 2 msgs/member/period.
  const theory = (r.theory?.msgs_per_member_sec || 0) * r.members;
  if (theory > 0) {
    const y = padT + plotH - (theory / maxMsgs) * plotH;
    ctx.strokeStyle = "#e3b341";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#e3b341";
    ctx.fillText("理论 " + Math.round(theory), padL + 4, y - 4);
  }
  ctx.fillStyle = "#8b98a8";
  for (let s = 0; s < traffic.length; s += Math.max(1, Math.round(traffic.length / 8))) {
    ctx.fillText(s + "s", padL + s * bw, H - 4);
  }

  // Drop / overhead stats.
  const stats = [
    ["消息总数", r.msgs_sent.toLocaleString()],
    ["字节总数", (r.bytes_sent / 1e6).toFixed(1) + " MB"],
    ["每台每秒字节", fmt(r.bytes_per_member_sec, 0)],
    ["丢包(随机)", r.drop_loss.toLocaleString()],
    ["丢包(分区)", r.drop_partition.toLocaleString()],
    ["因报文上限截断", r.truncations.toLocaleString()],
    ["化身号反驳", r.refutations.toLocaleString()],
    ["探测总数", r.probes.toLocaleString()],
  ];
  const box = $("#drop-stats");
  box.innerHTML = "";
  for (const [k, v] of stats) {
    const s = el("div", "s");
    s.appendChild(el("div", "k", k));
    s.appendChild(el("div", "v", v));
    box.appendChild(s);
  }

  // Message samples.
  const list = $("#sample-list");
  list.innerHTML = "";
  const samples = (d.samples || []).slice(-120).reverse();
  if (!samples.length) list.appendChild(el("div", "empty", "本次运行未采集到数据报样本。"));
  for (const s of samples) {
    const row = el("div", "sample");
    const full = s.budget > 0 && s.backlog > s.carried;
    if (full) row.classList.add("full");
    const top = el("div", "top");
    top.appendChild(el("span", "k", KIND_NAME[s.kind] || "?"));
    top.appendChild(el("span", "arrows", `${name(s.from)} → ${name(s.to)}`));
    top.appendChild(el("span", "size", `${s.size}B / ${s.budget}B 上限`));
    row.appendChild(top);
    const pig = el("div", "piggy");
    for (const u of s.piggy || []) {
      const t = el("span", "tag " + UPD_NAME[u.kind], `${UPD_NAME[u.kind]} ${name(u.about)}@${u.inc}`);
      t.title = `来源 ${name(u.source)} · 传播次数 ${u.transmit}`;
      pig.appendChild(t);
    }
    if ((s.piggy || []).length === 0) pig.appendChild(el("span", "tag", "无捎带"));
    row.appendChild(pig);
    if (full) {
      const meta = el("div", "meta",
        `捎带 ${s.carried} 条,已满;传播次数少的条目优先,其余留待后续报文`);
      row.appendChild(meta);
    }
    list.appendChild(row);
  }
}

/* ---------------------------------------------------------------- render all */

function renderAll() {
  if (!state.run) return;
  renderSummary();
  renderMembers();
  timelineHits = [];
  renderTimeline();
  renderEvents();
  renderMessages();
}

/* --------------------------------------------------------------- wiring */

function wireTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#panel-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "timeline") renderTimeline();
      if (tab.dataset.tab === "messages") renderMessages();
    });
  }
}

function wireControls() {
  $("#run").addEventListener("click", runSim);
  $("#scenario").addEventListener("change", () => {
    const s = state.catalog.find((x) => x.key === $("#scenario").value);
    if (s) $("#members").placeholder = s.members;
  });
  $("#observer").addEventListener("change", () => {
    state.observer = Number($("#observer").value);
    renderMembers();
  });
  $("#scrub-time").addEventListener("input", (e) => {
    const frac = Number(e.target.value) / 1000;
    state.scrubTime = state.t0 + frac * (state.t1 - state.t0);
    renderMembers();
    renderTimeline();
    renderEvents();
  });
  $("#member-filter").addEventListener("input", (e) => {
    state.filter = e.target.value.trim();
    renderMembers();
  });
  $("#tl-window").addEventListener("change", renderTimeline);
  $("#tl-focus").addEventListener("change", renderTimeline);
  window.addEventListener("resize", () => {
    renderTimeline();
    renderEvents();
    renderMessages();
  });
  wireTimelineTooltip();
}

function selectTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("active", on);
    $("#panel-" + tab.dataset.tab).classList.toggle("active", on);
  }
  if (name === "timeline") renderTimeline();
  if (name === "messages") renderMessages();
}

async function boot() {
  wireTabs();
  wireControls();
  await loadCatalog();
  await runSim();
  // Allow deep links like /?tab=messages&scenario=slow for screenshots/tests.
  const q = new URLSearchParams(location.search);
  if (q.get("scenario")) {
    $("#scenario").value = q.get("scenario");
    if (q.get("seed")) $("#seed").value = q.get("seed");
    if (q.get("lifeguard") === "0") $("#lifeguard").checked = false;
    await runSim();
  }
  if (q.get("tab")) selectTab(q.get("tab"));
}

boot();
