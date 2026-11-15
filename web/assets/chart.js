// 轻量 K 线/成交量绘制（Canvas 2D，无依赖）。
// 所有价格使用"本地时间戳"约定，时间轴标签用 getUTC* 提取。

(function (global) {
'use strict';

const UP = '#f85149';
const DOWN = '#3fb950';
const GRID = '#2a3140';
const TEXT = '#8b949e';
const AUCTION = '#c297ff';

function fmtTime(ts, withDate) {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function fmtTsMs(ts) {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * 绘制一组 K 线。
 * opts: {bars, width, height, priceDigits, volumeDigits, segments, halts, emptyPolicy}
 * bars: [{t,o,h,l,c,v,av,syn,cv,flags:[],...}]（按 t 升序）
 */
function drawCandles(ctx, opts) {
  const { bars, width, height, priceDigits = 2 } = opts;
  const padL = 8, padR = 62, padT = 10, padB = 58;
  const volH = Math.min(90, Math.floor((height - padT - padB) * 0.28));
  const priceH = height - padT - padB - volH - 12;

  ctx.clearRect(0, 0, width, height);
  if (!bars || bars.length === 0) {
    ctx.fillStyle = TEXT;
    ctx.font = '12px ui-monospace';
    ctx.fillText('无数据', padL, padT + 20);
    return;
  }

  let lo = Infinity, hi = -Infinity;
  const vols = [];
  for (const b of bars) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
    vols.push(b.v);
  }
  // 量轴用 99 分位，避免单笔异常量压扁整张图
  vols.sort((a, b) => a - b);
  const maxV = Math.max(1, vols.length ? vols[Math.min(vols.length - 1, Math.floor(vols.length * 0.99))] : 1);
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  if (hi === lo) { hi += 0.01; lo -= 0.01; }
  const span = hi - lo;
  const pad = span * 0.04;
  lo -= pad; hi += pad;

  const innerW = width - padL - padR;
  const slot = innerW / Math.max(bars.length, 1);
  const bodyW = Math.max(1, Math.min(slot * 0.72, 18));

  const yPrice = (p) => padT + priceH - ((p - lo) / (hi - lo)) * priceH;
  const volTop = padT + priceH + 12;
  const yVol = (v) => volTop + volH - (Math.min(v, maxV) / maxV) * volH;
  const xOf = (i) => padL + slot * (i + 0.5);

  // ---- 网格与价格轴 ----
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace';
  ctx.fillStyle = TEXT;
  const gridN = 5;
  for (let i = 0; i <= gridN; i++) {
    const y = padT + priceH - (priceH * i) / gridN;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    const p = lo + (span + pad * 2) * (i / gridN);
    ctx.fillText(p.toFixed(priceDigits), width - padR + 6, y + 3);
  }

  // ---- 停牌区间底色 ----
  if (opts.halts && opts.halts.length) {
    for (const h of opts.halts) {
      const i0 = bars.findIndex((b) => b.t >= h.start);
      let i1 = bars.findIndex((b) => b.t > h.end);
      if (i1 < 0) i1 = bars.length;
      if (i0 >= 0 && i1 > i0) {
        const x0 = padL + slot * i0, x1 = padL + slot * i1;
        ctx.fillStyle = 'rgba(88,166,255,0.07)';
        ctx.fillRect(x0, padT, Math.max(1, x1 - x0), priceH);
        ctx.fillStyle = '#58a6ff88';
        ctx.font = '10px ui-monospace';
        ctx.fillText('停牌', x0 + 4, padT + 12);
      }
    }
  }

  // ---- 时段分隔线 ----
  if (opts.segments && opts.segments.length) {
    const gaps = [];
    for (let i = 0; i < opts.segments.length - 1; i++) {
      const a = opts.segments[i], b = opts.segments[i + 1];
      if (b.start > a.end) gaps.push(b.start);
    }
    ctx.strokeStyle = '#3d4556';
    ctx.setLineDash([2, 3]);
    for (const g of gaps) {
      const i = bars.findIndex((x) => x.t > g);
      if (i > 0) {
        const x = padL + slot * i;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, volTop + volH);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // ---- K 线 ----
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = xOf(i);
    const up = b.c >= b.o;
    const color = b.flags && b.flags.includes('synthetic') ? '#c297ff' : (up ? UP : DOWN);

    // 影线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yPrice(b.h));
    ctx.lineTo(x, yPrice(b.l));
    ctx.stroke();

    // 实体
    const y1 = yPrice(Math.max(b.o, b.c));
    const y2 = yPrice(Math.min(b.o, b.c));
    ctx.fillStyle = color;
    const bh = Math.max(1, y2 - y1);
    ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);

    // 集合竞价量：底部紫色块
    if (b.av > 0) {
      const vh = volTop + volH - yVol(b.av);
      ctx.fillStyle = AUCTION + 'aa';
      ctx.fillRect(x - bodyW / 2, volTop + volH - 3, bodyW, -Math.max(1, vh));
    }
    // 总成交量柱
    const vh2 = volTop + volH - yVol(b.v);
    ctx.fillStyle = color + '55';
    ctx.fillRect(x - bodyW / 2 - 1, volTop + volH, bodyW + 2, -Math.max(1, vh2));

    // 被冲正标记（顶部小三角）
    if (b.cv > 0) {
      ctx.fillStyle = '#d29922';
      ctx.beginPath();
      ctx.moveTo(x, volTop + volH + 3);
      ctx.lineTo(x - 3, volTop + volH + 8);
      ctx.lineTo(x + 3, volTop + volH + 8);
      ctx.closePath();
      ctx.fill();
    }
    // 缺口未补
    if (b.flags && b.flags.includes('gap_unfilled')) {
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - bodyW / 2, yPrice(b.h));
      ctx.lineTo(x + bodyW / 2, yPrice(b.h));
      ctx.stroke();
    }
  }

  // ---- 时间轴 ----
  ctx.fillStyle = TEXT;
  ctx.font = '10px ui-monospace';
  const step = Math.max(1, Math.floor(bars.length / Math.max(2, Math.floor(innerW / 70))));
  for (let i = 0; i < bars.length; i += step) {
    const x = xOf(i);
    if (x < padL + 10 || x > width - padR - 10) continue;
    const b = bars[i];
    const label = opts.intraday === false ? fmtTime(b.t, true) : fmtTime(b.t, false);
    ctx.fillText(label, x - 14, height - 8);
  }
  if (bars.length > 0) {
    ctx.fillText('量', width - padR + 6, volTop + 10);
  }

  // ---- 十字定位（由调用方传入 hoverIndex）----
  if (opts.hoverIndex != null && opts.hoverIndex >= 0 && opts.hoverIndex < bars.length) {
    const hx = xOf(opts.hoverIndex);
    ctx.strokeStyle = '#58a6ff88';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, volTop + volH);
    ctx.stroke();
  }

  // 供交互使用
  return { xOf, yPrice, padL, slot, bars };
}

/**
 * 分时价格折线（回放视图用）。
 * opts: {trades, bars, width, height, basePrice, segments, halts}
 */
function drawReplay(ctx, opts) {
  const { bars, trades, width, height, prevClose = null, grid = null } = opts;
  const padL = 8, padR = 62, padT = 10, padB = 40;
  const volH = 70;
  const priceH = height - padT - padB - volH - 10;
  ctx.clearRect(0, 0, width, height);

  // x 轴按**整日网格**固定宽度，而不是按已完成 bar 数：
  // 回放早期只有几根 bar 时才不会把 K 线拉得又宽又怪，视觉上也更接近真实分时图。
  const nSlots = grid && grid.length ? grid.length : (bars && bars.length ? bars.length : 0);
  const slot = (width - padL - padR) / Math.max(nSlots, 1);
  const slotIndex = (t) => {
    if (grid && grid.length) {
      const i = grid.findIndex((g) => g.e >= t);
      return i < 0 ? grid.length - 1 : i;
    }
    return 0;
  };
  const all = bars && bars.length ? bars : [];
  if (!all.length) {
    ctx.fillStyle = TEXT; ctx.font = '12px ui-monospace';
    ctx.fillText('无数据', padL, padT + 20);
    return;
  }
  let lo = Infinity, hi = -Infinity;
  const vols = [];
  for (const b of all) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); vols.push(b.v); }
  if (prevClose) { lo = Math.min(lo, prevClose); hi = Math.max(hi, prevClose); }
  // 成交量轴用 99 分位做上限：单笔异常量（如注入的 500 万股）不应把整张图的量柱压扁。
  vols.sort((a, b) => a - b);
  const p99 = vols.length ? vols[Math.min(vols.length - 1, Math.floor(vols.length * 0.99))] : 1;
  const maxV = Math.max(p99, 1);
  const span = hi - lo || 0.01;
  lo -= span * 0.04; hi += span * 0.04;
  const innerW = width - padL - padR;
  const yPrice = (p) => padT + priceH - ((p - lo) / (hi - lo)) * priceH;
  const volTop = padT + priceH + 10;
  const yVol = (v) => volTop + volH - (Math.min(v, maxV) / maxV) * volH;
  // bar 的 x 位置：若给了网格，用网格下标；否则退回按序号
  const xOfBar = (b, i) => padL + slot * (slotIndex(b.t) + 0.5);
  const xOf = (i) => padL + slot * (i + 0.5);

  // 网格
  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.font = '10px ui-monospace'; ctx.fillStyle = TEXT;
  for (let i = 0; i <= 4; i++) {
    const y = padT + priceH - (priceH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText((lo + (hi - lo) * (i / 4)).toFixed(opts.priceDigits ?? 2), width - padR + 6, y + 3);
  }
  // 昨收线
  if (prevClose) {
    ctx.strokeStyle = '#d29922aa'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    const y = yPrice(prevClose);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke(); ctx.setLineDash([]);
  }

  // 价格折线
  ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < all.length; i++) {
    const x = xOfBar(all[i], i), y = yPrice(all[i].c);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#58a6ff55';
  ctx.beginPath();
  ctx.moveTo(xOfBar(all[0], 0), yPrice(all[0].c));
  for (let i = 1; i < all.length; i++) ctx.lineTo(xOfBar(all[i], i), yPrice(all[i].c));
  ctx.lineTo(xOfBar(all[all.length - 1], all.length - 1), volTop);
  ctx.lineTo(xOfBar(all[0], 0), volTop);
  ctx.fill();

  // 成交量柱
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    const x = xOfBar(b, i);
    const bw = Math.max(1, Math.min(slot * 0.72, 16));
    const up = b.c >= b.o;
    ctx.fillStyle = (up ? UP : DOWN) + '66';
    ctx.fillRect(x - bw / 2, volTop + volH, bw, -Math.max(1, volTop + volH - yVol(b.v)));
  }

  // 成交点（落在对应分钟网格上）
  if (trades && trades.length) {
    ctx.fillStyle = '#58a6ff';
    for (const t of trades) {
      const x = padL + slot * (slotIndex(t.ts) + 0.5), y = yPrice(t.p);
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 游标
  if (opts.cursorT != null) {
    const x = padL + slot * (slotIndex(opts.cursorT) + 0.5);
    ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, volTop + volH); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 时间轴：按网格抽稀
  ctx.fillStyle = TEXT; ctx.font = '10px ui-monospace';
  const g = grid && grid.length ? grid : all.map((b) => ({ e: b.t }));
  const tickStep = Math.max(1, Math.floor(g.length / Math.max(2, Math.floor(innerW / 70))));
  for (let i = 0; i < g.length; i += tickStep) {
    const x = padL + slot * (i + 0.5);
    if (x < padL + 10 || x > width - padR - 10) continue;
    ctx.fillText(fmtTime(g[i].e, false), x - 14, height - 8);
  }
  return { xOf, yPrice, slot, padL };
}

global.MKChart = { drawCandles, drawReplay, fmtTime, fmtTsMs };
})(window);
