import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";

vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: () => null }));

function makePlace(id: string) {
  return {
    id,
    name: `京都の場所${id}`,
    category: "寺院",
    description: "サンプルスポットです。",
    access_point: "京都駅から徒歩",
    latitude: 35,
    longitude: 135,
    themes: ["temple"],
  };
}

function makeResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("DiscoverMode", () => {
  it("renders locally-backed ideas without requesting live generation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      ideas: [{
        theme: "temple",
        title: "候補ルート",
        story: "京都の寺院を巡る事前サンプルです。",
        places: [makePlace("a"), makePlace("b")],
        image_url: null,
        author_name: null,
        source_url: null,
        license_name: null,
        license_url: null,
        copywriting_source: "fallback",
        note: "オフラインサンプル",
      }],
      requested_count: 5,
      shortfall: 4,
      used_fallback: true,
      fallback_count: 1,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PrefectureProvider>
        <FavoritesProvider>
          <DiscoverMode active />
        </FavoritesProvider>
      </PrefectureProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "候補ルート" })).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ideas?theme=all&count=5&spot_count=2&use_fallback=true&prefecture_code=26",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText("外部APIを使わない事前サンプル（1件）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "行きたい" }));
    const favorites = JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]");
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toMatchObject({
      title: "候補ルート",
      prefecture_code: "26",
      prefecture_name: "京都府",
    });
  });

  it("shows API errors and allows the user to retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      detail: "サンプルデータを取得できません",
    }, false));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PrefectureProvider>
        <FavoritesProvider>
          <DiscoverMode active />
        </FavoritesProvider>
      </PrefectureProvider>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("サンプルデータを取得できません")).toBeTruthy();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeTruthy();
  });
});
