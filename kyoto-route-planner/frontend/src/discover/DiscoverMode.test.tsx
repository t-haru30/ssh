import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";
import { clearRoutePhotoCache } from "./useRoutePhoto";
vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: () => null }));
vi.mock("../localPlaces", () => ({ localOrigins: { kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 } }, localPlaces: Array.from({ length: 8 }, (_, i) => ({ id: `facility-${i}`, name: `博物館${i}`, category: "博物館", latitude: 34.985849 + i * .005, longitude: 135.758766, themes: ["history"], tags: { area: "kyoto" }, description: "", access_point: "" })) }));
const illustrationResponse = { ok: true, json: async () => ({ status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }) };
beforeEach(() => { clearRoutePhotoCache(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(illustrationResponse)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function renderDiscoverMode(onPlanInSearch = vi.fn()) { return render(<PrefectureProvider><FavoritesProvider><DiscoverMode active onPlanInSearch={onPlanInSearch} /></FavoritesProvider></PrefectureProvider>); }
function count() { return Number(screen.getByText(/^[0-9]+件の候補$/).textContent?.replace("件の候補", "")); }
describe("DiscoverMode dynamic facilities", () => {
  it("restarts an interrupted AI selection when conditions rapidly return to the previous choice", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/discover" ? new Promise(() => {}) : Promise.resolve(illustrationResponse));
    vi.stubGlobal("fetch", fetchMock); renderDiscoverMode();
    await act(async () => vi.advanceTimersByTime(650));
    const first = fetchMock.mock.calls.find(([url]) => url === "/api/discover")!;
    fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
    fireEvent.click(screen.getByRole("button", { name: "おまかせ" }));
    expect(first[1]?.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(650));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(2);
  });
  it("automatically asks the agent once after conditions settle, and keeps hidden tabs idle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => url === "/api/discover"
      ? { ok: true, json: async () => ({ routes: [], note: "AI result", agent: { status: "ready", message: "AIが行き先を選びました。" } }) } : illustrationResponse);
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PrefectureProvider><FavoritesProvider><DiscoverMode active={false} /></FavoritesProvider></PrefectureProvider>);
    await act(async () => vi.advanceTimersByTime(1000)); expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<PrefectureProvider><FavoritesProvider><DiscoverMode active /></FavoritesProvider></PrefectureProvider>);
    fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
    await act(async () => vi.advanceTimersByTime(650));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(1);
    expect(screen.getByText("AIが行き先を選びました。")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(1);
  });
  it("labels a failed agent request as ordinary candidates and allows retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/discover" ? { ok: false } : illustrationResponse));
    renderDiscoverMode(); fireEvent.click(screen.getByRole("button", { name: /経路を見つける/ }));
    await waitFor(() => expect(screen.getByText(/AIの提案を取得できませんでした/)).toBeTruthy());
    expect(screen.queryByText(/AIが選んだおすすめ/)).toBeNull();
    expect((screen.getByRole("button", { name: /経路を見つける/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("moves from the introduction to candidates and back to conditions without generating another route", () => {
    const fetchMock = vi.fn().mockResolvedValue(illustrationResponse); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode();
    fireEvent.click(screen.getByRole("button", { name: /旅の候補を見る/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "京都府周辺の旅のプラン" }));
    fireEvent.click(screen.getByRole("button", { name: /条件を変更/ }));
    expect(document.activeElement?.className).toBe("discover-filters");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
  });
  it("composes local facilities without requesting the discovery API or using the five canned routes", () => {
    const fetchMock = vi.fn().mockResolvedValue(illustrationResponse); vi.stubGlobal("fetch", fetchMock); renderDiscoverMode();
    expect(screen.getByRole("heading", { name: "京都府周辺の旅のプラン" })).toBeTruthy();
    expect(count()).toBeGreaterThan(1); expect(screen.getAllByText(/博物館/).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
  });
  it("saves and undoes a local composition", async () => {
    renderDiscoverMode(); const total = count();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "しおりを開く" }));
    const favorites = JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]");
    expect(favorites).toHaveLength(1); expect(favorites[0].places.every((p: { id: string }) => p.id.startsWith("facility-"))).toBe(true);
    expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]")).toHaveLength(0); expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
  });
  it("restores browsing position across themes and offers a recovery from an empty theme", async () => {
    renderDiscoverMode(); const total = count(); await act(async () => {}); fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "グルメ" })); expect(count()).toBe(0);
    expect((screen.getByRole("button", { name: "しおりを開く" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "すべての候補を見る" })); expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
  });
  it("passes the visible conditions to backend generation and refreshes the variation", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/discover"
      ? { ok: true, json: async () => ({ routes: [], note: "server result" }) } : illustrationResponse); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode(); fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } }); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" })); fireEvent.click(screen.getByRole("button", { name: "半日" }));
    fireEvent.click(screen.getByRole("button", { name: /別の組み合わせを見る/ })); fireEvent.click(screen.getByRole("button", { name: /経路を見つける/ }));
    await waitFor(() => expect(screen.getByText("server result")).toBeTruthy());
    const discoverCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/discover");
    expect(discoverCalls).toHaveLength(1); const [, init] = discoverCalls[0]; expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ area: "kyoto", theme: "history", course: "half_day", radius_km: 12, cross_prefecture: false, variation: 1, count: 12 });
  });
  it("cancels a pending request when a filter changes and ignores its late result", async () => {
    let resolve!: (v: unknown) => void; const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/discover"
      ? new Promise(r => { resolve = r; }) : Promise.resolve(illustrationResponse)); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode(); fireEvent.click(screen.getByRole("button", { name: /経路を見つける/ }));
    const signal = fetchMock.mock.calls.find(([url]) => url === "/api/discover")![1]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "グルメ" })); expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ ok: true, json: async () => ({ routes: [], note: "stale result" }) }); });
    await waitFor(() => expect(screen.queryByText("stale result")).toBeNull()); expect(count()).toBe(0);
  });
  it("plans the saved route after skipping subsequent candidates", async () => {
    const onPlan = vi.fn(); renderDiscoverMode(onPlan);
    await act(async () => {});
    const plan = screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ });
    fireEvent.click(plan); const first = onPlan.mock.calls[0][0]; onPlan.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "しおりを開く" }));
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(plan); expect(onPlan).toHaveBeenCalledWith(first, true);
  });

  it("requests transport planning from the bottom action", () => {
    const onPlan = vi.fn(); renderDiscoverMode(onPlan);
    fireEvent.click(screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ }));
    expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({ area: "kyoto", spots: expect.any(Array) }), true);
  });
  it("keeps the current card until the already-prefetched next photo has decoded", async () => {
    const replies: Array<() => void> = [];
    const decoded: Array<() => void> = [];
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      complete = false; naturalWidth = 0; decoding = "";
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
      decode() { return new Promise<void>(resolve => decoded.push(resolve)); }
      removeAttribute() {}
    });
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise(resolve => {
      const place = JSON.parse(String(init?.body)).places[0];
      replies.push(() => resolve({ ok: true, json: async () => ({ status: "ready", place_id: place.id, place_name: place.name,
        image_url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${place.id}.jpg`,
        author_name: "Author", source_url: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
        license_name: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0/",
        image_verified: true, ai_checked: false, note: "" }) }));
    })));
    renderDiscoverMode(); const total = count();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    expect(screen.getByText("次のカードの写真を準備しています…")).toBeTruthy();
    await act(async () => replies.forEach(reply => reply()));
    await waitFor(() => expect(decoded).toHaveLength(3));
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => decoded.forEach(complete => complete()));
    await waitFor(() => expect(screen.getByText(`2 / ${total}`)).toBeTruthy());
    expect(screen.queryByText("次のカードの写真を準備しています…")).toBeNull();
  });
  it("does not advance after a pending photo wait is cancelled or its filters change", async () => {
    const replies: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => replies.push(() => resolve(illustrationResponse)))));
    renderDiscoverMode(); const total = count();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "待機をやめる" }));
    await act(async () => replies.forEach(reply => reply()));
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    clearRoutePhotoCache();
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
    await act(async () => replies.forEach(reply => reply()));
    expect(count()).toBe(0);
    expect(screen.queryByText("次のカードの写真を準備しています…")).toBeNull();
  });
  it("cancels a pending advance when undo is used from the previous action notice", async () => {
    const replies: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(illustrationResponse)
      .mockResolvedValueOnce(illustrationResponse).mockResolvedValueOnce(illustrationResponse)
      .mockImplementation(() => new Promise(resolve => replies.push(() => resolve(illustrationResponse)))));
    renderDiscoverMode(); const total = count();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    expect(screen.getByText(`3 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    expect(screen.getByText("次のカードの写真を準備しています…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    await act(async () => replies.forEach(reply => reply()));
    expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
    expect(screen.queryByText("次のカードの写真を準備しています…")).toBeNull();
  });
});
