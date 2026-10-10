import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import dataset from "../data/mock_dataset.json";
import { DiscoverCard } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute, RouteDataset } from "./datasetTypes";

const routes = (dataset as RouteDataset).routes;
const VISIBLE_CARDS = 3;

type DiscoverModeProps = {
  active: boolean;
};

export function DiscoverMode({ active }: DiscoverModeProps) {
  const [index, setIndex] = useState(0);
  const [exitDirection, setExitDirection] = useState<DiscoverDirection>("pass");
  const [selected, setSelected] = useState<DatasetRoute | null>(null);

  const stack = routes.slice(index, index + VISIBLE_CARDS);

  function swipe(direction: DiscoverDirection) {
    const current = routes[index];
    if (!current) return;
    setExitDirection(direction);
    setIndex((value) => value + 1);
    if (direction === "like") setSelected(current);
  }

  return (
    <div className="tab-panel discover-mode" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
      <div className="discover-heading">
        <p className="eyebrow">DISCOVER</p>
        <h2>直感で選ぶ、京都のよりみち</h2>
        <p>右にスワイプで詳細を表示、左でスキップ。</p>
      </div>

      <div className="discover-stack">
        <AnimatePresence custom={exitDirection}>
          {stack
            .map((route, depth) => ({ route, depth }))
            .reverse()
            .map(({ route, depth }) => (
              <DiscoverCard
                key={route.id}
                route={route}
                depth={depth}
                exitDirection={exitDirection}
                onSwipe={swipe}
              />
            ))}
        </AnimatePresence>
        {stack.length === 0 && (
          <div className="discover-empty">
            <strong>すべてのルートを見ました</strong>
            <button type="button" className="regenerate-button" onClick={() => setIndex(0)}>最初から見直す ↻</button>
          </div>
        )}
      </div>

      <div className="discover-actions">
        <button type="button" className="discover-action pass" onClick={() => swipe("pass")} disabled={stack.length === 0} aria-label="スキップ">✕</button>
        <span className="discover-progress">{Math.min(index + 1, routes.length)} / {routes.length}</span>
        <button type="button" className="discover-action like" onClick={() => swipe("like")} disabled={stack.length === 0} aria-label="行きたい">♡</button>
      </div>

      {selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
