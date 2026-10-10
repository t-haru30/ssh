import { useCallback, useEffect, useRef, useState } from "react";
import { isRouteIdea, isSwipeItinerary } from "./apiValidation";
import type { Origin, Place, SwipeItinerary, Theme } from "./types";
import type { RouteIdea, SwipeDirection } from "./SwipeCard";

type UseSwipeDeckOptions = {
  origin: Origin;
  departureDate: string;
  departureTime: string;
  onItineraryChange: (itinerary: SwipeItinerary) => void;
};

const BATCH_SIZE = 3;
const LOW_CARD_COUNT = 1;
const IDEA_THEMES: Theme[] = ["all", "history", "temple", "nature", "food"];

async function readResponseError(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (
    typeof payload === "object"
    && payload !== null
    && "detail" in payload
    && typeof payload.detail === "string"
  ) {
    return payload.detail;
  }
  return "リクエストに失敗しました。時間をおいて再度お試しください。";
}

function appendUniqueIdeas(current: RouteIdea[], additions: RouteIdea[]) {
  const seen = new Set<string>();
  return [...current, ...additions].filter((idea) => {
    const key = idea.places.map((place) => place.id).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function useSwipeDeck({
  origin,
  departureDate,
  departureTime,
  onItineraryChange,
}: UseSwipeDeckOptions) {
  const [ideas, setIdeas] = useState<RouteIdea[]>([]);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<SwipeDirection>("skip");
  const [error, setError] = useState<string | null>(null);
  const [failedLoadCount, setFailedLoadCount] = useState(0);
  const [retryIdeaId, setRetryIdeaId] = useState<string | null>(null);
  const [itinerary, setItinerary] = useState<SwipeItinerary | null>(null);
  const [showItinerary, setShowItinerary] = useState(false);
  const lastAutoLoadCount = useRef<number | null>(null);
  const loadGeneration = useRef(0);
  const loadAbortController = useRef<AbortController | null>(null);
  const adoptionAbortController = useRef<AbortController | null>(null);

  const activePlaces: Place[] = showItinerary && itinerary
    ? itinerary.places
    : ideas[0]?.places ?? [];

  useEffect(() => () => {
    loadGeneration.current += 1;
    loadAbortController.current?.abort();
    loadAbortController.current = null;
    adoptionAbortController.current?.abort();
    adoptionAbortController.current = null;
  }, []);

  const loadIdeas = useCallback(async (append: boolean, requestCount = BATCH_SIZE) => {
    loadAbortController.current?.abort();
    const controller = new AbortController();
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    loadAbortController.current = controller;
    setLoadingIdeas(true);
    setError(null);
    setFailedLoadCount(0);
    if (!append) setIdeas([]);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: requestCount }, async () => {
          const theme = IDEA_THEMES[Math.floor(Math.random() * IDEA_THEMES.length)];
          const response = await fetch(
            `/api/ideas/random?theme=${encodeURIComponent(theme)}&spot_count=2`,
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error(await readResponseError(response));
          const payload: unknown = await response.json();
          if (!isRouteIdea(payload)) throw new Error("アイデアAPIから有効な候補が返されませんでした。");
          if (generation === loadGeneration.current && !controller.signal.aborted) {
            setIdeas((current) => appendUniqueIdeas(current, [payload]));
          }
          return payload;
        }),
      );
      if (generation !== loadGeneration.current || controller.signal.aborted) return;
      const failedCount = results.filter((result) => result.status === "rejected").length;
      setFailedLoadCount(failedCount);
      if (failedCount > 0) {
        const firstFailure = results.find((result) => result.status === "rejected");
        const detail = firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
          ? ` ${firstFailure.reason.message}`
          : "";
        setError(
          failedCount === requestCount
            ? `アイデアを読み込めませんでした。${detail}`
            : `${failedCount}件のアイデア取得に失敗しました。取得できた候補を表示しています。${detail}`,
        );
      }
    } catch (cause) {
      if (generation === loadGeneration.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "アイデアを読み込めませんでした。");
      }
    } finally {
      if (generation === loadGeneration.current) {
        loadAbortController.current = null;
        setLoadingIdeas(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadIdeas(false);
  }, [loadIdeas]);

  useEffect(() => {
    if (
      ideas.length > 0
      && ideas.length <= LOW_CARD_COUNT
      && !loadingIdeas
      && failedLoadCount === 0
      && !itinerary
      && !adopting
      && lastAutoLoadCount.current !== ideas.length
    ) {
      lastAutoLoadCount.current = ideas.length;
      void loadIdeas(true);
    }
  }, [adopting, failedLoadCount, ideas.length, itinerary, loadingIdeas, loadIdeas]);

  const handleSwipe = useCallback(async (direction: SwipeDirection) => {
    const idea = ideas[0];
    if (!idea || adopting || adoptionAbortController.current) return;
    if (direction === "skip") {
      setSwipeDirection(direction);
      setError(null);
      setFailedLoadCount(0);
      setRetryIdeaId(null);
      setIdeas((current) => current.slice(1));
      return;
    }

    const controller = new AbortController();
    adoptionAbortController.current = controller;
    setAdopting(true);
    setError(null);
    setFailedLoadCount(0);
    setRetryIdeaId(null);
    try {
      const response = await fetch("/api/itineraries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: idea.places.map((place) => place.name).join(" "),
          departure_station: origin.name,
          departure_date: departureDate,
          departure_time: departureTime,
          stop_count: idea.places.length,
          selected_places: idea.places.map((place) => ({
            id: place.id,
            name: place.name,
            category: place.category,
            region: (place.address ?? "").slice(0, 3),
            address: place.address ?? "",
            latitude: place.latitude,
            longitude: place.longitude,
            description: place.description,
          })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const payload: unknown = await response.json();
      if (!isSwipeItinerary(payload)) throw new Error("経路APIから有効な旅程が返されませんでした。");
      if (controller.signal.aborted || adoptionAbortController.current !== controller) return;
      setItinerary(payload);
      setShowItinerary(true);
      onItineraryChange(payload);
      setIdeas((current) => current.filter((candidate) => candidate !== idea));
    } catch (cause) {
      if (!controller.signal.aborted && adoptionAbortController.current === controller) {
        setError(cause instanceof Error ? cause.message : "経路を取得できませんでした。");
        setRetryIdeaId(idea.places.map((place) => place.id).join("-"));
      }
    } finally {
      if (adoptionAbortController.current === controller) {
        adoptionAbortController.current = null;
        setAdopting(false);
      }
    }
  }, [adopting, departureDate, departureTime, ideas, onItineraryChange, origin]);

  return {
    ideas,
    loadingIdeas,
    adopting,
    swipeDirection,
    error,
    failedLoadCount,
    retryIdeaId,
    itinerary,
    showItinerary,
    setShowItinerary,
    activePlaces,
    loadIdeas,
    handleSwipe,
  };
}
