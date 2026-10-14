import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { JOURNEY_DRAFT_KEY, readJourneyDraft, saveJourneyDraft } from "./journeyDraft";
import { newTripStop, scheduleTrip } from "./dayTrip";
import type { RouteIdea } from "./SwipeCard";
import type { Place, RouteSuggestion } from "./types";
import type { SearchPreset } from "./routeSelection";
import { savedJourney } from "./savedJourney";
import type { FavoriteRoute } from "./useFavorites";
import { setOnboardingSuppressed } from "./Onboarding";

const { searchRender, savedState, onboardingState } = vi.hoisted(() => ({
  searchRender: vi.fn(),
  savedState: { favorites: [] as FavoriteRoute[] },
  onboardingState: { suppressed: true, choice: false },
}));

vi.mock("./discover/DiscoverMode", () => ({
  DiscoverMode: ({ active, onPlanInSearch }: { active: boolean; onPlanInSearch: (route: RouteIdea) => void }) => (
    <section hidden={!active}>
      <button type="button" onClick={() => onPlanInSearch(newRoute)}>別のルートを採用</button>
      <button type="button" onClick={() => onPlanInSearch(existingRoute)}>同じルートを採用</button>
    </section>
  ),
}));
vi.mock("./SearchMode", () => ({
  SearchMode: (props: { active: boolean; preset: SearchPreset | null }) => {
    searchRender(props);
    return <section hidden={!props.active}><p>{props.preset?.title ?? "編集中のしおり"}</p></section>;
  },
}));
vi.mock("./SavedRoutesList", () => ({ SavedRoutesList: () => null }));
vi.mock("./useFavorites", () => ({ useFavorites: () => ({ favorites: savedState.favorites, error: null }) }));
vi.mock("./ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("./Onboarding", () => ({
  Onboarding: ({ onClose }: { onClose: (suppressFuture: boolean) => void }) => (
    <div role="dialog" aria-label="はじめての使い方">
      <label><input type="checkbox" aria-label="今後、使い方の説明を表示しない" onChange={(event) => { onboardingState.choice = event.currentTarget.checked; }} />今後、使い方の説明を表示しない</label>
      <button type="button" onClick={() => onClose(onboardingState.choice)}>はじめる</button>
    </div>
  ),
  shouldSuppressOnboarding: () => onboardingState.suppressed,
  setOnboardingSuppressed: vi.fn((suppress: boolean) => { onboardingState.suppressed = suppress; }),
}));

const origin = { name: "京都駅", latitude: 34.98585, longitude: 135.75877 };
const garden: Place = {
  id: "garden", name: "庭園", category: "自然", description: "", access_point: "",
  latitude: 35, longitude: 135.76, themes: ["nature"],
};
const museum: Place = { ...garden, id: "museum", name: "美術館", latitude: 35.02 };
const existingRoute: RouteIdea = {
  theme: "nature", prefecture_code: "26", prefecture_name: "京都府", origin,
  title: "庭園の旅", story: "庭園を訪れる旅です。", places: [garden], dwell_minutes: { garden: 45 },
  image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
  copywriting_source: "fallback", note: "概算",
};
const newRoute: RouteIdea = { ...existingRoute, title: "美術館の旅", places: [museum], dwell_minutes: { museum: 60 } };

