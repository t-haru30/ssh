import { describe, expect, it } from "vitest";
import { composeLocalRoutes, isDiscoverResponse } from "./discover/dynamicRoutes";
import { routeSelection } from "./routeSelection";
import type { Place } from "./types";

describe("OpenPOI recommendation compatibility", () => {
  it("preserves provider IDs and verified positions from recommendation through route adoption", () => {
    const place: Place = { id: "openpoi-overture-example", name: "地域の博物館", category: "博物館", latitude: 35.001, longitude: 135,
      description: "", access_point: "", address: "京都府京都市中央町", themes: ["history"],
      tags: { area: "kyoto", source: "OpenPOI API", licenses: '["CC BY 4.0"]', attributions: '["Provider"]', position_check: "gsi_neighbourhood" } };
    const routes = composeLocalRoutes({ entry: { id: "kyoto", prefecture_code: "26", name: "京都府", center: [35, 135], route_count: 5, file: "kyoto.json" },
      origin: { name: "駅", latitude: 35, longitude: 135 }, theme: "history", course: "all", radius: 3, crossPrefecture: false, variation: 0 }, [place]);
    expect(routes).toHaveLength(1);
    expect(isDiscoverResponse({ routes, note: "" })).toBe(true);
    const adopted = routeSelection(routes[0]);
    expect(adopted.places[0]).toMatchObject({ id: place.id, name: place.name, category: place.category, latitude: place.latitude, longitude: place.longitude });
    expect(adopted.dwellMinutes[place.id]).toBe(routes[0].spots[0].stay_minutes);
    expect(adopted.places[0].address).toBe(place.address);
    expect(adopted.places[0].tags).toEqual(place.tags);
    for (const invalid of [{ address: 123 }, { tags: [] }, { tags: { source: 123 } }, { tags: { source: "x".repeat(25001) } }]) {
      expect(isDiscoverResponse({ routes: [{ ...routes[0], spots: [{ ...routes[0].spots[0], ...invalid }] }], note: "" })).toBe(false);
    }
  });
});
