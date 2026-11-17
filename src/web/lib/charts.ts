// 轻量 SVG 图表组件(无第三方依赖)
import { esc, fmtDateTime } from './api.js';

interface Point {
  x: number;
  y: number;
  label?: string;
}

/** 折线/面积图 */
export function lineChart(
  series: Array<{ name: string; color: string; points: Array<{ ts: number; v: number | null }> }>,
  opts: { height?: number; yMin?: number; yMax?: number; yFormat?: (v: number) => string; threshold?: number } = {},
): string {
  const W = 900;
  const H = opts.height ?? 260;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const allVals = series.flatMap((s) => s.points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v)));
  if (allVals.length === 0) return '<div class="empty">暂无数据</div>';
  const allTs = series[0]?.points.map((p) => p.ts) ?? [];
  const tMin = Math.min(...allTs);
  const tMax = Math.max(...allTs);
  let yMin = opts.yMin ?? Math.min(0, ...allVals);
  let yMax = opts.yMax ?? Math.max(...allVals);
  if (opts.threshold !== undefined) yMax = Math.max(yMax, opts.threshold);
  if (yMin === yMax) yMax = yMin + 1;
  const xOf = (ts: number) => padL + ((ts - tMin) / Math.max(1, tMax - tMin)) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

  const yTicks = 5;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = yOf(v);
    const label = opts.yFormat ? opts.yFormat(v) : v.toFixed(2);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
            <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${esc(label)}</text>`;
  }).join('');

  const xTickCount = 6;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => {
    const ts = tMin + ((tMax - tMin) * i) / xTickCount;
    const x = xOf(ts);
    return `<text x="${x}" y="${H - 10}" text-anchor="middle" fill="var(--muted)" font-size="11">${esc(
      fmtDateTime(ts).slice(5, 10),
    )}</text>`;
  }).join('');

  const paths = series
    .map((s) => {
      let d = '';
      let area = '';
      let started = false;
      const dots: string[] = [];
      s.points.forEach((p, i) => {
        if (p.v === null || !Number.isFinite(p.v)) {
          started = false;
          return;
        }
        const x = xOf(p.ts);
        const y = yOf(p.v);
        d += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
        if (!started) area += `M${x.toFixed(1)},${(H - padB).toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)} `;
        else area += `L${x.toFixed(1)},${y.toFixed(1)} `;
        started = true;
        if (i % Math.ceil(s.points.length / 12) === 0) {
          dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${s.color}"/>`);
        }
      });
      // 闭合面积
      const last = s.points.filter((p) => p.v !== null && Number.isFinite(p.v));
      if (last.length) {
        area += `L${xOf(last[last.length - 1]!.ts).toFixed(1)},${(H - padB).toFixed(1)} Z`;
      }
      const gid = `g-${s.name.replace(/\W/g, '')}`;
      return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.color}" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="${s.color}" stop-opacity="0.02"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#${gid})" stroke="none"/>
        <path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>
        ${dots.join('')}`;
    })
    .join('');

  const thresholdLine =
    opts.threshold !== undefined
      ? `<line x1="${padL}" y1="${yOf(opts.threshold)}" x2="${W - padR}" y2="${yOf(opts.threshold)}"
         stroke="var(--red)" stroke-width="1.5" stroke-dasharray="6 4"/>
         <text x="${W - padR}" y="${yOf(opts.threshold) - 5}" text-anchor="end" fill="var(--red)" font-size="11">阈值 ${esc(
           opts.yFormat ? opts.yFormat(opts.threshold) : String(opts.threshold),
         )}</text>`
      : '';

  const legend = series
    .map(
      (s) =>
        `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`,
    )
    .join('');

  return `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${gridLines}${xTicks}${paths}${thresholdLine}
  </svg><div class="legend">${legend}</div>`;
}

/** 横向条形图(用于对比) */
export function barChart(
  items: Array<{ label: string; value: number; color?: string; suffix?: string }>,
  opts: { max?: number; format?: (v: number) => string } = {},
): string {
  const max = opts.max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return `<div style="display:flex;flex-direction:column;gap:9px">
    ${items
      .map((i) => {
        const pctW = Math.max(2, (Math.abs(i.value) / max) * 100);
        const color = i.color ?? 'var(--accent)';
        const text = opts.format ? opts.format(i.value) : `${i.value}${i.suffix ?? ''}`;
        return `<div style="display:grid;grid-template-columns:150px 1fr 70px;align-items:center;gap:10px">
          <span class="mini" title="${esc(i.label)}">${esc(i.label)}</span>
          <div class="bar"><span style="width:${pctW}%;background:${color}"></span></div>
          <span class="mono mini" style="text-align:right">${esc(text)}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

/** 仪表盘式预算环 */
export function budgetGauge(frac: number | null): string {
  if (frac === null || !Number.isFinite(frac)) return '<span class="muted">—</span>';
  const clamped = Math.max(0, Math.min(1, frac));
  const R = 34;
  const C = 2 * Math.PI * R;
  const color = frac <= 0 ? 'var(--red)' : frac < 0.25 ? 'var(--red)' : frac < 0.5 ? 'var(--orange)' : 'var(--green)';
  const offset = C * (1 - clamped);
  return `<svg width="84" height="84" viewBox="0 0 84 84">
    <circle cx="42" cy="42" r="${R}" fill="none" stroke="var(--panel2)" stroke-width="8"/>
    <circle cx="42" cy="42" r="${R}" fill="none" stroke="${color}" stroke-width="8"
      stroke-dasharray="${C}" stroke-dashoffset="${offset}" stroke-linecap="round"
      transform="rotate(-90 42 42)"/>
    <text x="42" y="46" text-anchor="middle" fill="${color}" font-size="16" font-weight="700">${(
      clamped * 100
    ).toFixed(0)}%</text>
  </svg>`;
}

export function sparkline(points: Point[], color = 'var(--accent)'): string {
  if (points.length < 2) return '<span class="muted">—</span>';
  const W = 120;
  const H = 32;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const d = points
    .map((p, i) => {
      const x = ((p.x - minX) / Math.max(1, maxX - minX)) * W;
      const y = H - ((p.y - minY) / Math.max(1e-9, maxY - minY)) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg width="${W}" height="${H}" class="svg-chart" style="max-width:${W}px"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/></svg>`;
}
