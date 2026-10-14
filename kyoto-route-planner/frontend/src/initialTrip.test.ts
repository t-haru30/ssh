import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialTrip } from "./initialTrip";
import type { InitialTripOptions } from "./initialTrip";
import { preferenceMatches, preferenceReason } from "./tripPreferences";
import type { Place } from "./types";

const origin = { name: "出発駅", latitude: 35, longitude: 135 };
const makePlace = (id: string, category: string, themes: Place["themes"] = []): Place => ({
  ...origin, id, name: id, category, themes, description: "", access_point: "",
});
const park = makePlace("庭園", "公園", ["nature"]);
const museum = makePlace("歴史資料館", "博物館", ["history"]);
const food = makePlace("食堂", "飲食店", ["food"]);
const coffee = makePlace("喫茶店", "カフェ");
const options = (overrides: Partial<InitialTripOptions> = {}): InitialTripOptions => ({
  input: { departureTime: "09:00", availableMinutes: 240, budget: 5000, preferences: [] },
  origin, returnTo: origin, date: "2099-04-10", candidates: [park, museum, food, coffee], maxStops: 3,
  foodEstimate: 1500, coffeeEstimate: 600, transportEstimate: null, ...overrides,
});
afterEach(() => vi.unstubAllGlobals());

describe("local initial day trip", () => {
  it("chooses fewer stops in a short window with realistic category stays", () => {
    const short = createInitialTrip(options({ input: { departureTime: "09:00", availableMinutes: 30, budget: 5000 } }));
    const long = createInitialTrip(options());
    expect(short.stops).toHaveLength(1);
    expect(short.stops[0].dwellMinutes).toBeGreaterThanOrEqual(25);
    expect(short.returnMinute).toBeLessThanOrEqual(570);
    expect(long.stops).toHaveLength(3);
  });
  it("lets the known budget change the initial choice, without treating unknown fees as free", () => {
    const common = options({ candidates: [food, coffee], maxStops: 2 });
    const high = createInitialTrip({ ...common, input: { ...common.input, preferences: ["food", "coffee"], budget: 2100 } });
    const low = createInitialTrip({ ...common, input: { ...common.input, preferences: ["food", "coffee"], budget: 1000 } });
    expect(high.stops).toHaveLength(2);
    expect(high.knownCost).toBe(2100);
    expect(low.stops.map(stop => stop.place.id)).toEqual([coffee.id]);
    expect(low.knownCost).toBe(600);
    expect(low.provisionalCosts).toBe(true);
    expect(low.totalCost).toBeNull();
    expect(low.travelCost).toBeNull();
  });
  it("combines preferences and explains actual matches deterministically without fetching", () => {
    const fetch = vi.fn(() => { throw new Error("network must not be used"); });
    vi.stubGlobal("fetch", fetch);
    const common = options({ candidates: [park, museum], maxStops: 1 });
    const nature = createInitialTrip({ ...common, input: { ...common.input, preferences: ["nature"] } });
    const culture = createInitialTrip({ ...common, input: { ...common.input, preferences: ["culture"] } });
    expect(nature.stops[0].place.id).toBe(park.id);
    expect(culture.stops[0].place.id).toBe(museum.id);
    const combined = createInitialTrip(options({ candidates: [park, museum], input: { ...common.input, preferences: ["nature", "culture"] } }));
    expect(combined.stops).toHaveLength(2);
    expect(combined.transport.route.reasons?.[park.id]).toContain("希望の自然");
    expect(combined.transport.route.reasons?.[museum.id]).toContain("希望の文化・歴史");
    expect(combined).toEqual(createInitialTrip(options({ candidates: [museum, park], input: { ...common.input, preferences: ["nature", "culture"] } })));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps explicit empty preferences and null planning amounts unknown", () => {
    const initial = createInitialTrip(options({ candidates: [food, coffee], foodEstimate: null, coffeeEstimate: null,
      input: { departureTime: "09:00", availableMinutes: 240, budget: 5000, preferences: [] } }));
    expect(initial.input.preferences).toEqual([]);
    expect(initial.stops.every(stop => stop.spending === null)).toBe(true);
    expect(initial.planningEstimates).toEqual({ food: null, coffee: null });
    expect(initial.transportEstimate).toBeNull();
    expect(initial.provisionalCosts).toBe(true);
    expect(initial.transport.route.reasons?.[food.id]).not.toContain("希望の");
  });
  it("keeps distinct return destination and rejects an impossible window without losing conditions", () => {
    const returnTo = { ...origin, name: "別の駅", latitude: 35.2 };
    const supplied = options({ returnTo, input: { departureTime: "09:00", availableMinutes: 30, budget: 0, preferences: ["nature"] } });
    const initial = createInitialTrip(supplied);
    expect(initial.stops).toEqual([]);
    expect(initial.returnTo).toEqual(returnTo);
    expect(initial.input).toEqual(supplied.input);
    expect(initial.violations.join(" ")).toContain("初期案がありません");
    expect(initial.provisionalCosts).toBe(true);
    expect(initial.transport.route.coordinates?.at(-1)).toEqual([35.2, 135]);
  });
  it("retains an affordable preference alternative outside the highest relevance cluster", () => {
    const restaurants = Array.from({ length: 20 }, (_, index) => ({ ...food, id: `food-${index}`, name: `料理店${index}` }));
    const initial = createInitialTrip(options({ candidates: [...restaurants, coffee],
      input: { departureTime: "09:00", availableMinutes: 240, budget: 1000, preferences: ["food", "coffee"] } }));
    expect(initial.stops.map(stop => stop.place.id)).toEqual([coffee.id]);
  });
  it("does not infer a preference from promotional descriptions or confuse a cafe with shopping", () => {
    const place = { ...museum, description: "自然とカフェと買い物を楽しめます" };
    expect(preferenceMatches(place)).toEqual(["culture"]);
    expect(preferenceReason(place, ["coffee"])).not.toContain("希望のカフェ");
    expect(preferenceMatches(coffee)).toEqual(["coffee"]);
  });
  it("does not assign a meal allocation to cultural stops sharing a food route theme", () => {
    const initial = createInitialTrip(options({ candidates: [{ ...museum, themes: ["history", "food"] }], maxStops: 1 }));
    expect(initial.stops[0].spending).toBeNull();
    expect(initial.stops[0].dwellMinutes).toBe(60);
  });
  it("bounds the search to nearby local candidates", () => {
    const initial = createInitialTrip(options({ candidates: [{ ...park, latitude: 36 }] }));
    expect(initial.stops).toEqual([]);
    expect(initial.violations.join(" ")).toContain("50km以内の候補がありません");
  });
});
