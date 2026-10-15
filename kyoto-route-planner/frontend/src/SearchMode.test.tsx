import { cleanup, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchMode } from "./SearchMode";
import { readJourneyDraft, saveJourneyDraft } from "./journeyDraft";
import { completeNextStop, newTripStop, scheduleTrip } from "./dayTrip";
import { routeSelection } from "./routeSelection";
import { serializeJourneyFile } from "./journeyFile";
import { savedOvernight, type OvernightSnapshot } from "./overnightFavorite";

import { FavoritesProvider } from "./useFavorites";
import { PrefectureProvider } from "./PrefectureContext";
import type { ReactElement } from "react";
// Image lookup is independent of itinerary/transport requests and tested separately.
vi.mock("./FacilityPhoto", () => ({ FacilityPhoto: () => null }));

function render(ui: ReactElement) { return testingRender(ui, { wrapper: ({ children }) => <PrefectureProvider><FavoritesProvider>{children}</FavoritesProvider></PrefectureProvider> }); }

const SAVED_PLAN_STORAGE_KEY = "kyoto-route-planner:saved-plan:v1";
const SEARCH_FORM_STORAGE_KEY = "kyoto-route-planner:search-form:v1";
const savedRoute = {
  places: [{
    id: "saved-spot",
    name: "保存済みスポット",
    category: "文化",
    description: "保存された候補地",
    access_point: "",
    latitude: 35,
    longitude: 135,
    themes: ["history"],
  }],
  origin: { name: "京都駅", latitude: 35, longitude: 135 },
  legs: [],
  title: "保存済みルート",
  story: "前回の検索結果",
  total_minutes: null,
  departure_time: "09:00",
  arrival_time: null,
  timeline: [],
  note: "テスト用",
  coordinates: [],
};

vi.mock("./LazyMapView", () => ({ LazyMapView: () => null }));
vi.mock("./IdeaDeck", () => ({ IdeaDeck: () => null }));
vi.mock("./localPlaces", () => ({ localPlaces: [
  { id: "local-park", name: "駅前公園", latitude: 34.987, longitude: 135.76, category: "公園", description: "", access_point: "", themes: ["nature"] },
  { id: "local-cafe", name: "川辺カフェ", latitude: 34.988, longitude: 135.761, category: "カフェ", description: "", access_point: "", themes: ["food"] },
  { id: "local-museum", name: "小さな美術館", latitude: 34.989, longitude: 135.762, category: "美術館", description: "", access_point: "", themes: ["history"] },
] }));
vi.mock("./RouteTimeline", () => ({
  buildDayTimeline: () => [],
  buildRouteTimeline: () => [],
  RouteTimeline: () => null,
  withRouteLegs: (items: unknown) => items,
}));

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function overnightSnapshot(): OvernightSnapshot {
  const hotel = { ...savedRoute.places[0], themes: ["history" as const], id: "hotel", name: "保存した宿" };
  return { version: 1, nights: 1, stopsPerDay: 3, radius: 30, mood: "庭園", departureDate: "2026-10-20", departureTime: "08:15",
    itinerary: { query: null, origin: savedRoute.origin, hotel, feasible: true, route_search_calls: 2, note: "宿泊旅程",
      days: [1, 2].map(day => ({ day, date: `2026-10-${19 + day}`, places: [{ ...hotel, id: `overnight-${day}`, name: `宿泊旅の場所${day}` }],
        legs: [], schedule: [], lunch: { type: "lunch", place: null, start_time: "12:00", end_time: "13:00", reason: "" }, transit_minutes: 0, stay_minutes: 90, estimated_arrival_at: null, coordinates: [] })) } };
}

