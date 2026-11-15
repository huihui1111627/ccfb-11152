// 行情加工与核对 — 前端应用
// 数据约定：所有时间戳都是"本地时间戳"（本地时间当作 UTC），用 getUTC* 提取。

(function () {
'use strict';

const { fmtTime, fmtTsMs, drawCandles, drawReplay } = window.MKChart;

// ------------------------------------------------------------------ state
const S = {
  meta: null,
  symbol: null,
  date: null,
  view: 'replay',
  // 回放
  replay: null,
  replayIdx: 0,
  playing: false,
  playTimer: null,
  speedMs: 40,
  // K 线
  barsPeriod: '1m',
  barsAdjust: 'none',
  barsData: null,
  // 核对
  reconcile: null,
  selectedCase: null,
  caseDetail: null,
  // 异常
  anomalies: null,
  anomKind: null,
  anomSeverity: null,
  // 多源
  sources: null,
  continuous: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
};

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtCompact(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return String(n);
}
function fmtPx(n, digits = 2) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(digits);
}
function pct(n) { return (n * 100).toFixed(1) + '%'; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path) {
  const r = await fetch('/api' + path);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.message || j.error || msg; } catch (_) {}
    throw new Error(`${r.status} ${msg}`);
  }
  return r.json();
}

function setConn(ok) {
  const c = $('#conn-status');
  c.className = 'conn ' + (ok ? 'ok' : 'err');
  c.title = ok ? '服务正常' : '服务不可用';
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    S.meta = await api('/meta');
    setConn(true);
    $('#dataset-name').textContent = S.meta.dataset;
    $('#footer-left').textContent = `引擎 v${S.meta.engine_version} · ${S.meta.summary.symbols} 品种 · ${fmtCompact(S.meta.summary.messages)} 消息`;
    $('#footer-right').textContent = `金标准 ${S.meta.summary.golden_cases} 用例 · 异常 ${fmtNum(S.meta.summary.anomalies)} 条`;
    await initSelectors();
    wireTabs();
    await switchView('replay');
  } catch (e) {
    setConn(false);
    $('#dataset-name').textContent = '数据未加载';
    $('#main').innerHTML = `<div class="empty"><p>无法连接服务或数据未生成。</p><p class="mono faint">${esc(e.message)}</p>
      <p class="faint">请先运行 <code class="mono">mk gen</code> 生成数据，再启动 <code class="mono">mkd</code>。</p></div>`;
  }
}

async function initSelectors() {
  const symSel = $('#symbol-select');
  symSel.innerHTML = '';
  for (const inst of S.meta.instruments) {
    const opt = el('option', { value: inst.symbol }, `${inst.symbol}  ${inst.name}`);
    symSel.appendChild(opt);
  }
  S.symbol = S.meta.instruments[0].symbol;
  symSel.value = S.symbol;
  symSel.addEventListener('change', async () => {
    S.symbol = symSel.value;
    await refreshDates();
    await switchView(S.view);
  });

  const dateSel = $('#date-select');
  dateSel.addEventListener('change', async () => {
    S.date = dateSel.value;
    await switchView(S.view);
  });
  await refreshDates();
}

function currentInstrument() {
  return S.meta.instruments.find((i) => i.symbol === S.symbol);
}
function priceDigits() {
  const i = currentInstrument();
  return i ? i.price_decimals : 2;
}

async function refreshDates() {
  // 用 /api/bars 的日期范围确定可选交易日（更可靠）
  const r = await api(`/bars?symbol=${encodeURIComponent(S.symbol)}&period=1d`);
  const dates = r.bars.map((b) => b.date);
  const sel = $('#date-select');
  sel.innerHTML = '';
  for (const d of dates) sel.appendChild(el('option', { value: d }, d));
  S.date = dates[dates.length - 1] || S.meta.trading_days[S.meta.trading_days.length - 1];
  sel.value = S.date;
}

