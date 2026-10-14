vi.mock("../PreferenceTags", () => ({ PreferenceTags: ({ onChange }: { onChange: (tags: string[]) => void }) => <button onClick={() => onChange(["庭園でひと休み"])}>提案タグを選択</button> }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";
import { clearRoutePhotoCache } from "./useRoutePhoto";
import { similarTrip } from "./routeDiversity";
vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: ({ route, onClose }: { route: { title: string }; onClose: () => void }) => <div role="dialog" aria-label={route.title}><button onClick={onClose}>閉じる</button></div> }));
vi.mock("../localPlaces", () => ({ localOrigins: { kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 } }, localPlaces: Array.from({ length: 18 }, (_, i) => ({ id: `facility-${i}`, name: `博物館${i}`, category: "博物館", latitude: 34.985849 + i * .005, longitude: 135.758766, themes: ["history"], tags: { area: "kyoto" }, description: "", access_point: "" })) }));
const noPhoto = { ok: true, json: async () => ({ status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }) };
beforeEach(() => { clearRoutePhotoCache(); vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/discover" ? { ok: false } : noPhoto)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function mount(onPlanInSearch = vi.fn()) { return render(<PrefectureProvider><FavoritesProvider><DiscoverMode active onPlanInSearch={onPlanInSearch} /></FavoritesProvider></PrefectureProvider>); }
function revealThemes() {
  if (!screen.queryByRole("button", { name: "標準" })) fireEvent.click(screen.getByRole("button", { name: "指定しない" }));
  if (!screen.queryByRole("button", { name: "歴史・街歩き" })) fireEvent.click(screen.getByRole("button", { name: "標準" }));
}
function enterMood() {
  revealThemes();
  if ((screen.getByRole("button", { name: /旅の気分を選ぶ/ }) as HTMLButtonElement).disabled) fireEvent.click(screen.getByRole("button", { name: "おまかせ" }));
  fireEvent.click(screen.getByRole("button", { name: /旅の気分を選ぶ/ }));
}
function goMood() {
  enterMood();
  fireEvent.click(within(screen.getByRole("group", { name: /今回の旅で|家族で|食の寄り道/ })).getByRole("button", { name: "おまかせ" }));
  fireEvent.click(within(screen.getByRole("group", { name: "どれくらい楽しむ？" })).getByRole("button", { name: "おまかせ" }));
}
function next() { goMood(); fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ })); fireEvent.change(screen.getByLabelText("出発地点"), { target: { value: "京都駅|34.985849|135.758766" } }); }
async function generate() { const departure = screen.queryByLabelText("出発地点") as HTMLSelectElement | null; if (departure?.selectedOptions[0]?.textContent === "名古屋駅") fireEvent.change(departure, { target: { value: "京都駅|34.985849|135.758766" } }); fireEvent.click(screen.getByRole("button", { name: /おすすめ旅程を見る/ })); await waitFor(() => expect((screen.getByRole("button", { name: "いいね ♥" }) as HTMLButtonElement).disabled).toBe(false)); }
function saved() { return JSON.parse(localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]"); }

it("explains missing answers and orders departure before prefecture and gateway", () => {
  mount();
  expect(screen.getByRole("button", { name: /次へ：旅の気分/ }).getAttribute("aria-describedby")).toBe("discovery-next-hint");
  expect(screen.getByText(/誰と出かけるかを選んでください/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "指定しない" }));
  expect(screen.getByText("旅のペースを選んでください。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "標準" }));
  expect(screen.getByText("好きな過ごし方を1つ以上選んでください。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
  goMood(); fireEvent.click(screen.getByRole("button", { name: /次へ：行き先/ }));
  const departure = screen.getByLabelText("出発地点"), prefecture = screen.getByLabelText("行き先の都道府県"), gateway = screen.getByLabelText("行き先の駅・観光の起点");
  expect(departure.compareDocumentPosition(prefecture) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(prefecture.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("asks about meals after duration and sends optional times only for selected meals", async () => {
  mount(); enterMood();
  expect(screen.queryByRole("button", {name:"朝ごはん"})).toBeNull();
  fireEvent.click(within(screen.getByRole("group", { name: /今回の旅で/ })).getByRole("button", { name: "おまかせ" }));
  fireEvent.click(screen.getByRole("button", { name: "1日" }));
  fireEvent.click(screen.getByRole("button", { name:"昼ごはん" }));
  fireEvent.change(screen.getByLabelText("昼ごはんの時間（任意）"), {target:{value:"13:00"}});
  expect(screen.queryByLabelText("夜ごはんの時間（任意）")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:/行き先を選ぶ/}));
  fireEvent.click(screen.getByRole("button", {name:/おすすめ旅程を見る/}));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/discover")).toBe(true));
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/discover")![1]?.body));
  expect(body.meals).toEqual([{kind:"lunch",time:"13:00"}]);
});

it("treats unanswered gourmet meals as automatic and keeps explicit no-meals separate", async () => {
  mount(); revealThemes();
  fireEvent.click(screen.getByRole("button", {name: "グルメ"}));
  goMood(); fireEvent.click(screen.getByRole("button", {name: "1日"}));
  expect(screen.getByRole("button", {name:"食事なし"}).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", {name:/行き先を選ぶ/}));
  fireEvent.click(screen.getByRole("button", {name:/おすすめ旅程を見る/}));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/discover")).toBe(true));
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover");
  expect(JSON.parse(String(requests()[0][1]?.body)).meals).toEqual([{kind:"lunch"}, {kind:"dinner"}]);
  fireEvent.click(screen.getByRole("button", {name:"02 旅の気分へ"}));
  fireEvent.click(screen.getByRole("button", {name:"食事なし"}));
  fireEvent.click(screen.getByRole("button", {name:/行き先を選ぶ/}));
  fireEvent.click(screen.getByRole("button", {name:/おすすめ旅程を見る/}));
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(JSON.parse(String(requests()[1][1]?.body)).meals).toEqual([]);
});

it("keeps valid local candidates when the online response contains no routes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/discover" ? {ok:true, json:async () => ({routes:[], note:"候補なし"})} : noPhoto));
  mount(); next(); await generate();
  expect(screen.getByText(/^[1-9][0-9]*件の候補$/)).toBeTruthy();
  expect(screen.queryByText("この条件で新しく提案できる旅程はありません")).toBeNull();
});

it("keeps multiple themes selected and includes both in the request", async () => {
  mount(); revealThemes();
  fireEvent.click(screen.getByRole("button", { name: "自然・景色" }));
  fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
  expect(screen.getByRole("button", { name: "自然・景色" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "グルメ" }).getAttribute("aria-pressed")).toBe("true");
  next();
  fireEvent.click(screen.getByRole("button", { name: /おすすめ旅程を見る/ }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/discover")).toBe(true));
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/discover")![1]?.body));
  expect(body.themes).toEqual(["nature", "food"]);
});

it("prioritizes written wishes without a destination suggestion button and supports returning to steps 1 and 3", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok:true, json:async () => ({ origin:{name:"京都駅",latitude:34.985849,longitude:135.758766},prefecture:"京都府",municipality:"京都市" }) })));
  mount(); goMood();
  fireEvent.change(screen.getByRole("textbox"), { target:{value:"京都市で庭園を巡りたい"} });
  expect(screen.queryByRole("button", {name:"AIで行き先を提案"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:/次へ：行き先を選ぶ/}));
  await screen.findByRole("heading", {name:"どこから、どこへ？"});
  expect((screen.getByLabelText("行き先の都道府県") as HTMLSelectElement).value).toBe("kyoto");
  fireEvent.click(screen.getByRole("button", {name:"01 あなたの好みへ"}));
  expect(screen.getByRole("heading", {name:"まずは、あなたのこと。"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"03 行き先へ"}));
  fireEvent.click(screen.getByText(/到着後の観光範囲/));
  fireEvent.click(screen.getByLabelText("距離を制限しない"));
  expect(screen.getByText("到着後の観光範囲 · 制限なし")).toBeTruthy();
});

function mockLocation() {
  let success!: PositionCallback;
  let failure!: PositionErrorCallback;
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => { success = ok; failure = fail; });
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
  return { getCurrentPosition, succeed: () => act(() => success({ coords: { latitude: 35.01, longitude: 135.74 } } as GeolocationPosition)), fail: (code: number) => act(() => failure({ code } as GeolocationPositionError)) };
}

