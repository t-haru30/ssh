import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Origin, Place, SwipeItinerary } from "./types";
import { SwipeCard } from "./SwipeCard";
import { useSwipeDeck } from "./useSwipeDeck";
import { usePrefecture } from "./PrefectureContext";

const LOW_CARD_COUNT = 3;

type IdeaDeckProps = {
  origin: Origin;
  departureDate: string;
  departureTime: string;
  onActivePlacesChange: (places: Place[]) => void;
  onItineraryChange: (itinerary: SwipeItinerary) => void;
  onClose: () => void;
};

export function IdeaDeck({
  origin,
  departureDate,
  departureTime,
  onActivePlacesChange,
  onItineraryChange,
  onClose,
}: IdeaDeckProps) {
  const [fallbackOnly, setFallbackOnly] = useState(false);
  const { prefecture } = usePrefecture();
  const {
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
  } = useSwipeDeck({
    origin,
    departureDate,
    departureTime,
    onItineraryChange,
    fallbackOnly,
    prefectureCode: prefecture.code,
  });

  useEffect(() => {
    onActivePlacesChange(activePlaces);
  }, [activePlaces, onActivePlacesChange]);

  return (
    <section className="idea-deck-section" aria-labelledby="idea-deck-title">
      <div className="idea-deck-heading">
        <div>
          <p className="eyebrow">SWIPE YOUR KYOTO</p>
          <h2 id="idea-deck-title">{itinerary ? "旅のプラン" : "直感で、次の寄り道を。"}</h2>
        </div>
        <div className="idea-deck-heading-actions">
          {!itinerary && (
            <button
              className={`idea-source-toggle${fallbackOnly ? " active" : ""}`}
              type="button"
              aria-pressed={fallbackOnly}
              disabled={adopting}
              onClick={() => setFallbackOnly((value) => !value)}
            >
              {fallbackOnly ? "事前サンプル中" : "事前サンプルを使う"}
            </button>
          )}
          <button className="idea-close-button" type="button" onClick={onClose}>閉じる</button>
        </div>
      </div>
      {fallbackOnly && !itinerary && (
        <p className="idea-source-status" role="status">
          提案・画像の外部APIを使わず、事前サンプルを表示しています。採用後の経路検索には駅すぱあとAPIを使用します。
        </p>
      )}

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
                  exitDirection={swipeDirection}
                  onSwipe={(direction) => void handleSwipe(direction)}
                />
              ))}
            </AnimatePresence>
            {!loadingIdeas && ideas.length === 0 && failedLoadCount === 0 && (
              <div className="idea-empty">
                <p>表示できるアイデアがありません。</p>
                <button className="idea-primary-button" type="button" onClick={() => void loadIdeas(false)}>
                  {fallbackOnly ? "事前サンプルを最初から見る" : "もう一度取得"}
                </button>
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
          {!fallbackOnly && !loadingIdeas && ideas.length <= LOW_CARD_COUNT && !adopting && (
            <button className="idea-reload-button" type="button" onClick={() => void loadIdeas(true)}>アイデアを追加で読み込む</button>
          )}
        </>
      )}
    </section>
  );
}
