// 共享类型与常量
export const BUCKET_SEC = 300; // 5 分钟桶
export const DAY_SEC = 86400;
export const ROLLING_28D_SEC = 28 * DAY_SEC;
// 固定延迟直方图边界(ms)。延迟 SLO 阈值必须取自该集合,
// 这样桶级聚合与逐请求重算严格相等(聚合无损)。
export const HIST_EDGES = [50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000, 10000];
