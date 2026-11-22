// 容器资源规格推荐器可视化：原生 JS + 内联 SVG，无外部依赖。
const NS = "http://www.w3.org/2000/svg";
const MiB = 1024 * 1024;

const state = {
  overview: null,
  selected: null,
  detail: null,
  view: "timeline",
  filter: "",
  sortBy: "oom",
};

const el = (id) => document.getElementById(id);

function fmtCores(v) {
  if (v == null) return "-";
  return (v).toFixed(3) + " 核";
}
function fmtMiB(v) {
  if (v == null) return "-";
  return (v / MiB).toFixed(0) + " MiB";
}
function fmtClock(sec, startSec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return `第${d}天 ${String(h).padStart(2, "0")}时`;
}
function profileLabel(p) {
  return { stable: "平稳", daily: "日周期", burst: "突发", oom: "内存被杀" }[p] || p;
}

async function init() {
  state.overview = await fetch("/api/overview").then((r) => r.json());
  renderStatBar();
  renderContainerList();
  el("profileFilter").onchange = (e) => { state.filter = e.target.value; renderContainerList(); };
  el("sortBy").onchange = (e) => { state.sortBy = e.target.value; renderContainerList(); };
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      state.view = t.dataset.view;
      renderDetail();
    };
  });
}

function renderStatBar() {
  const s = state.overview.stats;
  const items = [
    ["容器数量", s.containerCount, ""],
    ["模拟天数", s.durationDays.toFixed(0) + " 天", ""],
    ["CPU 请求节省", s.cpuSavedCores.toFixed(1) + " 核", "good"],
    ["CPU 节省比例", s.cpuSavedPercent.toFixed(1) + "%", "good"],
    ["内存请求节省", (s.memSavedBytes / MiB / 1024).toFixed(1) + " GiB", "good"],
    ["内存节省比例", s.memSavedPercent.toFixed(1) + "%", "good"],
    ["基线 OOM 总数", s.totalBaselineOom, "warn"],
    ["治理后实际 OOM", s.totalActualOom, s.totalActualOom ? "bad" : "good"],
    ["被避免的 OOM", s.totalPreventedOom + "（" + s.oomReductionPercent.toFixed(1) + "%）", "good"],
    ["推荐调整次数", s.recommendationEvents, ""],
  ];
  el("statBar").innerHTML = items
    .map(([k, v, cls]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`)
    .join("");
}

function renderContainerList() {
  let list = state.overview.containers.slice();
  if (state.filter) list = list.filter((c) => c.profile === state.filter);
  if (state.sortBy === "oom") list.sort((a, b) => b.oomCount - a.oomCount || b.recommendChanges - a.recommendChanges);
  if (state.sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (state.sortBy === "profile") list.sort((a, b) => a.profile.localeCompare(b.profile));

  el("containerRows").innerHTML = list
    .map((c) => `
      <tr class="container-row ${state.selected === c.id ? "active" : ""}" data-id="${c.id}">
        <td>${c.name}<div class="muted" style="font-size:11px">${c.id}</div></td>
        <td><span class="badge ${c.profile}">${profileLabel(c.profile)}</span></td>
        <td>${fmtCores(c.cpuRequest)}</td>
        <td>${fmtMiB(c.memRequest)}</td>
        <td>${c.oomCount ? `<span class="oom-pill">${c.oomCount}</span>` : '<span class="muted">0</span>'}</td>
      </tr>`)
    .join("");
  document.querySelectorAll("tr.container-row").forEach((tr) => {
    tr.onclick = () => selectContainer(tr.dataset.id);
  });
}

async function selectContainer(id) {
  state.selected = id;
  renderContainerList();
  state.detail = await fetch("/api/container?id=" + encodeURIComponent(id)).then((r) => r.json());
  el("detailTitle").textContent = `${state.detail.name}（${state.detail.id}）· ${profileLabel(state.detail.profile)}`;
  renderDetail();
}

function renderDetail() {
  if (!state.detail) return;
  const body = el("detailBody");
  if (state.view === "timeline") body.innerHTML = renderTimeline(state.detail);
  if (state.view === "histogram") body.innerHTML = renderHistogramView(state.detail);
  if (state.view === "oom") body.innerHTML = renderOOMView(state.detail);
}

/* ---------- SVG 通用工具 ---------- */
function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function makeSVG(width, height) {
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  return svg;
}

/* ---------- 视图一：推荐值与上下限随时间变化 ---------- */
function renderTimeline(d) {
  const tl = d.timeline;
  if (!tl.length) return '<div class="empty">暂无时间线数据</div>';
  const W = 900, H = 260, padL = 64, padR = 16, padT = 14, padB = 34;
  const t0 = tl[0].atSec, t1 = tl[tl.length - 1].atSec;
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);

  function chart(metric, title, fmt, color) {
    const prefix = metric === "CPU" ? "cpu" : "mem";
    const keys = {
      current: prefix + "Current", target: prefix + "Target",
      lower: prefix + "Lower", upper: prefix + "Upper", usage: prefix + "Usage",
    };
    let max = 1e-9;
    tl.forEach((p) => {
      [keys.current, keys.target, keys.upper, keys.usage].forEach((k) => { if (p[k] > max) max = p[k]; });
    });
    max *= 1.08;
    const y = (v) => H - padB - (v / max) * (H - padT - padB);

    const wrap = document.createElement("div");
    wrap.innerHTML = `<h2 style="margin:6px 0">${title}</h2>`;
    const svg = makeSVG(W, H);

    // 网格 + Y 轴刻度。
    for (let i = 0; i <= 4; i++) {
      const gv = (max * i) / 4;
      const gy = y(gv);
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, stroke: "#2d3a48", "stroke-dasharray": "3 3" }));
      const txt = svgEl("text", { x: padL - 6, y: gy + 3, "text-anchor": "end", fill: "#8b98a5", "font-size": 10 });
      txt.textContent = fmt(gv);
      svg.appendChild(txt);
    }
    // X 轴时间刻度。
    for (let i = 0; i <= 5; i++) {
      const tv = t0 + ((t1 - t0) * i) / 5;
      const gx = x(tv);
      const txt = svgEl("text", { x: gx, y: H - padB + 16, "text-anchor": "middle", fill: "#8b98a5", "font-size": 10 });
      txt.textContent = fmtClock(tv, d.startSec);
      svg.appendChild(txt);
    }

    const line = (key, stroke, width, dash) => {
      const pts = tl.map((p) => `${x(p.atSec)},${y(p[key])}`).join(" ");
      svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke, "stroke-width": width, "stroke-dasharray": dash || "" }));
    };
    // 上下限区间填充。
    const areaPts =
      tl.map((p) => `${x(p.atSec)},${y(p[keys.upper])}`).join(" ") + " " +
      tl.slice().reverse().map((p) => `${x(p.atSec)},${y(p[keys.lower])}`).join(" ");
    svg.appendChild(svgEl("polygon", { points: areaPts, fill: color, "fill-opacity": 0.12 }));
    line(keys.usage, "#8b98a5", 1, "2 3");       // 实际用量
    line(keys.lower, color, 1, "5 4");           // 下限
    line(keys.upper, color, 1, "5 4");           // 上限
    line(keys.target, color, 2);                 // 推荐目标
    line(keys.current, "#bc8cff", 2);            // 当前请求

    // 标记截断点与 OOM 驱动点。
    const capKey = metric === "CPU" ? "cpuCapped" : "memCapped";
    const oomKey = metric === "CPU" ? null : "memOomDriven";
    tl.forEach((p) => {
      if (p[capKey]) svg.appendChild(svgEl("circle", { cx: x(p.atSec), cy: y(p[keys.target]), r: 3, fill: "#e3a008" }));
      if (oomKey && p[oomKey]) svg.appendChild(svgEl("circle", { cx: x(p.atSec), cy: y(p[keys.target]), r: 3.5, fill: "#f85149" }));
    });

    wrap.appendChild(svg);
    wrap.innerHTML += `
      <div class="legend">
        <span><i style="background:#bc8cff"></i>当前请求</span>
        <span><i style="background:${color}"></i>推荐目标</span>
        <span><i style="background:${color};opacity:.5"></i>上下限区间</span>
        <span><i style="background:#8b98a5"></i>实际用量</span>
        <span style="color:#e3a008">● 节点上限截断</span>
        ${oomKey ? '<span style="color:#f85149">● OOM 驱动上调</span>' : ""}
      </div>`;
    return wrap;
  }

  const host = document.createElement("div");
  host.appendChild(chart("CPU", "处理器：推荐请求值与上下限（核）", (v) => v.toFixed(2), "#4da3ff"));
  host.appendChild(chart("Mem", "内存：推荐请求值与上下限（MiB）", (v) => (v / MiB).toFixed(0), "#39c5cf"));
  const wrap = document.createElement("div");
  wrap.className = "chart-box";
  wrap.appendChild(host);
  return wrap.outerHTML;
}

/* ---------- 视图二：用量直方图 ---------- */
function renderHistogramView(d) {
  function histChart(buckets, title, fmt, color) {
    if (!buckets.length) return `<h2>${title}</h2><div class="empty">暂无样本</div>`;
    const W = 900, H = 240, padL = 64, padR = 16, padT = 14, padB = 40;
    const maxW = Math.max(...buckets.map((b) => b.weight));
    const bw = (W - padL - padR) / buckets.length;
    const y = (w) => H - padB - (w / maxW) * (H - padT - padB);
    const svg = makeSVG(W, H);
    buckets.forEach((b, i) => {
      const bx = padL + i * bw;
      const by = y(b.weight);
      svg.appendChild(svgEl("rect", {
        x: bx + 1, y: by, width: Math.max(1, bw - 2), height: H - padB - by,
        fill: color, "fill-opacity": 0.75,
      }));
      const title = svgEl("title", {});
      title.textContent = `区间 [${fmt(b.lower)}, ${fmt(b.upper)})  有效权重 ${b.weight.toFixed(3)}`;
      svg.lastChild.appendChild(title);
    });
    // X 轴：桶按指数增长，标注首/中/尾桶下界。
    [0, Math.floor(buckets.length / 2), buckets.length - 1].forEach((i) => {
      const b = buckets[i];
      const gx = padL + i * bw + bw / 2;
      const txt = svgEl("text", { x: gx, y: H - padB + 16, "text-anchor": "middle", fill: "#8b98a5", "font-size": 10 });
      txt.textContent = fmt(b.lower);
      svg.appendChild(txt);
    });
    const axis = svgEl("line", { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, stroke: "#2d3a48" });
    svg.appendChild(axis);
    return `<h2>${title}</h2>${svg.outerHTML}
      <div class="note">桶宽按指数增长（因子见配置），柱高为时间衰减后的有效权重；悬停查看区间与权重。共 ${buckets.length} 个非空桶。</div>`;
  }
  return `<div class="chart-box">
    ${histChart(d.cpuHistogram, "处理器用量直方图（核）", (v) => v.toFixed(3), "#4da3ff")}
    ${histChart(d.memHistogram, "内存用量直方图（MiB，每聚合周期峰值一个样本）", (v) => (v / MiB).toFixed(0), "#39c5cf")}
  </div>`;
}

/* ---------- 视图三：内存被杀事件 ---------- */
function renderOOMView(d) {
  const ooms = d.ooms || [];
  if (!ooms.length) return '<div class="empty">该容器没有发生内存不足事件</div>';
  const rows = ooms
    .slice()
    .sort((a, b) => a.atSec - b.atSec)
    .map((e) => `
      <div class="oom-item ${e.prevented ? "prevented" : "actual"}">
        <div>
          <strong>${e.prevented ? "已被推荐避免（基线世界）" : "实际 OOM 被杀"}</strong>
          <div class="muted">${fmtClock(e.atSec, d.startSec)}</div>
        </div>
        <div style="text-align:right">
          <div>当时用量 ${fmtMiB(e.usage)}</div>
          <div class="muted">放大样本 ${fmtMiB(e.amplified)}（记入直方图）</div>
        </div>
      </div>`)
    .join("");
  const actual = ooms.filter((e) => !e.prevented).length;
  const prevented = ooms.filter((e) => e.prevented).length;
  return `
    <div class="note" style="margin-bottom:8px">实际被杀 <span class="oom-flag">${actual}</span> 次，
      被推荐提前避免 <span style="color:var(--green);font-weight:600">${prevented}</span> 次。
      每次实际 OOM 都会把放大后的用量作为样本记入，保证下次内存推荐更大。</div>
    <div class="oom-list">${rows}</div>`;
}

init().catch((e) => {
  document.body.insertAdjacentHTML("afterbegin", `<div style="padding:20px;color:#f85149">加载失败：${e}</div>`);
});
