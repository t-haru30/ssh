import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { RouteIdea } from "../SwipeCard";
import { usePrefecture } from "../PrefectureContext";
import type { PrefectureCode } from "../PrefectureContext";
import { useFavorites } from "../useFavorites";
import { DiscoverCard } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute } from "./datasetTypes";
import type { RouteDataset, RouteDatasetIndex } from "./datasetTypes";

import prefectureIndex from "../data/routes/index.json";

const VISIBLE_CARDS = 3;
const datasets = import.meta.glob(["../data/routes/*.json", "!../data/routes/index.json"], {
  eager: true,
  import: "default",
}) as Record<string, RouteDataset>;
const prefectureDatasets = Object.values(datasets).filter(
  (value): value is RouteDataset => "area" in value && Array.isArray(value.routes),
);
const indexEntries = [...(prefectureIndex as RouteDatasetIndex).prefectures].sort((first, second) =>
  first.prefecture_code.localeCompare(second.prefecture_code),
);
const prefectureNames: Record<string, string> = Object.fromEntries(
  indexEntries.map((entry) => [entry.id, entry.name]),
);
const prefectureOrder = new Map(indexEntries.map((entry, order) => [entry.id, order]));
prefectureDatasets.sort(
  (first, second) => (prefectureOrder.get(first.area) ?? 99) - (prefectureOrder.get(second.area) ?? 99),
);

type DiscoverModeProps = {
  active: boolean;
};

export function DiscoverMode({ active }: DiscoverModeProps) {
  const { prefecture, setPrefectureCode } = usePrefecture();
  const { saveFavorite } = useFavorites();
  const [routes, setRoutes] = useState<Array<DatasetRoute | RouteIdea>>([]);
  const [area, setArea] = useState("kyoto");
  const [index, setIndex] = useState(0);
  const [exitDirection, setExitDirection] = useState<DiscoverDirection>("pass");
  const [selected, setSelected] = useState<DatasetRoute | RouteIdea | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stack = routes.slice(index, index + VISIBLE_CARDS);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setError(null);
    const dataset = prefectureDatasets.find((item) => item.area === area);
    if (!dataset) {
      setRoutes([]);
      setError("選択した都道府県のサンプルルートが見つかりません。");
    } else {
      setRoutes(dataset.routes);
      setIndex(0);
    }
    setLoading(false);
  }, [active, area]);

  function swipe(direction: DiscoverDirection) {
    const current = routes[index];
    if (!current) return;
    setExitDirection(direction);
    setIndex((value) => value + 1);
    if (direction === "like") {
      if ("spots" in current) {
        const entry = indexEntries.find((candidate) => candidate.id === current.area);
        saveFavorite({
          theme: current.theme,
          prefecture_code: entry?.prefecture_code ?? prefecture.code,
          prefecture_name: entry?.name ?? prefecture.name,
          title: current.title,
          story: `${current.spots.length}か所を巡る事前サンプルルートです。`,
          places: current.spots.map((spot) => ({
            id: spot.place_id,
            name: spot.name,
            category: spot.category,
            description: "",
            access_point: "",
            latitude: spot.lat,
            longitude: spot.lng,
            themes: [current.theme],
          })),
          image_url: null,
          author_name: null,
          source_url: null,
          license_name: null,
          license_url: null,
          copywriting_source: "fallback",
          note: "事前サンプル",
        });
      } else {
        saveFavorite(current);
      }
      setSelected(current);
    }
  }

  return (
    <div className="tab-panel discover-mode" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
      <div className="discover-heading">
        <p className="eyebrow">DISCOVER</p>
        <h2>直感で選ぶ、都道府県のよりみち</h2>
        <p>右にスワイプでしおりを開く、左でスキップ。</p>
      </div>
      <label className="prefecture-picker">
        都道府県
        <select value={area} onChange={(event) => {
          const nextArea = event.target.value;
          setArea(nextArea);
          const entry = indexEntries.find((candidate) => candidate.id === nextArea);
          if (entry) setPrefectureCode(entry.prefecture_code as PrefectureCode);
        }}>
          {prefectureDatasets.map((dataset) => (
            <option key={dataset.area} value={dataset.area}>
              {prefectureNames[dataset.area] ?? dataset.area}
            </option>
          ))}
        </select>
      </label>
      <p className="discover-fallback-status" role="status">
        {loading
          ? "事前サンプルを読み込んでいます…"
          : `${prefectureNames[area] ?? area}の実データに基づくサンプル（${routes.length}件）`}
      </p>

      <div className="discover-stack">
        <AnimatePresence custom={exitDirection}>
          {stack
            .map((route, depth) => ({ route, depth }))
            .reverse()
            .map(({ route, depth }) => (
              <DiscoverCard
                key={"places" in route ? route.places.map((place) => place.id).join("-") : route.id}
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
        <button type="button" className="discover-action like" onClick={() => swipe("like")} disabled={loading || stack.length === 0} aria-label="しおりを開く">♡</button>
      </div>

      {selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
