import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_SAVED_PLAN_KEY, readLegacySavedPlan, readSearchForm, saveLegacyPlan, saveSearchForm, SEARCH_FORM_KEY } from "./searchState";
import type { SearchForm } from "./searchState";
import type { OvernightItinerarySuggestion } from "./types";
const origin = { name: "京都駅", latitude: 34.98, longitude: 135.76 };
const place = { ...origin, id: "garden", category: "自然", description: "AI evidence", access_point: "", themes: [] };
const form = (): SearchForm => ({ originName: "京都駅", nearbyStations: [origin], theme: "all", mood: "庭園", stopCount: 3,
  departureDate: "2026-10-12", departureTime: "09:00", isOvernight: false, regenerationCount: 2 });
const overnight = (): OvernightItinerarySuggestion => ({ query: { apiKey: "secret" }, origin, hotel: place, days: [], feasible: true, route_search_calls: 1, note: "AI evidence" });
beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
describe("search form persistence", () => {
  it("restores old form and optional local input fields, omitting unknown secrets", () => {
    const input = { ...form(), customOrigin: origin, customReturn: null, returnSame: false, returnName: "大阪駅", preferences: ["coffee"] as const,
      initialMinutes: "360", initialBudget: "5000", foodEstimate: "", coffeeEstimate: "600", initialTransportEstimate: "", apiKey: "secret" };
    expect(saveSearchForm({ ...input, preferences: [...input.preferences] })).toBe(true);
    expect(readSearchForm()).toMatchObject({ originName: "京都駅", customReturn: null, returnSame: false, preferences: ["coffee"], foodEstimate: "" });
    expect(window.localStorage.getItem(SEARCH_FORM_KEY)).not.toContain("secret");
  });
  it("allows editable empty date/time and numeric fields", () => {
    expect(saveSearchForm({ ...form(), departureDate: "", departureTime: "", initialMinutes: "" })).toBe(true);
    expect(readSearchForm()?.departureDate).toBe("");
  });
  it.each([{ departureDate: "2026-02-30" }, { departureTime: "24:00" }, { stopCount: 9 }, { regenerationCount: -1 },
    { nearbyStations: Array.from({ length: 21 }, () => origin) }, { customReturn: { ...origin, latitude: 91 } },
    { preferences: ["coffee", "coffee"] }, { originName: "x".repeat(201) }, { initialMinutes: "oops" }])("rejects invalid form %j without overwrite", patch => {
    saveSearchForm(form()); const old = window.localStorage.getItem(SEARCH_FORM_KEY);
    expect(saveSearchForm({ ...form(), ...patch } as SearchForm)).toBe(false);
    expect(window.localStorage.getItem(SEARCH_FORM_KEY)).toBe(old);
    window.localStorage.setItem(SEARCH_FORM_KEY, JSON.stringify({ ...form(), ...patch }));
    expect(readSearchForm()).toBeNull();
  });
  it("handles invalid JSON and inaccessible storage", () => {
    window.localStorage.setItem(SEARCH_FORM_KEY, "{"); expect(readSearchForm()).toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("full"); });
    expect(saveSearchForm(form())).toBe(false);
  });
});
describe("legacy plan migration", () => {
  it("reads old day trips but invalidates travel and excludes provider and unknown data", () => {
    const route = { origin, places: [place], title: "旅", story: "AI evidence", total_minutes: 30, legs: [], fare_yen: 400,
      departure_time: "09:00", arrival_time: "10:00", note: "AI evidence", apiKey: "secret" };
    window.localStorage.setItem(LEGACY_SAVED_PLAN_KEY, JSON.stringify({ suggestions: [route], overnightSuggestion: null }));
    const restored = readLegacySavedPlan();
    expect(restored?.suggestions[0]).toMatchObject({ title: "旅", total_minutes: null, fare_yen: null, departure_time: null });
    expect(JSON.stringify(restored)).not.toMatch(/secret|AI evidence/);
  });
  it("persists only overnight journeys and clears old daytrip copies", () => {
    expect(saveLegacyPlan([], overnight())).toBe(true);
    expect(readLegacySavedPlan()?.overnightSuggestion?.hotel.id).toBe("garden");
    expect(window.localStorage.getItem(LEGACY_SAVED_PLAN_KEY)).not.toMatch(/secret|AI evidence/);
    expect(saveLegacyPlan([], null)).toBe(true);
    expect(readLegacySavedPlan()).toBeNull();
  });
  it("leaves malformed legacy storage untouched", () => {
    const raw = JSON.stringify({ suggestions: [], overnightSuggestion: { ...overnight(), origin: { latitude: 91 } } });
    window.localStorage.setItem(LEGACY_SAVED_PLAN_KEY, raw);
    expect(readLegacySavedPlan()).toBeNull();
    expect(window.localStorage.getItem(LEGACY_SAVED_PLAN_KEY)).toBe(raw);
  });
});
