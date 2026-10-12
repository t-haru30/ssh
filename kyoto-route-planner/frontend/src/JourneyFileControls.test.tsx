import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JourneyFileControls } from "./JourneyFileControls";
import { completeNextStop, newTripStop, scheduleTrip } from "./dayTrip";
import { serializeJourneyFile } from "./journeyFile";
import type { Place, RouteSuggestion } from "./types";

const origin = { name: "京都駅", latitude: 35, longitude: 135 };
const place: Place = { ...origin, id: "garden", name: "庭園", category: "自然", description: "", access_point: "", themes: [] };
const route: RouteSuggestion = { origin, places: [place], legs: [], total_minutes: 20, fare_yen: 200,
  departure_time: "09:00", arrival_time: null, title: null, story: null, note: "" };
const plan = completeNextStop(scheduleTrip({ departureTime: "09:00", availableMinutes: 180, budget: 3000 },
  origin, "2099-10-12", [newTripStop(place, 45)], { route, date: "2099-10-12", time: "09:00" }));
function upload(text: string) {
  const file = new File([text], "trip.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  fireEvent.change(screen.getByLabelText("旅程のJSONファイル"), { target: { files: [file] } });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("JourneyFileControls", () => {
  it("previews actual history and allows cancellation without adopting or mutating the current plan", async () => {
    const onImport = vi.fn();
    const before = JSON.stringify(plan);
    render(<JourneyFileControls plan={plan} title="現在の旅" onImport={onImport} />);
    upload(serializeJourneyFile(plan, "読み込む旅"));
    await screen.findByRole("dialog");
    expect(screen.getByText("読み込む旅")).toBeTruthy();
    expect(screen.getByText(/訪問済み 1か所/)).toBeTruthy();
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(JSON.stringify(plan)).toBe(before);
  });
  it("adopts only after confirmation and supports choosing the same file again", async () => {
    const onImport = vi.fn();
    render(<JourneyFileControls plan={plan} title="現在の旅" onImport={onImport} />);
    const text = serializeJourneyFile(plan, "新しい旅");
    upload(text);
    fireEvent.click(await screen.findByRole("button", { name: "この旅程を読み込む" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][0]).toMatchObject({ title: "新しい旅", plan: { stops: [{ completed: true }] } });
    expect(screen.queryByRole("dialog")).toBeNull();
    upload(text);
    await screen.findByRole("dialog");
    expect(onImport).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed and oversized files without changing the current journey", async () => {
    const onImport = vi.fn();
    render(<JourneyFileControls plan={plan} title="現在の旅" onImport={onImport} />);
    upload("{bad");
    expect((await screen.findByRole("alert")).textContent).toContain("JSON");
    upload(" ".repeat(200_001));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("200KB"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
  });
  it("ignores a file read that completes after unmount", async () => {
    let resolve!: (text: string) => void;
    const onImport = vi.fn();
    const view = render(<JourneyFileControls plan={null} title="" onImport={onImport} />);
    const file = new File([""], "trip.json");
    Object.defineProperty(file, "text", { value: () => new Promise<string>(done => { resolve = done; }) });
    fireEvent.change(screen.getByLabelText("旅程のJSONファイル"), { target: { files: [file] } });
    view.unmount(); resolve(serializeJourneyFile(plan, "旅"));
    await Promise.resolve();
    expect(onImport).not.toHaveBeenCalled();
  });
  it("exports a JSON download and revokes its temporary URL after the click", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:trip");
    const revoke = vi.fn();
    const previousCreate = URL.createObjectURL;
    const previousRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("よりみち-2099-10-12.json");
      expect(this.href).toBe("blob:trip");
    });
    try {
      render(<JourneyFileControls plan={plan} title="保存する旅" onImport={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "JSONを書き出す" }));
      expect(create).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:trip");
    } finally {
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
      vi.useRealTimers();
    }
  });
});
