import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TripTransit } from "./TripTransit";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const from = { name: "博物館", latitude: 35, longitude: 135 };
const to = { name: "カフェ", latitude: 35.01, longitude: 135 };

it("searches a facility pair with the rolled-over departure date and keeps fare and route together", async () => {
  const result = { type: "transit", from_name: from.name, to_name: to.name, mode: "public_transport", transit_line: "地下鉄", fare_yen: 260,
    start_time: "00:15", end_time: "00:30", duration_minutes: 15, is_estimate: false, legs: [{ from_name: "駅A", to_name: "駅B", line_name: "地下鉄", mode: "train", duration_minutes: 10 }] };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
  vi.stubGlobal("fetch", fetch);
  const onResult = vi.fn();
  const view = render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={1455} onResult={onResult} />);
  expect(screen.getByText("運賃目安：").nextElementSibling?.textContent).toBe("未確認");
  expect(screen.getByText('徒歩なら約19分')).toBeTruthy();
  expect(screen.queryByText(/250円/)).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(result));
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ departure_date: "2026-10-14", departure_time: "00:15", origin: from, destination: to });
  view.rerender(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={1455} initial={result as never} onResult={onResult} />);
  expect(screen.getByText("博物館 → カフェ")).toBeTruthy();
  const heading = screen.getByText("博物館 → カフェ").parentElement;
  expect(heading?.className).toBe("trip-transit-heading");
  expect(heading?.textContent).toContain("運賃目安：260円");
  const fareLabel = screen.getByText("運賃目安：");
  expect(fareLabel.nextElementSibling?.textContent).toBe("260円");
  const transitDetails = screen.getByText("交通手段・所要時間を見る").closest("details");
  expect(transitDetails?.open).toBe(false);
  fireEvent.click(screen.getByText("交通手段・所要時間を見る"));
  expect(transitDetails?.open).toBe(true);
  expect(screen.getByText("交通手段").nextElementSibling?.textContent).toBe("地下鉄");
  expect(screen.getByText("所要時間").nextElementSibling?.textContent).toBe("約15分");
  fireEvent.click(screen.getByText("路線・乗換を見る"));
  expect(screen.getAllByText(/地下鉄/).length).toBeGreaterThan(0);
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

it("omits the movement category when route details are unavailable", () => {
  const initial = { type: "transit" as const, from_name: from.name, to_name: to.name, mode: "walk" as const,
    start_time: null, end_time: null, duration_minutes: 12, is_estimate: true, fare_yen: 0 };
  render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={540} initial={initial} onResult={vi.fn()} />);
  expect(screen.getByText("運賃目安：").nextElementSibling?.textContent).toBe("0円");
  expect(screen.getByText("交通手段・所要時間を見る").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("交通手段・所要時間を見る"));
  expect(screen.getByText("交通手段").nextElementSibling?.textContent).toBe("徒歩");
  expect(screen.getByText("所要時間").nextElementSibling?.textContent).toBe("約12分（概算）");
});

it("removes generic movement labels and stacks multiple route legs with downward arrows", () => {
  const initial = {
    type: "transit" as const,
    from_name: from.name,
    to_name: to.name,
    mode: "public_transport" as const,
    transit_line: "移動 / JR東海道線 / 市バス",
    start_time: "09:00",
    end_time: "09:45",
    duration_minutes: 45,
    is_estimate: false,
    fare_yen: 500,
    legs: [
      { from_name: "博物館", to_name: "駅A", line_name: "JR東海道線", mode: "train", duration_minutes: 20 },
      { from_name: "駅A", to_name: "カフェ", line_name: "市バス", mode: "bus", duration_minutes: 25 },
    ],
  };
  render(<TripTransit from={from} to={to} date="2026-10-13" departureMinute={540} initial={initial} onResult={vi.fn()} />);
  expect(screen.getByText("博物館 → カフェ")).toBeTruthy();
  expect(screen.getByText("運賃目安：").nextElementSibling?.textContent).toBe("500円");
  expect(screen.getByText("交通手段・所要時間を見る").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("交通手段・所要時間を見る"));
  const route = screen.getByRole("list", { name: "利用する交通手段" });
  expect(route.textContent).toContain("JR東海道線");
  expect(route.textContent).toContain("市バス");
  expect(route.textContent).not.toMatch(/鉄道 · |バス · |徒歩 · /);
  expect(route.textContent).not.toContain("移動");
  expect(route.textContent).not.toContain("/");
  expect(route.querySelectorAll(".trip-transit-route-arrow")).toHaveLength(1);
  expect(screen.getByText("交通手段").nextElementSibling?.textContent).toBe("JR東海道線↓市バス");
  expect(screen.getByText("所要時間").nextElementSibling?.textContent).toBe("約45分");
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
