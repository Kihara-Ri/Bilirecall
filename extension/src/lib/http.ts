export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Native `fetch` must be invoked with the global scope as its receiver. Passing the bare
 * function into a client and calling it as `this.http(...)` throws "Illegal invocation"
 * in extension service workers, so everything goes through this wrapper.
 */
export const browserFetch: FetchLike = (input, init) => fetch(input, init);
