import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TripTransit } from "./TripTransit";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const from = { name: "博物館", latitude: 35, longitude: 135 };
const to = { name: "カフェ", latitude: 35.01, longitude: 135 };

it("searches a facility pair with the rolled-over departure date and keeps fare and route together", async () => {
  const result = { type: "transit", from_name: from.name, to_name: to.name, mode: "public_transport", fare_yen: 260,
    start_time: "00:15", end_time: "00:30", duration_minutes: 15, is_estimate: false, legs: [{ from_name: "駅A", to_name: "駅B", line_name: "地下鉄", mode: "train", duration_minutes: 10 }] };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
  vi.stubGlobal("fetch", fetch);
  const onResult = vi.fn();
  const view = render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={1455} onResult={onResult} />);
  expect(screen.getByText(/交通費の仮置き 250円/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(result));
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ departure_date: "2026-10-14", departure_time: "00:15", origin: from, destination: to });
  view.rerender(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={1455} initial={result as never} onResult={onResult} />);
  expect(screen.getByText("概算運賃 260円")).toBeTruthy();
  fireEvent.click(screen.getByText("路線・乗換を見る"));
  expect(screen.getByText(/地下鉄/)).toBeTruthy();
});

it("keeps the current itinerary intact when a segment lookup fails and allows retry", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal("fetch", fetch);
  const onResult = vi.fn();
  render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={540} onResult={onResult} />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("status");
  expect(onResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});
