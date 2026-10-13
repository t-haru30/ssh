import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJourneyDraft, JOURNEY_DRAFT_KEY, readJourneyDraft, saveJourneyDraft } from "./journeyDraft";
import { newTripStop, scheduleTrip } from "./dayTrip";
import type { Place, RouteSuggestion } from "./types";

const origin = { name: "京都駅", latitude: 34.98585, longitude: 135.75877 };
const place: Place = { id: "garden", name: "庭園", category: "自然", description: "", access_point: "", latitude: 35, longitude: 135.76, themes: ["nature"] };
const source: RouteSuggestion = { origin, places: [place], title: "庭園の旅", story: null, total_minutes: 30, legs: [], fare_yen: 400, departure_time: null, arrival_time: null, note: "概算" };
const plan = () => scheduleTrip({ departureTime: "09:00", availableMinutes: 180, budget: 3000 }, origin, "2099-04-10",
  [{ ...newTripStop(place, 45), locked: true, anchorTime: "10:00", spending: 0 }], { route: source, date: "2099-04-10", time: "09:00" });

beforeEach(() => window.localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe("browser journey draft", () => {
  it("restores fixed places, zero costs, conditions and the transport estimate after reopening", () => {
    expect(saveJourneyDraft(plan(), "庭園の旅")).toBe(true);
    const restored = readJourneyDraft();
    expect(restored?.plan.stops[0]).toMatchObject({ locked: true, anchorTime: "10:00", dwellMinutes: 45, spending: 0 });
    expect(restored?.plan.input).toEqual(plan().input);
    expect(restored?.plan.totalCost).toBe(400);
    expect(restored?.plan.returnMinute).toBe(plan().returnMinute);
    expect(clearJourneyDraft()).toBe(true);
    expect(readJourneyDraft()).toBeNull();
  });
  it("preserves completed actual times and rejects gaps or unlocked completion", () => {
    const original = plan();
    Object.assign(original.stops[0], { completed: true, completedStart: 600, completedEnd: 645, completedTravel: 15 });
    expect(saveJourneyDraft(original, "訪問済み")).toBe(true);
    expect(readJourneyDraft()?.plan.stops[0]).toMatchObject({ completed: true, completedStart: 600, completedEnd: 645, completedTravel: 15 });
    const raw = JSON.parse(window.localStorage.getItem(JOURNEY_DRAFT_KEY)!);
    raw.stops[0].locked = false;
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, JSON.stringify(raw));
    expect(readJourneyDraft()).toBeNull();
  });
  it("ignores malformed drafts without removing the user's stored data", () => {
    saveJourneyDraft(plan(), "庭園の旅");
    const raw = JSON.parse(window.localStorage.getItem(JOURNEY_DRAFT_KEY)!);
    raw.stops[0].dwellMinutes = -1;
    const corrupt = JSON.stringify(raw);
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, corrupt);
    expect(readJourneyDraft()).toBeNull();
    expect(window.localStorage.getItem(JOURNEY_DRAFT_KEY)).toBe(corrupt);
  });
  it("does not report success for an oversized draft or unavailable storage", () => {
    const large = plan();
    large.stops[0].place = { ...place, description: "a".repeat(210_000) };
    expect(saveJourneyDraft(large, "長い旅")).toBe(false);
    expect(window.localStorage.getItem(JOURNEY_DRAFT_KEY)).toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(saveJourneyDraft(plan(), "庭園の旅")).toBe(false);
  });
  it("keeps past appointments but invalidates their cached transport information", () => {
    const past = plan();
    past.date = "2020-04-10";
    past.transport = { ...past.transport, date: past.date };
    saveJourneyDraft(past, "前の旅");
    const restored = readJourneyDraft();
    expect(restored?.plan.date).toBe("2020-04-10");
    expect(restored?.plan.stops[0].locked).toBe(true);
    expect(restored?.plan.estimatedTravel).toBe(true);
    expect(restored?.plan.provisionalCosts).toBe(true);
  });
  it("restores independent return destination, multiple preferences, reasons and nullable allocations", () => {
    const returnTo = { ...origin, name: "帰着駅", latitude: 35.01 };
    const initial = scheduleTrip({ departureTime: "09:00", availableMinutes: 180, budget: 3000, preferences: ["nature", "coffee"] },
      origin, "2099-04-10", [newTripStop(place)],
      { route: { ...source, return_to: returnTo, reasons: { garden: "登録テーマが自然に合う候補です。" } }, date: "2099-04-10", time: "09:00" }, null, returnTo);
    initial.planningEstimates = { food: null, coffee: 600 };
    expect(saveJourneyDraft(initial, "初期案")).toBe(true);
    const restored = readJourneyDraft()?.plan;
    expect(restored?.returnTo).toEqual(returnTo);
    expect(restored?.input.preferences).toEqual(["nature", "coffee"]);
    expect(restored?.transport.route.reasons).toEqual(initial.transport.route.reasons);
    expect(restored?.planningEstimates).toEqual({ food: null, coffee: 600 });
    expect(restored?.stops[0].spending).toBeNull();
  });
  it("opens old drafts without optional conditions and preserves explicit empty preferences", () => {
    saveJourneyDraft(plan(), "旧形式");
    const raw = JSON.parse(window.localStorage.getItem(JOURNEY_DRAFT_KEY)!);
    delete raw.returnTo;
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, JSON.stringify(raw));
    expect(readJourneyDraft()?.plan.returnTo).toEqual(origin);
    expect(readJourneyDraft()?.plan.input.preferences).toBeUndefined();
    raw.input.preferences = [];
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, JSON.stringify(raw));
    expect(readJourneyDraft()?.plan.input.preferences).toEqual([]);
  });
  it.each([
    { input: { departureTime: "09:00", availableMinutes: 180, budget: 3000, preferences: ["unknown"] } },
    { input: { departureTime: "09:00", availableMinutes: 180, budget: 3000, preferences: ["nature", "nature"] } },
    { returnTo: null },
    { returnTo: { ...origin, latitude: 91 } },
    { planningEstimates: { food: -1, coffee: null } },
    { planningEstimates: { food: null } },
  ])("rejects malformed optional draft conditions %j", fields => {
    saveJourneyDraft(plan(), "庭園");
    const raw = JSON.parse(window.localStorage.getItem(JOURNEY_DRAFT_KEY)!);
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, JSON.stringify({ ...raw, ...fields }));
    expect(readJourneyDraft()).toBeNull();
  });
});
