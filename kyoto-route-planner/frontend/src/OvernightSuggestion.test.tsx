import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OvernightSuggestion, overnightReason } from "./OvernightSuggestion";
import { newTripStop, scheduleTrip } from "./dayTrip";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const origin = { name: "京都駅", latitude: 35, longitude: 135 };
const place = { ...origin, id: "museum", name: "博物館", category: "博物館", themes: [], access_point: "", description: "" };
const plan = scheduleTrip({ departureTime: "09:00", availableMinutes: 720, budget: 5000 }, origin, "2026-10-14",
  [newTripStop(place, 90)], { route: { origin, places: [place], legs: [], total_minutes: 900, note: "", title: null, story: null, departure_time: null, arrival_time: null }, date: "2026-10-14", time: "09:00" });
it("suggests hotels when the searched trip crosses midnight, preserving the original itinerary", async () => {
  const before = JSON.stringify(plan);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ places: [{ ...origin, id: "osm-node-1", name: "駅前ホテル" }] }) }));
  render(<OvernightSuggestion plan={plan} pending={false} />);
  expect(await screen.findByRole("link", { name: /駅前ホテル/ })).toBeTruthy();
  expect(screen.getByText(/空室・宿泊料金は未確認/)).toBeTruthy();
  expect(JSON.stringify(plan)).toBe(before);
  expect(overnightReason({ ...plan, returnMinute: 900 })).toBe("");
});
it("waits for automatic traffic lookup before fetching lodging", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<OvernightSuggestion plan={plan} pending />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("complementary")).toBeNull();
});
