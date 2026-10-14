import type { ReactElement } from "react";
import { cleanup, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayTripEditor } from "./DayTripEditor";
import { newTripStop, scheduleTrip } from "./dayTrip";
import { preferenceReason } from "./tripPreferences";
import type { RouteSuggestion } from "./types";
// Editing is local; facility photo requests are tested independently.
vi.mock("./FacilityPhoto", () => ({ FacilityPhoto: () => null }));

function render(ui: ReactElement) { const view = renderBase(ui); view.container.querySelectorAll<HTMLDetailsElement>(".trip-stop-fold, .trip-adjustment").forEach(item => { item.open = true; }); return view; }
const origin = { name: "京都駅", latitude: 35, longitude: 135 };
const places = ["公園", "美術館"].map((name, index) => ({ ...origin, id: String(index), name, category: "観光", description: "", access_point: "", themes: [] }));
const source: RouteSuggestion = { origin, places, legs: [], total_minutes: 20, fare_yen: 200, departure_time: "09:00", arrival_time: null, title: "選んだ旅", story: null, note: "" };
const props = { source, sourceDate: "2026-10-12", sourceTime: "09:00", origin, date: "2026-10-12", departureTime: "09:00", candidates: [], onPlanChange: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it("starts with a compact timeline whose spot details can be opened", () => {
  const view = renderBase(<DayTripEditor {...props} />);
  const folds = [...view.container.querySelectorAll<HTMLDetailsElement>(".trip-stop-fold")];
  expect(folds).toHaveLength(2);
  expect(folds.every(item => !item.open)).toBe(true);
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
  it("records visits in order and protects the original place and times during source refresh and fitting", async () => {
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
    fireEvent.change(screen.getByLabelText("使える時間（時間）"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("使える時間（分）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "固定以外を調整して確認" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
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
    expect((screen.getByLabelText("使える時間（時間）") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("使える時間（分）") as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("1人あたりの予算（円）") as HTMLInputElement).value).toBe("7000");
    expect(screen.queryByText("2026/10/12 · 京都駅発 → 大阪駅着")).toBeNull();
    expect(screen.getByText("2か所の寄り道")).toBeTruthy();
    expect(screen.getByText(/大阪駅に帰着/)).toBeTruthy();
    expect(screen.getByText(preferenceReason(places[0], ["nature", "culture"]))).toBeTruthy();
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
    expect(screen.getByText(preferenceReason(places[0], ["nature"]))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    view.rerender(<DayTripEditor {...props} preferences={["culture", "coffee"]} onPlanChange={changed} />);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0].input.preferences).toEqual(["culture", "coffee"]));
    expect(screen.getByText(preferenceReason(places[0], ["culture", "coffee"]))).toBeTruthy();
    expect(screen.getByRole("button", { name: "公園の固定を解除" })).toBeTruthy();
    expect(changed.mock.calls.at(-1)?.[0].stops).toHaveLength(2);
  });
  it("previews constraints, cancels without changing the itinerary, and applies with no network", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<DayTripEditor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "公園を固定" }));
    expect((screen.getByRole("button", { name: "公園を削除" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("使える時間（時間）"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("使える時間（分）"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "固定以外を調整して確認" }));
    const dialog = await screen.findByRole("dialog", { name: "旅程の変更を確認" });
    expect(dialog.textContent).toContain("90分 → 30分");
    fireEvent.click(within(dialog).getByRole("button", { name: "現在の旅程を残す" }));
    expect(screen.getAllByText(/滞在 90分/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "固定以外を調整して確認" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(screen.getByText(/滞在 30分/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "公園の固定を解除" }).getAttribute("aria-pressed")).toBe("true");
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
    render(<DayTripEditor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "公園の時間と費用を編集" }));
    fireEvent.change(screen.getByLabelText("滞在時間（分）"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("固定開始時刻（任意）"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("施設・飲食の見積もり（円）"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "変更を確認" }));
    fireEvent.click(screen.getByRole("button", { name: "この変更を反映" }));
    expect(screen.getByText(/滞在 45分.*500円.*10:00開始/)).toBeTruthy();
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
    expect(screen.getByRole("meter", { name: "予算に対する概算費用" }).getAttribute("aria-valuetext")).toContain("概算 1,200円");
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
    expect(fetch).not.toHaveBeenCalled();
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

it("leaves the original plan intact when a shorter time cannot fit fixed stays", async () => {
  const changed = vi.fn();
  const before = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 5000 }, origin, props.date,
    places.map(place => ({ ...newTripStop(place, 90), locked: true })), { route: source, date: props.sourceDate, time: props.sourceTime });
  render(<DayTripEditor {...props} initialPlan={before} onPlanChange={changed} />);
  fireEvent.change(screen.getByLabelText("使える時間（時間）"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("使える時間（分）"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "固定以外を調整して確認" }));
  expect(await screen.findByText(/この時間枠に収まる変更案がありません/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "この変更を反映" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "現在の旅程を残す" }));
  expect(changed.mock.calls.at(-1)?.[0].input.availableMinutes).toBe(360);
  expect(changed.mock.calls.at(-1)?.[0].stops.map((s: { dwellMinutes: number }) => s.dwellMinutes)).toEqual([90, 90]);
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
