import { describe, expect, it } from "vitest";
import { routeSelection } from "./routeSelection";
import type { DatasetRoute } from "./discover/datasetTypes";

describe("Discover route handoff", () => {
  it("opens legacy saved cafes as thirty-minute breaks without overriding saved stay times", () => {
    const route = { theme:"nature" as const, title:"カフェの旅", story:"散策と休憩", copywriting_source:"fallback" as const, note:"",
      image_url:null,author_name:null,source_url:null,license_name:null,license_url:null,
      places:[{id:"cafe",name:"町の喫茶",category:"カフェ",latitude:35,longitude:135,themes:[],description:"",access_point:""}] };
    expect(routeSelection(route).dwellMinutes.cafe).toBe(30);
    expect(routeSelection({...route,dwell_minutes:{cafe:60}}).dwellMinutes.cafe).toBe(60);
  });
  it("carries the exact places, order, stay times and selected area instead of a theme-only preset", () => {
    const route: DatasetRoute = { id: "tokyo", area: "tokyo", pattern: "half_day", course: "half_day", start: { name: "上野駅", lat: 35.7138, lng: 139.7773, to_first_km: 1, from_last_km: 2 }, legs: [], theme: "nature", title: "東京の旅", estimated_minutes: 200, total_score: 1, center: [35.68, 139.76], coordinates: [],
      spots: ["上野公園", "庭園"].map((name, i) => ({ place_id: `tokyo-${i}`, name, category: "公園", lat: 35.7 + i * .01, lng: 139.77, stay_minutes: 45 + i * 15, score: 1, role: "stop" })) };
    const result = routeSelection(route);
    expect(result.places.map(place => place.name)).toEqual(["上野公園", "庭園"]);
    expect(result.origin).toEqual({ name: "上野駅", latitude: 35.7138, longitude: 139.7773 });
    expect(result.dwellMinutes).toEqual({ "tokyo-0": 45, "tokyo-1": 60 });
    const departure = { name: "現在地", latitude: 35.17, longitude: 136.88 };
    const withDeparture = { ...route, travel_origin: departure };
    expect(routeSelection(withDeparture).places).toEqual(result.places);
    const fullTrip = routeSelection(withDeparture, true);
    expect(fullTrip.origin).toEqual(departure);
    expect(fullTrip.returnTo).toEqual(departure);
    expect(fullTrip.places.map(place => place.name)).toEqual(["上野駅", "上野公園", "庭園", "上野駅"]);
    expect(new Set(fullTrip.places.map(place => place.id)).size).toBe(4);
    const evening: DatasetRoute = { ...route, course: "full_day", spots: [...route.spots, { ...route.spots[0], place_id: "dinner", name: "食堂", category: "飲食店", stay_minutes: 75, role: "dinner" }] };
    const eveningPreset = routeSelection(evening);
    expect(eveningPreset.anchorTimes).toEqual({ dinner: "18:00" });
    expect(eveningPreset.availableMinutes).toBe(720);
    expect(eveningPreset.dwellMinutes.dinner).toBe(75);
  });
});
