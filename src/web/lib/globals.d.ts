// 前端全局过滤状态(轻量,无需状态管理库)
declare global {
  interface Window {
    __sloFilter?: { kw?: string; tier?: string; detector?: string; severity?: string };
  }
}
export {};
