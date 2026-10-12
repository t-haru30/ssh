import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Origin } from "../types";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { RouteDetailModal } from "./RouteDetailModal";

vi.mock("../MapView", () => ({ MapView: ({ origin }: { origin: Origin }) => <div data-testid="map-origin">{origin.name}</div> }));
afterEach(cleanup);

const savedRoute: RouteIdea = {
  theme: "history", prefecture_code: "13", prefecture_name: "東京都", title: "東京の街を歩く", story: "休日のよりみち。",
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
    expect(screen.getByText(/09:00 出発：上野駅/)).toBeTruthy();
    expect(screen.getByText("徒歩で約10分")).toBeTruthy();
    expect(screen.getByText("車で約15分")).toBeTruthy();
    expect(screen.getByText("公共交通で約20分")).toBeTruthy();
    expect(screen.getByText(/昼食 · .*滞在の目安 1時間/)).toBeTruthy();
    expect(screen.getByText("09:10")).toBeTruthy();
    expect(screen.getByText("10:10")).toBeTruthy();
    expect(screen.getByText("帰着の目安 11:30 上野駅")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("map-origin").textContent).toBe("上野駅"));
  });

  it("keeps a saved route's prefecture and stay times when previewing and planning", async () => {
    const onPlan = vi.fn();
    const onClose = vi.fn();
    render(<RouteDetailModal route={savedRoute} onClose={onClose} onPlanInSearch={onPlan} />);
    expect(screen.getByText(/出発の目安：東京都・エリア中心/)).toBeTruthy();
    expect(screen.getByText(/滞在の目安 45分/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("map-origin").textContent).toBe("東京都・エリア中心"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "このルートで旅を計画する" }));
    expect(onPlan).toHaveBeenCalledWith(savedRoute);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
