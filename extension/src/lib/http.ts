export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Native `fetch` must be invoked with the global scope as its receiver. Passing the bare
 * function into a client and calling it as `this.http(...)` throws "Illegal invocation"
 * in extension service workers, so everything goes through this wrapper.
 */
export const browserFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * 外部请求（B站 接口 / 字幕 CDN / AI / Notion / Webhook）统一要有超时：MV3 的 fetch 没有
 * 默认上限，而流水线整条跑在按记录锁里，一个挂住的连接会连带卡住同一记录的笔记保存与互动刷新。
 * 这里的 15 秒是默认档，需要更长时间的调用（AI 摘要、Notion 上传）在调用处显式传入。
 */
export const REQUEST_TIMEOUT_MS = 15_000;