describe("overnight favorite UI", () => {
  it("saves the generated overnight result after post-search condition editing is removed", async () => {
    const snapshot = overnightSnapshot();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({ ok: true,
      json: async () => String(input).includes("/api/itineraries/overnight") ? snapshot.itinerary : [snapshot.itinerary.origin] })));
    render(<SearchMode active />);
    await waitFor(() => expect((screen.getByRole("button", { name: /この条件で旅程を提案する/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "宿泊あり" }));
    fireEvent.click(screen.getByRole("button", { name: /自然・景色/ }));
    fireEvent.change(screen.getByLabelText("出発日"), { target: { value: snapshot.departureDate } });
    fireEvent.change(screen.getByLabelText("出発時刻"), { target: { value: snapshot.departureTime } });
    fireEvent.click(screen.getByRole("button", { name: /旅のしおりを作る/ }));
    await screen.findByRole("button", { name: /この旅程を保存/ });
    expect(screen.queryByRole("combobox", { name: /泊数/ })).toBeNull();
    expect(screen.queryByLabelText("出発日")).toBeNull();
    expect(screen.queryByRole("button", { name: "条件を変更する" })).toBeNull();
    cleanup(); render(<SearchMode active />);
    await screen.findByRole("button", { name: /この旅程を保存/ });
    fireEvent.click(screen.getByRole("button", { name: /この旅程を保存/ }));
    const saved = JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1")!)[0];
    expect(saved.overnight_snapshot).toMatchObject({ nights: 1, departureDate: snapshot.departureDate, departureTime: snapshot.departureTime, radius: 30 });
    expect(saved.overnight_snapshot.itinerary.days).toHaveLength(2);
    expect(saved.theme).toBe("nature");
  });
  it("restores an overnight favorite without route calls and removes the old day trip draft before reload", async () => {
    const snapshot = overnightSnapshot();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => [snapshot.itinerary.origin] }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SearchMode active preset={{ theme: "history", stopCount: 1, nonce: 101, places: [{ ...savedRoute.places[0], themes: ["history"] }], origin: savedRoute.origin, title: "古い日帰り", dwellMinutes: {} }} />);
    await waitFor(() => expect(readJourneyDraft()).not.toBeNull());
    view.rerender(<SearchMode active preset={{ ...routeSelection(savedOvernight(snapshot, "nature")), nonce: 102, autoSearch: true }} />);
    await waitFor(() => expect(readJourneyDraft()).toBeNull());
    expect(screen.getByText(/保存した宿泊旅程を開きました/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(call => String(call[0]) === "/api/origins")).toBe(true);
    cleanup(); render(<SearchMode active />);
    await screen.findByRole("button", { name: /この旅程を保存/ });
    expect(readJourneyDraft()).toBeNull();
    expect(screen.queryByText(/前回の旅程を復元しました/)).toBeNull();
  });
});

