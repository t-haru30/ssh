import type { ReactElement } from "react";
import { cleanup, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayTripEditor } from "./DayTripEditor";
import { newTripStop, scheduleTrip } from "./dayTrip";
import { preferenceReason } from "./tripPreferences";
import type { RouteSuggestion } from "./types";
// External map and photo loading are tested independently of itinerary editing.
vi.mock("./LazyMapView", () => ({ LazyMapView: () => null }));
vi.mock("./FacilityPhoto", () => ({ FacilityPhoto: () => null }));
vi.mock("./discover/PlaceDetails", () => ({ PlaceDetailsDialog: ({ place, stayMinutes, onClose }: { place: { name: string }; stayMinutes?: number; onClose: () => void }) => <div role="dialog" aria-label={place.name}>{stayMinutes}分滞在<button type="button" onClick={onClose}>閉じる詳細</button></div> }));

function render(ui: ReactElement) { const view = renderBase(ui); view.container.querySelectorAll<HTMLDetailsElement>(".trip-stop-fold").forEach(item => { item.open = true; }); return view; }
const origin = { name: "京都駅", latitude: 35, longitude: 135 };
const places = ["公園", "美術館"].map((name, index) => ({ ...origin, id: String(index), name, category: "観光", description: "", access_point: "", themes: [] }));
const source: RouteSuggestion = { origin, places, legs: [], total_minutes: 20, fare_yen: 200, departure_time: "09:00", arrival_time: null, title: "選んだ旅", story: null, note: "" };
const props = { source, sourceDate: "2026-10-12", sourceTime: "09:00", origin, date: "2026-10-12", departureTime: "09:00", candidates: [], onPlanChange: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows fixed-start conflicts even though the removed budget and duration controls are hidden", () => {
  const initialPlan = scheduleTrip({departureTime:"09:00",availableMinutes:360,budget:5000}, origin, props.date,
    places.map((place,index)=>({...newTripStop(place),locked:index===0,anchorTime:index===0?"09:00":null})),
    {route:source,date:props.date,time:"09:00"});
  render(<DayTripEditor {...props} initialPlan={initialPlan} />);
  expect(screen.getByRole("heading", { name: "私の旅のしおり" })).toBeTruthy();
  expect(screen.getByText(/公園の固定開始に.*間に合いません/)).toBeTruthy();
});

it("opens the selected spot details when its photo is clicked and closes the dialog", () => {
  render(<DayTripEditor {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "公園の詳細を表示" }));
  expect(screen.getByRole("dialog", { name: "公園" }).textContent).toContain("90分滞在");
  fireEvent.click(screen.getByRole("button", { name: "閉じる詳細" }));
  expect(screen.queryByRole("dialog", { name: "公園" })).toBeNull();
});
it('keeps restored station endpoints fixed and disables unlock, replacement and deletion',()=>{
  const endpoints=[{...places[0],id:'trip-arrival',name:'観光起点駅'},...places,{...places[0],id:'trip-return',name:'帰路駅'}];
  const saved=scheduleTrip({departureTime:'09:00',availableMinutes:600,budget:5000},origin,props.date,endpoints.map(p=>({...newTripStop(p,30),locked:false})),{route:{...source,places:endpoints},date:props.date,time:'09:00'});
  saved.stops[0].locked=false;saved.stops.at(-1)!.locked=false;
  render(<DayTripEditor {...props} source={{...source,places:endpoints}} initialPlan={saved} />);
  for(const name of ['観光起点駅','帰路駅']){
    expect(screen.getByRole('button',{name:`${name}は起点のため固定`}).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button',{name:`${name}を入れ替える`}).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button',{name:`${name}を削除`}).hasAttribute('disabled')).toBe(true);
  }
});

