import { describe, expect, it } from "vitest";
import { completeNextStop, completedStopCount, fitTrip, newTripStop, readTripNumber, scheduleTrip, undoLastCompletedStop } from "./dayTrip";
import type { TripStop, TripTransport } from "./dayTrip";
import type { Place } from "./types";

const origin = { name: "出発駅", latitude: 35, longitude: 135 };
const place = (id: string): Place => ({ ...origin, id, name: id, category: "公園", description: "", access_point: "", themes: [] });
const stops = ["A", "B", "C"].map(id => ({ ...newTripStop(place(id)), spending: 0 }));
const transport: TripTransport = { route: { origin, places: stops.map(stop => stop.place), legs: [], total_minutes: 30, fare_yen: 0, departure_time: "09:00", arrival_time: null, title: null, story: null, note: "" }, date: "2026-10-12", time: "09:00" };
const plan = (selected: TripStop[] = stops, availableMinutes = 360, budget = 5000) => scheduleTrip({ departureTime: "09:00", availableMinutes, budget }, origin, transport.date, selected, transport);

describe("day trip constraints", () => {
  it("keeps missing fares out of totals and counts only known segment fares", () => {
    const source = { ...transport, route: { ...transport.route, fare_yen: null,
      timeline: [200, null, 0, 300].map(fare => ({ type: "transit" as const, from_name: "A", to_name: "B",
        mode: "public_transport" as const, start_time: null, end_time: null, duration_minutes: 10, is_estimate: false, fare_yen: fare })) } };
    const partial = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, source.date, stops, source);
    expect(partial.travelCost).toBeNull();
    expect(partial.totalCost).toBeNull();
    expect(partial.knownCost).toBe(500);
    expect(partial.unknownCosts).toBe(1);
    source.route.timeline[1].fare_yen = 100;
    const complete = scheduleTrip(partial.input, origin, source.date, stops, source);
    expect(complete.travelCost).toBe(600);
    expect(complete.totalCost).toBe(600);
    const moved = scheduleTrip(partial.input, origin, source.date, stops.slice(0, 2), source);
    expect(moved.travelCost).toBeNull();
    expect(moved.totalCost).toBeNull();
    expect(moved.knownCost).toBe(0);
  });
  it("preserves completed actual times, dwell and travel when the remaining route and departure change", () => {
    const completed = completeNextStop(plan());
    const past = completed.stops[0];
    const changed = scheduleTrip({ ...completed.input, departureTime: "12:00", availableMinutes: 10 },
      { ...origin, latitude: 36 }, "2026-10-13",
      [{ ...past, dwellMinutes: 15, locked: false }, { ...stops[2], dwellMinutes: 360 }], transport);
    const after = fitTrip(changed);
    expect(after.stops[0]).toMatchObject({ completed: true, locked: true, start: past.start, end: past.end,
      dwellMinutes: past.dwellMinutes, travel: past.travel });
    expect(after.violations.join(" ")).toContain("訪問済み");
    expect(past.dwellMinutes).toBe(90);
  });
  it("never removes completed visits to satisfy a smaller budget or shorter day", () => {
    const completed = completeNextStop(plan(stops.map(stop => ({ ...stop, spending: 100 }))));
    const after = fitTrip(scheduleTrip({ ...completed.input, budget: 0, availableMinutes: 15 }, origin,
      transport.date, completed.stops, transport));
    expect(after.stops[0]).toMatchObject({ completed: true, dwellMinutes: 90, start: completed.stops[0].start,
      end: completed.stops[0].end });
    expect(after.violations.join(" ")).toContain("超過");
  });
  it("marks only the next scheduled visit and undoes only the last completion", () => {
    const first = completeNextStop(plan());
    const second = completeNextStop(first);
    expect(completedStopCount(second.stops)).toBe(2);
    expect(second.stops[1].completedStart).toBe(first.stops[1].start);
    const undone = undoLastCompletedStop(second);
    expect(completedStopCount(undone.stops)).toBe(1);
    expect(undone.stops[0]).toEqual(second.stops[0]);
    expect(undone.stops[1]).toMatchObject({ completed: false, completedStart: null, completedEnd: null, locked: true });
    expect(completedStopCount(undoLastCompletedStop(undone).stops)).toBe(0);
  });
  it("rejects inserting a future visit ahead of history and incomplete actual-time records", () => {
    const completed = completeNextStop(plan());
    expect(() => plan([stops[1], completed.stops[0]])).toThrow("先頭から順");
    expect(() => plan([{ ...stops[0], completed: true }])).toThrow("開始・終了時刻");
    expect(() => plan([{ ...completed.stops[0], completedEnd: 1 }])).toThrow("開始・終了時刻");
  });
  it("shortens flexible stays before removing any stop, while preserving fixed dwell", () => {
    const before = plan(stops.map((stop, index) => ({ ...stop, locked: index === 0 })), 180);
    const after = fitTrip(before);
    expect(after.stops.map(stop => stop.place.id)).toEqual(["A", "B", "C"]);
    expect(after.stops.map(stop => stop.dwellMinutes)).toEqual([90, 30, 30]);
    expect(after.returnMinute).toBe(720);
    expect(before.stops[1].dwellMinutes).toBe(90);
  });
  it("removes the fewest flexible places and never changes fixed order", () => {
    const selected = stops.map((stop, index) => ({ ...stop, dwellMinutes: index === 0 ? 30 : 90, locked: index === 0 }));
    const before = plan(selected, 60);
    before.planningEstimates = { food: 1500, coffee: null };
    const after = fitTrip(before);
    expect(after.stops).toHaveLength(2);
    expect(after.stops[0]).toMatchObject({ place: { id: "A" }, dwellMinutes: 30, locked: true });
    expect(after.returnMinute).toBeLessThanOrEqual(600);
    expect(after.planningEstimates).toEqual({ food: 1500, coffee: null });
  });
  it("keeps every commitment and reports overruns when no fitting subset exists", () => {
    const selected = stops.map(stop => ({ ...stop, locked: true, spending: 100 }));
    const before = plan(selected, 30, 0);
    const after = fitTrip(before);
    expect(after.stops.map(stop => [stop.place.id, stop.dwellMinutes])).toEqual([["A", 90], ["B", 90], ["C", 90]]);
    expect(after.violations.join(" ")).toContain("超過");
    expect(after.knownCost).toBe(300);
  });
  it("shortens earlier flexible visits to reach a fixed appointment, keeping waiting time", () => {
    const selected = stops.map((stop, index) => ({ ...stop, locked: index === 1, anchorTime: index === 1 ? "10:00" : null }));
    const after = fitTrip(plan(selected));
    expect(after.stops[1]).toMatchObject({ start: 600, late: 0, dwellMinutes: 90, locked: true });
    expect(after.stops[0].dwellMinutes).toBeLessThan(90);
  });
  it("uses category allowances for missing charges and preserves explicitly entered zero", () => {
    const after = plan(stops.map(stop => ({ ...stop, place: { ...stop.place, category: "博物館" }, spending: null })), 360, 0);
    expect(after.totalCost).toBe(3000);
    expect(after.provisionalCosts).toBe(true);
    expect(after.violations.join(" ")).toContain("超過");
    expect(plan(stops, 360, 0).totalCost).toBe(0);
  });
  it("invalidates old transport costs and durations after topology, date or origin changes", () => {
    expect(plan(stops.slice(0, 2)).estimatedTravel).toBe(true);
    expect(plan(stops.slice(0, 2)).provisionalCosts).toBe(true);
    const changed = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, { ...origin, latitude: 36 }, "2026-10-13", stops, transport);
    expect(changed.estimatedTravel).toBe(true);
    expect(changed.provisionalCosts).toBe(true);
  });
  it("invalidates a loop transport estimate when only the return destination changes", () => {
    const returnTo = { ...origin, name: "帰着駅", latitude: 35.01 };
    const changed = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, transport.date, stops, transport, null, returnTo);
    expect(changed.returnTo).toEqual(returnTo);
    expect(changed.estimatedTravel).toBe(true);
    expect(changed.provisionalCosts).toBe(true);
    expect(changed.returnTravel).toBeGreaterThan(0);
    const matching = scheduleTrip(changed.input, origin, transport.date, stops,
      { ...transport, route: { ...transport.route, return_to: returnTo } }, null, returnTo);
    expect(matching.estimatedTravel).toBe(false);
    expect(matching.travelMinutes).toBe(30);
    expect(matching.travelCost).toBe(0);
  });
  it("preserves return destination, preferences and planning allocations when fitting", () => {
    const returnTo = { ...origin, name: "帰着駅", latitude: 35.001 };
    const before = scheduleTrip({ departureTime: "09:00", availableMinutes: 60, budget: 5000, preferences: ["culture", "coffee"] }, origin, transport.date, stops, transport, null, returnTo);
    before.planningEstimates = { food: null, coffee: 600 };
    const after = fitTrip(before);
    expect(after.returnTo).toEqual(returnTo);
    expect(after.input.preferences).toEqual(["culture", "coffee"]);
    expect(after.planningEstimates).toEqual({ food: null, coffee: 600 });
  });
  it("rejects empty numbers while allowing an explicitly entered zero budget", () => {
    expect(() => readTripNumber("", "予算", 0, 50000)).toThrow();
    expect(() => readTripNumber("1.5", "予算", 0, 50000)).toThrow();
    expect(readTripNumber("0", "予算", 0, 50000)).toBe(0);
  });
  it("never produces a negative segment through rounding", () => {
    const after = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, transport.date, stops, { ...transport, route: { ...transport.route, total_minutes: 1 } });
    expect(after.stops.every(stop => stop.travel >= 0)).toBe(true);
    expect(after.returnTravel).toBeGreaterThanOrEqual(0);
    expect(after.travelMinutes).toBe(1);
  });
});

it("uses verified per-segment transport times instead of distributing a total by distance", () => {
  const source = { ...transport, route: { ...transport.route, timeline: [7, 23, 12, 8].map((duration, i) => ({
    type: "transit" as const, from_name: "A", to_name: "B", mode: "public_transport" as const,
    start_time: null, end_time: null, is_estimate: false, duration_minutes: duration, transit_line: `路線${i}`,
  })) } };
  const result = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, source.date, stops, source);
  expect(result.stops.map(stop => stop.travel)).toEqual([7, 23, 12]);
  expect(result.returnTravel).toBe(8);
  expect(result.travelMinutes).toBe(50);
});
it("keeps sightseeing at least thirty minutes while allowing station transfers", () => {
  expect(newTripStop(place("A"), 15).dwellMinutes).toBe(30);
  expect(newTripStop(place("trip-arrival"), 15).dwellMinutes).toBe(15);
  const before = plan(stops, 30);
  const result = fitTrip(before);
  expect(result.stops.every(stop => stop.dwellMinutes >= 30)).toBe(true);
  expect(before.stops.map(stop => stop.dwellMinutes)).toEqual([90, 90, 90]);
});
