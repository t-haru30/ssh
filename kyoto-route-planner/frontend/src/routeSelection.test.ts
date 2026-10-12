import { describe, expect, it } from "vitest";
import { routeSelection } from "./routeSelection";
import type { DatasetRoute } from "./discover/datasetTypes";

describe("Discover route handoff", () => {
  it("carries the exact places, order, stay times and selected area instead of a theme-only preset", () => {
    const route: DatasetRoute = { id: "tokyo", area: "tokyo", pattern: "half_day", course: "half_day", start: { name: "上野駅", lat: 35.7138, lng: 139.7773, to_first_km: 1, from_last_km: 2 }, legs: [], theme: "nature", title: "東京の旅", estimated_minutes: 200, total_score: 1, center: [35.68, 139.76], coordinates: [],
      spots: ["上野公園", "庭園"].map((name, i) => ({ place_id: `tokyo-${i}`, name, category: "公園", lat: 35.7 + i * .01, lng: 139.77, stay_minutes: 45 + i * 15, score: 1, role: "stop" })) };
    const result = routeSelection(route);
    expect(result.places.map(place => place.name)).toEqual(["上野公園", "庭園"]);
    expect(result.origin).toEqual({ name: "上野駅", latitude: 35.7138, longitude: 139.7773 });
    expect(result.dwellMinutes).toEqual({ "tokyo-0": 45, "tokyo-1": 60 });
  });
});
