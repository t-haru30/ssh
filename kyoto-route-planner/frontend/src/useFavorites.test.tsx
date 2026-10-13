import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PrefectureProvider } from "./PrefectureContext";
import type { RouteIdea } from "./SwipeCard";
import { newTripStop, scheduleTrip } from "./dayTrip";
import { serializeJourneyFile } from "./journeyFile";
import { FavoritesProvider, MAX_FAVORITES, useFavorites } from "./useFavorites";

const STORAGE_KEY = "kyoto-route-planner:favorites:v1";

function makeIdea(index = 0): RouteIdea {
  return {
    theme: "temple",
    prefecture_code: "26",
    prefecture_name: "京都府",
    title: `清水寺と高台寺 ${index}`,
    story: "東山を巡るサンプルです。",
    places: [
      {
        id: `kiyomizu-${index}`,
        name: "清水寺",
        category: "寺院",
        description: "",
        access_point: "徒歩",
        latitude: 34.9949,
        longitude: 135.785,
        themes: ["temple"],
      },
      {
        id: `kodaiji-${index}`,
        name: "高台寺",
        category: "寺院",
        description: "",
        access_point: "徒歩",
        latitude: 35.0008,
        longitude: 135.7807,
        themes: ["temple"],
      },
    ],
    image_url: null,
    author_name: null,
    source_url: null,
    license_name: null,
    license_url: null,
    copywriting_source: "fallback",
    note: "ローカルサンプル",
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PrefectureProvider>
      <FavoritesProvider>{children}</FavoritesProvider>
    </PrefectureProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function snapshotIdea(dwellMinutes = 45): RouteIdea {
  const idea = makeIdea();
  const origin = { name: "京都駅", latitude: 34.9858, longitude: 135.7588 };
  const route = { origin, places: idea.places, legs: [], total_minutes: null, departure_time: null, arrival_time: null, title: null, story: null, note: "" };
  const plan = scheduleTrip({ departureTime: "09:00", availableMinutes: 360, budget: 3000 }, origin, "2099-10-12", idea.places.map(p => newTripStop(p, dwellMinutes)), { route, date: "", time: "" });
  return { ...idea, journey_file: serializeJourneyFile(plan, idea.title) };
}

describe("useFavorites", () => {
  it.each(["{invalid", JSON.stringify({ version: 2 }), 42, null, ""])("rejects an invalid journey snapshot without replacing saved data: %j", (snapshot) => {
    const { result } = renderHook(() => useFavorites(), { wrapper });
    act(() => { expect(result.current.saveFavorite(makeIdea(1))).toBe(true); });
    const stored = localStorage.getItem(STORAGE_KEY);
    const invalid = { ...makeIdea(), journey_file: snapshot } as RouteIdea;
    act(() => { expect(result.current.saveFavorite(invalid)).toBe(false); });
    expect(result.current.isFavorite(invalid)).toBe(false);
    expect(result.current.favorites).toHaveLength(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);
  });

  it("deduplicates equivalent snapshots with different save timestamps and JSON formatting", () => {
    const original = snapshotIdea();
    const data = JSON.parse(original.journey_file!);
    const duplicate = { ...original, journey_file: JSON.stringify({ ...data, savedAt: "2099-10-13T00:00:00.000Z" }) };
    const { result } = renderHook(() => useFavorites(), { wrapper });
    act(() => { expect(result.current.saveFavorite(original)).toBe(true); });
    act(() => { expect(result.current.saveFavorite(duplicate)).toBe(false); });
    expect(result.current.isFavorite(duplicate)).toBe(true);
    expect(result.current.favorites).toHaveLength(1);
  });

  it("saves a separate itinerary when its stay duration changes", () => {
    const original = snapshotIdea(45), changed = snapshotIdea(60);
    const { result } = renderHook(() => useFavorites(), { wrapper });
    act(() => { expect(result.current.saveFavorite(original)).toBe(true); });
    expect(result.current.isFavorite(changed)).toBe(false);
    act(() => { expect(result.current.saveFavorite(changed)).toBe(true); });
    expect(result.current.favorites).toHaveLength(2);
    expect(new Set(result.current.favorites.map(f => f.id)).size).toBe(2);
  });

  it("restores Discover routes with five stops without changing their saved data", () => {
    const idea = makeIdea();
    idea.places = Array.from({ length: 5 }, (_, index) => ({ ...idea.places[index % 2], id: `long-${index}` }));
    const first = renderHook(() => useFavorites(), { wrapper });
    act(() => { expect(first.result.current.saveFavorite(idea)).toBe(true); });
    const originalStorage = window.localStorage.getItem(STORAGE_KEY);
    first.unmount();
    const restored = renderHook(() => useFavorites(), { wrapper });
    expect(restored.result.current.error).toBeNull();
    expect(restored.result.current.favorites[0].places).toHaveLength(5);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(originalStorage);
  });
  it("saves a route with its prefecture metadata and persists it", () => {
    const { result } = renderHook(() => useFavorites(), { wrapper });

    let saved = false;
    act(() => {
      saved = result.current.saveFavorite(makeIdea());
    });

    expect(saved).toBe(true);
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0]).toMatchObject({
      id: "26:kiyomizu-0|kodaiji-0",
      title: "清水寺と高台寺 0",
      prefecture_code: "26",
      prefecture_name: "京都府",
      tags: { prefecture_code: "26", prefecture_name: "京都府" },
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(1);
    expect(result.current.isFavorite(makeIdea())).toBe(true);
  });

  it("does not save the same route twice and removes saved routes", () => {
    const { result } = renderHook(() => useFavorites(), { wrapper });
    act(() => {
      result.current.saveFavorite(makeIdea());
    });
    let duplicateSaved = true;
    act(() => {
      duplicateSaved = result.current.saveFavorite(makeIdea());
    });

    expect(duplicateSaved).toBe(false);
    expect(result.current.favorites).toHaveLength(1);

    act(() => {
      result.current.removeFavorite(result.current.favorites[0].id);
    });
    expect(result.current.favorites).toHaveLength(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("keeps only the 50 newest routes and evicts the oldest route", () => {
    const { result } = renderHook(() => useFavorites(), { wrapper });

    act(() => {
      for (let index = 0; index <= MAX_FAVORITES; index += 1) {
        result.current.saveFavorite(makeIdea(index));
      }
    });

    expect(result.current.favorites).toHaveLength(MAX_FAVORITES);
    expect(result.current.favorites[0].title).toBe(`清水寺と高台寺 ${MAX_FAVORITES}`);
    expect(result.current.favorites[MAX_FAVORITES - 1].title).toBe("清水寺と高台寺 1");
    expect(result.current.favorites.some((favorite) => favorite.title.endsWith(" 0"))).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    expect(stored).toHaveLength(MAX_FAVORITES);
    expect(stored[0].title).toBe(`清水寺と高台寺 ${MAX_FAVORITES}`);
  });

  it("rejects a new route when every saved route is pinned and allows retry after unpinning", () => {
    const { result } = renderHook(() => useFavorites(), { wrapper });
    act(() => {
      for (let index = 0; index < MAX_FAVORITES; index += 1) {
        result.current.saveFavorite(makeIdea(index));
      }
    });
    act(() => {
      result.current.favorites.forEach((favorite) => result.current.togglePin(favorite.id));
    });
    const originalStorage = window.localStorage.getItem(STORAGE_KEY);
    const firstId = result.current.favorites[0].id;
    const newIdea = makeIdea(MAX_FAVORITES);
    let saved = true;

    act(() => {
      saved = result.current.saveFavorite(newIdea);
    });

    expect(saved).toBe(false);
    expect(result.current.error).toContain("すべてピン留め");
    expect(result.current.isFavorite(newIdea)).toBe(false);
    expect(result.current.favorites).toHaveLength(MAX_FAVORITES);
    expect(result.current.favorites.every((favorite) => favorite.pinned)).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(originalStorage);

    act(() => {
      result.current.togglePin(firstId);
      saved = result.current.saveFavorite(newIdea);
    });

    expect(saved).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isFavorite(newIdea)).toBe(true);
    expect(result.current.favorites).toHaveLength(MAX_FAVORITES);
    expect(result.current.favorites.some((favorite) => favorite.id === firstId)).toBe(false);
    expect(result.current.favorites.filter((favorite) => favorite.pinned)).toHaveLength(MAX_FAVORITES - 1);
  });

  it("restores the saved origin and individual dwell times after remounting", () => {
    const metadata = {
      origin: { name: "東京駅", latitude: 35.6812, longitude: 139.7671 },
      dwell_minutes: { "kiyomizu-0": 45, "kodaiji-0": 60 },
    };
    const idea = { ...makeIdea(), ...metadata };
    const first = renderHook(() => useFavorites(), { wrapper });
    act(() => {
      first.result.current.saveFavorite(idea);
    });
    first.unmount();

    const { result } = renderHook(() => useFavorites(), { wrapper });

    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0]).toMatchObject(metadata);
    expect(result.current.error).toBeNull();
  });

  it.each([
    { origin: { name: "範囲外の起点", latitude: 999, longitude: 139 } },
    { dwell_minutes: [] },
    { dwell_minutes: { "kiyomizu-0": "45" } },
    { dwell_minutes: { "kiyomizu-0": -15 } },
  ])("rejects invalid optional itinerary metadata without overwriting storage: %j", (metadata) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const serialized = JSON.stringify([{
      ...makeIdea(),
      ...metadata,
      id: "26:kiyomizu-0|kodaiji-0",
      tags: { prefecture_code: "26", prefecture_name: "京都府" },
      saved_at: "2026-10-10T00:00:00.000Z",
    }]);
    window.localStorage.setItem(STORAGE_KEY, serialized);

    const { result } = renderHook(() => useFavorites(), { wrapper });

    expect(result.current.favorites).toHaveLength(0);
    expect(result.current.error).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(serialized);
  });

  it("trims existing saved data to the newest 50 routes on load", () => {
    const savedRoutes = Array.from({ length: MAX_FAVORITES + 1 }, (_, index) => ({
      ...makeIdea(index),
      id: `26:kiyomizu-${index}|kodaiji-${index}`,
      prefecture_code: "26",
      prefecture_name: "京都府",
      tags: { prefecture_code: "26", prefecture_name: "京都府" },
      saved_at: new Date(2026, 0, index + 1).toISOString(),
    })).reverse();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRoutes));

    const { result } = renderHook(() => useFavorites(), { wrapper });

    expect(result.current.favorites).toHaveLength(MAX_FAVORITES);
    expect(result.current.favorites[0].title).toBe(`清水寺と高台寺 ${MAX_FAVORITES}`);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(MAX_FAVORITES);
  });

  it("loads existing favorites on mount", () => {
    const initialRoute = {
      ...makeIdea(),
      id: "26:kodaiji|kiyomizu",
      prefecture_code: "26",
      prefecture_name: "京都府",
      tags: { prefecture_code: "26", prefecture_name: "京都府" },
      saved_at: "2026-10-10T00:00:00.000Z",
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([initialRoute]));

    const { result } = renderHook(() => useFavorites(), { wrapper });

    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0].title).toBe("清水寺と高台寺 0");
    expect(result.current.error).toBeNull();
  });

  it("surfaces invalid stored data instead of silently replacing it", () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.localStorage.setItem(STORAGE_KEY, "{invalid");

    const { result } = renderHook(() => useFavorites(), { wrapper });

    expect(result.current.favorites).toHaveLength(0);
    expect(result.current.error).toBeTruthy();
    expect(logError).toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("{invalid");
  });
});

it("replaces an edited source atomically, retains its identity and pin, and does not duplicate", () => {
  const { result } = renderHook(() => useFavorites(), { wrapper });
  act(() => { result.current.saveFavorite(makeIdea()); });
  const id = result.current.favorites[0].id;
  act(() => { result.current.togglePin(id); });
  const edited = { ...snapshotIdea(60), title: "編集した旅" };
  act(() => { expect(result.current.replaceFavorite(id, edited)).toBe(true); });
  expect(result.current.favorites).toHaveLength(1);
  expect(result.current.favorites[0]).toMatchObject({ id, title: "編集した旅", edited: true, pinned: true });
  expect(result.current.isFavorite(edited)).toBe(true);
  act(() => { expect(result.current.saveFavorite(edited)).toBe(false); });
  const before = localStorage.getItem(STORAGE_KEY);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  act(() => { expect(result.current.replaceFavorite(id, makeIdea(2))).toBe(false); });
  expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  expect(result.current.favorites[0].title).toBe("編集した旅");
});
