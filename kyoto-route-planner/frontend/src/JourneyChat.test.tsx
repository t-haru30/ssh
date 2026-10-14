import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyChat } from "./JourneyChat";
import { readChatProposal } from "./journeyChatState";
import { completeNextStop, newTripStop, scheduleTrip } from "./dayTrip";
import type { RouteSuggestion } from "./types";

vi.mock("./LazyMapView", () => ({ LazyMapView: ({places}: {places: {name: string}[]}) => <div data-testid="preview-map">{places.map(p => p.name).join(" → ")}</div> }));
vi.mock("./FacilityPhoto", () => ({ FacilityPhoto: () => <span>施設画像</span> }));

const origin = { name: "駅", latitude: 35, longitude: 135 };
const places = ["美術館", "公園", "カフェ"].map((name, i) => ({ ...origin, id: String(i), name, category: "観光", description: "", access_point: "", themes: [] }));
const route: RouteSuggestion = { origin, places: places.slice(0, 2), legs: [], total_minutes: 20, fare_yen: 200, departure_time: "09:00", arrival_time: null, title: "旅", story: null, note: "" };
const plan = () => scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, "2026-10-15", route.places.map(p => newTripStop(p)), { route, date: "2026-10-15", time: "09:00" });
const data = { message: "変更案です", steps: ["候補を検索しました", "検証しました"], proposal: { stops: [{ id: "0", dwell: 90 }, { id: "2", dwell: 30 }] } };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline"))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("chat proposal validation", () => {
  it("accepts sourced live cafes, rejects source spoofing and too-short stays", () => {
    const live = { ...places[2], id: "osm-cafe-node-123", category: "カフェ", tags: { source: "OpenStreetMap", amenity: "cafe", source_url: "https://www.openstreetmap.org/node/123" } };
    const proposed = { stops: [{ id: "0", dwell: 90 }, { id: live.id, dwell: 30 }] };
    const next = readChatProposal(proposed, plan(), places, [live]);
    expect(next.stops[1].place.tags?.source_url).toBe(live.tags.source_url);
    expect(() => readChatProposal(proposed, plan(), places, [{ ...live, tags: { ...live.tags, source_url: "https://example.com" } }])).toThrow("出典");
    expect(() => readChatProposal({ stops: [{ id: "2", dwell: 15 }] }, plan(), places)).toThrow("30分");
    const poi = { ...live, id: "openpoi-0123456789abcdef01234567", tags: { source: "OpenPOI API", venue_type: "cafe", position_check: "gsi_neighbourhood", source_url: "https://openpoiapi.com/attribution.html", licenses: '["CDLA-Permissive-2.0"]', attributions: '["Overture Maps Foundation"]' } };
    expect(readChatProposal({ stops: [{ id: poi.id, dwell: 30 }] }, plan(), places, [poi]).stops[0].place.id).toBe(poi.id);
    expect(() => readChatProposal({ stops: [{ id: poi.id, dwell: 30 }] }, plan(), places, [{ ...poi, tags: { ...poi.tags, position_check: "" } }])).toThrow("出典");
  });
  it("protects fixed and completed stops and rejects fabricated IDs", () => {
    const base = plan(); base.stops[0].locked = true;
    for (const stops of [[{ id: "1", dwell: 30 }], [{ id: "0", dwell: 15 }], [{ id: "other", dwell: 30 }]]) expect(() => readChatProposal({ stops }, base, places)).toThrow();
    const completed = completeNextStop(base);
    expect(() => readChatProposal({ stops: [{ id: "1", dwell: 30 }, { id: "0", dwell: 90 }] }, completed, places)).toThrow("訪問済み");
    const next = readChatProposal(data.proposal, completed, places);
    expect(next.stops[0]).toMatchObject({ completed: true, start: completed.stops[0].start, end: completed.stops[0].end });
  });
  it("recomputes travel, estimates new costs, rejects infeasible changes", () => {
    const base = plan();
    const next = readChatProposal(data.proposal, base, places);
    expect(next.estimatedTravel).toBe(true); expect(next.totalCost).toBeGreaterThan(0); expect(next.provisionalCosts).toBe(true);
    expect(next.stops[1].spending).toBeNull();
    expect(() => readChatProposal({ stops: [{ id: "0", dwell: 360 }, { id: "1", dwell: 360 }] }, base, places)).toThrow("収まりません");
  });
});

