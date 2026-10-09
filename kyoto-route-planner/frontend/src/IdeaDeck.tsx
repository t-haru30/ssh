import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Origin, Place, SwipeItinerary, Theme } from "./types";
import { SwipeCard } from "./SwipeCard";
import type { RouteIdea, SwipeDirection } from "./SwipeCard";

type IdeaDeckProps = {
  origin: Origin;
  departureDate: string;
  departureTime: string;
  onActivePlacesChange: (places: Place[]) => void;
  onItineraryChange: (itinerary: SwipeItinerary) => void;
  onClose: () => void;
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

function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.latitude === "number"
    && typeof candidate.longitude === "number";
}

function isIdea(value: unknown): value is RouteIdea {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === "string"
    && typeof candidate.story === "string"
    && (candidate.image_url === undefined || candidate.image_url === null || typeof candidate.image_url === "string")
    && Array.isArray(candidate.places)
    && candidate.places.length >= 2
    && candidate.places.every(isPlace)
    && typeof candidate.theme === "string";
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

export function IdeaDeck({
  origin,
  departureDate,
  departureTime,
  onActivePlacesChange,
  onItineraryChange,
  onClose,
}: IdeaDeckProps) {
  const [ideas, setIdeas] = useState<RouteIdea[]>([]);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<SwipeDirection>("skip");
  const [error, setError] = useState<string | null>(null);
  const [failedLoadCount, setFailedLoadCount] = useState(0);
  const [retryIdeaId, setRetryIdeaId] = useState<string | null>(null);
  const [itinerary, setItinerary] = useState<SwipeItinerary | null>(null);
  const [showItinerary, setShowItinerary] = useState(false);
  const activePlaces = showItinerary && itinerary ? itinerary.places : ideas[0]?.places ?? [];
  const lastAutoLoadCount = useRef<number | null>(null);
  const initialLoadStarted = useRef(false);

  useEffect(() => {
    onActivePlacesChange(activePlaces);
  }, [activePlaces, onActivePlacesChange]);

  const loadIdeas = useCallback(async (append: boolean, requestCount = BATCH_SIZE) => {
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
          );
          if (!response.ok) throw new Error(await readResponseError(response));
          const payload: unknown = await response.json();
          if (!isIdea(payload)) throw new Error("アイデアAPIから有効な候補が返されませんでした。");
          setIdeas((current) => appendUniqueIdeas(current, [payload]));
          return payload;
        }),
      );
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
      setError(cause instanceof Error ? cause.message : "アイデアを読み込めませんでした。");
    } finally {
      setLoadingIdeas(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
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

  async function handleSwipe(direction: SwipeDirection) {
    const idea = ideas[0];
    if (!idea || adopting) return;
    if (direction === "skip") {
      setSwipeDirection(direction);
      setError(null);
      setFailedLoadCount(0);
      setRetryIdeaId(null);
      setIdeas((current) => current.slice(1));
      return;
    }

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
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const result = await response.json() as SwipeItinerary;
      setItinerary(result);
      setShowItinerary(true);
      onItineraryChange(result);
      setIdeas((current) => current.filter((candidate) => candidate !== idea));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "経路を取得できませんでした。");
      setRetryIdeaId(idea.places.map((place) => place.id).join("-"));
    } finally {
      setAdopting(false);
    }
  }

  return (
    <section className="idea-deck-section" aria-labelledby="idea-deck-title">
      <div className="idea-deck-heading">
        <div>
          <p className="eyebrow">SWIPE YOUR KYOTO</p>
          <h2 id="idea-deck-title">{itinerary ? "旅のプラン" : "直感で、次の寄り道を。"}</h2>
        </div>
        <button className="idea-close-button" type="button" onClick={onClose}>閉じる</button>
      </div>

      {error && (
        <div className="idea-error" role="alert">
          <span>{error}</span>
          {failedLoadCount > 0 && (
            <button
              className="idea-primary-button"
              type="button"
              onClick={() => void loadIdeas(true, failedLoadCount)}
              disabled={loadingIdeas}
            >
              失敗分を再取得
            </button>
          )}
          {retryIdeaId === ideas[0]?.places.map((place) => place.id).join("-") && (
            <button
              className="idea-primary-button"
              type="button"
              onClick={() => void handleSwipe("accept")}
              disabled={adopting}
            >
              このルートを再試行
            </button>
          )}
        </div>
      )}
      {loadingIdeas && ideas.length === 0 && <p className="idea-loading" role="status">アイデアを集めています…</p>}

      {showItinerary && itinerary ? (
        <motion.div className="idea-itinerary" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <p className="eyebrow">YOUR SELECTED ROUTE</p>
          <h3>選んだスポットの経路</h3>
          <p className="idea-itinerary-summary">
            {itinerary.estimated_total_minutes === null
              ? "所要時間を取得できませんでした"
              : `移動と滞在の目安 ${Math.floor(itinerary.estimated_total_minutes / 60)}時間${itinerary.estimated_total_minutes % 60}分`}
            {itinerary.estimated_return_at ? ` · 帰着 ${itinerary.estimated_return_at.slice(11, 16)}` : ""}
          </p>
          <ol className="idea-itinerary-places">
            {itinerary.places.map((place) => <li key={place.id}>{place.name}</li>)}
          </ol>
          {itinerary.legs.length > 0 && (
            <ol className="idea-itinerary-legs">
              {itinerary.legs.map((leg, index) => (
                <li key={`${leg.from_name}-${leg.to_name}-${index}`}>
                  <span>{leg.from_name} → {leg.to_name}</span>
                  <strong>{leg.line_name}</strong>
                  {leg.duration_minutes !== null && <small>{leg.duration_minutes}分</small>}
                </li>
              ))}
            </ol>
          )}
          <p className="idea-itinerary-note">{itinerary.note}</p>
          <button className="idea-primary-button" type="button" onClick={() => setShowItinerary(false)}>ほかのアイデアを見る</button>
        </motion.div>
      ) : (
        <>
          <div className="idea-swipe-guide" aria-label="操作方法">
            <span className="idea-swipe-guide-skip"><span aria-hidden="true">←</span> 左へスワイプ：スキップ</span>
            <span className="idea-swipe-guide-accept">右へスワイプ：採用 <span aria-hidden="true">→</span></span>
          </div>
          <div className="idea-stage" aria-live="polite">
            <AnimatePresence custom={swipeDirection}>
              {ideas.slice(0, 3).reverse().map((idea, index) => (
                <SwipeCard
                  key={idea.places.map((place) => place.id).join("-")}
                  idea={idea}
                  depth={2 - index}
                  isProcessing={adopting}
                  onSwipe={(direction) => void handleSwipe(direction)}
                />
              ))}
            </AnimatePresence>
            {!loadingIdeas && ideas.length === 0 && failedLoadCount === 0 && (
              <div className="idea-empty">
                <p>表示できるアイデアがありません。</p>
                <button className="idea-primary-button" type="button" onClick={() => void loadIdeas(false)}>もう一度取得</button>
              </div>
            )}
          </div>
          <div className="idea-actions">
            <button type="button" className="idea-action-button skip" onClick={() => void handleSwipe("skip")} disabled={!ideas.length || adopting} aria-label="スキップ">×</button>
            <button type="button" className="idea-action-button accept" onClick={() => void handleSwipe("accept")} disabled={!ideas.length || adopting} aria-label="このアイデアを採用">✓</button>
          </div>
          {adopting && (
            <p className="idea-loading" role="status">
              「{ideas[0]?.title ?? "選択したルート"}」の経路を計算しています…
            </p>
          )}
          <p className="idea-deck-footnote">残り {ideas.length} 件</p>
          {!loadingIdeas && ideas.length <= LOW_CARD_COUNT && !adopting && (
            <button className="idea-reload-button" type="button" onClick={() => void loadIdeas(true)}>アイデアを追加で読み込む</button>
          )}
        </>
      )}
    </section>
  );
}