describe("SearchMode nearby departures", () => {
  it("shows map and itinerary together without a display switch or transport request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => [savedRoute.origin] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchMode active preset={{ theme: "history", stopCount: 1, nonce: 777,
      places: [{ ...savedRoute.places[0], themes: ["history"] }], origin: savedRoute.origin,
      title: "表示切り替えの旅", dwellMinutes: {} }} />);
    await waitFor(() => expect(readJourneyDraft()).not.toBeNull());
    expect(document.getElementById("journey-map")).toBeTruthy();
    expect(document.getElementById("journey-timeline")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "旅程と地図の表示切り替え" })).toBeNull();
    expect(fetchMock.mock.calls.every(call => String(call[0]) === "/api/origins")).toBe(true);
  });
  it("loads nearby station and stop options and submits the selected coordinates", async () => {
    const origins = [
      { name: "京都駅", latitude: 34.9858, longitude: 135.7588 },
      { name: "大阪駅", latitude: 34.7, longitude: 135.5 },
    ];
    const nearbyStations = [
      { name: "最寄りバス停", latitude: 34.986, longitude: 135.759 },
      { name: "周辺地下鉄駅", latitude: 34.987, longitude: 135.76 },
    ];
    let submittedRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = url.includes("/api/origins")
        ? origins
        : url.includes("/api/nearby-stations")
          ? nearbyStations
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
      if (url.includes("/api/routes")) {
        submittedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { ok: false, json: async () => ({ detail: "test complete" }) } as Response;
      }
      return { ok: true, json: async () => json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({
        coords: { latitude: 34.986, longitude: 135.758 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    render(<SearchMode active />);

    const departureSelect = (await screen.findAllByRole("combobox"))[0];
    const locationButton = await screen.findByRole("button", { name: "現在地から探す" });
    await waitFor(() => expect((locationButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(locationButton);

    await waitFor(() => expect((departureSelect as HTMLSelectElement).selectedOptions[0].textContent).toBe("最寄りバス停"));
    expect(within(departureSelect).getByRole("option", { name: "周辺地下鉄駅" })).toBeTruthy();
    expect(within(departureSelect).getByRole("option", { name: "京都駅" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nearby-stations?latitude=34.986&longitude=135.758",
      expect.anything(),
    );

    fireEvent.change(departureSelect, { target: { value: (within(departureSelect).getByRole("option", { name: "周辺地下鉄駅" }) as HTMLOptionElement).value } });
    fireEvent.click(screen.getByRole("button", { name: /この条件で旅程を提案する/ }));
    expect(submittedRequest).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /交通経路を再検索/ }));
    await waitFor(() => expect(submittedRequest).not.toBeNull());
    expect(submittedRequest).toMatchObject({
      origin: {name:"周辺地下鉄駅",latitude:34.987,longitude:135.76},
      return_to: {name:"周辺地下鉄駅",latitude:34.987,longitude:135.76},
    });
  });

  it("shows an empty-route fallback and allows retrying the search", async () => {
    window.localStorage.setItem(SAVED_PLAN_STORAGE_KEY, JSON.stringify({ suggestions: [savedRoute], overnightSuggestion: null }));
    const routeRequests = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.split("?")[0] === "/api/routes/preview") {
        routeRequests();
        return { ok: true, json: async () => ({ routes: [] }) } as Response;
      }
      if (url.includes("/api/origins")) {
        return { ok: true, json: async () => [{ name: "京都駅", latitude: 35, longitude: 135 }] } as Response;
      }
      if (url.includes("/api/places/status")) {
        return { ok: true, json: async () => ({ warning: null, state: "success" }) } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }));

    render(<SearchMode active />);

    const search = await screen.findByRole("button", { name: /交通経路を再検索/ });
    await waitFor(() => expect(search).toHaveProperty("disabled", false));
    fireEvent.click(search);
    expect((await screen.findByRole("alert")).textContent).toContain("スポットが見つかりませんでした");

    const previousCount=routeRequests.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(routeRequests.mock.calls.length).toBeGreaterThan(previousCount));
  });

  it("restores a saved route without exposing post-search condition controls", async () => {
      window.localStorage.setItem(SAVED_PLAN_STORAGE_KEY, JSON.stringify({
        suggestions: [savedRoute],
        overnightSuggestion: null,
      }));
      window.localStorage.setItem(SEARCH_FORM_STORAGE_KEY, JSON.stringify({
        originName: "大阪駅",
        nearbyStations: [],
        theme: "history",
        mood: "静かな場所",
        stopCount: 2,
        departureDate: "2026-10-13",
        departureTime: "10:30",
        isOvernight: false,
        regenerationCount: 0,
      }));
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = url.includes("/api/origins")
          ? [
            { name: "京都駅", latitude: 35, longitude: 135 },
            { name: "大阪駅", latitude: 34.7, longitude: 135.5 },
          ]
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
        return { ok: true, json: async () => json } as Response;
      }));

      render(<SearchMode active />);

      expect(await screen.findByRole("textbox", { name: "プラン名" })).toHaveProperty("value", "保存済みルート");
      expect(screen.queryByRole("button", { name: "条件を変更する" })).toBeNull();
      expect(screen.queryByLabelText("出発日")).toBeNull();
      expect(screen.queryByRole("combobox", { name: "出発駅" })).toBeNull();
      expect(screen.queryByText("好きな過ごし方")).toBeNull();
      await waitFor(() => expect(readJourneyDraft()?.plan.stops[0].place.id).toBe("saved-spot"));
      expect(window.localStorage.getItem(SAVED_PLAN_STORAGE_KEY)).toBeNull();
      expect(screen.queryByRole("button", { name: "宿泊あり" })).toBeNull();
  });

  it("saves route results returned by the route API", async () => {
      window.localStorage.setItem(SAVED_PLAN_STORAGE_KEY, JSON.stringify({ suggestions: [savedRoute], overnightSuggestion: null }));
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/routes")) {
          return { ok: true, json: async () => ({ routes: [savedRoute] }) } as Response;
        }
        const json = url.includes("/api/origins")
          ? [{ name: "京都駅", latitude: 35, longitude: 135 }]
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
        return { ok: true, json: async () => json } as Response;
      }));

      render(<SearchMode active />);
      const search = await screen.findByRole("button", { name: /交通経路を再検索/ });
      await waitFor(() => expect(search).toHaveProperty("disabled", false));
      fireEvent.click(search);

      await waitFor(() => {
        const draft = readJourneyDraft();
        expect(draft?.title).toBe("保存済みルート");
        expect(draft?.plan.transport.date).toBeTruthy();
        expect(draft?.plan.stops[0].place.name).toBe("保存済みスポット");
        expect(window.localStorage.getItem(SAVED_PLAN_STORAGE_KEY)).toBeNull();
    });
  });
});

