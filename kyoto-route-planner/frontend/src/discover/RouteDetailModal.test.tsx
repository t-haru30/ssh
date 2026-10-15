import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteSuggestion, Origin } from "../types";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { newTripStop, scheduleTrip } from "../dayTrip";
import { serializeJourneyFile } from "../journeyFile";
import { RouteDetailModal } from "./RouteDetailModal";

vi.mock("../GoogleJourneyMap", () => ({ GoogleJourneyMap: ({ origin }: { origin: Origin }) => <div data-testid="map-origin">{origin.name}</div> }));
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ detail: "テスト用のオフライン環境" }) }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const savedRoute: RouteIdea = {
  theme: "history", prefecture_code: "13", prefecture_name: "東京都", title: "東京の街を歩く", story: "休日のConcierGO。",
  places: [{ id: "tokyo-spot", name: "東京の史跡", category: "史跡", latitude: 35.68, longitude: 139.76, description: "", access_point: "", themes: ["history"] }],
  dwell_minutes: { "tokyo-spot": 45 }, image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
  copywriting_source: "fallback", note: "",
};

describe("RouteDetailModal", () => {
  it("shows the dataset's station, each travel mode, stays, lunch and return time", async () => {
    const route: DatasetRoute = {
      id: "station-trip", area: "tokyo", pattern: "half_day", course: "half_day", theme: "history", title: "駅から巡る旅",
      start: { name: "上野駅", lat: 35.7138, lng: 139.7773, to_first_km: 1, from_last_km: 2 },
      estimated_minutes: 150, total_score: 1, center: [35.68, 139.76], coordinates: [],
      spots: [
        { place_id: "park", name: "庭園", category: "公園", lat: 35.71, lng: 139.77, stay_minutes: 45, score: 1, role: "stop" },
        { place_id: "lunch", name: "昼食のお店", category: "レストラン", lat: 35.72, lng: 139.78, stay_minutes: 60, score: 1, role: "lunch" },
      ],
      legs: [
        { from: "上野駅", to: "庭園", distance_km: 1, mode: "walk", minutes: 10 },
        { from: "庭園", to: "昼食のお店", distance_km: 2, mode: "car", minutes: 15 },
        { from: "昼食のお店", to: "上野駅", distance_km: 2, mode: "public_transport", minutes: 20 },
      ],
    };
    render(<RouteDetailModal route={route} onClose={() => {}} />);
    expect(screen.queryByText(/観光の起点：上野駅/)).toBeNull();
    expect(screen.getByText("上野駅を出発")).toBeTruthy();
    expect(screen.getAllByText("移動の内訳")).toHaveLength(3);
    const transitSummaries = screen.getAllByText("移動の内訳");
    expect(transitSummaries[0].closest("details")?.open).toBe(false);
    fireEvent.click(transitSummaries[0]);
    expect(transitSummaries[0].closest("details")?.open).toBe(true);
    fireEvent.click(transitSummaries[0]);
    expect(transitSummaries[0].closest("details")?.open).toBe(false);
    for (const details of transitSummaries) fireEvent.click(details);
    expect(screen.getByText("徒歩で約10分")).toBeTruthy();
    expect(screen.getByText("車で約15分")).toBeTruthy();
    expect(screen.getByText("約20分")).toBeTruthy();
    expect(screen.getByText(/昼ごはん · .*滞在の目安 1時間/)).toBeTruthy();
    expect(screen.getByText("09:10")).toBeTruthy();
    expect(screen.getByText("10:10")).toBeTruthy();
    expect(screen.getByText("帰着の目安 11:30 上野駅")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("map-origin").textContent).toBe("上野駅"));
  });

  it("keeps a saved route's prefecture and stay times when previewing and planning", async () => {
    const onPlan = vi.fn();
    const onClose = vi.fn();
    render(<RouteDetailModal route={savedRoute} onClose={onClose} onPlanInSearch={onPlan} />);
    const dialog = screen.getByRole("dialog");
    const scrollRegion = dialog.querySelector(".discover-modal-scroll");
    const footer = dialog.querySelector(".discover-modal-footer");
    expect(scrollRegion?.contains(dialog.querySelector(".discover-modal-timeline"))).toBe(true);
    expect(scrollRegion?.contains(footer)).toBe(false);
    expect(footer?.parentElement).toBe(dialog);
    expect(screen.queryByText(/観光の起点：東京都・エリア中心/)).toBeNull();
    expect(screen.getByText(/滞在の目安 45分/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("map-origin").textContent).toBe("東京都・エリア中心"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "このルートで旅を計画する" }));
    expect(onPlan).toHaveBeenCalledWith(savedRoute);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("RouteDetailModal", () => {
  it("loads the Ekispert preview and renders its line and corrected times", async () => {
    const route: DatasetRoute = {
      id: "kyoto-sample",
      area: "kyoto",
      pattern: "half_day",
      course: "half_day",
      theme: "temple",
      title: "京都の寺社を巡る",
      estimated_minutes: 120,
      legs: [
        { from: "京都駅", to: "伏見稲荷大社", distance_km: 3, mode: "public_transport", minutes: 10 },
        { from: "伏見稲荷大社", to: "京都駅", distance_km: 3, mode: "public_transport", minutes: 10 },
      ],
      start: { name: "京都駅", lat: 34.985849, lng: 135.758766, to_first_km: 3, from_last_km: 3 },
      total_score: 1,
      center: [34.985849, 135.758766],
      spots: [{
        place_id: "fushimi",
        name: "伏見稲荷大社",
        category: "神社",
        lat: 34.9671,
        lng: 135.7727,
        stay_minutes: 90,
        score: 1,
        role: "stop",
      }],
      coordinates: [[34.9671, 135.7727]],
    };
    const preview: RouteSuggestion = {
      places: [{
        id: "fushimi",
        name: "伏見稲荷大社",
        category: "神社",
        description: "",
        access_point: "",
        latitude: 34.9671,
        longitude: 135.7727,
        themes: ["temple"],
      }],
      origin: {
        name: "京都駅",
        latitude: 34.985849,
        longitude: 135.758766,
      },
      legs: [{
        from_name: "京都",
        to_name: "稲荷",
        line_name: "JR奈良線",
        mode: "train",
        duration_minutes: 5,
      }],
      title: null,
      story: null,
      total_minutes: 35,
      departure_time: "09:00",
      arrival_time: "09:35",
      timeline: [
        {
          type: "spot",
          role: "start",
          place_id: null,
          name: "京都駅",
          category: "出発地",
          time: "09:00",
          stay_minutes: 0,
        },
        {
          type: "transit",
          from_name: "京都駅",
          to_name: "伏見稲荷大社",
          mode: "public_transport",
          transit_line: "移動 / JR奈良線 / 徒歩 / 市バス",
          start_time: "09:02",
          end_time: "09:08",
          duration_minutes: 6,
          is_estimate: false,
        },
      ],
      note: "駅すぱあとAPIで検索しました。",
      coordinates: [
        [34.985849, 135.758766],
        [34.9671, 135.7727],
        [34.985849, 135.758766],
      ],
    };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/routes/preview" ? preview : {places:[],status:"unavailable"}), {status:200}));
    vi.stubGlobal("fetch", fetchMock);

    render(<RouteDetailModal route={route} onClose={() => undefined} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getAllByText("移動の内訳")[0]);
    expect(await screen.findByText("JR奈良線")).toBeTruthy();
    expect(screen.queryByText("公共交通 · JR奈良線")).toBeNull();
    expect(screen.getByText(/運行時刻 09:02〜09:08/)).toBeTruthy();
    expect(screen.queryByText("↓")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/routes/preview",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("hides the location and manual route-search controls", async () => {
    render(<RouteDetailModal route={savedRoute} onClose={() => undefined} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/routes/preview", expect.anything()));
    expect(screen.queryByRole("button", { name: "現在地から出発" })).toBeNull();
    expect(screen.queryByRole("button", { name: "元の出発地に戻す" })).toBeNull();
    expect(screen.queryByRole("button", { name: "交通経路を再検索する" })).toBeNull();
    expect(screen.queryByText("この旅で訪れる場所")).toBeNull();
    expect(screen.queryByText("この場所の見どころ")).toBeNull();
  });
});

it("automatically previews the outward and homeward transfers while retaining tourist cards", async () => {
  const travelOrigin = { name: "名古屋駅", latitude: 35.17, longitude: 136.88 };
  const route = { ...savedRoute, origin: { name: "京都駅", latitude: 34.98, longitude: 135.75 }, travel_origin: travelOrigin };
  render(<RouteDetailModal route={route} onClose={() => {}} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/routes/preview", expect.anything()));
  const call = vi.mocked(fetch).mock.calls.find(call => call[0] === "/api/routes/preview")!;
  const body = JSON.parse(call[1]!.body as string);
  expect(body.origin).toEqual(travelOrigin);
  expect(body.return_to).toEqual(travelOrigin);
  expect(body.places.map((place: { id: string }) => place.id)).toEqual(["trip-arrival", "tokyo-spot", "trip-return"]);
  expect(body.stay_minutes).toEqual([15, 45, 15]);
  expect(screen.getByRole("heading", { name: "東京の史跡" })).toBeTruthy();
  expect(screen.getByText(/帰着の目安 交通検索後に表示 名古屋駅/)).toBeTruthy();
});

it("previews saved journey date, departure, return destination and anchors", async () => {
  const origin = { name: "出発駅", latitude: 35, longitude: 135 };
  const returnTo = { name: "宿泊先", latitude: 35.1, longitude: 135.2 };
  const source: RouteSuggestion = { origin, return_to: returnTo, places: savedRoute.places, legs: [], total_minutes: null,
    title: null, story: null, departure_time: null, arrival_time: null, note: "" };
  const plan = scheduleTrip({ departureTime: "10:30", availableMinutes: 360, budget: 5000 }, origin, "2026-11-22",
    [{ ...newTripStop(savedRoute.places[0], 60), anchorTime: "12:00", locked: true }],
    { route: source, date: "", time: "" }, null, returnTo);
  render(<RouteDetailModal route={{ ...savedRoute, journey_file: serializeJourneyFile(plan, "保存旅程") }} onClose={() => {}} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/routes/preview", expect.anything()));
  const call = vi.mocked(fetch).mock.calls.find(call => call[0] === "/api/routes/preview")!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ origin, return_to: returnTo, departure_date: "2026-11-22",
    departure_time: "10:30", stay_minutes: [60], meal_times: { "tokyo-spot": "12:00" } });
  expect(screen.getByText(/帰着の目安 交通検索後に表示 宿泊先/)).toBeTruthy();
});
