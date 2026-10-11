import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SavedRoutesList } from "./SavedRoutesList";
import { PrefectureProvider } from "./PrefectureContext";
import { FavoritesProvider } from "./useFavorites";

const STORAGE_KEY = "kyoto-route-planner:favorites:v1";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PrefectureProvider>
      <FavoritesProvider>{children}</FavoritesProvider>
    </PrefectureProvider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SavedRoutesList", () => {
  it("shows the empty state", () => {
    render(<SavedRoutesList onClose={() => undefined} />, { wrapper });
    expect(screen.getByText("まだ保存されたプランはありません。")).toBeTruthy();
    expect(screen.getByText("スワイプしてお気に入りを見つけましょう！")).toBeTruthy();
  });

  it("shows prefecture tags and removes a saved route", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{
      theme: "temple",
      title: "東山の寺院めぐり",
      story: "東山を巡るルートです。",
      places: [
        {
          id: "kiyomizu",
          name: "清水寺",
          category: "寺院",
          description: "",
          access_point: "徒歩",
          latitude: 35,
          longitude: 135,
          themes: ["temple"],
        },
        {
          id: "kodaiji",
          name: "高台寺",
          category: "寺院",
          description: "",
          access_point: "徒歩",
          latitude: 35.01,
          longitude: 135.01,
          themes: ["temple"],
        },
      ],
      image_url: null,
      author_name: null,
      source_url: null,
      license_name: null,
      license_url: null,
      copywriting_source: "fallback",
      note: "",
      id: "26:kiyomizu",
      prefecture_code: "26",
      prefecture_name: "京都府",
      tags: { prefecture_code: "26", prefecture_name: "京都府" },
      saved_at: "2026-10-10T00:00:00.000Z",
    }]));
    render(<SavedRoutesList onClose={() => undefined} />, { wrapper });

    expect(screen.getByText("保存数の上限は50件です。上限を超えると、古いルートから自動的に削除されます。")).toBeTruthy();
    expect(screen.getByText("京都府 (26)")).toBeTruthy();
    expect(screen.getByText("清水寺 → 高台寺")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "東山の寺院めぐりを保存から削除" }));

    expect(screen.getByText("まだ保存されたプランはありません。")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(0);
  });
});
