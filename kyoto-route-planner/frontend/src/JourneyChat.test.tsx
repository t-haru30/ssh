import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyChat } from "./JourneyChat";
import { chatPayload, readChatProposal } from "./journeyChatState";
import { completeNextStop, newTripStop, scheduleTrip, tripClock } from "./dayTrip";
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
  it("accepts an independently sourced named landmark and keeps distant visits provisional until transit is fetched",()=>{
    const landmark={...places[0],id:"osm-way-123",name:"法隆寺",category:"寺院",latitude:34.614,longitude:135.734,tags:{source:"OpenStreetMap",license:"ODbL-1.0",source_url:"https://www.openstreetmap.org/way/123"}};
    const base=plan();base.input.budget=50000;
    const next=readChatProposal({stops:[{id:landmark.id,dwell:60}]},base,places,[landmark]);
    expect(next.stops[0].place.name).toBe("法隆寺");
    expect(next.unknownTravelSegments?.length).toBeGreaterThan(0);
    expect(()=>readChatProposal({stops:[{id:landmark.id,dwell:60}]},base,places,[{...landmark,tags:{...landmark.tags,source_url:"https://evil.example"}}])).toThrow("出典");
  });
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
  it("recomputes travel and costs without enforcing removed budget and duration settings", () => {
    const base = plan();
    const next = readChatProposal(data.proposal, base, places);
    expect(next.estimatedTravel).toBe(true); expect(next.totalCost).toBeNull(); expect(next.knownCost).toBeGreaterThan(0); expect(next.provisionalCosts).toBe(true);
    expect(next.stops[1].spending).toBeNull();
    base.input.availableMinutes = 30; base.input.budget = 0;
    const extended = readChatProposal({ stops: [{ id: "0", dwell: 360 }, { id: "1", dwell: 360 }] }, base, places);
    expect(extended.returnMinute).toBeGreaterThan(540 + base.input.availableMinutes);
    expect(extended.knownCost).toBeGreaterThan(base.input.budget);
    expect(extended.violations).toEqual([]);
    expect(extended.input).toEqual(base.input);
    const request = chatPayload(base, places, "公園を長く楽しみたい", []);
    expect(request).not.toHaveProperty("budget");
    expect(request).not.toHaveProperty("available_minutes");
  });
  it("still rejects a change that misses a fixed appointment", () => {
    const base = plan(); base.stops[1].anchorTime = "11:00"; base.stops[1].locked = true;
    expect(() => readChatProposal({ stops: [{ id: "0", dwell: 180 }, { id: "1", dwell: 90 }] }, base, places)).toThrow("固定した開始時刻");
  });
  it("restores original visit settings when undoing a removal in a follow-up", () => {
    const base = plan(); base.stops[1].spending = 750; base.stops[1].anchorTime = "11:00";
    const preview = readChatProposal({stops:[{id:"0",dwell:90},{id:"2",dwell:30}]}, base, places);
    const restored = readChatProposal({stops:[{id:"0",dwell:90},{id:"1",dwell:90}]}, preview, places, [], base);
    expect(restored.stops[1]).toMatchObject({spending:750,anchorTime:"11:00"});
    const protectedBase = plan(); protectedBase.stops[1].locked = true;
    expect(() => readChatProposal({stops:[{id:"0",dwell:90},{id:"2",dwell:30}]}, preview, places, [], protectedBase)).toThrow("固定・訪問済み");
  });
});

