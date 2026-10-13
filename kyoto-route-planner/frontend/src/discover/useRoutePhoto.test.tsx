import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../types";
import { clearRoutePhotoCache, useRoutePhoto } from "./useRoutePhoto";
const place: Place = { id: "a", name: "施設A", category: "寺院", description: "", access_point: "", latitude: 35, longitude: 135, themes: ["temple"] };
const photo = { status: "ready", place_id: "a", place_name: "施設A", image_url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg", author_name: "Author", source_url: "https://commons.wikimedia.org/wiki/File:Test.jpg", license_name: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0/", image_verified: true, ai_checked: true, note: "" };
const response = (value: unknown) => ({ ok: true, json: async () => value });
beforeEach(() => { clearRoutePhotoCache(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(photo))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("useRoutePhoto", () => {
  it("posts only the first three places once in StrictMode, and does not run while inactive", async () => {
    const places = [place, ...["b","c","d"].map(id => ({ ...place, id }))];
    const view = renderHook(({ enabled }) => useRoutePhoto(places, enabled), { initialProps: { enabled: false }, wrapper: StrictMode });
    await act(async () => {}); expect(fetch).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ places: places.slice(0,3) });
  });
  it("caches an identical route but preserves facility order priority", async () => {
    const b = { ...place, id: "b" };
    const view = renderHook(({ places }) => useRoutePhoto(places, true), { initialProps: { places: [place,b] } });
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    view.unmount();
    const next = renderHook(() => useRoutePhoto([place,b], true));
    await waitFor(() => expect(next.result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledOnce();
    next.rerender();
    next.unmount();
    const reordered = renderHook(() => useRoutePhoto([b,place], true));
    await waitFor(() => expect(reordered.result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not double post on an initially active StrictMode mount", async () => {
    const view = renderHook(() => useRoutePhoto([place], true), { wrapper: StrictMode });
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["https://creativecommons.org/licenses/by-sa/3.0", "https://creativecommons.org/licenses/by-sa/3.0/"])("accepts actual thumbnail responses with license %s", async license_url => {
    const actual = { ...photo, image_url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Test.jpg/960px-Test.jpg", license_name: "CC BY-SA 3.0", license_url };
    vi.mocked(fetch).mockResolvedValue(response(actual) as Response);
    const view = renderHook(() => useRoutePhoto([place], true));
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(view.result.current.photo).toEqual(actual);
  });
  it.each([{ place_name: "別施設" }, { place_id: "unknown" }, { image_verified: "true" }, { image_url: "https://evil.example/photo.jpg" }, { image_url: "https://thumb.wikimedia.org.evil.example/photo.jpg" }, { image_url: "https://fake.thumb.wikimedia.org/photo.jpg" }, { source_url: "https://commons.wikimedia.org/wiki/Other" }, { license_url: "https://evil.example/license" }, { license_url: "https://creativecommons.org/licenses/by-sa/3.0?tracking=x" }, { license_url: "https://creativecommons.org/licenses/by-sa/3.0#license" }, { license_url: "https://user@creativecommons.org/licenses/by-sa/3.0" }, { author_name: "" }])("rejects invalid identity or attribution %j", async invalid => {
    vi.mocked(fetch).mockResolvedValue(response({ ...photo, ...invalid }) as Response);
    const view = renderHook(() => useRoutePhoto([place], true));
    await waitFor(() => expect(view.result.current.status).toBe("unavailable"));
    expect(view.result.current.photo).toBeNull();
  });
  it("aborts hidden requests and ignores stale replies", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const view = renderHook(({ enabled }) => useRoutePhoto([place], enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    view.rerender({ enabled: false }); expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(photo) as Response));
    expect(view.result.current.photo).toBeNull();
  });
  it("ends at 30 seconds without automatically retrying", async () => {
    vi.useFakeTimers(); vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const view = renderHook(() => useRoutePhoto([place], true));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(view.result.current.status).toBe("unavailable");
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(60_000)); expect(fetch).toHaveBeenCalledOnce();
  });
});
