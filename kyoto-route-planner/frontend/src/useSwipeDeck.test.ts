import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteIdea } from "./SwipeCard";
import type { Place } from "./types";
import { useSwipeDeck } from "./useSwipeDeck";

function makePlace(id: string): Place {
  return {
    id,
    name: `場所${id}`,
    category: "公園",
    description: "",
    access_point: "駅から徒歩",
    latitude: 35,
    longitude: 135,
    themes: ["nature"],
  };
}

function makeIdea(index: number): RouteIdea {
  return {
    theme: "nature",
    title: `候補${index}`,
    story: "自然を巡るアイデアです。",
    places: [makePlace(`idea-${index}-a`), makePlace(`idea-${index}-b`)],
    image_url: null,
    copywriting_source: "fallback",
    note: "",
  };
}

function makeResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

function renderSwipeDeck() {
  return renderHook(() => useSwipeDeck({
    origin: {
      name: "京都駅",
      latitude: 34.9858,
      longitude: 135.7588,
    },
    departureDate: "2026-05-01",
    departureTime: "09:00",
    onItineraryChange: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSwipeDeck", () => {
  it("keeps successful ideas when part of a batch fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(makeIdea(0)))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(makeResponse(makeIdea(2)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(2));
    expect(result.current.failedLoadCount).toBe(1);
    expect(result.current.error).toContain("1件のアイデア取得に失敗しました");
  });

  it("ignores stale batch responses after a newer load starts", async () => {
    const pending: Array<{
      resolve: (response: Response) => void;
      signal: AbortSignal | null;
    }> = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((resolve) => {
        pending.push({ resolve, signal: init?.signal ?? null });
      })
    )));
    const { result } = renderSwipeDeck();
    await waitFor(() => expect(pending).toHaveLength(3));

    let refresh: Promise<void> = Promise.resolve();
    act(() => {
      refresh = result.current.loadIdeas(false, 1);
    });
    expect(pending).toHaveLength(4);
    expect(pending.slice(0, 3).every((request) => request.signal?.aborted)).toBe(true);

    await act(async () => {
      pending.slice(0, 3).forEach((request, index) => {
        request.resolve(makeResponse(makeIdea(index)));
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      pending[3].resolve(makeResponse(makeIdea(9)));
      await refresh;
    });

    expect(result.current.ideas.map((idea) => idea.title)).toEqual(["候補9"]);
  });

  it("keeps the selected idea and exposes retry after itinerary failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(makeIdea(0)))
      .mockResolvedValueOnce(makeResponse(makeIdea(1)))
      .mockResolvedValueOnce(makeResponse(makeIdea(2)))
      .mockResolvedValueOnce(makeResponse({ detail: "経路が見つかりません" }, false));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(3));
    const selectedId = result.current.ideas[0].places.map((place) => place.id).join("-");
    await act(async () => {
      await result.current.handleSwipe("accept");
    });

    expect(result.current.ideas).toHaveLength(3);
    expect(result.current.retryIdeaId).toBe(selectedId);
    expect(result.current.error).toBe("経路が見つかりません");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("aborts an in-flight itinerary request when the hook unmounts", async () => {
    const adoptionSignal = { current: null as AbortSignal | null };
    let resolveAdoption: ((response: Response) => void) | null = null;
    const selectedIdea = makeIdea(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(selectedIdea))
      .mockResolvedValueOnce(makeResponse(makeIdea(1)))
      .mockResolvedValueOnce(makeResponse(makeIdea(2)))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        adoptionSignal.current = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          resolveAdoption = resolve;
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(3));
    let adoption: Promise<void> = Promise.resolve();
    act(() => {
      adoption = result.current.handleSwipe("accept");
    });
    await waitFor(() => expect(result.current.adopting).toBe(true));
    unmount();
    expect(adoptionSignal.current?.aborted).toBe(true);

    await act(async () => {
      resolveAdoption?.(makeResponse({
        origin: { name: "京都駅", latitude: 34.9858, longitude: 135.7588 },
        places: selectedIdea.places,
        legs: [],
        estimated_total_minutes: 120,
        estimated_return_at: "2026-05-01T11:00",
        note: "",
      }));
      await adoption;
    });
  });
});
