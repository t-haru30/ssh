import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileTripMap } from "./MobileTripMap";
import { newTripStop, scheduleTrip } from "./dayTrip";
import type { MapViewProps } from "./MapView";
import type { RouteSuggestion, RouteTimelineTransit } from "./types";

const map = vi.hoisted(() => vi.fn());
vi.mock("./LazyMapView", () => ({ LazyMapView: (props: MapViewProps) => {
  map(props);
  return <div data-testid="booklet-map">{props.places.map(place => place.name).join(" → ")}</div>;
} }));

const origin = { name: "京都駅", latitude: 34.985, longitude: 135.758 };
const places = ["京都の博物館", "京都の庭園"].map((name, index) => ({
  ...origin, id: String(index), name, category: "観光", description: "", access_point: "", themes: [],
}));
const transit: RouteTimelineTransit = { type: "transit", from_name: origin.name, to_name: places[0].name,
  mode: "public_transport", transit_line: "市バス", start_time: "09:00", end_time: "09:10",
  duration_minutes: 10, is_estimate: false, map_token: "a".repeat(32) };
const route: RouteSuggestion = { origin, places, legs: [], total_minutes: 30, fare_yen: 500,
  departure_time: "09:00", arrival_time: null, title: "京都の旅", story: null, note: "", timeline: [transit] };
const plan = () => scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 },
  origin, "2026-10-17", places.map(place => newTripStop(place, 60)), { route, date: "2026-10-17", time: "09:00" });

function viewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => {
    expect(query).toBe("(max-width:650px)");
    return { matches: width <= 650, addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  }));
  return (nextWidth: number) => act(() => { width = nextWidth; listeners.forEach(listener => listener()); });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); map.mockClear(); });

it("shows the current itinerary directly on mobile without opening the chat", () => {
  viewport(390);
  const current = plan();
  render(<MobileTripMap plan={current} routeLoading={false} />);
  expect(screen.getByRole("region", { name: "しおりの旅程マップ" }).textContent).toContain("京都の博物館 → 京都の庭園");
  expect(map.mock.calls.at(-1)?.[0]).toMatchObject({ origin, returnTo: origin, journeyDate: current.date,
    initialMode: "routes", routeLoading: false, timeline: [transit], mapTokens: [transit.map_token] });
});

it("does not load an additional map on desktop and follows viewport changes", () => {
  const resize = viewport(1000);
  render(<MobileTripMap plan={plan()} routeLoading={false} />);
  expect(map).not.toHaveBeenCalled();
  resize(650);
  expect(screen.getByTestId("booklet-map")).toBeTruthy();
  resize(651);
  expect(screen.queryByTestId("booklet-map")).toBeNull();
});

it("updates edited stops and dates, and discards routes from the old itinerary", () => {
  viewport(390);
  const current = plan();
  const { rerender } = render(<MobileTripMap plan={current} routeLoading={false} />);
  const edited = { ...current, date: "2026-10-18", stops: [...current.stops].reverse() };
  rerender(<MobileTripMap plan={edited} routeLoading />);
  expect(screen.getByTestId("booklet-map").textContent).toBe("京都の庭園 → 京都の博物館");
  expect(map.mock.calls.at(-1)?.[0]).toMatchObject({ journeyDate: edited.date, routeLoading: true, timeline: [], mapTokens: [] });
});
