import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { DiscoverMode } from "./DiscoverMode";

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
        <DiscoverMode active />
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
  });

  it("shows API errors and allows the user to retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      detail: "サンプルデータを取得できません",
    }, false));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PrefectureProvider>
        <DiscoverMode active />
      </PrefectureProvider>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("サンプルデータを取得できません")).toBeTruthy();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeTruthy();
  });
});
