import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../types";
import { routeIllustrationRequest, useRouteIllustration } from "./useRouteIllustration";

const keyA = "a".repeat(64);
const keyB = "b".repeat(64);
let serial = 0;
const places: Place[] = ["公園", "博物館"].map((name, i) => ({
  id: `place-${i}`, name, category: i ? "博物館" : "公園", description: `施設紹介${i}`,
  latitude: 35 + i * .01, longitude: 135, access_point: "駅から徒歩", themes: ["history"],
  address: "共有しない住所", tags: { private: "共有しない値" },
}));
function request() { return routeIllustrationRequest(`旅のタイトル${++serial}`, "history", places); }
function response(status: string, key = keyA, overrides = {}) {
  return { ok: true, json: async () => ({ status, key, image_url: status === "ready" ? `/api/route-illustrations/${key}/image` : null, note: "fixture", ...overrides }) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useRouteIllustration", () => {
  it("posts the title, theme and ordered facility details without unrelated place metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("ready")); vi.stubGlobal("fetch", fetchMock);
    const input = request(); const { result } = renderHook(() => useRouteIllustration(input, true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/route-illustrations"); expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ title: input.title, theme: "history", places: places.map(({ id, name, category, description, latitude, longitude }) => ({ id, name, category, description, latitude, longitude })) });
    expect(result.current.imageUrl).toBe(`/api/route-illustrations/${keyA}/image`);
  });

  it("does not start in the background and starts once enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("disabled")); vi.stubGlobal("fetch", fetchMock);
    const input = request(); const view = renderHook(({ enabled }) => useRouteIllustration(input, enabled), { initialProps: { enabled: false } });
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });

  it("polls pending jobs every two seconds with GET and never repeats the generation POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(response("pending")).mockResolvedValueOnce(response("pending")).mockResolvedValueOnce(response("ready"));
    vi.stubGlobal("fetch", fetchMock);
    const input = request(); const view = renderHook(() => useRouteIllustration(input, true));
    await act(async () => {});
    expect(view.result.current.status).toBe("pending");
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/route-illustrations/${keyA}`);
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(view.result.current.status).toBe("ready");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("reuses completed images across remounts and evicts results beyond the 32-image cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("ready")); vi.stubGlobal("fetch", fetchMock);
    const first = request();
    async function mount(input = first) {
      const view = renderHook(() => useRouteIllustration(input, true));
      await act(async () => {}); expect(view.result.current.status).toBe("ready"); view.unmount();
    }
    await mount(); await mount(); expect(fetchMock).toHaveBeenCalledOnce();
    for (let i = 0; i < 32; i++) await mount(request());
    expect(fetchMock).toHaveBeenCalledTimes(33);
    await mount(); expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it("aborts when the route changes and ignores late replies without caching them", async () => {
    let resolveOld!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(response("ready", keyB));
    vi.stubGlobal("fetch", fetchMock);
    const first = request(), second = request();
    const view = renderHook(({ input }) => useRouteIllustration(input, true), { initialProps: { input: first } });
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender({ input: second }); expect(signal.aborted).toBe(true);
    await waitFor(() => expect(view.result.current.key).toBe(keyB));
    await act(async () => { resolveOld(response("ready", keyA)); });
    expect(view.result.current.key).toBe(keyB); view.unmount();
    renderHook(() => useRouteIllustration(first, true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("does not automatically retry disabled, busy or error results", async () => {
    vi.useFakeTimers();
    for (const status of ["disabled", "busy", "error"] as const) {
      const fetchMock = vi.fn().mockResolvedValue(response(status)); vi.stubGlobal("fetch", fetchMock);
      const input = request(); const view = renderHook(() => useRouteIllustration(input, true));
      await act(async () => {}); expect(view.result.current.status).toBe(status);
      await act(async () => { await vi.advanceTimersByTimeAsync(160_000); });
      expect(fetchMock).toHaveBeenCalledOnce(); view.unmount();
    }
  });

  it("rejects malformed responses and remote or mismatched image URLs", async () => {
    for (const data of [response("ready", "invalid-key"), response("unknown"), response("ready", keyA, { image_url: "https://other.example/image.png" }), response("ready", keyA, { image_url: `/api/route-illustrations/${keyB}/image` }), response("ready", keyA, { image_url: null })]) {
      const fetchMock = vi.fn().mockResolvedValue(data); vi.stubGlobal("fetch", fetchMock);
      const input = request(); const view = renderHook(() => useRouteIllustration(input, true));
      await waitFor(() => expect(view.result.current.status).toBe("error"));
      expect(view.result.current.imageUrl).toBeNull(); expect(fetchMock).toHaveBeenCalledOnce(); view.unmount();
    }
  });

  it("cancels scheduled polling when the active card becomes inactive", async () => {
    vi.useFakeTimers(); const fetchMock = vi.fn().mockResolvedValue(response("pending")); vi.stubGlobal("fetch", fetchMock);
    const input = request(); const view = renderHook(({ enabled }) => useRouteIllustration(input, enabled), { initialProps: { enabled: true } });
    await act(async () => {}); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender({ enabled: false }); expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