beforeEach(() => {
  window.localStorage.clear();
  searchRender.mockClear();
  vi.mocked(setOnboardingSuppressed).mockClear();
  savedState.favorites=[];
  onboardingState.suppressed = true;
  onboardingState.choice = false;
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const source: RouteSuggestion = {
    origin, places: [garden], title: existingRoute.title, story: null, total_minutes: 30,
    legs: [], fare_yen: 400, departure_time: null, arrival_time: null, note: "概算",
  };
  const plan = scheduleTrip(
    { departureTime: "09:00", availableMinutes: 240, budget: 3000 }, origin, "2099-04-10",
    [{ ...newTripStop(garden, 45), locked: true, anchorTime: "10:00", spending: 0 }],
    { route: source, date: "2099-04-10", time: "09:00" },
  );
  expect(saveJourneyDraft(plan, existingRoute.title)).toBe(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("App onboarding", () => {
  it("shows the welcome guide on a first visit and remembers when it is dismissed", () => {
    onboardingState.suppressed = false;
    render(<App />);
    expect(screen.getByRole("dialog", { name: "はじめての使い方" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(screen.queryByRole("dialog", { name: "はじめての使い方" })).toBeNull();
    expect(setOnboardingSuppressed).toHaveBeenCalledWith(false);
    expect(onboardingState.suppressed).toBe(false);
  });

  it("suppresses the welcome guide only when the checkbox is selected", () => {
    onboardingState.suppressed = false;
    render(<App />);
    fireEvent.click(screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(setOnboardingSuppressed).toHaveBeenCalledWith(true);
    expect(onboardingState.suppressed).toBe(true);
  });

  it("does not show the welcome guide automatically after opting out", () => {
    onboardingState.suppressed = true;
    render(<App />);
    expect(screen.queryByRole("dialog", { name: "はじめての使い方" })).toBeNull();
  });
});

describe("App journey replacement confirmation", () => {
  it("reopens the edited saved plan from its original liked card even after its name and venues changed", () => {
    const original=readJourneyDraft()!.plan;
    const edited=scheduleTrip({...original.input,budget:8000},origin,original.date,[newTripStop(museum,60)],original.transport);
    savedState.favorites=[{...savedJourney(edited,"nature","編集した美術館の旅"),id:"26:garden",prefecture_code:"26",prefecture_name:"京都府",edited:true,tags:{},saved_at:"2026-10-14T00:00:00Z"}];
    render(<App />);
    fireEvent.click(screen.getByRole("tab",{name:/見つける/}));
    fireEvent.click(screen.getByRole("button",{name:"同じルートを採用"}));
    const dialog=screen.getByRole("dialog",{name:"編集中のしおりを置き換えますか？"});
    expect(within(dialog).getByText("編集した美術館の旅")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button",{name:"新しいルートで編集する"}));
    expect(searchRender).toHaveBeenLastCalledWith(expect.objectContaining({preset:expect.objectContaining({sourceFavoriteId:"26:garden",title:"編集した美術館の旅",tripPlan:expect.objectContaining({input:expect.objectContaining({budget:8000}),stops:[expect.objectContaining({place:museum})]})})}));
  });
  it("keeps the draft on cancellation and passes the replacement preset only after explicit approval", () => {
    const originalStorage = window.localStorage.getItem(JOURNEY_DRAFT_KEY);
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /見つける/ }));
    fireEvent.click(screen.getByRole("button", { name: "別のルートを採用" }));

    const dialog = screen.getByRole("dialog", { name: "編集中のしおりを置き換えますか？" });
    expect(within(dialog).getByText("庭園の旅")).toBeTruthy();
    expect(within(dialog).getByText("美術館の旅")).toBeTruthy();
    expect(searchRender).toHaveBeenLastCalledWith(expect.objectContaining({ preset: null }));
    fireEvent.click(within(dialog).getByRole("button", { name: "今の下書きを残す" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(JOURNEY_DRAFT_KEY)).toBe(originalStorage);
    expect(readJourneyDraft()?.plan.stops[0].locked).toBe(true);
    expect(searchRender).toHaveBeenLastCalledWith(expect.objectContaining({ preset: null }));

    fireEvent.click(screen.getByRole("button", { name: "別のルートを採用" }));
    fireEvent.click(screen.getByRole("button", { name: "新しいルートで編集する" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(searchRender).toHaveBeenLastCalledWith(expect.objectContaining({
      active: true,
      preset: expect.objectContaining({ title: "美術館の旅", origin, places: [museum], dwellMinutes: { museum: 60 } }),
    }));
    expect(screen.getByRole("tab", { name: /旅程を編集/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("reopens the same route without replacing its fixed appointments or conditions", () => {
    const originalStorage = window.localStorage.getItem(JOURNEY_DRAFT_KEY);
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /見つける/ }));
    fireEvent.click(screen.getByRole("button", { name: "同じルートを採用" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(searchRender).toHaveBeenLastCalledWith({ active: true, preset: null, editingOnly: true, onDiscover: expect.any(Function) });
    expect(window.localStorage.getItem(JOURNEY_DRAFT_KEY)).toBe(originalStorage);
    expect(readJourneyDraft()?.plan).toMatchObject({
      input: { departureTime: "09:00", availableMinutes: 240, budget: 3000 },
      stops: [{ place: { id: "garden" }, locked: true, anchorTime: "10:00", dwellMinutes: 45, spending: 0 }],
    });
  });
});