describe("SearchMode local initial proposal", () => {
  const origins = [
    { name: "京都駅", latitude: 34.9858, longitude: 135.7588 },
    { name: "帰着駅", latitude: 34.99, longitude: 135.763 },
  ];
  it("applies initial constraints, multiple preferences and destination before any transit request", async () => {
    let submitted: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/routes/preview") {
        submitted = JSON.parse(String(init?.body));
        return { ok: false, json: async () => ({ detail: "test complete" }) };
      }
      return { ok: true, json: async () => origins };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchMode active />);
    await waitFor(() => expect((screen.getByRole("button", { name: /この条件で旅程を提案する/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "出発駅に戻る" }));
    const returnSelect = screen.getByRole("combobox", { name: "帰着駅" });
    fireEvent.change(returnSelect, { target: { value: (within(returnSelect).getByRole("option", { name: "帰着駅" }) as HTMLOptionElement).value } });
    fireEvent.change(screen.getByLabelText(/使える時間（分）/), { target: { value: "140" } });
    fireEvent.change(screen.getByLabelText(/1人あたりの予算（円）/), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "カフェ" }));
    expect(screen.getByRole("button", { name: "食事" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "カフェ" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /この条件で旅程を提案する/ }));
    expect(await screen.findByRole("heading", { name: "駅前公園" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "川辺カフェ" })).toBeNull();
    expect(readJourneyDraft()?.plan.input).toMatchObject({availableMinutes:140,budget:500});
    expect(screen.queryByText("時間と予算を調整")).toBeNull();
    expect(screen.getAllByText(/帰着駅/).length).toBeGreaterThan(0);
    expect(readJourneyDraft()?.plan.input.preferences).toEqual(expect.arrayContaining(["nature", "culture", "food", "coffee"]));
    expect(screen.queryByText(/登録カテゴリ「公園」.*希望の自然/)).toBeNull();
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(["/api/origins"]);
    fireEvent.click(screen.getByRole("button", { name: /交通経路を再検索/ }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ return_to: {name:"帰着駅",latitude:34.99,longitude:135.763} });
    expect((submitted as unknown as { places: { id: string }[] }).places.some(place => place.id === "local-cafe")).toBe(false);
  });
  it("keeps the form and entered conditions when no feasible initial proposal exists", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => origins }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchMode active />);
    await waitFor(() => expect((screen.getByRole("button", { name: /この条件で旅程を提案する/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/使える時間（分）/), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(/1人あたりの予算（円）/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /この条件で旅程を提案する/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("初期案がありません"));
    expect((screen.getByLabelText(/使える時間（分）/) as HTMLInputElement).value).toBe("30");
    expect(screen.getByRole("button", { name: /この条件で旅程を提案する/ })).toBeTruthy();
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});

describe("SearchMode selected route", () => {
  it("saves a legacy draft as a new card when its original favorite is no longer present", async () => {
    const place={...savedRoute.places[0],themes:["history","history"] as const};
    const plan=scheduleTrip({departureTime:"09:00",availableMinutes:360,budget:5000},savedRoute.origin,"2099-10-17",
      [newTripStop({...place,themes:[...place.themes]},60)],{route:{...savedRoute,places:[{...place,themes:[...place.themes]}]},date:"",time:""});
    expect(saveJourneyDraft(plan,"以前の旅程","deleted-favorite-id")).toBe(true);
    vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>[savedRoute.origin]})));
    render(<SearchMode active />);
    const save=await screen.findByRole("button",{name:"♡ この旅程を保存"});
    await waitFor(()=>expect(save).toHaveProperty("disabled",false));
    fireEvent.click(save);
    await screen.findByText(/保存しました/);
    const favorites=JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1")!);
    expect(favorites).toHaveLength(1);
    expect(favorites[0].title).toBe("以前の旅程");
    expect(readJourneyDraft()?.sourceFavoriteId).not.toBe("deleted-favorite-id");
    expect(serializeJourneyFile(readJourneyDraft()!.plan,"以前の旅程")).toContain("以前の旅程");
  });
  it("removes post-search date controls and refreshes transport with the saved schedule", async () => {
    const calls: Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(String(input)==="/api/routes/preview") {
        calls.push(JSON.parse(String(init?.body)));
        return {ok:true,json:async()=>({...savedRoute, departure_time:"10:30"})};
      }
      return {ok:true,json:async()=>String(input)==="/api/origins"?[savedRoute.origin]:[]};
    }));
    render(<SearchMode active preset={{theme:"history",stopCount:1,nonce:177,places:savedRoute.places.map(p=>({...p,themes:["history"]})),dwellMinutes:{},origin:savedRoute.origin,title:"日時の更新",departureTime:"10:30"}} />);
    await screen.findByRole("heading",{name:"保存済みスポット"});
    expect(screen.queryByLabelText("出発日")).toBeNull();
    expect(screen.queryByLabelText("出発時刻")).toBeNull();
    expect(screen.queryByRole("button",{name:"この日時で交通情報を更新"})).toBeNull();
    expect(screen.queryByRole("button",{name:"条件を変更する"})).toBeNull();
    const refresh=screen.getByRole("button",{name:/交通経路を再検索/});
    await waitFor(()=>expect(refresh).toHaveProperty("disabled",false));
    const initialDate = readJourneyDraft()!.plan.date;
    fireEvent.click(refresh);
    await waitFor(()=>expect(calls.some(call=>call.departure_date===initialDate && call.departure_time==="10:30")).toBe(true));
    await waitFor(()=>expect(refresh).toHaveProperty("disabled",false));
    expect(screen.queryByLabelText("出発日")).toBeNull();
    await waitFor(()=>expect(readJourneyDraft()?.plan.date).toBe(initialDate));
  });
  it("refreshes a future journey by segments while preserving all seven visits and meal anchors",async()=>{
    const origin={name:"京都駅",latitude:34.9858,longitude:135.7588};
    const picked=Array.from({length:7},(_,i)=>({...origin,id:`future-${i}`,name:`未来の施設${i}`,category:"公園",description:"",access_point:"",themes:[] as []}));
    const calls:{url:string;body:Record<string,unknown>}[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.startsWith("/api/routes")){
        calls.push({url,body:JSON.parse(String(init?.body))});
        return {ok:true,json:async()=>({...savedRoute,origin,return_to:origin,places:picked,departure_time:"10:00",arrival_time:"22:00",total_minutes:720})};
      }
      return {ok:true,json:async()=>url==="/api/origins"?[origin]:[]};
    }));
    render(<SearchMode active preset={{theme:"nature",stopCount:7,nonce:33,places:picked,origin,title:"未来の旅",departureTime:"10:00",dwellMinutes:{"future-1":75,"future-5":75},anchorTimes:{"future-1":"12:30","future-5":"20:30"}}} />);
    await screen.findByRole("heading",{name:"未来の施設0"});
    expect(screen.queryByLabelText("出発日")).toBeNull();
    const originalDate = readJourneyDraft()!.plan.date;
    const refresh=screen.getByRole("button",{name:/交通経路を再検索/});
    await waitFor(()=>expect(refresh).toHaveProperty("disabled",false));
    fireEvent.click(refresh);
    await waitFor(()=>expect(calls.some(call=>call.body.departure_date===originalDate)).toBe(true));
    const request=calls.find(call=>call.body.departure_date===originalDate)!;
    expect(request.url).toBe("/api/routes/preview");
    expect(request.body).toMatchObject({origin,return_to:origin,places:picked,departure_time:"10:00",meal_times:{"future-1":"12:30","future-5":"20:30"}});
    expect((request.body.stay_minutes as number[])[1]).toBe(75);
    await waitFor(()=>expect(readJourneyDraft()?.plan.stops).toHaveLength(7));
  });
  it("previews JSON without replacing the journey, then restores completed visits and independent return without external search", async () => {
    const origin = { name: "出発駅", latitude: 34.9858, longitude: 135.7588 };
    const returnTo = { name: "帰る駅", latitude: 34.99, longitude: 135.763 };
    const place = { ...origin, id: "import-place", name: "読み込む庭園", category: "公園", description: "", access_point: "", themes: [] };
    const route = { origin, return_to: returnTo, places: [place], legs: [], total_minutes: 10, fare_yen: 300, departure_time: "09:00", arrival_time: null, title: "保存した旅", story: null, note: "" };
    const plan = completeNextStop(scheduleTrip({ departureTime: "09:00", availableMinutes: 240, budget: 2500, preferences: ["nature"] }, origin, "2099-10-12", [{ ...newTripStop(place, 45), locked: true, anchorTime: "10:30" }], { route, date: "2099-10-12", time: "09:00" }, null, returnTo));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => [origin] })); vi.stubGlobal("fetch", fetchMock);
    render(<SearchMode active />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "出発駅" }) as HTMLSelectElement).disabled).toBe(false));
    const file = new File([""], "journey.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => serializeJourneyFile(plan, "保存した旅") });
    fireEvent.change(screen.getByLabelText("旅程のJSONファイル"), { target: { files: [file] } });
    await screen.findByRole("dialog", { name: "読み込む旅程を確認" });
    expect(screen.queryByRole("heading", { name: "読み込む庭園" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "この旅程を読み込む" }));
    await screen.findByRole("heading", { name: "読み込む庭園" });
    await waitFor(() => expect(readJourneyDraft()?.plan.stops[0].completed).toBe(true));
    expect(readJourneyDraft()?.plan.returnTo).toEqual(returnTo);
    expect(readJourneyDraft()?.plan.input).toMatchObject({ availableMinutes: 240, budget: 2500, preferences: ["nature"] });
    expect(readJourneyDraft()?.plan.estimatedTravel).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /この旅程を保存/ }));
    const favorite = JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]")[0];
    expect(favorite.journey_file).toEqual(expect.any(String));
    const restored = routeSelection(favorite);
    expect(restored.returnTo).toEqual(returnTo);
    expect(restored.tripPlan?.input).toMatchObject({ budget: 2500, availableMinutes: 240 });
    expect(restored.tripPlan?.stops[0].completed).toBe(true);
    expect(restored.tripPlan?.stops[0]).toMatchObject({ locked: true, anchorTime: "10:30" });

    expect((screen.getByRole("button", { name: "読み込む庭園を削除" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "条件を変更する" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "出発駅" })).toBeNull();
    expect(screen.queryByLabelText("出発日")).toBeNull();
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(["/api/origins"]);
  });

  it("does not expose station condition controls after displaying a selected route", async () => {
    const origin = { name: "京都駅", latitude: 34.9858, longitude: 135.7588 };
    const place = { ...origin, id: "p", name: "公園", category: "公園", description: "", access_point: "", themes: [] };
    let submitted: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/routes/preview") { submitted = JSON.parse(String(init?.body)); return { ok: false, json: async () => ({ detail: "test complete" }) }; }
      return { ok: true, json: async () => [origin] };
    }); vi.stubGlobal("fetch", fetchMock);
    render(<SearchMode active preset={{ theme: "nature", stopCount: 1, nonce: 8, places: [place], origin, title: "公園の旅", dwellMinutes: {} }} />);
    await screen.findByRole("heading", { name: "公園" });
    expect(screen.queryByRole("combobox", { name: "出発駅" })).toBeNull();
    expect(screen.queryByRole("group", { name: "帰着駅" })).toBeNull();
    expect(fetchMock.mock.calls.some(call => String(call[0]).startsWith("/api/stations/search"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /交通経路を再検索/ }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ return_to: origin });
  });
  it("retains the saved schedule and omits date and time inputs after a route is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ name: "京都駅", latitude: 34.9858, longitude: 135.7588 }] })));
    const place = { id: "p", name: "公園", latitude: 34.987, longitude: 135.76, category: "公園", description: "", access_point: "", themes: [] };
    render(<SearchMode active preset={{ theme: "nature", stopCount: 1, nonce: 2, places: [place], origin: { name: "京都駅", latitude: 34.9858, longitude: 135.7588 }, title: "公園の旅", dwellMinutes: {} }} />);
    await screen.findByRole("heading", { name: "公園" });
    await waitFor(() => expect(readJourneyDraft()).not.toBeNull());
    const before = readJourneyDraft()!;
    expect(screen.queryByLabelText("出発日")).toBeNull();
    expect(screen.queryByLabelText("出発時刻")).toBeNull();
    expect(screen.queryByRole("button", { name: "条件を変更する" })).toBeNull();
    expect(screen.getByRole("heading", { name: "公園" })).toBeTruthy();
    expect(readJourneyDraft()?.plan.date).toBe(before.plan.date);
    expect(readJourneyDraft()?.plan.input.departureTime).toBe(before.plan.input.departureTime);
    cleanup();
    render(<SearchMode active />);
    expect(await screen.findByRole("heading", { name: "公園" })).toBeTruthy();
    expect(screen.getByText(/前回の旅程を復元しました/)).toBeTruthy();
  });
  it("submits the selected area and exact spots instead of a new theme-based search", async () => {
    const picked = ["上野公園", "庭園"].map((name, index) => ({ id: `selected-${index}`, name, latitude: 35.7 + index * .01, longitude: 139.77, category: "公園", description: "", access_point: "", themes: [] }));
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/routes/preview") { submitted = JSON.parse(String(init?.body)); return { ok: false, json: async () => ({ detail: "test complete" }) }; }
      const data = url === "/api/origins" ? [{ name: "京都駅", latitude: 35, longitude: 135 }] : url === "/api/places/status" ? { warning: null, state: "success" } : [];
      return { ok: true, json: async () => data };
    }));
    render(<SearchMode active preset={{ theme: "nature", stopCount: 2, nonce: 1, autoSearch: true, places: picked, origin: { name: "東京都・エリア中心", latitude: 35.68, longitude: 139.76 }, title: "東京の旅", dwellMinutes: { "selected-0": 45 } }} />);
    const refresh = await screen.findByRole("button", { name: /交通経路を再検索/ });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ origin: {name:"東京都・エリア中心",latitude:35.68,longitude:139.76}, places:picked, stay_minutes:[45,90] });
    expect(screen.getByRole("heading", { name: "上野公園" })).toBeTruthy();
    expect(readJourneyDraft()?.plan.stops[0].dwellMinutes).toBe(45);
    fireEvent.click(screen.getByRole("button", { name: "上野公園を固定" }));
    fireEvent.click(screen.getByRole("button", { name: "庭園を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(screen.queryByRole("button", { name: "条件を変更する" })).toBeNull();
    expect(await screen.findByRole("button", { name: "上野公園の固定を解除" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "庭園" })).toBeNull();
    expect(readJourneyDraft()?.plan.stops[0].dwellMinutes).toBe(45);
    cleanup();
    render(<SearchMode active />);
    expect(await screen.findByRole("button", { name: "上野公園の固定を解除" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "庭園" })).toBeNull();
    expect(screen.getByText(/前回の旅程を復元しました/)).toBeTruthy();
    expect(readJourneyDraft()?.plan.stops[0].dwellMinutes).toBe(45);
  });
});


