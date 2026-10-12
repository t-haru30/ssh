import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";
vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: () => null }));
vi.mock("../localPlaces", () => ({ localOrigins: { kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 } }, localPlaces: Array.from({ length: 8 }, (_, i) => ({ id: `facility-${i}`, name: `博物館${i}`, category: "博物館", latitude: 34.985849 + i * .005, longitude: 135.758766, themes: ["history"], tags: { area: "kyoto" }, description: "", access_point: "" })) }));
const illustrationResponse = { ok: true, json: async () => ({ status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }) };
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(illustrationResponse)));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function renderDiscoverMode(onPlanInSearch = vi.fn()) { return render(<PrefectureProvider><FavoritesProvider><DiscoverMode active onPlanInSearch={onPlanInSearch} /></FavoritesProvider></PrefectureProvider>); }
function count() { return Number(screen.getByText(/^[0-9]+件の候補$/).textContent?.replace("件の候補", "")); }
describe("DiscoverMode dynamic facilities", () => {
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
  it("saves and undoes a local composition", () => {
    renderDiscoverMode(); const total = count();
    fireEvent.click(screen.getByRole("button", { name: "しおりを開く" }));
    const favorites = JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]");
    expect(favorites).toHaveLength(1); expect(favorites[0].places.every((p: { id: string }) => p.id.startsWith("facility-"))).toBe(true);
    expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]")).toHaveLength(0); expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
  });
  it("restores browsing position across themes and offers a recovery from an empty theme", () => {
    renderDiscoverMode(); const total = count(); fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
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
  it("plans the saved route after skipping subsequent candidates", () => {
    const onPlan = vi.fn(); renderDiscoverMode(onPlan);
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
});
