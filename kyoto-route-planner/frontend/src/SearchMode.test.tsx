import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchMode } from "./SearchMode";

const SAVED_PLAN_STORAGE_KEY = "kyoto-route-planner:saved-plan:v1";
const SEARCH_FORM_STORAGE_KEY = "kyoto-route-planner:search-form:v1";
const savedRoute = {
  places: [{
    id: "saved-spot",
    name: "保存済みスポット",
    category: "文化",
    description: "保存された候補地",
    access_point: "",
    latitude: 35,
    longitude: 135,
    themes: ["history"],
  }],
  origin: { name: "京都駅", latitude: 35, longitude: 135 },
  legs: [],
  title: "保存済みルート",
  story: "前回の検索結果",
  total_minutes: null,
  departure_time: "09:00",
  arrival_time: null,
  timeline: [],
  note: "テスト用",
  coordinates: [],
};

vi.mock("./LazyMapView", () => ({ LazyMapView: () => null }));
vi.mock("./IdeaDeck", () => ({ IdeaDeck: () => null }));
vi.mock("./RouteTimeline", () => ({
  buildDayTimeline: () => [],
  buildRouteTimeline: () => [],
  RouteTimeline: () => null,
  withRouteLegs: (items: unknown) => items,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SearchMode nearby departures", () => {
  it("loads nearby station and stop options and submits the selected coordinates", async () => {
    const origins = [
      { name: "京都駅", latitude: 35.0, longitude: 135.0 },
      { name: "大阪駅", latitude: 34.7, longitude: 135.5 },
    ];
    const nearbyStations = [
      { name: "最寄りバス停", latitude: 35.001, longitude: 135.001 },
      { name: "周辺地下鉄駅", latitude: 35.002, longitude: 135.002 },
    ];
    let submittedRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = url.includes("/api/origins")
        ? origins
        : url.includes("/api/nearby-stations")
          ? nearbyStations
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
      if (url.includes("/api/routes")) {
        submittedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { ok: false, json: async () => ({ detail: "test complete" }) } as Response;
      }
      return { ok: true, json: async () => json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({
        coords: { latitude: 35.123, longitude: 135.456 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    render(<SearchMode active />);

    const departureSelect = (await screen.findAllByRole("combobox"))[0];
    const locationButton = await screen.findByRole("button", { name: "現在地から探す" });
    await waitFor(() => expect((locationButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(locationButton);

    const nearbyGroup = await screen.findByRole("group", { name: "現在地周辺" });
    await waitFor(() => expect((departureSelect as HTMLSelectElement).value).toBe("最寄りバス停"));
    expect(nearbyGroup.textContent).toContain("最寄りバス停");
    expect(screen.getByRole("group", { name: "主要駅" }).textContent).toContain("京都駅");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nearby-stations?latitude=35.123&longitude=135.456",
      expect.anything(),
    );

    fireEvent.change(departureSelect, { target: { value: "周辺地下鉄駅" } });
    fireEvent.click(screen.getByRole("button", { name: /旅のしおりを作る/ }));
    await waitFor(() => expect(submittedRequest).not.toBeNull());
    expect(submittedRequest).toMatchObject({
      origin: "周辺地下鉄駅",
      origin_latitude: 35.002,
      origin_longitude: 135.002,
    });
  });

  it("shows an empty-route fallback and allows retrying the search", async () => {
    const routeRequests = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/routes")) {
        routeRequests();
        return { ok: true, json: async () => ({ routes: [] }) } as Response;
      }
      if (url.includes("/api/origins")) {
        return { ok: true, json: async () => [{ name: "京都駅", latitude: 35, longitude: 135 }] } as Response;
      }
      if (url.includes("/api/places/status")) {
        return { ok: true, json: async () => ({ warning: null, state: "success" }) } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }));

    render(<SearchMode active />);

    fireEvent.click(await screen.findByRole("button", { name: /旅のしおりを作る/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("スポットが見つかりませんでした");

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(routeRequests).toHaveBeenCalledTimes(2));
  });

  it("restores a saved route and form, then persists form changes", async () => {
      window.localStorage.setItem(SAVED_PLAN_STORAGE_KEY, JSON.stringify({
        suggestions: [savedRoute],
        overnightSuggestion: null,
      }));
      window.localStorage.setItem(SEARCH_FORM_STORAGE_KEY, JSON.stringify({
        originName: "大阪駅",
        nearbyStations: [],
        theme: "history",
        mood: "静かな場所",
        stopCount: 2,
        departureDate: "2026-10-13",
        departureTime: "10:30",
        isOvernight: false,
        regenerationCount: 0,
      }));
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = url.includes("/api/origins")
          ? [
            { name: "京都駅", latitude: 35, longitude: 135 },
            { name: "大阪駅", latitude: 34.7, longitude: 135.5 },
          ]
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
        return { ok: true, json: async () => json } as Response;
      }));

      render(<SearchMode active />);

      expect(await screen.findAllByRole("heading", { name: "保存済みルート" })).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "条件を変更する" }));
      expect((await screen.findAllByRole("combobox"))[0]).toHaveProperty("value", "大阪駅");
      expect(screen.getByRole("button", { name: /歴史・文化/ }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("出発日")).toHaveProperty("value", "2026-10-13");

      fireEvent.click(screen.getByRole("button", { name: "1泊2日" }));
      await waitFor(() => {
        const savedForm = JSON.parse(window.localStorage.getItem(SEARCH_FORM_STORAGE_KEY) ?? "{}");
        expect(savedForm.isOvernight).toBe(true);
      });
      expect(screen.getByRole("textbox")).toHaveProperty("value", "静かな場所");
  });

  it("saves route results returned by the route API", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/routes")) {
          return { ok: true, json: async () => ({ routes: [savedRoute] }) } as Response;
        }
        const json = url.includes("/api/origins")
          ? [{ name: "京都駅", latitude: 35, longitude: 135 }]
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
        return { ok: true, json: async () => json } as Response;
      }));

      render(<SearchMode active />);
      fireEvent.click(await screen.findByRole("button", { name: /旅のしおりを作る/ }));

      await waitFor(() => {
        const savedPlan = JSON.parse(window.localStorage.getItem(SAVED_PLAN_STORAGE_KEY) ?? "{}");
        expect(savedPlan.suggestions?.[0]?.title).toBe("保存済みルート");
    });
  });
});
