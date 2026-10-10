import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { isRouteIdeaBatch } from "../apiValidation";
import type { RouteIdea } from "../SwipeCard";
import { usePrefecture } from "../PrefectureContext";
import { useFavorites } from "../useFavorites";
import { DiscoverCard } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute } from "./datasetTypes";

const VISIBLE_CARDS = 3;

type DiscoverModeProps = {
  active: boolean;
};

export function DiscoverMode({ active }: DiscoverModeProps) {
  const { prefecture } = usePrefecture();
  const { saveFavorite } = useFavorites();
  const [routes, setRoutes] = useState<RouteIdea[]>([]);
  const [index, setIndex] = useState(0);
  const [exitDirection, setExitDirection] = useState<DiscoverDirection>("pass");
  const [selected, setSelected] = useState<DatasetRoute | RouteIdea | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallbackCount, setFallbackCount] = useState(0);
  const [usedFallback, setUsedFallback] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const stack = routes.slice(index, index + VISIBLE_CARDS);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function loadFallbackIdeas() {
      try {
        const params = new URLSearchParams({
          theme: "all",
          count: "5",
          spot_count: "2",
          use_fallback: "true",
          prefecture_code: prefecture.code,
        });
        const response = await fetch(`/api/ideas?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const detail = typeof payload === "object"
            && payload !== null
            && "detail" in payload
            && typeof payload.detail === "string"
            ? payload.detail
            : "事前サンプルを読み込めませんでした。";
          throw new Error(detail);
        }
        const payload: unknown = await response.json();
        if (!isRouteIdeaBatch(payload)) {
          throw new Error("提案APIから有効なサンプル一覧が返されませんでした。");
        }
        if (controller.signal.aborted) return;
        setRoutes(payload.ideas);
        setIndex(0);
        setFallbackCount(payload.fallback_count);
        setUsedFallback(payload.used_fallback);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "事前サンプルを読み込めませんでした。");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadFallbackIdeas();
    return () => controller.abort();
  }, [active, loadAttempt, prefecture.code]);

  function swipe(direction: DiscoverDirection) {
    const current = routes[index];
    if (!current) return;
    setExitDirection(direction);
    setIndex((value) => value + 1);
    if (direction === "like") {
      saveFavorite(current);
      setSelected(current);
    }
  }

  return (
    <div className="tab-panel discover-mode" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
      <div className="discover-heading">
        <p className="eyebrow">DISCOVER</p>
        <h2>直感で選ぶ、京都のよりみち</h2>
        <p>右にスワイプで詳細を表示、左でスキップ。</p>
      </div>
      <p className="discover-fallback-status" role="status">
        {loading
          ? "事前サンプルを読み込んでいます…"
          : usedFallback
            ? `外部APIを使わない事前サンプル（${fallbackCount}件）`
            : `リアルタイム生成の候補を表示中（事前サンプル ${fallbackCount}件）`}
      </p>

      <div className="discover-stack">
        <AnimatePresence custom={exitDirection}>
          {stack
            .map((route, depth) => ({ route, depth }))
            .reverse()
            .map(({ route, depth }) => (
              <DiscoverCard
                key={route.places.map((place) => place.id).join("-")}
                route={route}
                depth={depth}
                exitDirection={exitDirection}
                onSwipe={swipe}
              />
            ))}
        </AnimatePresence>
        {loading && routes.length === 0 && (
          <div className="discover-empty" role="status">サンプルルートを読み込んでいます…</div>
        )}
        {error && (
          <div className="discover-empty discover-error" role="alert">
            <strong>{error}</strong>
            <button type="button" className="regenerate-button" onClick={() => setLoadAttempt((value) => value + 1)}>
              再読み込み
            </button>
          </div>
        )}
        {!loading && !error && routes.length > 0 && stack.length === 0 && (
          <div className="discover-empty">
            <strong>すべてのルートを見ました</strong>
            <button type="button" className="regenerate-button" onClick={() => setIndex(0)}>最初から見直す ↻</button>
          </div>
        )}
      </div>

      <div className="discover-actions">
        <button type="button" className="discover-action pass" onClick={() => swipe("pass")} disabled={loading || stack.length === 0} aria-label="スキップ">✕</button>
        <span className="discover-progress">{Math.min(index + 1, routes.length)} / {routes.length}</span>
        <button type="button" className="discover-action like" onClick={() => swipe("like")} disabled={loading || stack.length === 0} aria-label="行きたい">♡</button>
      </div>

      {selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
