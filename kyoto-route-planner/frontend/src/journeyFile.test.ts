import { describe, expect, it } from "vitest";
import { newTripStop, scheduleTrip } from "./dayTrip";
import { MAX_JOURNEY_FILE_BYTES, parseJourneyFile, serializeJourneyFile } from "./journeyFile";
import type { Place, RouteSuggestion } from "./types";
const origin = { name: "京都駅", latitude: 34.98, longitude: 135.76 };
const place: Place = { id: "garden", name: "庭園", category: "自然", latitude: 35, longitude: 135.76,
  themes: ["nature"], description: "provider review", access_point: "", tags: { api_key: "secret" } };
function plan() {
  const route: RouteSuggestion = { origin, places: [place], title: "AI summary", story: "private", legs: [],
    total_minutes: 30, fare_yen: 400, departure_time: null, arrival_time: null, note: "provider review" };
  const result = scheduleTrip({ departureTime: "09:00", availableMinutes: 180, budget: 3000, preferences: ["nature", "coffee"] },
    origin, "2099-04-10", [{ ...newTripStop(place, 45), locked: true, anchorTime: "10:00", spending: 0 }],
    { route, date: "2099-04-10", time: "09:00" }, 500, { ...origin, name: "帰着駅", latitude: 35.01 });
  result.planningEstimates = { food: null, coffee: 600 };
  return result;
}
const raw = () => JSON.parse(serializeJourneyFile(plan(), "庭園の旅"));
describe("portable journey JSON", () => {
  it("roundtrips local intent and actual coordinates while invalidating transport and omitting provider data", () => {
    const original = plan();
    const text = serializeJourneyFile(original, "庭園の旅");
    expect(text).not.toMatch(/secret|api_key|AI summary|provider review|private/);
    const restored = parseJourneyFile(text);
    expect(restored.title).toBe("庭園の旅");
    expect(restored.plan.input).toEqual(original.input);
    expect(restored.plan.returnTo).toEqual(original.returnTo);
    expect(restored.plan.planningEstimates).toEqual(original.planningEstimates);
    expect(restored.plan.stops[0]).toMatchObject({ locked: true, anchorTime: "10:00", spending: 0,
      place: { id: place.id, latitude: place.latitude, longitude: place.longitude } });
    expect(restored.plan.estimatedTravel).toBe(true);
    expect(restored.plan.travelCost).toBe(500);
    expect(restored.plan.transport.route.total_minutes).toBeNull();
    expect(restored.plan.transport.date).toBe("");
  });
  it("keeps a completed locked prefix and reconstructs actual schedule", () => {
    const data = raw();
    Object.assign(data.stops[0], { completed: true, completedStart: 600, completedEnd: 645, completedTravel: 10 });
    data.input.departureTime = "12:00"; // Editing future departure must not erase actual history.
    const stop = parseJourneyFile(JSON.stringify(data)).plan.stops[0];
    expect(stop).toMatchObject({ completed: true, completedStart: 600, completedEnd: 645, completedTravel: 10 });
  });
  it("imports v1 local drafts without trusting route, totals or extra secrets", () => {
    const data = { ...raw(), version: 1, totalCost: -100, apiKey: "secret", transport: { route: { story: "secret" } } };
    const restored = parseJourneyFile(JSON.stringify(data));
    expect(JSON.stringify(restored)).not.toContain("secret");
    expect(restored.plan.totalCost).toBe(500);
  });
  it.each([
    (d: any) => { d.version = 99; },
    (d: any) => { d.date = "2026-02-30"; },
    (d: any) => { d.origin.latitude = 91; },
    (d: any) => { d.stops[0].place.name = "x".repeat(201); },
    (d: any) => { d.stops.push(d.stops[0]); },
    (d: any) => { d.stops[0].spending = -1; },
    (d: any) => { d.input.preferences = ["nature", "nature"]; },
    (d: any) => { d.stops[0].completed = true; },
    (d: any) => { Object.assign(d.stops[0], { completed: true, locked: false, completedStart: 600, completedEnd: 645 }); },
    (d: any) => { Object.assign(d.stops[0], { completed: true, completedStart: 600, completedEnd: 646 }); },
    (d: any) => { d.stops[0].completedStart = 600; },
    (d: any) => { d.stops.push({ ...d.stops[0], place: { ...place, id: "second" }, completed: true, completedStart: 600, completedEnd: 645 }); },
  ])("rejects malformed data without changing storage", mutate => {
    const data = raw(); mutate(data);
    window.localStorage.setItem("existing", "untouched");
    expect(() => parseJourneyFile(JSON.stringify(data))).toThrow();
    expect(window.localStorage.getItem("existing")).toBe("untouched");
  });
  it("limits UTF-8 bytes, reports friendly errors and permits empty itineraries", () => {
    expect(() => parseJourneyFile("あ".repeat(Math.ceil(MAX_JOURNEY_FILE_BYTES / 3)))).toThrow("200KB");
    expect(() => parseJourneyFile("{" )).toThrow("JSON");
    const data = raw(); data.stops = [];
    expect(parseJourneyFile(JSON.stringify(data)).plan.stops).toHaveLength(0);
  });
});
