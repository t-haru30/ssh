import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PrefectureProvider } from "./PrefectureContext";
import type { RouteIdea } from "./SwipeCard";
import { FavoritesProvider, useFavorites } from "./useFavorites";

const STORAGE_KEY = "kyoto-route-planner:favorites:v1";

function makeIdea(): RouteIdea {
  return {
    theme: "temple",
    prefecture_code: "26",
    prefecture_name: "京都府",
    title: "清水寺と高台寺",
    story: "東山を巡るサンプルです。",
    places: [
      {
        id: "kiyomizu",
        name: "清水寺",
        category: "寺院",
        description: "",
        access_point: "徒歩",
        latitude: 34.9949,
        longitude: 135.785,
        themes: ["temple"],
      },
      {
        id: "kodaiji",
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

describe("useFavorites", () => {
  it("saves a route with its prefecture metadata and persists it", () => {
    const { result } = renderHook(() => useFavorites(), { wrapper });

    let saved = false;
    act(() => {
      saved = result.current.saveFavorite(makeIdea());
    });

    expect(saved).toBe(true);
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0]).toMatchObject({
      id: "26:kiyomizu|kodaiji",
      title: "清水寺と高台寺",
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
    expect(result.current.favorites[0].title).toBe("清水寺と高台寺");
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