describe("JourneyChat", () => {
  it("reorders by drag into a validated preview, with travel between stops and fixed positions protected", async () => {
    const base = scheduleTrip({departureTime:"09:00",availableMinutes:600,budget:10000}, origin, "2026-10-15", places.map(p => newTripStop(p,30)), {route:{...route,places},date:"2026-10-15",time:"09:00"});
    base.stops[0].locked = true;
    const apply = vi.fn();
    const {container} = render(<JourneyChat plan={base} candidates={places} onApply={apply} />);
    expect(screen.getByRole("button",{name:"美術館の並べ替え"}).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button",{name:"公園を前へ移動"}).hasAttribute("disabled")).toBe(true);
    fireEvent.dragStart(screen.getByRole("button",{name:"カフェの並べ替え"}),{dataTransfer:{setData:vi.fn()}});
    fireEvent.drop(container.querySelector('[data-stop-id="1"]')!);
    expect(screen.getByTestId("preview-map").textContent).toBe("美術館 → カフェ → 公園");
    expect(container.querySelector('[aria-label="プレビューの移動：美術館からカフェ"]')).not.toBeNull();
    expect(base.stops.map(s=>s.place.id)).toEqual(["0","1","2"]);
    expect(apply).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button",{name:"この変更を反映"}).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"この変更を反映"}));
    expect(apply.mock.calls[0][0].stops.map((s:{place:{id:string}})=>s.place.id)).toEqual(["0","2","1"]);
  });
  it("previews replacements on the map, protects fixed stops and applies explicitly", async () => {
    const base = plan(); base.stops[0].locked = true;
    const apply = vi.fn();
    render(<JourneyChat plan={base} candidates={places} onApply={apply} />);
    expect(screen.getByRole("button", {name: "プレビューで美術館を入れ替える"}).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", {name: "プレビューで公園を入れ替える"}));
    fireEvent.change(screen.getByLabelText("公園の入れ替え先"), {target: {value: "2"}});
    expect(screen.getByTestId("preview-map").textContent).toBe("美術館 → カフェ");
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: /^現在の旅程$/}));
    expect(screen.getByTestId("preview-map").textContent).toBe("美術館 → 公園");
    fireEvent.click(screen.getByRole("button", {name: /変更案 ●/}));
    await waitFor(() => expect(screen.getByRole("button",{name:"この変更を反映"}).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", {name: "この変更を反映"}));
    expect(apply.mock.calls[0][0].stops.map((s: {place: {id: string}}) => s.place.id)).toEqual(["0", "2"]);
  });
  it("previews without applying, supports explicit adoption and follow-up context", async () => {
    const apply = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => data }); vi.stubGlobal("fetch", fetchMock);
    render(<JourneyChat plan={plan()} candidates={places} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), { target: { value: "カフェを追加" } });
    fireEvent.click(screen.getByRole("button", { name: "相談する" }));
    await screen.findByRole("button", { name: "この変更を反映" });
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^現在の旅程$/ }));
    expect(screen.getByRole("button", { name: "この変更を反映" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /変更案 ●/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "この変更を反映" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("旅程への希望"), { target: { value: "カフェはもう少し短く" } });
    fireEvent.click(screen.getByRole("button", { name: "相談する" }));
    await screen.findByRole("button", { name: "この変更を反映" });
    expect(JSON.parse(fetchMock.mock.calls.filter(call => call[0] === "/api/journey/chat")[1][1].body).history.some((m: {text: string}) => m.text.includes("未反映の変更案"))).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "この変更を反映" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].stops.map((s: {place: {id: string}}) => s.place.id)).toEqual(["0", "2"]);
  });
  it("discards late replies when the plan changes", async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn((_url: string, _options: RequestInit) => new Promise(r => { resolve = r; })); vi.stubGlobal("fetch", fetchMock);
    const base = plan(); const view = render(<JourneyChat plan={base} candidates={places} onApply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), { target: { value: "カフェを追加" } });
    fireEvent.click(screen.getByRole("button", { name: "相談する" }));
    view.rerender(<JourneyChat plan={{ ...base, date: "2026-10-16" }} candidates={places} onApply={vi.fn()} />);
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
    resolve({ ok: true, json: async () => data });
    await waitFor(() => expect(screen.queryByRole("button", { name: "この変更を反映" })).toBeNull());
  });
  it("shows unavailable status without applying a fallback edit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: "AIチャットが未設定です。" }) }));
    const apply = vi.fn(); render(<JourneyChat plan={plan()} candidates={places} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), { target: { value: "休憩したい" } });
    fireEvent.click(screen.getByRole("button", { name: "相談する" }));
    expect((await screen.findByRole("alert")).textContent).toContain("未設定"); expect(apply).not.toHaveBeenCalled();
  });
});
