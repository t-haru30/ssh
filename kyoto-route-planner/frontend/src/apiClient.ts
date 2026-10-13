/** Abort both on explicit cancellation and on a bounded provider wait. */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = window.setTimeout(abort, timeoutMs);
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { window.clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

export async function readApiError(response: Response) {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "detail" in payload && typeof payload.detail === "string") return payload.detail;
  } catch { /* Reverse proxies may return HTML instead of JSON. */ }
  return "ルートを取得できませんでした。時間をおいて再試行してください。";
}