it("automatically searches all segments and displays total time without showing overruns", async () => {
  const timeline = [10, 15, 20].map(duration => ({ type: "transit", from_name: "地点A", to_name: "地点B", mode: "public_transport", transit_line: "地下鉄", duration_minutes: duration, is_estimate: false, start_time: "09:00", end_time: "09:10", fare_yen: 200 }));
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...source, timeline, coordinates: [[35,135]], total_minutes: 45 }) });
  vi.stubGlobal("fetch", fetcher);
  const changed = vi.fn();
  render(<DayTripEditor {...props} onPlanChange={changed} />);
  expect(screen.getByText("公共交通の経路を確認しています…")).toBeTruthy();
  expect(await screen.findAllByText("約3時間45分")).toHaveLength(1);
  expect(screen.getByLabelText("現在の旅程の概要")).toBeTruthy();
  const tripSummary = screen.getByLabelText("現在の旅程の概要");
  expect(tripSummary.querySelector(".trip-summary-range > span")?.textContent).toBe("出発〜帰着の目安");
  expect(tripSummary.querySelector(".trip-summary-range > strong")?.textContent).toMatch(/^9:00~\d{1,2}:\d{2}$/);
  expect(screen.queryByText(/移動・滞在を含む総時間/)).toBeNull();
  expect(screen.getByText(/約3時間45分 · 移動 約45分 · 滞在/)).toBeTruthy();
  const costHeading = screen.getByText("/1人").parentElement;
  expect(costHeading?.className).toBe("trip-cost-heading");
  expect(costHeading?.firstElementChild?.tagName).toBe("STRONG");
  expect(screen.getByText("交通・施設・飲食の合計")).toBeTruthy();
  expect(screen.queryByText(/超過/)).toBeNull();
  expect(screen.getAllByText("運賃目安：")[0].nextElementSibling?.textContent).toBe("200円");
  expect(screen.getAllByText("交通手段・所要時間を見る")[0].closest("details")?.open).toBe(false);
  fireEvent.click(screen.getAllByText("交通手段・所要時間を見る")[0]);
  expect(screen.getAllByText("交通手段")[0].nextElementSibling?.textContent).toBe("地下鉄");
  expect(screen.getAllByText("所要時間")[0].nextElementSibling?.textContent).toBe("約10分");
  await waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ travelMinutes: 45, returnMinute: 765 }));
  expect(changed.mock.calls.at(-1)?.[0].stops.map((stop: { place: { id: string } }) => stop.place.id)).toEqual(["0", "1"]);
  fireEvent.click(screen.getByRole("button", { name: "しおりを見る" }));
  const bookmark = screen.getByRole("textbox", { name: "しおりの内容" }) as HTMLTextAreaElement;
  expect(bookmark.value).toContain("交通手段：地下鉄 · 所要時間 約10分 · 運賃目安 200円（概算）");
  expect(bookmark.value).toContain("帰りの交通手段：地下鉄 · 所要時間 約20分 · 運賃目安 200円（概算）");
});

it("offers related nearby places only on request and preserves the plan until adoption", async () => {
  const shrine = { ...places[0], id: "shrine", name: "近所の神社", category: "神社" };
  const temple = { ...places[0], id: "temple", name: "近所のお寺", category: "寺院" };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => url === "/api/search/places"
    ? { ok: true, json: async () => ({ results: [{ place: shrine }], suggestions: ["地域名や距離条件を変えて再検索してください。"], related_available: true, related_results: JSON.parse(String(init?.body)).include_related ? [{ place: temple }] : [], related_note: JSON.parse(String(init?.body)).include_related ? "寺院も含む関連候補です。" : null }) }
    : { ok: false });
  vi.stubGlobal("fetch", fetcher);
  const changed = vi.fn(); render(<DayTripEditor {...props} onPlanChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "＋ 寄り道を追加" }));
  fireEvent.change(screen.getByRole("textbox", { name: "候補を検索" }), { target: { value: "京都 神社" } });
  fireEvent.click(screen.getByRole("button", { name: "候補を検索" }));
  await screen.findByText("候補が少ないときは");
  expect(screen.queryByRole("button", { name: /近所のお寺/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "近隣の関連候補も探す" }));
  const related = await screen.findByRole("button", { name: /近所のお寺/ });
  expect(screen.getByRole("region", { name: "近隣の関連候補" }).contains(related)).toBe(true);
  expect(changed.mock.calls.at(-1)?.[0].stops).toHaveLength(2);
  fireEvent.click(related);
  expect(changed.mock.calls.at(-1)?.[0].stops).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
  expect(changed.mock.calls.at(-1)?.[0].stops.at(-1).place.id).toBe("temple");
});

it("keeps a manually added distant stop even if it exceeds the time budget", () => {
  const changed = vi.fn();
  const distant = { ...places[0], id:"distant", name:"遠方の庭園", latitude:36 };
  render(<DayTripEditor {...props} candidates={[distant]} onPlanChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name:"＋ 寄り道を追加" }));
  fireEvent.click(screen.getByRole("button", { name:/遠方の庭園.*この候補を選ぶ/ }));
  fireEvent.click(screen.getByRole("button", { name:"この変更を反映" }));
  expect(changed.mock.calls.at(-1)?.[0].stops.map((s: {place:{id:string}}) => s.place.id)).toEqual(["0","1","distant"]);
});

