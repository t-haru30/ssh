import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";
import { clearRoutePhotoCache } from "./useRoutePhoto";
vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: ({ route, onClose }: { route: { title: string }; onClose: () => void }) => <div role="dialog" aria-label={route.title}><button onClick={onClose}>閉じる</button></div> }));
vi.mock("../localPlaces", () => ({ localOrigins: { kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 } }, localPlaces: Array.from({ length: 8 }, (_, i) => ({ id: `facility-${i}`, name: `博物館${i}`, category: "博物館", latitude: 34.985849 + i * .005, longitude: 135.758766, themes: ["history"], tags: { area: "kyoto" }, description: "", access_point: "" })) }));
const illustrationResponse = { ok: true, json: async () => ({ status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }) };
beforeEach(() => { clearRoutePhotoCache(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(illustrationResponse)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function renderDiscoverMode(onPlanInSearch = vi.fn()) { return render(<PrefectureProvider><FavoritesProvider><DiscoverMode active onPlanInSearch={onPlanInSearch} /></FavoritesProvider></PrefectureProvider>); }
function favorites() { return JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]"); }
function count() { return Number(screen.getByText(/^[0-9]+件の候補$/).textContent?.replace("件の候補", "")); }
describe("DiscoverMode dynamic facilities", () => {
  it("keeps draft edits idle and aborts hidden tabs without restarting", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/discover" ? new Promise(() => {}) : Promise.resolve(illustrationResponse));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PrefectureProvider><FavoritesProvider><DiscoverMode active /></FavoritesProvider></PrefectureProvider>);
    const total = count();
    fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
    fireEvent.click(screen.getByRole("button", { name: "半日" }));
    await act(async () => {});
    expect(count()).toBe(total);
    expect(screen.getByText("すべての気分 · 時間の指定なし")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    const first = fetchMock.mock.calls.find(([url]) => url === "/api/discover")!;
    fireEvent.click(screen.getByRole("button", { name: "おまかせ" }));
    expect(first[1]?.signal?.aborted).toBe(false);
    view.rerender(<PrefectureProvider><FavoritesProvider><DiscoverMode active={false} /></FavoritesProvider></PrefectureProvider>);
    expect(first[1]?.signal?.aborted).toBe(true);
    view.rerender(<PrefectureProvider><FavoritesProvider><DiscoverMode active /></FavoritesProvider></PrefectureProvider>);
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(1);
  });
  it("collapses mobile conditions on apply and reopens them without requesting again", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(max-width: 800px)" })));
    const fetchMock = vi.fn((url: string) => url === "/api/discover" ? new Promise(() => {}) : Promise.resolve(illustrationResponse));
    vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode();
    fireEvent.change(screen.getByLabelText("都道府県"), { target: { value: "osaka" } });
    expect(screen.getByRole("heading", { name: "京都府周辺の旅のプラン" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    expect(screen.getByRole("heading", { name: "大阪府周辺の旅のプラン" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /旅の条件/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "都道府県" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /条件を変更/ }));
    await waitFor(() => expect(screen.getByLabelText("都道府県")).toBeTruthy());
    expect(screen.getByRole("button", { name: /旅の条件/ }).getAttribute("aria-expanded")).toBe("true");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(1);
  });
  it("labels a failed agent request as ordinary candidates and allows retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/discover" ? { ok: false } : illustrationResponse));
    renderDiscoverMode(); fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    await waitFor(() => expect(screen.getByText(/AIの提案を取得できませんでした/)).toBeTruthy());
    expect(screen.queryByText(/AIが選んだおすすめ/)).toBeNull();
    expect((screen.getByRole("button", { name: /この条件で探す/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each(["failure", "cancel"] as const)("restarts fallback browsing after a same-condition retry ends in %s", async (outcome) => {
    const onPlan = vi.fn();
    renderDiscoverMode(onPlan);
    const fallbackTotal = count();
    fireEvent.click(screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ }));
    const firstFallback = onPlan.mock.calls[0][0];
    const apiRoutes = Array.from({ length: 3 }, (_, i) => ({ ...firstFallback, id: `api-route-${i}`, title: `AI候補${i}` }));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url !== "/api/discover") return Promise.resolve(illustrationResponse);
      calls += 1;
      if (calls === 1) return Promise.resolve({ ok: true, json: async () => ({ routes: apiRoutes, note: "initial API collection" }) });
      return outcome === "failure" ? Promise.resolve({ ok: false }) : new Promise(() => {});
    }));
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    await waitFor(() => expect(count()).toBe(3));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    if (outcome === "cancel") fireEvent.click(screen.getByRole("button", { name: "検索を中止する" }));
    await waitFor(() => expect(screen.getByText(outcome === "failure" ? /AIの提案を取得できませんでした/ : /AIの提案を中止しました/)).toBeTruthy());
    expect(screen.getByText(`1 / ${fallbackTotal}`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "← 前の候補" }) as HTMLButtonElement).disabled).toBe(true);
    onPlan.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ }));
    expect(onPlan).toHaveBeenCalledWith(firstFallback, true);
  });
  it("moves from the introduction to candidates and back to conditions without generating another route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(illustrationResponse); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode();
    fireEvent.click(screen.getByRole("button", { name: /旅の候補を見る/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "京都府周辺の旅のプラン" }));
    fireEvent.click(screen.getByRole("button", { name: /条件を変更/ }));
    await waitFor(() => expect(document.activeElement?.className).toBe("discover-filters"));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
  });
  it("composes local facilities without requesting the discovery API or using the five canned routes", () => {
    const fetchMock = vi.fn().mockResolvedValue(illustrationResponse); vi.stubGlobal("fetch", fetchMock); renderDiscoverMode();
    expect(screen.getByRole("heading", { name: "京都府周辺の旅のプラン" })).toBeTruthy();
    expect(count()).toBeGreaterThan(1); expect(screen.getAllByText(/博物館/).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
  });
  it("opens details, toggles save, and browses independently while retaining saves", async () => {
    const onPlan = vi.fn(); renderDiscoverMode(onPlan); const total = count();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ }));
    const route = onPlan.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "詳細を見る" }));
    expect(screen.getByRole("dialog", { name: route.title })).toBeTruthy();
    expect(favorites()).toHaveLength(0);
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(favorites()).toHaveLength(1);
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存済み" }));
    expect(favorites()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    await waitFor(() => expect(screen.getByText(`2 / ${total}`)).toBeTruthy());
    expect(favorites()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "← 前の候補" }));
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存済み" }).getAttribute("aria-pressed")).toBe("true");
    expect(favorites()).toHaveLength(1);
  });
  it("passes the visible conditions to backend generation and refreshes the variation", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/discover"
      ? { ok: true, json: async () => ({ routes: [], note: "server result" }) } : illustrationResponse); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode(); fireEvent.click(screen.getByText(/移動範囲を変更/)); fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } }); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" })); fireEvent.click(screen.getByRole("button", { name: "半日" }));
    expect((screen.getByRole("button", { name: "別の組み合わせ" }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    await waitFor(() => expect(screen.getByText("server result")).toBeTruthy());
    const discoverCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/discover");
    expect(discoverCalls).toHaveLength(1); const [, init] = discoverCalls[0]; expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ area: "kyoto", theme: "history", course: "half_day", radius_km: 12, cross_prefecture: false, variation: 0, count: 12 });
    fireEvent.click(screen.getByRole("button", { name: "別の組み合わせ" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(2));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([url]) => url === "/api/discover")[1][1]?.body)).variation).toBe(1);
  });
  it("supersedes a pending request only when the new draft is applied and ignores its late result", async () => {
    let resolve!: (v: unknown) => void; const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/discover"
      ? new Promise(r => { resolve = r; }) : Promise.resolve(illustrationResponse)); vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode(); fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    const signal = fetchMock.mock.calls.find(([url]) => url === "/api/discover")![1]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "グルメ" })); expect(signal.aborted).toBe(false);
    const firstResolve = resolve;
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ })); expect(signal.aborted).toBe(true);
    await act(async () => { firstResolve({ ok: true, json: async () => ({ routes: [], note: "stale result" }) }); });
    await waitFor(() => expect(screen.queryByText("stale result")).toBeNull()); expect(count()).toBe(0);
  });
  it("plans the currently visible route after saving and moving to the next candidate", async () => {
    const onPlan = vi.fn(); renderDiscoverMode(onPlan);
    await act(async () => {});
    const plan = screen.getByRole("button", { name: /この条件で乗換つきの経路を作る/ });
    fireEvent.click(plan); const first = onPlan.mock.calls[0][0]; onPlan.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    await act(async () => {});
    fireEvent.click(plan); expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({ area: "kyoto" }), true);
    expect(onPlan.mock.calls[0][0].id).not.toBe(first.id);
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
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
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
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    fireEvent.click(screen.getByRole("button", { name: "待機をやめる" }));
    await act(async () => replies.forEach(reply => reply()));
    expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
    clearRoutePhotoCache();
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
    fireEvent.click(screen.getByRole("button", { name: /この条件で探す/ }));
    await act(async () => replies.forEach(reply => reply()));
    expect(count()).toBe(0);
    expect(screen.queryByText("次のカードの写真を準備しています…")).toBeNull();
  });
  it("keeps previous disabled during photo preparation and allows it after cancellation", async () => {
    const replies: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(illustrationResponse)
      .mockResolvedValueOnce(illustrationResponse).mockResolvedValueOnce(illustrationResponse)
      .mockImplementation(() => new Promise(resolve => replies.push(() => resolve(illustrationResponse)))));
    renderDiscoverMode(); const total = count();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    expect(screen.getByText(`3 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "次へ →" }));
    expect(screen.getByText("次のカードの写真を準備しています…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "← 前の候補" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "待機をやめる" }));
    fireEvent.click(screen.getByRole("button", { name: "← 前の候補" }));
    await act(async () => replies.forEach(reply => reply()));
    expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
    expect(screen.queryByText("次のカードの写真を準備しています…")).toBeNull();
  });
});