it("requests location only on click and sends its coordinates as the departure", async () => {
  const location = mockLocation(); mount(); next();
  expect(location.getCurrentPosition).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "現在地を使う" }));
  expect((screen.getByRole("button", { name: /おすすめ旅程を見る/ }) as HTMLButtonElement).disabled).toBe(true);
  location.succeed();
  expect(await screen.findByText("現在地を出発地点に設定しました。")).toBeTruthy();
  await generate();
  const request = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/discover")![1];
  expect(JSON.parse(String(request?.body)).origin).toEqual({ name: "京都駅", latitude: 34.985849, longitude: 135.758766 });
});

it.each([1, 2, 3])("keeps the selected station when location fails (%s) and allows retry", async code => {
  const location = mockLocation(); mount(); next();
  fireEvent.click(screen.getByRole("button", { name: "現在地を使う" }));
  location.fail(code);
  expect(await screen.findByText(/駅名から選んでください/)).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "出発地点" }) as HTMLSelectElement).selectedOptions[0].textContent).toBe("京都駅");
  fireEvent.click(screen.getByRole("button", { name: "現在地を使う" }));
  expect(location.getCurrentPosition).toHaveBeenCalledTimes(2);
});

it("ignores late location results after changing destination or leaving the step", () => {
  const location = mockLocation(); mount(); next();
  fireEvent.click(screen.getByRole("button", { name: "現在地を使う" }));
  fireEvent.change(screen.getByLabelText("行き先の都道府県"), { target: { value: "aomori" } });
  location.succeed();
  expect(screen.queryByRole("option", { name: "現在地" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "現在地を使う" }));
  fireEvent.click(screen.getByRole("button", { name: "← 戻る" }));
  location.succeed();
  fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
  expect(screen.queryByRole("option", { name: "現在地" })).toBeNull();
});
describe("sequential discovery", () => {
  it("shows only the current question, carries answers back, and does not fetch candidates before submission", () => {
    mount();
    expect(screen.queryByRole("button", { name: "いいね ♥" })).toBeNull();
    expect(screen.queryByLabelText("行き先の都道府県")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "家族と" }));
    revealThemes(); fireEvent.click(screen.getByRole("button", { name: "自然・景色" }));
    goMood();
    expect(screen.queryByRole("button", { name: "家族と" })).toBeNull();
    expect(screen.getByRole("group", { name: "家族でどんな時間を過ごしたい？" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/ほかに、やってみたいこと/), { target: { value: "庭園で休みたい" } });
    fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "← 戻る" }));
    expect((screen.getByLabelText(/ほかに、やってみたいこと/) as HTMLTextAreaElement).value).toBe("庭園で休みたい");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(0);
  });
  it("sends choices, free text, and selected departure to generation", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.startsWith("/api/stations/search") ? { ok: true, json: async () => [{ name: "二条駅", latitude: 35.01, longitude: 135.74, code: "1", prefecture: "京都府", lines: [] }] } : url === "/api/discover" ? { ok: false } : noPhoto);
    vi.stubGlobal("fetch", fetchMock); mount();
    revealThemes(); fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
    goMood();
    fireEvent.click(screen.getByRole("button", { name: "ゆっくり過ごしたい" }));
    fireEvent.click(screen.getByRole("button", { name: "半日" }));
    fireEvent.change(screen.getByLabelText(/ほかに、やってみたいこと/), { target: { value: "庭園で休みたい" } });
    fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "出発地点" })).getByRole("button", { name: "駅名で探す" }));
    fireEvent.change(screen.getByLabelText("駅名を入力"), { target: { value: "二条" } });
    fireEvent.click(screen.getByRole("button", { name: "駅を検索" }));
    fireEvent.click(await screen.findByRole("button", { name: /二条駅 京都府/ }));
    await generate();
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/discover")![1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ theme: "history", course: "half_day", traveler: { pace: "relaxed" }, priority_text: "庭園で休みたい", preference_text: "ゆっくり過ごしたい。庭園で休みたい", origin: { latitude: 34.985849, longitude: 135.758766 } });
    expect(screen.queryByLabelText("出発地点")).toBeNull();
  });
  it("likes save and advance, passes do not save, and a liked itinerary opens the same route for editing", async () => {
    const onPlan = vi.fn(); mount(onPlan); next(); await generate();
    fireEvent.click(screen.getByRole("button", { name: /この旅程を選んで編集する/ }));
    const first = onPlan.mock.calls[0][0]; onPlan.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "いいね ♥" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(screen.getByText(/^2 \/ /)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("region", { name: "いいねした旅程" })).getByRole("button", { name: /編集する/ }));
    expect(onPlan).toHaveBeenCalledWith(first);
    fireEvent.click(screen.getByRole("button", { name: "← 今回は見送る" }));
    await waitFor(() => expect(screen.getByText(/^3 \/ /)).toBeTruthy());
    expect(saved()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "← 前の候補" }));
    expect(screen.getByText(/^2 \/ /)).toBeTruthy();
  });
  it("does not duplicate likes after returning to a card", async () => {
    mount(); next(); await generate();
    fireEvent.click(screen.getByRole("button", { name: "いいね ♥" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "← 前の候補" }));
    fireEvent.click(screen.getByRole("button", { name: "いいね ♥" }));
    await act(async () => {});
    expect(saved()).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "いいねした旅程" })).getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(/^2 \/ /)).toBeTruthy();
  });
  it.each([["条件を変更", "まずは、あなたのこと。"], ["行き先を選び直す", "どこから、どこへ？"]])("cancels generation on %s and ignores stale responses", async (button, heading) => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/discover" ? new Promise(r => { resolve = r; }) : Promise.resolve(noPhoto));
    vi.stubGlobal("fetch", fetchMock); mount(); next();
    fireEvent.click(screen.getByRole("button", { name: /おすすめ旅程を見る/ }));
    const signal = fetchMock.mock.calls.find(([url]) => url === "/api/discover")![1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(button) }));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ ok: true, json: async () => ({ routes: [], note: "stale result" }) }));
    expect(screen.queryByText("stale result")).toBeNull();
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
  });
  it("shows local fallback on failure and regenerates with a new variation", async () => {
    mount(); next(); await generate();
    expect(screen.getByText(/AIの提案を取得できませんでした/)).toBeTruthy();
    expect(screen.getByText(/^[1-9][0-9]*件の候補$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "別の組み合わせ" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(2));
    const body = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover")[1][1]?.body;
    expect(JSON.parse(String(body)).variation).toBe(1);
  });
});

