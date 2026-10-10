import { useCallback, useEffect, useRef, useState } from "react";
import { isRouteIdeaBatch, isSwipeItinerary } from "./apiValidation";
import type { Origin, Place, SwipeItinerary } from "./types";
import type { RouteIdea, SwipeDirection } from "./SwipeCard";

type UseSwipeDeckOptions = {
  origin: Origin;
  departureDate: string;
  departureTime: string;
  onItineraryChange: (itinerary: SwipeItinerary) => void;
  fallbackOnly: boolean;
  prefectureCode: string;
};

const INITIAL_BATCH_SIZE = 5;
const PREFETCH_BATCH_SIZE = 5;
const PREFETCH_THRESHOLD = 3;
const EMPTY_PLACES: Place[] = [];

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
  const seen = new Set(current.map((idea) => idea.places.map((place) => place.id).sort().join("|")));
  const uniqueAdditions = additions.filter((idea) => {
    const key = idea.places.map((place) => place.id).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...current, ...uniqueAdditions];
}

function ideaSignature(idea: RouteIdea) {
  return idea.places.map((place) => place.id).sort().join("|");
}

export function useSwipeDeck({
  origin,
  departureDate,
  departureTime,
  onItineraryChange,
  fallbackOnly,
  prefectureCode,
}: UseSwipeDeckOptions) {
  const [ideas, setIdeas] = useState<RouteIdea[]>([]);
  const [loadingIdeas, setLoadingIdeas] = useState(true);
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
  const seenIdeaSignatures = useRef(new Set<string>());

  const activePlaces: Place[] = showItinerary && itinerary
    ? itinerary.places
    : ideas[0]?.places ?? EMPTY_PLACES;

  useEffect(() => () => {
    loadGeneration.current += 1;
    loadAbortController.current?.abort();
    loadAbortController.current = null;
    adoptionAbortController.current?.abort();
    adoptionAbortController.current = null;
  }, []);

  const loadIdeas = useCallback(async (append: boolean, requestCount = INITIAL_BATCH_SIZE) => {
    loadAbortController.current?.abort();
    const controller = new AbortController();
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    loadAbortController.current = controller;
    setLoadingIdeas(true);
    setError(null);
    setFailedLoadCount(0);
    if (!append) {
      setIdeas([]);
      lastAutoLoadCount.current = null;
      seenIdeaSignatures.current.clear();
    }
    try {
      const params = new URLSearchParams({
        theme: "all",
        count: String(requestCount),
        spot_count: "2",
        prefecture_code: prefectureCode,
      });
      if (fallbackOnly) params.set("use_fallback", "true");
      [...seenIdeaSignatures.current]
        .slice(-50)
        .forEach((signature) => params.append("exclude", signature));
      const response = await fetch(`/api/ideas?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await readResponseError(response));
      const payload: unknown = await response.json();
      if (!isRouteIdeaBatch(payload)) {
        throw new Error("アイデアAPIから有効な候補一覧が返されませんでした。");
      }
      if (generation !== loadGeneration.current || controller.signal.aborted) return;
      setIdeas((current) => appendUniqueIdeas(current, payload.ideas));
      payload.ideas.forEach((idea) => seenIdeaSignatures.current.add(ideaSignature(idea)));
      setFailedLoadCount(payload.shortfall);
      if (payload.shortfall > 0) {
        setError(
          `候補を${payload.ideas.length}件取得しました。データ不足のため${payload.shortfall}件は補充できませんでした。`,
        );
      }
    } catch (cause) {
      if (generation === loadGeneration.current && !controller.signal.aborted) {
        setFailedLoadCount(requestCount);
        setError(cause instanceof Error ? cause.message : "アイデアを読み込めませんでした。");
      }
    } finally {
      if (generation === loadGeneration.current) {
        loadAbortController.current = null;
        setLoadingIdeas(false);
      }
    }
  }, [fallbackOnly, prefectureCode]);

  useEffect(() => {
    void loadIdeas(false);
  }, [loadIdeas]);

  useEffect(() => {
    if (
      ideas.length > 0
      && ideas.length <= PREFETCH_THRESHOLD
      && !fallbackOnly
      && !loadingIdeas
      && failedLoadCount === 0
      && !itinerary
      && !adopting
      && lastAutoLoadCount.current !== ideas.length
    ) {
      lastAutoLoadCount.current = ideas.length;
      void loadIdeas(true, PREFETCH_BATCH_SIZE);
    }
  }, [adopting, failedLoadCount, fallbackOnly, ideas.length, itinerary, loadingIdeas, loadIdeas]);

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
