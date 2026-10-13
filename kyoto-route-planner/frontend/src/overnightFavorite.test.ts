import { describe, expect, it } from "vitest";
import { parseOvernightSnapshot, savedOvernight, type OvernightSnapshot } from "./overnightFavorite";
import { routeSelection } from "./routeSelection";
import { favoriteId } from "./useFavorites";
const origin = { name: "京都駅", latitude: 34.98, longitude: 135.76 };
function snapshot(): OvernightSnapshot {
  const hotel = { ...origin, id: "hotel", category: "宿泊", description: "provider-secret", access_point: "", themes: [] };
  return { version: 1, nights: 6, stopsPerDay: 3, radius: 50, mood: "自然", departureDate: "2026-10-12", departureTime: "08:15",
    itinerary: { query: { apiKey: "provider-secret" }, origin, hotel, feasible: true, route_search_calls: 14, note: "provider-secret",
      days: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, date: `2026-10-${12 + index}`,
        places: Array.from({ length: 3 }, (_, stop) => ({ ...hotel, id: `day${index}-stop${stop}`, name: `行き先${index}-${stop}` })),
        legs: [], schedule: [], lunch: { type: "lunch", place: null, start_time: "12:00", end_time: "13:00", reason: "provider-secret" },
        transit_minutes: 10, stay_minutes: 180, estimated_arrival_at: "18:00", coordinates: [] })) } };
}
describe("saved overnight journeys", () => {
  it("summarizes seven days in eight card spots but restores all 21 in order without transport or provider data", () => {
    const idea = savedOvernight(snapshot(), "nature");
    expect(idea.places).toHaveLength(8);
    expect(JSON.stringify(idea)).not.toContain("provider-secret");
    const preset = routeSelection(idea);
    expect(preset.places).toHaveLength(21);
    expect(preset.autoSearch).toBe(false);
    expect(preset.overnightSnapshot).toMatchObject({ nights: 6, departureTime: "08:15", radius: 50, itinerary: { route_search_calls: 0, hotel: { id: "hotel" } } });
    expect(preset.overnightSnapshot?.itinerary.days[6].places[2].id).toBe("day6-stop2");
  });
  it.each([{ nights: 0 }, { departureDate: "2026-02-30" }, { departureTime: "24:00" }, { radius: 201 }, { version: 2 }])("rejects malformed saved inputs %j", patch => {
    expect(() => parseOvernightSnapshot({ ...snapshot(), ...patch })).toThrow();
  });
  it("distinguishes departure conditions and days after the card summary when deduplicating", () => {
    const first = snapshot(); const changed = snapshot(); changed.itinerary.days[6].places[2].name = "別の行き先";
    expect(favoriteId(savedOvernight(first, "all"), "26")).not.toBe(favoriteId(savedOvernight(changed, "all"), "26"));
    changed.departureTime = "10:00";
    expect(favoriteId(savedOvernight(first, "all"), "26")).not.toBe(favoriteId(savedOvernight(changed, "all"), "26"));
  });
});