it("starts with a compact timeline and shows spot details only from the photo", () => {
  const view = renderBase(<DayTripEditor {...props} />);
  const visuals = [...view.container.querySelectorAll<HTMLElement>(".trip-stop-visual")];
  const folds = [...view.container.querySelectorAll<HTMLDetailsElement>(".trip-stop-fold")];
  expect(visuals).toHaveLength(2);
  expect(folds).toHaveLength(2);
  expect(visuals[0].querySelector(".trip-stop-number")?.textContent).toBe("1");
  expect(visuals[0].querySelector(".trip-stop-header time")?.textContent).toMatch(/\d{2}:\d{2} — \d{2}:\d{2}/);
  expect(visuals[0].querySelector(".trip-stop-header h4")?.textContent).toBe("公園");
  expect(visuals[0].querySelector(".trip-spot-photo-button")).not.toBeNull();
  expect(folds.every(item => !item.open)).toBe(true);
  expect(folds[0].querySelector("summary")?.textContent).toBe("操作");
  expect(view.queryByText("この場所をおすすめする理由")).toBeNull();
  expect(view.queryByText(/場所の詳細/)).toBeNull();
  fireEvent.click(folds[0].querySelector("summary")!);
  expect(folds[0].open).toBe(true);
});

it("retains the replacement and other stops despite a long travel time", () => {
  const changed = vi.fn();
  const distant = { ...places[0], id:"distant", name:"遠方の庭園", latitude:36 };
  render(<DayTripEditor {...props} candidates={[distant]} onPlanChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name:"美術館を入れ替える" }));
  fireEvent.click(screen.getByRole("button", { name:/遠方の庭園.*この候補を選ぶ/ }));
  fireEvent.click(screen.getByRole("button", { name:"この変更を反映" }));
  expect(changed.mock.calls.at(-1)?.[0].stops.map((s: {place:{id:string}}) => s.place.id)).toEqual(["0","distant"]);
});