it("advances immediately even when the next card photo request never finishes", async () => {
  mount(); next(); await generate();
  clearRoutePhotoCache();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  fireEvent.click(screen.getByRole("button", { name: "いいね ♥" }));
  expect(screen.getByText(/^2 \/ /)).toBeTruthy();
  expect(saved()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "← 今回は見送る" }));
  expect(screen.getByText(/^3 \/ /)).toBeTruthy();
});

it("excludes the visible and passed trips when asking for another combination", async () => {
  const onPlan = vi.fn(); mount(onPlan); next(); await generate();
  fireEvent.click(screen.getByRole("button", { name: /この旅程を選んで編集する/ }));
  const first = onPlan.mock.calls[0][0];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/discover"
    ? { ok: true, json: async () => ({ routes: [{ ...first, id: "new-id-same-trip" }], note: "repeat" }) } : noPhoto));
  fireEvent.click(screen.getByRole("button", { name: "別の組み合わせ" }));
  await waitFor(() => expect(screen.getByText(/^[1-9][0-9]*件の候補$/)).toBeTruthy());
  onPlan.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /この旅程を選んで編集する/ }));
  expect(similarTrip(first, onPlan.mock.calls[0][0])).toBe(false);
});

it("changes destination directly while retaining profile, mood and free-text answers", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "家族と" }));
  revealThemes(); fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
  goMood();
  fireEvent.click(screen.getByRole("button", { name: "半日" }));
  fireEvent.change(screen.getByLabelText(/ほかに、やってみたいこと/), { target: { value: "博物館に寄りたい" } });
  fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
  await generate();
  fireEvent.click(screen.getByRole("button", { name: "行き先を選び直す" }));
  expect(screen.getByRole("heading", { name: "どこから、どこへ？" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("行き先の都道府県"), { target: { value: "aomori" } });
  const departure = (screen.getByLabelText("行き先の駅・観光の起点") as HTMLSelectElement).selectedOptions[0].textContent;
  fireEvent.click(screen.getByRole("button", { name: /おすすめ旅程を見る/ }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover")).toHaveLength(2));
  const request = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/discover")[1][1];
  expect(JSON.parse(String(request?.body))).toMatchObject({ area: "aomori", theme: "history", course: "half_day", traveler: { companion: "family" }, preference_text: "おまかせ。博物館に寄りたい", origin: { name: departure } });
});

it("includes selected AI tags in the next screen and recommendation request", async () => {
  mount();
  revealThemes(); fireEvent.click(screen.getByRole("button", { name: "おまかせ" }));
  goMood();
  fireEvent.click(screen.getByRole("button", { name: "提案タグを選択" }));
  expect(screen.getByText("✦ 庭園でひと休み")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
  await generate();
  const request = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/discover")![1];
  expect(JSON.parse(String(request?.body)).preference_text).toContain("庭園でひと休み");
});

it("reveals each profile question only after the preceding choice", () => {
  mount();
  expect(screen.getByRole("heading", { name: "まずは、あなたのこと。" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "標準" })).toBeNull();
  expect(screen.queryByRole("button", { name: "歴史・街歩き" })).toBeNull();
  expect((screen.getByRole("button", { name: /旅の気分を選ぶ/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("progressbar", { name: "好みの設定" }).getAttribute("aria-valuenow")).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "家族と" }));
  expect(screen.getByRole("button", { name: "ゆったり" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "歴史・街歩き" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "ゆったり" }));
  expect(screen.getByRole("button", { name: "歴史・街歩き" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "提案タグを選択" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
  expect(screen.queryByRole("button", { name: "提案タグを選択" })).toBeNull();
  expect(screen.getByRole("button", { name: /旅の気分を選ぶ/ })).toBeTruthy();
  expect((screen.getByRole("button", { name: /旅の気分を選ぶ/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("好みの設定が完了しました。")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "好みの設定" }).getAttribute("aria-valuenow")).toBe("3");
  expect(screen.getByRole("button", { name: "家族と" }).getAttribute("aria-pressed")).toBe("true");
});

it("reveals mood questions one by one and keeps answers when returning", () => {
  mount(); enterMood();
  expect(screen.queryByRole("group", { name: "どれくらい楽しむ？" })).toBeNull();
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect((screen.getByRole("button", { name: /行き先を選ぶ/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "← 戻る" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "有名な場所を巡りたい" }));
  expect(screen.getByRole("group", { name: "どれくらい楽しむ？" })).toBeTruthy();
  expect(screen.getByRole("textbox")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "半日" }));
  expect(screen.getByRole("textbox")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /行き先を選ぶ/ }));
  fireEvent.click(screen.getByRole("button", { name: "← 戻る" }));
  expect(screen.getByRole("button", { name: "有名な場所を巡りたい" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "半日" }).getAttribute("aria-pressed")).toBe("true");
});

it("allows returning users to jump to 02 with their saved preferences and shows AI tags before the mood question", () => {
  const first = mount();
  expect(screen.queryByRole("button", { name: "02 旅の気分へ" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "家族と" }));
  fireEvent.click(screen.getByRole("button", { name: "ゆったり" }));
  fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
  first.unmount();
  mount();
  fireEvent.click(screen.getByRole("button", { name: "02 旅の気分へ" }));
  expect(screen.getByRole("heading", { name: "どんな一日にしたい？" })).toBeTruthy();
  expect(screen.getByText("歴史・街歩き")).toBeTruthy();
  expect(screen.getByText("ゆったり")).toBeTruthy();
  const tags = screen.getByRole("button", { name: "提案タグを選択" });
  const question = screen.getByRole("group", { name: "家族でどんな時間を過ごしたい？" });
  expect(tags.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("shows unanswered tags without selection and restores the full deck on ordinary regeneration", async () => {
  const view = mount();
  expect(screen.getByRole("button", { name: "指定しない" }).getAttribute("aria-pressed")).toBe("false");
  next(); await generate();
  const initialCount = view.container.querySelector(".discover-progress")?.textContent;
  fireEvent.click(screen.getByRole("button", { name: "いいね ♥" }));
  fireEvent.click(screen.getByRole("button", { name: "行き先を選び直す" }));
  await generate();
  expect(view.container.querySelector(".discover-progress")?.textContent).toBe(initialCount);
  expect((screen.getByRole("button", { name: "いいね ♥" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps destination stations inside the selected prefecture", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/stations/search") ? {ok: true, json: async () => [{name:"岐阜",latitude:35.410,longitude:136.757,code:"gifu",prefecture:"岐阜県",lines:[]}]} : noPhoto));
  mount(); next();
  fireEvent.change(screen.getByLabelText("行き先の都道府県"), {target:{value:"gifu"}});
  expect(within(screen.getByLabelText("行き先の駅・観光の起点")).queryByRole("option", {name:"京都駅"})).toBeNull();
  const field = screen.getByLabelText("行き先の駅・観光の起点").closest("fieldset")!;
  fireEvent.click(within(field).getByRole("button", {name:"駅名で探す"}));
  fireEvent.change(within(field).getByLabelText("駅名を入力"), {target:{value:"岐阜"}});
  fireEvent.click(within(field).getByRole("button", {name:"駅を検索"}));
  fireEvent.click(await within(field).findByRole("button", {name:/岐阜.*岐阜県/}));
  expect((screen.getByLabelText("行き先の都道府県") as HTMLSelectElement).value).toBe("gifu");
  expect((screen.getByLabelText("県をまたぐ候補も含める") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("行き先の駅・観光の起点") as HTMLSelectElement).selectedOptions[0].textContent).toContain("岐阜");
});
