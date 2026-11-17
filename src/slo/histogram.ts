import { HIST_BINS, LATENCY_EDGES } from '../shared/types.js';

/**
 * 延迟直方图:17 个 bin。
 * bin i (0..15):[0, edges[i]) 语义的累积边界计数,采用标准边界定义:
 *   bin i 计数 = 延迟落在 [edge_{i-1}, edge_i) 的请求数(edge_{-1}=0)
 *   bin 16 = 延迟 >= edges[15] 的请求数
 * 每个 bin 计数用 uint16 LE(演示流量上限内足够,超出截断到 65535)。
 */

export function emptyHist(): Uint16Array {
  return new Uint16Array(HIST_BINS);
}

export function encodeHist(hist: Uint16Array): Buffer {
  const buf = Buffer.alloc(HIST_BINS * 2);
  for (let i = 0; i < HIST_BINS; i++) {
    buf.writeUInt16LE(Math.min(hist[i], 65535), i * 2);
  }
  return buf;
}

export function decodeHist(blob: Buffer | Uint8Array): Uint16Array {
  const hist = new Uint16Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) {
    hist[i] = blob[i * 2]! | (blob[i * 2 + 1]! << 8);
  }
  return hist;
}

/** 落一个延迟样本到对应 bin */
export function addSample(hist: Uint16Array, latencyMs: number): void {
  let idx = HIST_BINS - 1;
  for (let i = 0; i < LATENCY_EDGES.length; i++) {
    if (latencyMs < LATENCY_EDGES[i]) {
      idx = i;
      break;
    }
  }
  hist[idx] = Math.min(hist[idx] + 1, 65535);
}

/**
 * 线性插值估算分位数。q 取 0..1。
 */
export function quantile(hist: Uint16Array, q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = q * total;
  let cum = 0;
  let prevEdge = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    const count = hist[i];
    if (cum + count >= target) {
      // 在 bin i 内部插值:[prevEdge, upperEdge)
      const upperEdge = i < LATENCY_EDGES.length ? LATENCY_EDGES[i] : LATENCY_EDGES[LATENCY_EDGES.length - 1] * 2;
      if (count === 0) return upperEdge;
      const frac = (target - cum) / count;
      return prevEdge + frac * (upperEdge - prevEdge);
    }
    cum += count;
    prevEdge = i < LATENCY_EDGES.length ? LATENCY_EDGES[i] : prevEdge;
  }
  return LATENCY_EDGES[LATENCY_EDGES.length - 1];
}

/** 延迟 <= thresholdMs 的请求数(延迟 SLO 的 good 计数) */
export function countBelow(hist: Uint16Array, thresholdMs: number): number {
  let sum = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    const upperEdge =
      i < LATENCY_EDGES.length ? LATENCY_EDGES[i] : LATENCY_EDGES[LATENCY_EDGES.length - 1] * 2;
    if (upperEdge <= thresholdMs) {
      sum += hist[i];
    } else {
      // 跨界 bin 线性插值
      const lowerEdge = i === 0 ? 0 : LATENCY_EDGES[i - 1];
      if (thresholdMs > lowerEdge && hist[i] > 0) {
        const frac = (thresholdMs - lowerEdge) / (upperEdge - lowerEdge);
        sum += hist[i] * Math.max(0, Math.min(1, frac));
      }
      break;
    }
  }
  return Math.round(sum);
}

/** 把两个直方图相加(用于窗口聚合),返回新数组 */
export function mergeHist(a: Uint16Array, b: Uint16Array): Uint16Array {
  const out = new Uint16Array(HIST_BINS);
  for (let i = 0; i < HIST_BINS; i++) out[i] = Math.min(a[i] + b[i], 65535);
  return out;
}