describe("JourneyChat", () => {
  it("shows the departure and estimated return times together", () => {
    const current = plan();
    const view = render(<JourneyChat plan={current} candidates={places} onApply={vi.fn()} />);

    expect(screen.getByText("出発〜帰着の目安").nextElementSibling?.textContent)
      .toBe(`9:00~${tripClock(current.returnMinute)}`);
    expect(view.container.querySelector(".journey-workspace-header .journey-state")).toBeNull();
    expect(view.container.querySelector(".journey-workspace-header")?.textContent).not.toContain("希望を伝える");
    expect(view.container.querySelector(".journey-conversation > .journey-pane-label")?.textContent).toBe("チャット");
    expect(view.container.querySelector("#journey-preview-panel .journey-pane-label > span")?.textContent).toBe("プレビュー");
    expect(screen.getByRole("button", { name: "マップを隠す" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マップを閉じる" })).toBeNull();
    expect(screen.queryByText("現在の旅程を編集中")).toBeNull();
    expect(screen.queryByText("旅程プレビュー")).toBeNull();
  });

  it("allows adoption after transport refresh even when an edit exceeds legacy hidden limits", async () => {
    const base = plan(); base.input.availableMinutes = 120;
    base.stops.forEach(stop => { stop.spending = 3000; });
    const apply = vi.fn();
    const previewRoute = { ...route, coordinates: [], timeline: [5, 10, 5].map(duration => ({
      type: "transit", from_name: "地点A", to_name: "地点B", mode: "public_transport", transit_line: "市バス",
      duration_minutes: duration, is_estimate: false, start_time: "09:00", end_time: "09:05", fare_yen: 100,
    })) };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/journey/chat"
      ? { message: "美術館でゆっくり過ごす変更案です。", steps: [], proposal: { stops: [{ id: "0", dwell: 120 }, { id: "1", dwell: 90 }] } }
      : previewRoute })));
    render(<JourneyChat plan={base} candidates={places} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), { target: { value: "美術館の滞在を120分に増やして" } });
    fireEvent.click(screen.getByRole("button", { name: "相談する" }));
    const adopt = await screen.findByRole("button", { name: "この案を旅程に反映" });
    await waitFor(() => expect(adopt.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(adopt);
    const next = apply.mock.calls[0][0];
    expect(next.knownCost).toBeGreaterThan(base.input.budget);
    expect(next.returnMinute - 540).toBeGreaterThan(base.input.availableMinutes);
    expect(next.violations).toEqual([]);
  });
  it("applies an inline change card only after route validation, without requiring the preview tab", async () => {
    const apply = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve({ok:true,json:async () => url === "/api/journey/chat" ? data : {...route,places:[places[0],places[2]]}})));
    render(<JourneyChat plan={plan()} candidates={places} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), {target:{value:"カフェを追加"}});
    fireEvent.click(screen.getByRole("button", {name:"相談する"}));
    const card = await screen.findByRole("article", {name:"会話内の変更案"});
    expect(card.textContent).toContain("カフェ");
    const adopt = screen.getByRole("button", {name:"この案を旅程に反映"});
    expect(adopt.hasAttribute("disabled")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:/^現在の旅程$/}));
    await waitFor(() => expect(adopt.hasAttribute("disabled")).toBe(false));
    fireEvent.click(adopt);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].stops.map((s:{place:{id:string}})=>s.place.id)).toEqual(["0","2"]);
    expect(screen.queryByRole("article", {name:"会話内の変更案"})).toBeNull();
  });

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
    const followUp = JSON.parse(fetchMock.mock.calls.filter(call => call[0] === "/api/journey/chat")[1][1].body);
    expect(followUp.history.some((m: {text: string}) => m.text.includes("未反映の変更案"))).toBe(true);
    expect(followUp.stops.map((s: {place: {id: string}}) => s.place.id)).toEqual(["0", "2"]);
    expect(followUp.applied_stops.map((s: {place: {id: string}}) => s.place.id)).toEqual(["0", "1"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "この変更を反映" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].stops.map((s: {place: {id: string}}) => s.place.id)).toEqual(["0", "2"]);
  });
  it("keeps discovered visits in follow-ups and preserves a preview if the next request fails", async () => {
    const live = { ...places[2], id: "osm-cafe-node-123", name: "川辺の喫茶店", category: "カフェ", tags: { source: "OpenStreetMap", amenity: "cafe", source_url: "https://www.openstreetmap.org/node/123" } };
    const requests: ReturnType<typeof chatPayload>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url !== "/api/journey/chat") throw new Error("offline routes");
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 3) return {ok:false, json: async () => ({detail:"通信に失敗しました"})};
      return {ok:true, json: async () => ({message:"変更案です",steps:[],proposal:{stops:[{id:"0",dwell:90},{id:live.id,dwell:requests.length === 1 ? 60 : 30}]},discovered_candidates:requests.length === 1 ? [live] : []})};
    }));
    const apply = vi.fn(); render(<JourneyChat plan={plan()} candidates={places.slice(0, 2)} onApply={apply} />);
    const send = (text: string) => {
      fireEvent.change(screen.getByLabelText("旅程への希望"), {target:{value:text}});
      fireEvent.click(screen.getByRole("button", {name:"相談する"}));
    };
    send("公園の代わりにカフェを追加して");
    await screen.findByRole("article", {name:"会話内の変更案"});
    send("そのカフェを30分にして");
    await waitFor(() => expect(requests).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText("変更案を考えています")).toBeNull());
    expect(requests[1].stops[1]).toMatchObject({place:{id:live.id},dwell:60});
    expect(requests[1].candidates.some(p => p.id === live.id)).toBe(true);
    expect(requests[1].candidates.some(p => p.id === "1")).toBe(true);
    await waitFor(() => expect(screen.getByTestId("preview-map").textContent).toContain(live.name));
    expect(screen.getByText(/30\s*分の滞在/)).toBeTruthy();
    send("もう30分長くして");
    expect((await screen.findByRole("alert")).textContent).toContain("通信に失敗");
    expect(requests[2].stops[1].dwell).toBe(30);
    expect(screen.getByTestId("preview-map").textContent).toContain(live.name);
    expect(screen.getByRole("article", {name:"会話内の変更案"})).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });
  it("edits the applied plan again after rejecting a preview", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
      if (url !== "/api/journey/chat") throw new Error("offline routes");
      return {ok:true,json:async () => data};
    }); vi.stubGlobal("fetch", fetchMock);
    render(<JourneyChat plan={plan()} candidates={places} onApply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("旅程への希望"), {target:{value:"カフェを追加"}});
    fireEvent.click(screen.getByRole("button", {name:"相談する"}));
    fireEvent.click(await screen.findByRole("button", {name:"この案を見送る"}));
    fireEvent.change(screen.getByLabelText("旅程への希望"), {target:{value:"公園を短くして"}});
    fireEvent.click(screen.getByRole("button", {name:"相談する"}));
    await screen.findByRole("article", {name:"会話内の変更案"});
    const latest = JSON.parse(fetchMock.mock.calls.filter(c => c[0] === "/api/journey/chat")[1][1].body as string);
    expect(latest.stops.map((s: {place:{id:string}}) => s.place.id)).toEqual(["0","1"]);
    expect(latest.applied_stops).toBeUndefined();
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