describe("editing-only entry", () => {
  it("shows discovery instead of the initial proposal form when no itinerary is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [savedRoute.origin] })));
    const onDiscover = vi.fn();
    render(<SearchMode active editingOnly onDiscover={onDiscover} />);
    expect(document.querySelector("#panel-search > .hero")).toBeNull();
    expect(screen.getByRole("heading", { name: "まずは、気になる旅を選びましょう" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /この条件で旅程を提案する/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "宿泊あり" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "旅を見つける →" }));
    expect(onDiscover).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("omits the condition form while editing an itinerary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [savedRoute.origin] })));
    render(<SearchMode active editingOnly preset={{
      theme: "history",
      stopCount: 1,
      nonce: 778,
      places: [{ ...savedRoute.places[0], themes: ["history"] }],
      origin: savedRoute.origin,
      title: "編集する旅",
      dwellMinutes: {},
    }} />);

    expect(await screen.findByRole("button", { name: "別の旅を見つける" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "旅程の条件を編集" })).toBeNull();
    expect(screen.queryByText("旅の条件を決めましょう")).toBeNull();
    expect(screen.queryByText("行きたい場所と、過ごせる時間から。")).toBeNull();
    expect(document.querySelector(".planner-card")).toBeNull();
  });
});

it("renames a plan without restoring a removed stop, and updates the same saved card", async () => {
  localStorage.setItem(SAVED_PLAN_STORAGE_KEY, JSON.stringify({ suggestions: [savedRoute], overnightSuggestion: null }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [savedRoute.origin] })));
  const view = render(<SearchMode active />);
  const titleInput = await screen.findByRole("textbox", { name: "プラン名" });
  expect(titleInput.closest(".route-copy-banner")).toBeTruthy();
  expect(view.container.querySelector(".results-heading .plan-title-input")).toBeNull();
  expect(view.container.querySelector(".trip-heading .journey-save-button")).toBeTruthy();
  expect(view.container.querySelector(".results-heading h2")).toBeNull();
  expect(view.container.querySelector(".results-heading .result-date")).toBeNull();
  await waitFor(() => expect((screen.getByRole("button", { name: "♡ この旅程を保存" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(titleInput, { target: { value: "週末の散歩" } });
  expect(titleInput).toHaveProperty("value", "週末の散歩");
  fireEvent.click(screen.getByRole("button", { name: "♡ この旅程を保存" }));
  await screen.findByText(/保存しました/);
  fireEvent.change(titleInput, { target: { value: "私の週末" } });
  fireEvent.click(screen.getByRole("button", { name: "♡ この旅程を保存" }));
  await screen.findByText(/元のプランを更新しました/);
  const favorites = JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1")!);
  expect(favorites).toHaveLength(1);
  expect(favorites[0]).toMatchObject({ title: "私の週末", edited: true });
  fireEvent.click(screen.getByRole("button", { name: "保存済みスポットを削除" }));
  fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
  fireEvent.change(titleInput, { target: { value: "新しい散歩" } });
  await waitFor(() => expect(readJourneyDraft()?.plan.stops).toHaveLength(0));
  expect(readJourneyDraft()?.title).toBe("新しい散歩");
});
