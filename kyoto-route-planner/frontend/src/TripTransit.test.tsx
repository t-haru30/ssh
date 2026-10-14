import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("labels walking explicitly without inventing a railway", () => {
  const initial = { type: "transit" as const, from_name: from.name, to_name: to.name, mode: "walk" as const,
    start_time: null, end_time: null, duration_minutes: 12, is_estimate: true, fare_yen: 0 };
  render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={540} initial={initial} onResult={vi.fn()} />);
  expect(screen.getByText(/徒歩 · 徒歩区間/)).toBeTruthy();
  expect(screen.getByText("概算運賃 0円")).toBeTruthy();
});

it("cancels the old segment when conditions change and never applies a late response to the new itinerary", async () => {
  let resolveOld!: (value: unknown) => void;
  let resolveNew!: (value: unknown) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const onResult = vi.fn();
  const view = render(<TripTransit from={from} to={to} date="2026-10-14" departureMinute={540} onResult={onResult} />);
  fireEvent.click(screen.getByRole("button"));
  const oldSignal = fetcher.mock.calls[0][1].signal;
  const newFrom = { ...from, name: "別の駅", latitude: 36 };
  view.rerender(<TripTransit from={newFrom} to={to} date="2026-10-14" departureMinute={600} onResult={onResult} />);
  expect(oldSignal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button"));
  const result = { type:"transit",from_name:from.name,to_name:to.name,mode:"public_transport",start_time:"09:00",end_time:"09:15",duration_minutes:15,is_estimate:false,fare_yen:260 };
  await act(async () => { resolveOld({ok:true,json:async () => result}); });
  expect(onResult).not.toHaveBeenCalled();
  expect(screen.getByRole("button").textContent).toBe("経路と運賃を検索中…");
  const current = {...result,from_name:newFrom.name,start_time:"10:00",end_time:"10:15"};
  await act(async () => { resolveNew({ok:true,json:async () => current}); });
  expect(onResult).toHaveBeenCalledExactlyOnceWith(current);
});

it("uses the current stop callback when an unchanged segment moves to another position", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch",vi.fn(() => new Promise(r => {resolve=r;})));
  const oldCallback=vi.fn(), currentCallback=vi.fn();
  const view=render(<TripTransit from={from} to={to} date="2026-10-14" departureMinute={540} onResult={oldCallback} />);
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<TripTransit from={from} to={to} date="2026-10-14" departureMinute={540} onResult={currentCallback} />);
  const result={type:"transit",from_name:from.name,to_name:to.name,mode:"public_transport",start_time:"09:00",end_time:"09:15",duration_minutes:15,is_estimate:false};
  await act(async () => {resolve({ok:true,json:async () => result});});
  expect(oldCallback).not.toHaveBeenCalled();
  expect(currentCallback).toHaveBeenCalledExactlyOnceWith(result);
});
