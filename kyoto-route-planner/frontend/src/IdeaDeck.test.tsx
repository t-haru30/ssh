import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeaDeck } from "./IdeaDeck";
import { PrefectureProvider } from "./PrefectureContext";
import { FavoritesProvider } from "./useFavorites";

vi.mock("./SwipeCard", () => ({
  SwipeCard: () => <article>提案カード</article>,
}));

const STORAGE_KEY = "kyoto-route-planner:favorites:v1";

function makeIdea(index: number) {
  return {
    theme: "temple",
    title: `候補ルート${index}`,
    story: "寺院を巡るルートです。",
    places: [
      {
        id: `place-${index}-a`,
        name: "清水寺",
        category: "寺院",
        description: "",
        access_point: "徒歩",
        latitude: 35,
        longitude: 135,
        themes: ["temple"],
      },
      {
        id: `place-${index}-b`,
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
  };
}

function makeResponse(payload: unknown, ok = true): Response {
  return { ok, json: async () => payload } as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PrefectureProvider>
      <FavoritesProvider>{children}</FavoritesProvider>
    </PrefectureProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("IdeaDeck", () => {
  it("saves a route immediately when accepted, even if itinerary lookup fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({
        ideas: [makeIdea(0), makeIdea(1), makeIdea(2), makeIdea(3), makeIdea(4)],
        requested_count: 5,
        shortfall: 0,
        used_fallback: false,
        fallback_count: 0,
      }))
      .mockResolvedValueOnce(makeResponse({ detail: "経路が見つかりません" }, false));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IdeaDeck
        origin={{ name: "京都駅", latitude: 35, longitude: 135 }}
        departureDate="2026-05-01"
        departureTime="09:00"
        onActivePlacesChange={vi.fn()}
        onItineraryChange={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper },
    );
    await screen.findAllByText("提案カード");

    fireEvent.click(screen.getByRole("button", { name: "このアイデアを採用" }));
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(1);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")[0]).toMatchObject({
      title: "候補ルート0",
      prefecture_code: "26",
      prefecture_name: "京都府",
    });
    expect(await screen.findByText("経路が見つかりません")).toBeTruthy();
  });
});