// ------------------------------------------------------------------ tabs
function wireTabs() {
  $$('#tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

async function switchView(view) {
  S.view = view;
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  stopPlay();
  try {
    if (view === 'replay') await renderReplay();
    else if (view === 'bars') await renderBars();
    else if (view === 'factors') await renderFactors();
    else if (view === 'reconcile') await renderReconcile();
    else if (view === 'anomalies') await renderAnomalies();
    else if (view === 'sources') await renderSources();
  } catch (e) {
    $('#view-' + view).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

// ================================================================== REPLAY
async function renderReplay() {
  const view = $('#view-replay');
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 加载回放数据…</div>`;
  const data = await api(`/replay?symbol=${encodeURIComponent(S.symbol)}&date=${S.date}`);
  S.replay = data;
  // 初始停在当日最后一条成交：图表显示完整一天，用户可点“复位”从头回放。
  S.replayIdx = Math.max(0, data.trades.length - 1);
  S.playing = false;

  const dg = priceDigits();
  const inst = currentInstrument();
  const allTrades = data.trades;

  view.innerHTML = '';
  const layout = el('div', { class: 'replay-layout' });
  const mainCol = el('div', { class: 'replay-main' });
  const sideCol = el('div', { class: 'replay-side' });

  // ---- chart panel ----
  const chartCard = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  const head = el('div', { class: 'row', style: 'padding:10px 12px;border-bottom:1px solid var(--border)' });
  head.appendChild(el('div', { class: 'stat' },
    el('span', { class: 'k' }, '合约'),
    el('span', { class: 'v', style: 'font-size:14px' }, S.symbol)));
  const priceStat = el('div', { class: 'stat' }, el('span', { class: 'k' }, '最新价'), el('span', { class: 'v', id: 'rp-last' }, '—'));
  const chgStat = el('div', { class: 'stat' }, el('span', { class: 'k' }, '涨跌幅'), el('span', { class: 'v', id: 'rp-chg' }, '—'));
  const volStat = el('div', { class: 'stat' }, el('span', { class: 'k' }, '累计量'), el('span', { class: 'v', id: 'rp-vol' }, '0'));
  const turnStat = el('div', { class: 'stat' }, el('span', { class: 'k' }, '累计额'), el('span', { class: 'v', id: 'rp-turn' }, '0'));
  const anomStat = el('div', { class: 'stat' }, el('span', { class: 'k' }, '异常'), el('span', { class: 'v', id: 'rp-anom' }, '0'));
  head.append(priceStat, chgStat, volStat, turnStat, anomStat);
  head.appendChild(el('div', { style: 'flex:1' }));
  head.appendChild(el('div', { class: 'legend' },
    el('span', { class: 'l-up' }, '涨'),
    el('span', { class: 'l-dn' }, '跌'),
    el('span', { class: 'l-au' }, '竞价量'),
    el('span', { class: 'l-iso' }, '隔离')));

  const canvas = el('canvas', { id: 'replay-canvas' });
  chartCard.append(head, canvas);
  mainCol.appendChild(chartCard);

  // ---- transport ----
  const transport = el('div', { class: 'transport' });
  const playBtn = el('button', { class: 'btn primary', id: 'rp-play' }, '▶ 播放');
  const resetBtn = el('button', { class: 'btn', id: 'rp-reset' }, '⟲ 复位');
  const clock = el('span', { class: 'clock', id: 'rp-clock' }, '09:15:00');
  const slider = el('input', { type: 'range', id: 'rp-slider', min: '0', max: String(allTrades.length - 1 || 0), value: '0' });
  const posLbl = el('span', { class: 'mono faint', id: 'rp-pos' }, `0 / ${allTrades.length}`);
  const speedSel = el('select', { class: 'ctl', id: 'rp-speed' },
    el('option', { value: '120' }, '0.5×'),
    el('option', { value: '40', selected: 'selected' }, '1×'),
    el('option', { value: '12' }, '3×'),
    el('option', { value: '2' }, '10×'));
  transport.append(playBtn, resetBtn, clock, slider, posLbl, speedSel);
  mainCol.appendChild(transport);

  // ---- side: current forming bars ----
  const formingCard = el('div', { class: 'card' });
  formingCard.appendChild(el('h3', {}, '正在形成'));
  const formingWrap = el('div', { id: 'rp-forming', class: 'bar-progress' });
  formingCard.appendChild(formingWrap);
  sideCol.appendChild(formingCard);

  // ---- side: trade feed ----
  const feedCard = el('div', { class: 'card', style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
  feedCard.appendChild(el('h3', {}, '逐笔成交'));
  const feed = el('div', { class: 'trade-feed scroll', id: 'rp-feed' });
  feedCard.appendChild(feed);
  sideCol.appendChild(feedCard);

  layout.append(mainCol, sideCol);
  view.appendChild(layout);

  // ---- canvas sizing ----
  const resize = () => {
    const w = chartCard.clientWidth;
    const h = Math.max(260, Math.min(window.innerHeight - 250, 520));
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    canvas.style.height = h + 'px';
    canvas.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    S.canvasW = w; S.canvasH = h;
  };
  resize();
  window.addEventListener('resize', () => { if (S.view === 'replay') { resize(); redrawReplay(); } });

  // ---- interaction ----
  playBtn.addEventListener('click', () => S.playing ? stopPlay() : startPlay());
  resetBtn.addEventListener('click', () => { stopPlay(); S.replayIdx = 0; updateReplay(); });
  // 播放时若已在末尾，自动从头开始
  playBtn.addEventListener('click', () => {
    if (!S.playing && S.replayIdx >= allTrades.length - 1) { S.replayIdx = 0; updateReplay(); }
  }, true);
  slider.addEventListener('input', () => {
    stopPlay();
    S.replayIdx = Number(slider.value);
    updateReplay();
  });
  speedSel.addEventListener('change', () => {
    S.speedMs = Number(speedSel.value);
    if (S.playing) { stopPlay(); startPlay(); }
  });

  S.rp = { canvas, slider, clock, playBtn, feed, formingWrap, allTrades, dg, inst, resize };
  updateReplay(true);
}

function startPlay() {
  S.playing = true;
  const btn = $('#rp-play');
  if (btn) btn.textContent = '⏸ 暂停';
  S.playTimer = setInterval(() => {
    const n = S.rp.allTrades.length;
    if (S.replayIdx >= n - 1) { stopPlay(); return; }
    S.replayIdx++;
    updateReplay();
  }, S.speedMs);
}
function stopPlay() {
  S.playing = false;
  if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; }
  const btn = $('#rp-play');
  if (btn) btn.textContent = '▶ 播放';
}

function updateReplay(initial) {
  const { canvas, slider, clock, feed, formingWrap, allTrades, dg } = S.rp;
  const data = S.replay;
  const idx = S.replayIdx;
  const cursorTrade = allTrades[idx];
  const cursorTs = cursorTrade ? cursorTrade.ts : data.sessions[0]?.start ?? 0;

  slider.value = String(idx);
  $('#rp-pos').textContent = `${idx + 1} / ${allTrades.length}`;
  clock.textContent = cursorTrade ? fmtTsMs(cursorTrade.ts) : '09:15:00.000';

  // 已完成 bar：游标之前的 1m bar
  const allBars = data.bars['1m'] || [];
  // 只保留时间上已完成的 bar（bar.t <= cursorTs 表示该分钟结束）
  const doneBars = allBars.filter((b) => b.t <= cursorTs);

  // 正在形成的 bar：从最后一个 done bar 到游标之间的成交
  const lastDoneT = doneBars.length ? doneBars[doneBars.length - 1].t : -Infinity;
  const nextGrid = (data.grids['1m'] || []).find((g) => g.e > lastDoneT);
  const formingTrades = allTrades.filter((t) => t.ts > lastDoneT && t.ts <= cursorTs);

  // 画图
  const ctx = canvas.getContext('2d');
  const prevClose = data.prev_close;
  drawReplay(ctx, {
    bars: doneBars,
    trades: allTrades.slice(0, idx + 1),
    width: S.canvasW, height: S.canvasH,
    prevClose, priceDigits: dg,
    cursorT: cursorTs,
    grid: data.grids['1m'] || null,
  });

  // 顶部统计
  const last = doneBars.length ? doneBars[doneBars.length - 1].c : (prevClose ?? 0);
  const chg = prevClose ? (last / prevClose - 1) : 0;
  const elLast = $('#rp-last');
  if (elLast) {
    elLast.textContent = fmtPx(last, dg);
    elLast.className = 'v ' + (chg >= 0 ? 'up' : 'down');
  }
  const elChg = $('#rp-chg');
  if (elChg) { elChg.textContent = (chg >= 0 ? '+' : '') + pct(chg); elChg.className = 'v ' + (chg >= 0 ? 'up' : 'down'); }
  const cumV = doneBars.reduce((a, b) => a + b.v, 0);
  $('#rp-vol').textContent = fmtCompact(cumV);
  $('#rp-turn').textContent = fmtCompact(doneBars.reduce((a, b) => a + b.to, 0));
  const anoms = data.anomalies.filter((a) => a.ts <= cursorTs);
  $('#rp-anom').textContent = String(anoms.length);

  // 正在形成的 bar
  formingWrap.innerHTML = '';
  if (formingTrades.length && nextGrid) {
    const o = formingTrades[0].p;
    const c = formingTrades[formingTrades.length - 1].p;
    const h = Math.max(...formingTrades.map((t) => t.p));
    const l = Math.min(...formingTrades.map((t) => t.p));
    const v = formingTrades.reduce((a, t) => a + t.v, 0);
    formingWrap.appendChild(miniBar('正在形成', nextGrid.e, o, h, l, c, v, dg, true));
  }
  for (const p of ['5m', '15m', '1d']) {
    const bs = (data.bars[p] || []).filter((b) => b.t <= cursorTs);
    if (!bs.length) continue;
    const b = bs[bs.length - 1];
    formingWrap.appendChild(miniBar(p, b.t, b.o, b.h, b.l, b.c, b.v, dg, false));
  }
  if (!formingWrap.children.length) {
    formingWrap.appendChild(el('div', { class: 'faint', style: 'font-size:11px;padding:8px' }, '尚无成交'));
  }

  // 逐笔 feed（最近的在上）
  const recent = allTrades.slice(Math.max(0, idx - 60), idx + 1).reverse();
  const isoRecent = (data.isolated || []).filter((t) => t.ts <= cursorTs).slice(-20).reverse();
  const rows = [];
  for (const t of recent) rows.push(trowHtml(t, false, dg));
  for (const t of isoRecent) rows.push(trowHtml(t, true, dg));
  rows.sort((a, b) => b.ts - a.ts);
  feed.innerHTML = rows.map((r) => r.html).join('');
  if (!initial) {
    const f = feed.querySelector('.trow');
    if (f) f.classList.add('fresh');
  }
}

function miniBar(label, t, o, h, l, c, v, dg, forming) {
  const up = c >= o;
  return el('div', { class: 'mini-bar' },
    el('div', { class: 'lbl' }, `${label} ${fmtTime(t)}`),
    el('div', { class: 'ohlc ' + (up ? 'up' : 'down') },
      `${fmtPx(o, dg)} / ${fmtPx(h, dg)} / ${fmtPx(l, dg)} / ${fmtPx(c, dg)}`),
    el('div', { class: 'lbl' }, `量 ${fmtCompact(v)}`));
}

function trowHtml(t, iso, dg) {
  const cls = 'trow' + (iso ? ' iso' : '');
  const sideCls = t.side === 'B' ? 'up' : t.side === 'S' ? 'down' : 'dim';
  const tag = iso ? '<span class="pill sev-error">隔离</span>' : (t.syn ? '<span class="pill">补</span>' : '');
  return {
    ts: t.ts,
    html: `<div class="${cls}"><span class="dim">${fmtTsMs(t.ts)}</span><span class="${sideCls}">${fmtPx(t.p, dg)}</span><span>${fmtCompact(t.v)}</span><span class="${sideCls}">${t.side}</span></div>`,
  };
}

function redrawReplay() {
  if (S.rp) updateReplay(true);
}

// ================================================================== BARS
async function renderBars() {
  const view = $('#view-bars');
  const periods = S.meta.periods;
  const adjusts = ['none', 'forward', 'backward'];
  const adjustLabel = { none: '不复权', forward: '前复权', backward: '后复权' };

  const filters = el('div', { class: 'filters' },
    el('span', { class: 'faint' }, '周期'),
    el('select', { class: 'ctl', id: 'b-period' }, ...periods.map((p) => el('option', { value: p, ...(p === S.barsPeriod ? { selected: 'selected' } : {}) }, p))),
    el('span', { class: 'faint', style: 'margin-left:8px' }, '复权'),
    el('select', { class: 'ctl', id: 'b-adjust' }, ...adjusts.map((a) => el('option', { value: a, ...(a === S.barsAdjust ? { selected: 'selected' } : {}) }, adjustLabel[a]))),
    el('span', { class: 'faint', style: 'margin-left:8px' }, '范围'),
    el('select', { class: 'ctl', id: 'b-range' },
      el('option', { value: 'day' }, '当日'),
      el('option', { value: 'all' }, '全部交易日')),
    el('span', { style: 'flex:1' }),
    el('span', { class: 'faint', id: 'b-count' }, ''),
  );
  view.innerHTML = '';
  view.appendChild(filters);

  const chartCard = el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:12px' });
  const canvas = el('canvas', { id: 'bars-canvas' });
  chartCard.appendChild(canvas);
  view.appendChild(chartCard);

  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('h3', {}, '明细'));
  const tableWrap = el('div', { class: 'scroll', style: 'max-height:420px', id: 'b-table' });
  tableCard.appendChild(tableWrap);
  view.appendChild(tableCard);

  const metaCard = el('div', { class: 'card', style: 'margin-top:12px' });
  metaCard.id = 'b-meta';
  view.appendChild(metaCard);

  const isFuture = currentInstrument().asset === 'future';
  if (isFuture) {
    const adjSel = $('#b-adjust');
    adjSel.disabled = true;
    adjSel.title = '期货不适用除权复权（R33）';
    S.barsAdjust = 'none';
  }
  await loadBars();

  $('#b-period').addEventListener('change', async (e) => { S.barsPeriod = e.target.value; await loadBars(); });
  $('#b-adjust').addEventListener('change', async (e) => { S.barsAdjust = e.target.value; await loadBars(); });
  $('#b-range').addEventListener('change', () => loadBars());

  async function loadBars() {
    const range = $('#b-range') ? $('#b-range').value : 'day';
    const inst = currentInstrument();
    const isFuture = inst.asset === 'future';
    if (isFuture && S.barsAdjust !== 'none') {
      S.barsAdjust = 'none';
      $('#b-adjust').value = 'none';
    }
    const q = new URLSearchParams({ symbol: S.symbol, period: S.barsPeriod, adjust: S.barsAdjust });
    if (range === 'day') q.set('date', S.date);
    const data = await api('/bars?' + q.toString());
    S.barsData = data;

    const w = chartCard.clientWidth || 900;
    const h = 420;
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    canvas.style.height = h + 'px';
    canvas.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    drawCandles(canvas.getContext('2d'), {
      bars: data.bars, width: w, height: h,
      priceDigits: priceDigits(),
      intraday: S.barsPeriod !== '1d',
    });

    $('#b-count').textContent = `${data.meta.count} 根 · ${data.meta.first || ''} → ${data.meta.last || ''}`;

    // 表格
    const rows = data.bars.slice(-300).reverse();
    tableWrap.innerHTML = `<table class="tbl"><thead><tr>
      <th>时间</th><th class="num">开</th><th class="num">高</th><th class="num">低</th><th class="num">收</th>
      <th class="num">量</th><th class="num">额</th><th class="num">笔数</th><th class="num">主买</th><th class="num">主卖</th><th class="num">竞价</th><th>标记</th>
    </tr></thead><tbody>${rows.map((b) => `<tr>
      <td>${b.date} ${b.end.slice(0, 8)}</td>
      <td class="num">${fmtPx(b.o, priceDigits())}</td>
      <td class="num">${fmtPx(b.h, priceDigits())}</td>
      <td class="num">${fmtPx(b.l, priceDigits())}</td>
      <td class="num ${b.c >= b.o ? 'up' : 'down'}">${fmtPx(b.c, priceDigits())}</td>
      <td class="num">${fmtNum(b.v)}</td>
      <td class="num">${fmtCompact(b.to)}</td>
      <td class="num">${b.n}</td>
      <td class="num">${fmtNum(b.bvol)}</td>
      <td class="num">${fmtNum(b.svol)}</td>
      <td class="num">${b.av ? fmtNum(b.av) : ''}</td>
      <td>${b.flags.map((f) => `<span class="pill flag">${f}</span>`).join(' ')}</td>
    </tr>`).join('')}</tbody></table>`;

    // meta
    const notes = [];
    if (data.meta.note) notes.push(data.meta.note);
    if (isFuture) notes.push('期货不适用复权：/api/bars 对期货的 forward/backward 请求返回 400。');
    if (data.bars.some((b) => b.cv > 0)) notes.push('cv>0 表示该 bar 内有成交被撤销/更正，OHLC 已按剩余成交重算。');
    $('#b-meta').innerHTML = `<div class="kv">
      <span class="k">品种</span><span class="v">${esc(data.symbol)} · ${esc(currentInstrument().name)}</span>
      <span class="k">周期 / 复权</span><span class="v">${esc(data.period)} · ${esc(adjustLabel[data.adjust] || data.adjust)}</span>
      <span class="k">序号范围</span><span class="v">${data.meta.first_seq} → ${data.meta.last_seq}</span>
      <span class="k">说明</span><span class="v" style="font-family:inherit">${esc(notes.join(' '))}</span>
    </div>`;
  }
}

// ================================================================== FACTORS
async function renderFactors() {
  const view = $('#view-factors');
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 加载…</div>`;
  const inst = currentInstrument();
  if (inst.asset === 'future') {
    view.innerHTML = `<div class="card"><h3>复权因子</h3><p class="dim">${esc(S.symbol)} 是期货合约，不适用除权除息复权（R33）。</p></div>`;
    return;
  }
  const data = await api(`/factors?symbol=${encodeURIComponent(S.symbol)}`);
  view.innerHTML = '';

  const defCard = el('div', { class: 'card', style: 'margin-bottom:12px' });
  defCard.appendChild(el('h3', {}, '口径定义'));
  defCard.appendChild(el('div', { class: 'kv' },
    el('span', { class: 'k' }, 'q（除权因子）'), el('span', { class: 'v', style: 'font-family:inherit' }, data.definitions.q),
    el('span', { class: 'k' }, '前复权'), el('span', { class: 'v', style: 'font-family:inherit' }, data.definitions.forward),
    el('span', { class: 'k' }, '后复权'), el('span', { class: 'v', style: 'font-family:inherit' }, data.definitions.backward),
  ));
  view.appendChild(defCard);

  const rowCard = el('div', { class: 'card', style: 'margin-bottom:12px' });
  rowCard.appendChild(el('h3', {}, '除权除息事件'));
  if (!data.rows.length) {
    rowCard.appendChild(el('p', { class: 'dim' }, '该品种在数据集内没有除权除息事件。'));
  } else {
    rowCard.innerHTML += `<table class="tbl"><thead><tr>
      <th>除权日</th><th class="num">每股现金</th><th class="num">送股</th><th class="num">配股</th><th class="num">配股价</th>
      <th class="num">除权前收</th><th class="num">q</th><th class="num">除权参考价</th><th class="num">前复权因子</th><th class="num">后复权因子</th><th>备注</th>
    </tr></thead><tbody>${data.rows.map((r) => `<tr>
      <td>${r.ex_date}</td>
      <td class="num">${r.cash_div.toFixed(2)}</td>
      <td class="num">${r.bonus.toFixed(2)}</td>
      <td class="num">${r.rights.toFixed(2)}</td>
      <td class="num">${r.rights_price.toFixed(2)}</td>
      <td class="num">${r.prev_close.toFixed(2)}</td>
      <td class="num" style="color:var(--accent)">${r.q.toFixed(8)}</td>
      <td class="num">${r.p_ex.toFixed(4)}</td>
      <td class="num">${r.forward_factor.toFixed(8)}</td>
      <td class="num">${r.backward_factor.toFixed(8)}</td>
      <td>${esc(r.note)}</td>
    </tr>`).join('')}</tbody></table>`;
  }
  view.appendChild(rowCard);

  // 因子曲线 + 三口径价格对照
  const seriesCard = el('div', { class: 'card' });
  seriesCard.appendChild(el('h3', {}, '每日因子与三口径收盘价'));
  const canvas = el('canvas', { id: 'factor-canvas' });
  seriesCard.appendChild(canvas);
  const tbl = el('div', { class: 'scroll', style: 'max-height:300px;margin-top:10px' });
  seriesCard.appendChild(tbl);
  view.appendChild(seriesCard);

  // 取三种口径的日线
  const [none, fwd, bwd] = await Promise.all([
    api(`/bars?symbol=${encodeURIComponent(S.symbol)}&period=1d&adjust=none`),
    api(`/bars?symbol=${encodeURIComponent(S.symbol)}&period=1d&adjust=forward`),
    api(`/bars?symbol=${encodeURIComponent(S.symbol)}&period=1d&adjust=backward`),
  ]);
  const dg = priceDigits();
  const series = data.series;
  const w = seriesCard.clientWidth || 900, h = 260;
  canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawFactorChart(ctx, series, w, h);

  tbl.innerHTML = `<table class="tbl"><thead><tr>
    <th>交易日</th><th class="num">前复权因子</th><th class="num">后复权因子</th>
    <th class="num">原始收盘</th><th class="num">前复权收盘</th><th class="num">后复权收盘</th></tr></thead><tbody>${
    series.map((s, i) => {
      const raw = none.bars[i], f = fwd.bars[i], b = bwd.bars[i];
      return `<tr><td>${s.date}</td>
        <td class="num">${s.forward.toFixed(8)}</td>
        <td class="num">${s.backward.toFixed(8)}</td>
        <td class="num">${raw ? fmtPx(raw.c, dg) : '—'}</td>
        <td class="num" style="color:var(--accent)">${f ? fmtPx(f.c, dg) : '—'}</td>
        <td class="num" style="color:#c297ff">${b ? fmtPx(b.c, dg) : '—'}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function drawFactorChart(ctx, series, width, height) {
  ctx.clearRect(0, 0, width, height);
  const padL = 10, padR = 70, padT = 14, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const s of series) { lo = Math.min(lo, s.forward, s.backward); hi = Math.max(hi, s.forward, s.backward); }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi === lo) { hi += 0.01; lo -= 0.01; }
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;
  const x = (i) => padL + (innerW * i) / Math.max(1, series.length - 1);
  ctx.strokeStyle = '#2a3140'; ctx.fillStyle = '#8b949e'; ctx.font = '10px ui-monospace';
  for (let i = 0; i <= 4; i++) {
    const yy = padT + innerH - (innerH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(width - padR, yy); ctx.stroke();
    ctx.fillText((lo + ((hi - lo) * i) / 4).toFixed(4), width - padR + 6, yy + 3);
  }
  for (const [key, color] of [['forward', '#58a6ff'], ['backward', '#c297ff']]) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    series.forEach((s, i) => { const xx = x(i), yy = y(s[key]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
    ctx.stroke();
    ctx.fillStyle = color;
    for (let i = 0; i < series.length; i++) {
      ctx.beginPath(); ctx.arc(x(i), y(series[i][key]), 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = '#8b949e';
  series.forEach((s, i) => {
    if (series.length > 9 && i % 2) return;
    ctx.fillText(s.date.slice(5), x(i) - 13, height - 8);
  });
  ctx.fillStyle = '#58a6ff'; ctx.fillText('■ 前复权', padL, padT - 2);
  ctx.fillStyle = '#c297ff'; ctx.fillText('■ 后复权', padL + 62, padT - 2);
}

// ================================================================== RECONCILE
async function renderReconcile() {
  const view = $('#view-reconcile');
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 加载核对结果…</div>`;
  const [rep, recall] = await Promise.all([api('/reconcile'), api('/injections').catch(() => null)]);
  S.reconcile = rep;
  view.innerHTML = '';

  const sum = rep.summary;
  const passRate = sum.bars ? (sum.matched / sum.bars) * 100 : 0;
  const top = el('div', { class: 'grid', style: 'grid-template-columns:repeat(5,1fr);margin-bottom:12px' });
  const stat = (k, v, cls = '') => el('div', { class: 'card' }, el('div', { class: 'stat' },
    el('span', { class: 'k' }, k), el('span', { class: 'v ' + cls }, v)));
  top.append(
    stat('金标准用例', String(sum.cases)),
    stat('对比 bar 数', String(sum.bars)),
    stat('完全匹配', String(sum.matched), 'down'),
    stat('存在差异', String(sum.mismatched), sum.mismatched ? 'up' : ''),
    stat('字段级差异', String(sum.field_diffs), sum.field_diffs ? 'up' : ''),
  );
  view.appendChild(top);

  if (recall) {
    const card = el('div', { class: 'card', style: 'margin-bottom:12px' });
    const rate = (recall.recall * 100).toFixed(1);
    card.appendChild(el('div', { class: 'row' },
      el('div', { class: 'stat' }, el('span', { class: 'k' }, '异常注入召回'), el('span', { class: 'v', style: 'color:' + (recall.recall > 0.95 ? 'var(--down)' : 'var(--warn)') }, rate + '%')),
      el('div', { class: 'stat' }, el('span', { class: 'k' }, '命中 / 注入'), el('span', { class: 'v' }, `${recall.detected} / ${recall.total}`)),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'faint', style: 'max-width:520px;font-size:11px' }, '仿真器知道它注入了哪些异常（真值），这里统计引擎实际识别到的比例。这是"核对页"的第二条主线：不仅对 K 线，也对异常识别能力。'),
    ));
    view.appendChild(card);
  }

  const layout = el('div', { class: 'split2' });
  const listCard = el('div', { class: 'card' });
  listCard.appendChild(el('h3', {}, '用例（点击查看推导）'));
  const list = el('div', { class: 'case-list' });
  for (const c of rep.cases) {
    list.appendChild(el('div', {
      class: 'case' + (S.selectedCase === c.id ? ' selected' : ''),
      'data-id': c.id,
      onclick: () => selectCase(c.id),
    },
      el('span', { class: 'id' }, c.id),
      el('span', { class: `pill ${c.status === 'pass' ? 'ok' : 'fail'}` }, c.status === 'pass' ? 'PASS' : 'FAIL'),
      el('span', { class: 'title' }, c.title),
      el('span', { class: 'rules' }, ...c.rules.map((r) => el('span', { class: 'pill' }, r))),
      el('span', { class: 'faint mono', style: 'font-size:11px' }, `${c.period} · ${c.bar_count} bar`),
    ));
  }
  listCard.appendChild(list);
  layout.appendChild(listCard);

  const detailCard = el('div', { class: 'card', id: 'case-detail' });
  detailCard.innerHTML = '<h3>用例详情</h3><p class="faint">选择左侧用例查看人工推导与逐字段对比。</p>';
  layout.appendChild(detailCard);
  view.appendChild(layout);

  const diffCard = el('div', { class: 'card', style: 'margin-top:12px' });
  diffCard.appendChild(el('h3', {}, `差异明细（${rep.diffs.length}）`));
  if (!rep.diffs.length) {
    diffCard.appendChild(el('p', { class: 'dim' }, '所有金标准 bar 逐字段完全一致。'));
  } else {
    diffCard.innerHTML += `<table class="tbl diff"><thead><tr>
      <th>用例</th><th>周期</th><th>bar</th><th>字段</th><th class="num">期望</th><th class="num">实际</th><th>原因码</th><th>说明</th>
    </tr></thead><tbody>${rep.diffs.map((d) => `<tr>
      <td>${d.case_id}</td><td>${d.period}</td><td>${d.bar_end}</td><td>${d.field}</td>
      <td class="num exp">${JSON.stringify(d.expected)}</td>
      <td class="num act">${JSON.stringify(d.actual)}</td>
      <td><span class="pill sev-error">${d.reason_code}</span></td>
      <td style="font-family:inherit">${esc(d.reason)}</td>
    </tr>`).join('')}</tbody></table>`;
  }
  view.appendChild(diffCard);

  const consCard = el('div', { class: 'card', style: 'margin-top:12px' });
  consCard.id = 'cons-card';
  consCard.innerHTML = '<h3>跨周期一致性</h3><div class="empty"><span class="spinner"></span></div>';
  view.appendChild(consCard);
  const cons = await api('/consistency');
  consCard.innerHTML = `<h3>跨周期一致性</h3><div class="row" style="margin-bottom:8px">
      <span class="stat"><span class="k">检查项</span><span class="v">${cons.summary.checked}</span></span>
      <span class="stat"><span class="k">通过</span><span class="v down">${cons.summary.ok}</span></span>
      <span class="stat"><span class="k">失败</span><span class="v ${cons.summary.failed ? 'up' : ''}">${cons.summary.failed}</span></span>
    </div>
    <p class="faint" style="font-size:11px;margin:0">校验 Σ1m 量/额 == 1d，以及 Σ1m == Σ5m（R70）。</p>
    <div class="diff-card" style="margin-top:10px">
      <details><summary>常见“和行情软件对不上”的原因清单</summary>
      <ul style="font-size:12px;line-height:1.8;color:var(--text-dim);margin:8px 0 0;padding-left:18px">
        <li><b>时间窗口径</b>：本引擎用左开右闭 <code class="mono">(t-1m, t]</code>。把 <code class="mono">09:31:00.000</code>
            算进 09:31 还是 09:32，直接差一整笔（G01）。</li>
        <li><b>集合竞价归属</b>：开盘竞价是否单独成一根 09:30 的 1m bar、收盘竞价是否并入 15:00，
            各家软件不同（G02/G04/G12）。</li>
        <li><b>午休边界</b>：11:30:00 与 13:00:00 的归属（G03）。</li>
        <li><b>冲正是否传导</b>：撤单/废单/更正后有没有把量额笔数和 OHLC 一起重算（G05/G06/G16/G17）。</li>
        <li><b>夜盘交易日归属</b>：21:00 后归下一交易日（G08/G19）。</li>
        <li><b>空 bar 策略</b>：无成交的分钟是省略还是用前收填充（G10）。</li>
        <li><b>复权口径</b>：前/后复权基准不同，同一根 bar 会显示不同价格（复权因子页）。</li>
        <li><b>多源与补数</b>：合并后是否去重、缺号是否补、补的是对源还是快照合成（多源/连续页）。</li>
      </ul>
      </details>
    </div>`;

  if (!S.selectedCase) selectCase(rep.cases[0]?.id);
}

async function selectCase(id) {
  if (!id) return;
  S.selectedCase = id;
  $$('.case').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  const card = $('#case-detail');
  card.innerHTML = '<h3>用例详情</h3><div class="empty"><span class="spinner"></span></div>';
  const d = await api(`/reconcile/${encodeURIComponent(id)}`);
  const dg = priceDigits();
  const rows = [];
  for (let i = 0; i < Math.max(d.expected.length, d.actual.length); i++) {
    const e = d.expected[i], a = d.actual[i];
    const same = e && a && ['o','h','l','c','v','n','bvol','svol','av'].every((k) =>
      Math.abs((e[k] ?? 0) - (a[k] ?? 0)) < 1e-6);
    rows.push(`<tr>
      <td>${e ? e.end : a.end}</td>
      <td class="num">${e ? fmtPx(e.o, dg) : '—'}</td><td class="num">${e ? fmtPx(e.h, dg) : '—'}</td>
      <td class="num">${e ? fmtPx(e.l, dg) : '—'}</td><td class="num">${e ? fmtPx(e.c, dg) : '—'}</td>
      <td class="num">${e ? fmtNum(e.v) : '—'}</td><td class="num">${e ? e.n : '—'}</td>
      <td class="num">${a ? fmtPx(a.o, dg) : '—'}</td><td class="num">${a ? fmtPx(a.h, dg) : '—'}</td>
      <td class="num">${a ? fmtPx(a.l, dg) : '—'}</td><td class="num">${a ? fmtPx(a.c, dg) : '—'}</td>
      <td class="num">${a ? fmtNum(a.v) : '—'}</td><td class="num">${a ? a.n : '—'}</td>
      <td><span class="pill ${same ? 'ok' : 'fail'}">${same ? '一致' : '差异'}</span>${a && a.flags.length ? ' ' + a.flags.map((f) => `<span class="pill flag">${f}</span>`).join(' ') : ''}</td>
    </tr>`);
  }
  card.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <span class="pill ${d.case.status === 'pass' ? 'ok' : 'fail'}">${d.case.status.toUpperCase()}</span>
      <strong>${esc(d.case.id)}</strong>
      <span class="dim">${esc(d.case.title)}</span>
    </div>
    <div class="dim" style="font-size:11px;margin-bottom:8px">规则：${d.case.rules.map((r) => `<span class="pill">${r}</span>`).join(' ')} · fixture ${esc(d.case.fixture)}</div>
    <div class="desc">${esc(d.description)}</div>
    <h3 style="margin-top:14px">消息输入</h3>
    <div class="scroll" style="max-height:150px"><table class="tbl"><thead><tr>
      <th>时间</th><th>类型</th><th class="num">价格</th><th class="num">量</th><th>方向</th><th>竞价</th><th>成交/引用 ID</th>
    </tr></thead><tbody>${d.trades.map((t) => `<tr>
      <td>${t.hm}</td><td>${esc(t.kind)}</td><td class="num">${t.p ? fmtPx(t.p, dg) : ''}</td>
      <td class="num">${t.v || ''}</td><td>${t.side}</td><td>${t.auction ? '✓' : ''}</td><td class="faint">${esc(t.id)}</td>
    </tr>`).join('')}</tbody></table></div>
    <h3 style="margin-top:14px">期望 vs 实际</h3>
    <div class="scroll"><table class="tbl"><thead>
      <tr><th rowspan="2">bar</th><th colspan="6" class="num" style="text-align:center;border-bottom:1px solid var(--border)">手算期望</th><th colspan="6" class="num" style="text-align:center;border-bottom:1px solid var(--border)">引擎实际</th><th rowspan="2">结论</th></tr>
      <tr><th class="num">开</th><th class="num">高</th><th class="num">低</th><th class="num">收</th><th class="num">量</th><th class="num">笔</th>
      <th class="num">开</th><th class="num">高</th><th class="num">低</th><th class="num">收</th><th class="num">量</th><th class="num">笔</th></tr>
    </thead><tbody>${rows.join('')}</tbody></table></div>
    ${d.diffs.length ? `<h3 style="margin-top:14px">差异</h3><table class="tbl diff"><thead><tr><th>bar</th><th>字段</th><th class="num">期望</th><th class="num">实际</th><th>原因</th></tr></thead><tbody>${d.diffs.map((x) => `<tr><td>${x.bar_end}</td><td>${x.field}</td><td class="num exp">${JSON.stringify(x.expected)}</td><td class="num act">${JSON.stringify(x.actual)}</td><td style="font-family:inherit">${esc(x.reason)}</td></tr>`).join('')}</tbody></table>` : ''}
  `;
}

// ================================================================== ANOMALIES
async function renderAnomalies() {
  const view = $('#view-anomalies');
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 加载异常日志…</div>`;
  const q = new URLSearchParams({ limit: '2000' });
  if (S.symbol) q.set('symbol', S.symbol);
  if (S.anomKind) q.set('kind', S.anomKind);
  if (S.anomSeverity) q.set('severity', S.anomSeverity);
  const data = await api('/anomalies?' + q.toString());
  S.anomalies = data;
  view.innerHTML = '';

  const sevOrder = ['error', 'warn', 'info'];
  const sevLabel = { error: '错误', warn: '警告', info: '信息' };
  const kindLabel = {
    price_jump: '价格跳变', volume_spike: '成交量异常', timestamp_inversion: '时间戳倒挂',
    out_of_session: '非交易时段', duplicate_seq: '序号重复', seq_gap: '序号缺口',
    seq_gap_filled: '缺口已补', gap_unfilled: '缺口未补', invalid_tick: '非合法价位',
    limit_breach: '涨跌停越界', trade_during_halt: '停牌期成交', cancel_unknown: '未知撤单',
    correction_unknown: '未知更正', late_correction: '迟到冲正', source_conflict: '多源冲突',
    bad_price: '坏价格', bad_volume: '坏数量', order_rejected: '废单',
    halt_begin: '停牌开始', halt_end: '停牌结束', trade_canceled: '成交撤销',
    trade_corrected: '成交更正',
  };

  const filterCard = el('div', { class: 'card', style: 'margin-bottom:12px' });
  const sevRow = el('div', { class: 'row', style: 'margin-bottom:8px' });
  sevRow.appendChild(el('span', { class: 'faint' }, '级别'));
  for (const sev of sevOrder) {
    const n = data.by_severity[sev] || 0;
    sevRow.appendChild(el('span', {
      class: 'chip' + (S.anomSeverity === sev ? ' active' : ''),
      onclick: () => { S.anomSeverity = S.anomSeverity === sev ? null : sev; renderAnomalies(); },
    }, `${sevLabel[sev]}${n ? ` (${n})` : ''}`));
  }
  const kindRow = el('div', { class: 'row' });
  kindRow.appendChild(el('span', { class: 'faint' }, '类型'));
  const kinds = Object.entries(data.by_kind).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of kinds) {
    kindRow.appendChild(el('span', {
      class: 'chip' + (S.anomKind === k ? ' active' : ''),
      onclick: () => { S.anomKind = S.anomKind === k ? null : k; renderAnomalies(); },
    }, `${kindLabel[k] || k} ${n}`));
  }
  filterCard.append(sevRow, kindRow);
  view.appendChild(filterCard);

  const head = el('div', { class: 'row', style: 'margin-bottom:10px' },
    el('strong', {}, `${data.total} 条`),
    el('span', { class: 'faint' }, S.symbol ? `· ${S.symbol}` : '· 全部品种'),
    el('span', { style: 'flex:1' }),
    el('span', { class: 'faint', style: 'font-size:11px' }, '隔离 = 该成交未进入任何 K 线；补 = 由对源/快照补数'),
  );
  view.appendChild(head);

  const tableCard = el('div', { class: 'card', style: 'padding:0' });
  const wrap = el('div', { class: 'scroll', style: 'max-height:calc(100vh - 300px)' });
  wrap.innerHTML = `<table class="tbl"><thead><tr>
    <th>ID</th><th>时间</th><th>品种</th><th>源</th><th>类型</th><th>级别</th><th>动作</th><th>成交ID</th><th>说明</th>
  </tr></thead><tbody>${data.items.map((a) => `<tr>
    <td class="faint">${a.id}</td>
    <td>${a.ts === 0 ? '<span class="faint">—</span>' : a.date.slice(5) + ' ' + a.hm}</td>
    <td>${a.symbol}</td>
    <td>${a.source}</td>
    <td><span class="pill">${kindLabel[a.kind] || a.kind}</span></td>
    <td><span class="pill sev-${a.severity}">${sevLabel[a.severity]}</span></td>
    <td>${a.action === 'isolated' ? '<span class="pill fail">隔离</span>' : a.action === 'filled' ? '<span class="pill ok">补数</span>' : '<span class="faint">保留</span>'}</td>
    <td class="faint">${esc(a.trade_id || '')}</td>
    <td style="font-family:inherit;max-width:520px">${esc(a.detail)}</td>
  </tr>`).join('')}</tbody></table>`;
  tableCard.appendChild(wrap);
  view.appendChild(tableCard);
}

// ================================================================== SOURCES / CONTINUOUS
async function renderSources() {
  const view = $('#view-sources');
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 加载…</div>`;
  const [src, cont] = await Promise.all([
    api('/sources'),
    api('/continuous?product=rb&period=1d').catch(() => null),
  ]);
  S.sources = src; S.continuous = cont;
  view.innerHTML = '';

  const srcCard = el('div', { class: 'card', style: 'margin-bottom:12px' });
  srcCard.appendChild(el('h3', {}, '多源合并与序号补全'));
  srcCard.innerHTML += `<table class="tbl"><thead><tr>
    <th>品种</th><th>源</th><th class="num">通道</th><th class="num">收到</th><th class="num">重复</th>
    <th class="num">缺口</th><th class="num">缺号数</th><th class="num">对源补</th><th class="num">合成补</th><th class="num">未补</th><th class="num">倒挂</th><th class="num">序号范围</th>
  </tr></thead><tbody>${src.items.map((s) => `<tr>
    <td>${s.symbol}</td><td><span class="pill">${s.source}</span></td><td class="num">${s.channel}</td>
    <td class="num">${fmtNum(s.received)}</td><td class="num">${s.duplicates || ''}</td>
    <td class="num">${s.gaps || ''}</td><td class="num">${s.gap_seq_total || ''}</td>
    <td class="num" style="color:var(--down)">${s.filled_trades || ''}</td>
    <td class="num" style="color:#c297ff">${s.synthetic_trades || ''}</td>
    <td class="num" style="color:${s.unfilled ? 'var(--up)' : ''}">${s.unfilled || ''}</td>
    <td class="num" style="color:${s.inversions ? 'var(--warn)' : ''}">${s.inversions || ''}</td>
    <td class="num faint">${s.first_seq}–${s.last_seq}</td>
  </tr>`).join('')}</tbody></table>`;
  view.appendChild(srcCard);

  if (cont) {
    const card = el('div', { class: 'card', style: 'margin-bottom:12px' });
    card.appendChild(el('h3', {}, `主力连续合约（${cont.product}）`));
    const rolls = cont.rolls.map((r) => `${r.date} ${r.from} → ${r.to}（比例 ${r.ratio.toFixed(4)}）`).join('；') || '数据集内未发生主力切换';
    card.appendChild(el('p', { class: 'dim', style: 'font-size:12px' }, `切换事件：${rolls}`));
    const dg = 0;
    card.innerHTML += `<table class="tbl"><thead><tr>
      <th>交易日</th><th>主力合约</th><th class="num">持仓量</th><th class="num">开</th><th class="num">高</th><th class="num">低</th><th class="num">收</th>
      <th class="num">量</th><th class="num">复权开</th><th class="num">复权收</th><th>切换</th>
    </tr></thead><tbody>${cont.bars.map((b) => `<tr>
      <td>${b.date}</td><td>${b.contract}</td><td class="num">${fmtNum(b.oi)}</td>
      <td class="num">${fmtPx(b.o, dg)}</td><td class="num">${fmtPx(b.h, dg)}</td><td class="num">${fmtPx(b.l, dg)}</td><td class="num">${fmtPx(b.c, dg)}</td>
      <td class="num">${fmtNum(b.v)}</td>
      <td class="num" style="color:var(--accent)">${fmtPx(b.o_adj, 2)}</td>
      <td class="num" style="color:var(--accent)">${fmtPx(b.c_adj, 2)}</td>
      <td>${b.roll ? '<span class="pill sev-warn">切换</span>' : ''}</td>
    </tr>`).join('')}</tbody></table>`;
    card.appendChild(el('p', { class: 'faint', style: 'font-size:11px;margin:8px 0 0' },
      '主力判定：当日持仓量最大且连续 2 日超过当前主力 5% 才切换，切换于次日生效；连续价格以最新合约为基准向前复权（R60–R63）。'));
    view.appendChild(card);
  }
}

// ------------------------------------------------------------------ go
document.addEventListener('DOMContentLoaded', boot);
})();