describe("DayTripEditor", () => {
  it("keeps ordinary undo within the current visit record", () => {
    const changed = vi.fn();
    render(<DayTripEditor {...props} onPlanChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "美術館を固定" }));
    fireEvent.click(screen.getByRole("button", { name: "公園を訪問済みにする" }));
    fireEvent.click(screen.getByRole("button", { name: "この時刻で記録する" }));
    expect((screen.getByRole("button", { name: "ひとつ前に戻す" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "美術館の固定を解除" }));
    fireEvent.click(screen.getByRole("button", { name: "ひとつ前に戻す" }));
    expect(changed.mock.calls.at(-1)?.[0].stops[0].completed).toBe(true);
    expect((screen.getByRole("button", { name: "ひとつ前に戻す" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "公園の訪問済みを解除" }));
    fireEvent.click(screen.getByRole("button", { name: "訪問済みを解除する" }));
    expect((screen.getByRole("button", { name: "ひとつ前に戻す" }) as HTMLButtonElement).disabled).toBe(true);
    expect(changed.mock.calls.at(-1)?.[0].stops[0]).toMatchObject({ completed: false, locked: true });
  });
  it("records visits in order and protects the original place and times during source refresh", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    const view = render(<DayTripEditor {...props} onPlanChange={changed} />);
    expect(screen.queryByRole("button", { name: "美術館を訪問済みにする" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "公園を訪問済みにする" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(changed.mock.calls.at(-1)?.[0].stops[0].completed).not.toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "公園を訪問済みにする" }));
    fireEvent.click(screen.getByRole("button", { name: "この時刻で記録する" }));
    const original = changed.mock.calls.at(-1)![0].stops[0];
    expect(original.completed).toBe(true);
    expect((screen.getByRole("button", { name: "公園の時間と費用を編集" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "公園を削除" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "美術館を訪問済みにする" })).toBeTruthy();
    view.rerender(<DayTripEditor {...props} onPlanChange={changed} source={{ ...source, places: [{ ...places[0], latitude: 36, name: "変更された名前" }, places[1]] }} />);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0].stops[0].place.name).toBe("公園"));
    expect(changed.mock.calls.at(-1)?.[0].stops[0]).toMatchObject({ start: original.start, end: original.end, place: original.place, completed: true });
    expect(changed.mock.calls.at(-1)?.[0].stops[0]).toMatchObject({ start: original.start, end: original.end, dwellMinutes: original.dwellMinutes, completed: true });
    fireEvent.click(screen.getByRole("button", { name: "公園の訪問済みを解除" }));
    fireEvent.click(screen.getByRole("button", { name: "訪問済みを解除する" }));
    expect(changed.mock.calls.at(-1)?.[0].stops[0]).toMatchObject({ completed: false, locked: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps the saved destination, conditions and recommendation reasons through edits, undo and source refresh", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const returnTo = { name: "大阪駅", latitude: 34.7, longitude: 135.5 };
    const initialPlan = scheduleTrip(
      { departureTime: "09:00", availableMinutes: 600, budget: 7000, preferences: ["nature", "culture"] }, origin, props.date,
      places.map(place => newTripStop(place, 40)), { route: { ...source, return_to: returnTo }, date: props.date, time: "09:00" }, 800, returnTo,
    );
    const changed = vi.fn();
    const view = render(<DayTripEditor {...props} initialPlan={initialPlan} onPlanChange={changed} />);
    expect(changed.mock.calls.at(-1)?.[0].input).toMatchObject({availableMinutes:600,budget:7000});
    expect(screen.queryByLabelText("使える時間（時間）")).toBeNull();
    expect(screen.queryByText("時間と予算を調整")).toBeNull();
    expect(screen.queryByText("2026/10/12 · 京都駅発 → 大阪駅着")).toBeNull();
    expect(screen.getByText("2か所の寄り道")).toBeTruthy();
    expect(screen.getByText(/大阪駅に帰着/)).toBeTruthy();
    expect(screen.queryByText(preferenceReason(places[0], ["nature", "culture"]))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "美術館を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    fireEvent.click(screen.getByRole("button", { name: "ひとつ前に戻す" }));
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    view.rerender(<DayTripEditor {...props} source={{ ...source, places: places.map(place => ({ ...place })), reasons: { "0": "古い好みの説明" } }} initialPlan={initialPlan} onPlanChange={changed} />);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0].returnTo.name).toBe("大阪駅"));
    expect(changed.mock.calls.at(-1)?.[0].input).toMatchObject({ availableMinutes: 600, budget: 7000, preferences: ["nature", "culture"] });
    expect(changed.mock.calls.at(-1)?.[0].transportEstimate).toBe(800);
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
    expect(screen.queryByText("古い好みの説明")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "しおりを見る" }));
    const bookmark = screen.getByRole("textbox", { name: "しおりの内容" }) as HTMLTextAreaElement;
    expect(bookmark.value).toContain("京都駅発 → 大阪駅着");
    expect(bookmark.value).toContain(`この場所をおすすめする理由：${preferenceReason(places[0], ["nature", "culture"])}`);
    expect(bookmark.value).toContain("帰りは交通情報未確認 大阪駅");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refreshes recommendation reasons when preferences change without resetting the itinerary", async () => {
    const changed = vi.fn();
    const view = render(<DayTripEditor {...props} preferences={["nature"]} onPlanChange={changed} />);
    expect(screen.queryByText(preferenceReason(places[0], ["nature"]))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    view.rerender(<DayTripEditor {...props} preferences={["culture", "coffee"]} onPlanChange={changed} />);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0].input.preferences).toEqual(["culture", "coffee"]));
    expect(screen.queryByText(preferenceReason(places[0], ["culture", "coffee"]))).toBeNull();
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
    expect(changed.mock.calls.at(-1)?.[0].stops).toHaveLength(2);
  });
  it("previews per-stop edits and cancels without changing the itinerary", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const changed = vi.fn();
    render(<DayTripEditor {...props} onPlanChange={changed} />);
    fireEvent.click(screen.getByRole("button", {name:"美術館の時間と費用を編集"}));
    fireEvent.change(screen.getByLabelText("滞在時間（分）"), {target:{value:"45"}});
    fireEvent.click(screen.getByRole("button", {name:"変更を確認"}));
    const dialog = screen.getByRole("dialog", {name:"旅程の変更を確認"});
    fireEvent.click(within(dialog).getByRole("button", {name:"現在の旅程を残す"}));
    expect(changed.mock.calls.at(-1)?.[0].stops[1].dwellMinutes).toBe(90);
    expect(screen.queryByText("時間と予算を調整")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves edits, locks and selected places when departure conditions change", async () => {
    const changed = vi.fn();
    const { rerender } = render(<DayTripEditor {...props} onPlanChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    fireEvent.click(screen.getByRole("button", { name: "美術館を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    rerender(<DayTripEditor {...props} departureTime="10:00" onPlanChange={changed} />);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0].stops).toHaveLength(1));
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
    expect(changed.mock.calls.at(-1)?.[0].stops[0].dwellMinutes).toBe(90);
  });
  it("supports manual estimates and appointment editing through an explicit preview", () => {
    const changed = vi.fn();
    render(<DayTripEditor {...props} onPlanChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "公園の時間と費用を編集" }));
    fireEvent.change(screen.getByLabelText("滞在時間（分）"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("固定開始時刻（任意）"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("施設・飲食の見積もり（円）"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "変更を確認" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(changed.mock.calls.at(-1)?.[0].stops[0]).toMatchObject({ dwellMinutes: 45, spending: 500, anchorTime: "10:00", locked: true });
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
  });
  it("allows swapping only a flexible stop, keeping the fixed stop and its duration", () => {
    const alternative = { ...places[0], id: "new", name: "庭園" };
    render(<DayTripEditor {...props} candidates={[alternative]} />);
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    fireEvent.click(screen.getByRole("button", { name: "美術館を入れ替える" }));
    fireEvent.click(screen.getByRole("button", { name: /庭園.*この候補を選ぶ/ }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "庭園" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "美術館" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ひとつ前に戻す" }));
    expect(screen.getByRole("heading", { name: "美術館" })).toBeTruthy();
  });
  it("keeps uncertain costs and travel estimates in a selectable bookmark when clipboard is unavailable", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<DayTripEditor {...props} />);
    expect(screen.getByLabelText("現在の旅程の概要").textContent).toContain("1,200円");
    expect(screen.getByLabelText("現在の旅程の概要").textContent).not.toContain("予算");
    expect(screen.queryByRole("meter", { name: "予算に対する概算費用" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    fireEvent.click(screen.getByRole("button", { name: "しおりを見る" }));
    const dialog = screen.getByRole("dialog", { name: "旅のしおり" });
    const bookmark = within(dialog).getByRole("textbox", { name: "しおりの内容" }) as HTMLTextAreaElement;
    expect(bookmark.readOnly).toBe(true);
    expect(bookmark.value).toContain("公園［固定］");
    expect(bookmark.value).toContain("概算 1,200円");
    expect(bookmark.value).toContain("営業時間・実際の発着時刻は未確認");
    fireEvent.click(within(dialog).getByRole("button", { name: "しおりをコピー" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("下のしおりを選択"));
    expect(writeText).toHaveBeenCalledWith(bookmark.value);
    // The editor may finish its automatic route lookup while clipboard fallback settles.
    // Copying the bookmark itself must not send it to a server.
    expect(fetch.mock.calls.every(([url]) => url === "/api/routes/preview")).toBe(true);
  });
  it("filters local candidates as you type without an external search", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DayTripEditor {...props} candidates={[
      { ...places[0], id: "garden", name: "緑の庭園", category: "自然" },
      { ...places[0], id: "cafe", name: "川辺カフェ", category: "グルメ" },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "＋ 寄り道を追加" }));
    fireEvent.change(screen.getByRole("textbox", { name: "候補を検索" }), { target: { value: "庭園" } });
    expect(screen.getByRole("button", { name: /緑の庭園.*この候補を選ぶ/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /川辺カフェ.*この候補を選ぶ/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "クリア" }));
    expect(screen.getByRole("button", { name: /川辺カフェ.*この候補を選ぶ/ })).toBeTruthy();
  });
  it("offers a clear empty itinerary and restores the last stop with undo", () => {
    render(<DayTripEditor {...props} />);
    for (const name of ["美術館", "公園"]) {
      fireEvent.click(screen.getByRole("button", { name: `${name}を削除` }));
      fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    }
    expect(screen.getByRole("heading", { name: "次の寄り道を、ひとつ。" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "＋ 寄り道を追加" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "ひとつ前に戻す" }));
    expect(screen.getByRole("heading", { name: "公園" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "次の寄り道を、ひとつ。" })).toBeNull();
  });
});



it("automatically previews return destination and preserves stops on failure", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  const returnTo = { ...origin, name: "宿泊先", latitude: 35.2 };
  render(<DayTripEditor {...props} returnTo={returnTo} onPlanChange={changed} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/routes/preview", expect.anything()));
  const request = fetch.mock.calls.find(call => call[0] === "/api/routes/preview")!;
  expect(JSON.parse(request[1].body)).toMatchObject({ return_to: returnTo, stay_minutes: [90, 90] });
  await screen.findByText(/交通経路を確認できませんでした。現在の旅程を保持/);
  expect(changed.mock.calls.at(-1)?.[0].stops.map((stop: { place: { id: string } }) => stop.place.id)).toEqual(["0", "1"]);
});
