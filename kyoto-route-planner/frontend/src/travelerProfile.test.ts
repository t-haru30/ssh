import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_TRAVELER_PROFILE, readTravelerProfile, saveTravelerProfile, TRAVELER_PROFILE_KEY } from "./travelerProfile";
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("round trips a validated profile and rejects malformed storage", () => {
 const profile = { ...EMPTY_TRAVELER_PROFILE, companion: "solo" as const }; saveTravelerProfile(profile); expect(readTravelerProfile()).toEqual(profile);
 for (const raw of ["bad", "{}", JSON.stringify({ ...profile, gender: "invalid" })]) { localStorage.setItem(TRAVELER_PROFILE_KEY, raw); expect(readTravelerProfile()).toEqual(EMPTY_TRAVELER_PROFILE); }
});
it("tolerates storage errors", () => {
 vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error(); });
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error(); });
 expect(readTravelerProfile()).toEqual(EMPTY_TRAVELER_PROFILE); expect(() => saveTravelerProfile(EMPTY_TRAVELER_PROFILE)).not.toThrow();
});

it("migrates legacy and invalid pace values to standard", () => {
 for (const pace of [undefined, "invalid"]) {
   localStorage.setItem(TRAVELER_PROFILE_KEY, JSON.stringify({ age_group: "65_plus", gender: "female", companion: "family", pace }));
   expect(readTravelerProfile()).toEqual({ age_group: "65_plus", gender: "female", companion: "family", pace: "standard" });
 }
 for (const pace of ["relaxed", "standard", "packed"] as const) {
   saveTravelerProfile({ ...EMPTY_TRAVELER_PROFILE, pace });
   expect(readTravelerProfile().pace).toBe(pace);
 }
});
