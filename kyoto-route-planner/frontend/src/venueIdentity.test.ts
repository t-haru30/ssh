import { describe, expect, it } from "vitest";
import { distinctVenues } from "./venueIdentity";
import { composeLocalRoutes } from "./discover/dynamicRoutes";
import { createInitialTrip } from "./initialTrip";
import { newTripStop, scheduleTrip } from "./dayTrip";
import type { Place } from "./types";

const origin = { name: "駅", latitude: 35, longitude: 135 };
const place = (id: string, name: string, latitude = 35.001): Place => ({ ...origin, id, name, latitude, category: "史跡", themes: ["history"], description: "", access_point: "", tags: { area: "kyoto" } });
const views = [place("south", "南東から見た二条城東南隅櫓の眺め"), place("west", "西から見た二条城東南隅櫓の眺め", 35.002)];

describe("automatic venue identity", () => {
  it("collapses explicit viewpoints and nearby exact names, retaining distant names and separate buildings", () => {
    const pool = [...views, place("exact", "二条城東南隅櫓"), place("other", "二条城西南隅櫓"), place("far", "二条城東南隅櫓", 35.02)];
    expect(distinctVenues(pool).map(p => p.id)).toEqual(["south", "other", "far"]);
    expect(pool).toHaveLength(5);
    expect(distinctVenues([place("a", "Ａ 公園"), place("b", "a公園")])).toHaveLength(1);
  });
  it("composes fewer automatic stops without duplicate views and leaves manual stops untouched", () => {
    const routes = composeLocalRoutes({ entry: { id: "kyoto", prefecture_code: "26", name: "京都府", center: [35, 135], route_count: 1, file: "kyoto.json" }, origin, theme: "all", course: "all", radius: 3, crossPrefecture: false, variation: 0 }, [...views,place('canonical','二条城東南隅櫓')]);
    expect(routes[0].spots).toHaveLength(1);
    expect(routes[0].spots[0].place_id).toBe('canonical');
    const input = { departureTime: "09:00", availableMinutes: 300, budget: 5000 };
    const plan = createInitialTrip({ input, origin, returnTo: origin, date: "2099-04-10", candidates: views, maxStops: 3, foodEstimate: null, coffeeEstimate: null, transportEstimate: null });
    expect(plan.stops).toHaveLength(1);
    const manual = scheduleTrip(input, origin, "2099-04-10", views.map(p => newTripStop(p, 30)), plan.transport, null, origin);
    expect(manual.stops.map(stop => stop.place.id)).toEqual(["south", "west"]);
  });
});
