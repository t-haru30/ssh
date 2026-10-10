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
    author_name: null,
    source_url: null,
    license_name: null,
    license_url: null,
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

function makeBatch(ideas: RouteIdea[], requestedCount = ideas.length, shortfall = 0) {
  return {
    ideas,
    requested_count: requestedCount,
    shortfall,
    used_fallback: false,
    fallback_count: 0,
  };
}

function renderSwipeDeck(fallbackOnly = false) {
  return renderHook(({ isFallbackOnly }) => useSwipeDeck({
    origin: {
      name: "京都駅",
      latitude: 34.9858,
      longitude: 135.7588,
    },
    departureDate: "2026-05-01",
    departureTime: "09:00",
    onItineraryChange: vi.fn(),
    fallbackOnly: isFallbackOnly,
  }), { initialProps: { isFallbackOnly: fallbackOnly } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSwipeDeck", () => {
  it("keeps cards returned with a reported shortfall and exposes retry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(makeBatch([makeIdea(0), makeIdea(2)], 5, 3)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(2));
    expect(result.current.failedLoadCount).toBe(3);
    expect(result.current.error).toContain("3件は補充できませんでした");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/ideas?theme=all&count=5");
  });

  it("requests only pre-generated ideas when fallback-only mode is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(makeBatch([makeIdea(0), makeIdea(1), makeIdea(2), makeIdea(3), makeIdea(4)])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck(true);

    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
    expect(fetchMock.mock.calls[0][0]).toContain("use_fallback=true");
  });

  it("aborts a live request and reloads from fallback when switching modes", async () => {
    const pending: Array<{
      resolve: (response: Response) => void;
      signal: AbortSignal | null;
    }> = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((resolve) => {
        pending.push({ resolve, signal: init?.signal ?? null });
      })
    )));
    const { result, rerender } = renderSwipeDeck(false);
    await waitFor(() => expect(pending).toHaveLength(1));

    rerender({ isFallbackOnly: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal?.aborted).toBe(true);

    await act(async () => {
      pending[1].resolve(makeResponse(makeBatch([makeIdea(9)])));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.ideas.map((idea) => idea.title)).toEqual(["候補9"]);
  });

  it("does not prefetch past the available sample batch in fallback-only mode", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(makeBatch([
        makeIdea(0),
        makeIdea(1),
        makeIdea(2),
        makeIdea(3),
        makeIdea(4),
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck(true);

    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
    await act(async () => {
      await result.current.handleSwipe("skip");
      await result.current.handleSwipe("skip");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.ideas).toHaveLength(3);
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
    await waitFor(() => expect(pending).toHaveLength(1));

    let refresh: Promise<void> = Promise.resolve();
    act(() => {
      refresh = result.current.loadIdeas(false, 1);
    });
    expect(pending).toHaveLength(2);
    expect(pending[0].signal?.aborted).toBe(true);

    await act(async () => {
      pending[0].resolve(makeResponse(makeBatch([makeIdea(0), makeIdea(1), makeIdea(2)])));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      pending[1].resolve(makeResponse(makeBatch([makeIdea(9)])));
      await refresh;
    });

    expect(result.current.ideas.map((idea) => idea.title)).toEqual(["候補9"]);
  });

  it("keeps the selected idea and exposes retry after itinerary failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(makeBatch([
        makeIdea(0),
        makeIdea(1),
        makeIdea(2),
        makeIdea(3),
        makeIdea(4),
      ])))
      .mockResolvedValueOnce(makeResponse({ detail: "経路が見つかりません" }, false));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
    const selectedId = result.current.ideas[0].places.map((place) => place.id).join("-");
    await act(async () => {
      await result.current.handleSwipe("accept");
    });

    expect(result.current.ideas).toHaveLength(5);
    expect(result.current.retryIdeaId).toBe(selectedId);
    expect(result.current.error).toBe("経路が見つかりません");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight itinerary request when the hook unmounts", async () => {
    const adoptionSignal = { current: null as AbortSignal | null };
    let resolveAdoption: ((response: Response) => void) | null = null;
    const selectedIdea = makeIdea(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(makeBatch([
        selectedIdea,
        makeIdea(1),
        makeIdea(2),
        makeIdea(3),
        makeIdea(4),
      ])))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        adoptionSignal.current = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          resolveAdoption = resolve;
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
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

  it("prefetches a new batch when three cards remain", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(makeBatch([
        makeIdea(0),
        makeIdea(1),
        makeIdea(2),
        makeIdea(3),
        makeIdea(4),
      ])))
      .mockResolvedValueOnce(makeResponse(makeBatch([
        makeIdea(5),
        makeIdea(6),
      ], 5, 3)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderSwipeDeck();

    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
    await act(async () => {
      await result.current.handleSwipe("skip");
      await result.current.handleSwipe("skip");
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toContain("count=5");
    expect(fetchMock.mock.calls[1][0]).toContain("exclude=");
    await waitFor(() => expect(result.current.ideas).toHaveLength(5));
    expect(result.current.ideas.map((idea) => idea.title)).toEqual([
      "候補2",
      "候補3",
      "候補4",
      "候補5",
      "候補6",
    ]);
  });
});
