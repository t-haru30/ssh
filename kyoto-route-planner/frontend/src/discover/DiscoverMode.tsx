import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { RouteIdea } from "../SwipeCard";
import { usePrefecture } from "../PrefectureContext";
import type { PrefectureCode } from "../PrefectureContext";
import { favoriteId, useFavorites } from "../useFavorites";
import { routeSelection } from "../routeSelection";
import { DiscoverCard, formatMinutes } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute, RouteDataset, RouteDatasetIndex } from "./datasetTypes";
import prefectureIndex from "../data/routes/index.json";
import "./discover.css";

const datasets = import.meta.glob(["../data/routes/*.json", "!../data/routes/index.json"], { eager: true, import: "default" }) as Record<string, RouteDataset>;
const indexEntries = [...(prefectureIndex as RouteDatasetIndex).prefectures].sort((a, b) => a.prefecture_code.localeCompare(b.prefecture_code));
const datasetsByArea = new Map(Object.values(datasets).filter(value => "area" in value && Array.isArray(value.routes)).map(value => [value.area, value]));
const themes = [
  { id: "all", label: "おまかせ", icon: "✦" }, { id: "history", label: "歴史・街歩き", icon: "◷" },
  { id: "temple", label: "寺社めぐり", icon: "⛩" }, { id: "nature", label: "自然・景色", icon: "❋" }, { id: "food", label: "グルメ", icon: "♨" },
] as const;
type ThemeFilter = (typeof themes)[number]["id"];
type BrowseState = { index: number; history: Array<string | null> };
const EMPTY_BROWSE: BrowseState = { index: 0, history: [] };
const destinations = [
  { area: "kyoto", caption: "古都の風景に出会う", mark: "京" }, { area: "hokkaido", caption: "北の街を歩く", mark: "北" },
  { area: "nagano", caption: "山のある街へ", mark: "山" }, { area: "okinawa", caption: "南の島によりみち", mark: "島" },
];
type DiscoverModeProps = { active: boolean; onPlanInSearch?: (route: DatasetRoute | RouteIdea) => void };

export function DiscoverMode({ active, onPlanInSearch }: DiscoverModeProps) {
  const { prefecture, setPrefectureCode } = usePrefecture();
  const { saveFavorite, removeFavorite, isFavorite } = useFavorites();
  const [area, setArea] = useState(() => indexEntries.find(entry => entry.prefecture_code === prefecture.code)?.id ?? "kyoto");
  const [theme, setTheme] = useState<ThemeFilter>("all");
  const [pattern, setPattern] = useState<"all" | "half_day" | "full_day">("all");
  // Each collection keeps its position across filter changes and tab navigation.
  const [collections, setCollections] = useState<Record<string, BrowseState>>({});
  const [exitDirection, setExitDirection] = useState<DiscoverDirection>("pass");
  const [selected, setSelected] = useState<DatasetRoute | RouteIdea | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const allRoutes = datasetsByArea.get(area)?.routes ?? [];
  const routes = useMemo(() => allRoutes.filter(route => (theme === "all" || route.theme === theme) && (pattern === "all" || route.course === pattern)), [allRoutes, theme, pattern]);
  const collectionKey = `${area}:${theme}:${pattern}`;
  const { index, history } = collections[collectionKey] ?? EMPTY_BROWSE;
  const stack = routes.slice(index, index + 3);
  const areaName = indexEntries.find(entry => entry.id === area)?.name ?? area;

  function chooseArea(nextArea: string) {
    setArea(nextArea); setNotice(null);
    const entry = indexEntries.find(candidate => candidate.id === nextArea);
    if (entry) setPrefectureCode(entry.prefecture_code as PrefectureCode);
  }
  function updateCollection(next: BrowseState) { setCollections(current => ({ ...current, [collectionKey]: next })); }
  function undo() {
    if (!history.length) return;
    const savedId = history[history.length - 1];
    if (savedId && !removeFavorite(savedId)) { setNotice("保存の取り消しができませんでした。もう一度お試しください。"); return; }
    updateCollection({ index: Math.max(0, index - 1), history: history.slice(0, -1) });
    setExitDirection("pass"); setSelected(null); setNotice(null);
  }
  function swipe(direction: DiscoverDirection) {
    const current = routes[index];
    if (!current) return;
    let savedId: string | null = null;
    if (direction === "like") {
      const entry = indexEntries.find(candidate => candidate.id === current.area);
      const selection = routeSelection(current);
      const idea: RouteIdea = {
        theme: current.theme, prefecture_code: entry?.prefecture_code ?? prefecture.code, prefecture_name: entry?.name ?? prefecture.name,
        title: current.title, story: `${current.spots.length}か所を巡る、約${formatMinutes(current.estimated_minutes)}のよりみち。`,
        places: selection.places, origin: selection.origin, dwell_minutes: selection.dwellMinutes,
        image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
        copywriting_source: "fallback", note: "地図データに基づく旅の候補",
      };
      const alreadySaved = isFavorite(idea);
      if (!alreadySaved && !saveFavorite(idea)) { setNotice("保存できませんでした。画面上部の保存機能の案内をご確認ください。"); return; }
      if (!alreadySaved) savedId = favoriteId(idea, idea.prefecture_code ?? prefecture.code);
      setNotice(alreadySaved ? "♥ すでに保存済みです" : "♥ 保存しました。保存済みからいつでも見返せます。");
      setSelected(current);
    } else setNotice("スキップしました");
    setExitDirection(direction);
    updateCollection({ index: index + 1, history: [...history, savedId] });
  }

  return <div className="tab-panel discover-mode" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
    <section className="discover-hero" aria-labelledby="discover-title">
      <div className="discover-hero-copy"><p className="eyebrow">A LITTLE DETOUR, A NEW DISCOVERY</p><h1 id="discover-title">次の休日、<br />心が向くほうへ。</h1><p>行きたい街と、いまの気分から。<br />あなたに似合う、よりみちを見つけよう。</p><span className="discover-hero-note">47都道府県から探す、小さな旅のきっかけ</span></div>
      <div className="discover-hero-art" aria-hidden="true"><img src="/images/yorimichi-journey.webp" alt="" /><span className="discover-art-image-caption">いつもの日常から、少し遠くへ。</span></div>
    </section>
    <section className="discover-destinations" aria-label="おすすめの行き先">
      <div className="discover-destination-heading"><span className="eyebrow">WHERE TO NEXT?</span><h2>気になる街から</h2></div>
      <div className="discover-destination-list">{destinations.map(destination => {
        const entry = indexEntries.find(item => item.id === destination.area);
        return <button key={destination.area} type="button" className={`discover-destination destination-${destination.area}`} aria-pressed={area === destination.area} onClick={() => chooseArea(destination.area)}><span className="discover-destination-mark" aria-hidden="true">{destination.mark}</span><span><strong>{entry?.name}</strong><small>{destination.caption}</small></span><span aria-hidden="true">↗</span></button>;
      })}</div>
    </section>
    <section className="discover-workspace" aria-label="旅の候補を探す">
      <aside className="discover-filters"><p className="eyebrow">MAKE IT YOURS</p><h2>どんな旅にしよう？</h2>
        <label className="prefecture-picker">都道府県<select value={area} onChange={event => chooseArea(event.target.value)}>{indexEntries.filter(entry => datasetsByArea.has(entry.id)).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <fieldset className="discover-filter-group"><legend>いまの気分</legend><div className="discover-theme-options">{themes.map(item => <button type="button" key={item.id} aria-pressed={theme === item.id} onClick={() => { setTheme(item.id); setNotice(null); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</div></fieldset>
        <fieldset className="discover-filter-group"><legend>使える時間</legend><div className="discover-duration-options">{([{ id: "all", label: "指定なし" }, { id: "half_day", label: "半日" }, { id: "full_day", label: "1日" }] as const).map(item => <button key={item.id} type="button" aria-pressed={pattern === item.id} onClick={() => { setPattern(item.id); setNotice(null); }}>{item.label}</button>)}</div></fieldset>
        <div className="discover-howto"><span aria-hidden="true">♡</span><strong>ひらめきを、旅のしおりに。</strong><p>気になるルートを保存したら、出発地や滞在時間を調整して、自分だけの旅に。</p></div>
      </aside>
      <div className="discover-results"><header className="discover-results-heading"><div><p className="eyebrow">YOUR DISCOVERIES</p><h2>{areaName}のよりみち</h2></div><span className="discover-result-count">{routes.length}件の候補</span></header>
        <p className="discover-fallback-status" role="status">{theme === "all" ? "すべての気分" : themes.find(item => item.id === theme)?.label} · {pattern === "all" ? "時間の指定なし" : pattern === "half_day" ? "半日コース" : "1日コース"}</p>
        <div className="discover-stack"><AnimatePresence custom={exitDirection}>{stack.map((route, depth) => ({ route, depth })).reverse().map(({ route, depth }) => <DiscoverCard key={route.id} route={route} depth={depth} exitDirection={exitDirection} onSwipe={swipe} />)}</AnimatePresence>
          {routes.length === 0 && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">⌁</span><strong>この条件の候補は、まだありません</strong><p>気分や時間を変えると、新しいよりみちが見つかるかも。</p><button type="button" className="idea-primary-button" onClick={() => { setTheme("all"); setPattern("all"); }}>すべての候補を見る</button></div>}
          {routes.length > 0 && !stack.length && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">✦</span><strong>すべてのルートを見ました</strong><p>お気に入りの旅は「保存済み」から見返せます。</p><button type="button" className="idea-primary-button" onClick={() => { updateCollection(EMPTY_BROWSE); setNotice(null); }}>最初から見直す ↻</button></div>}
        </div>
        <div className="discover-actions"><button type="button" className="discover-action undo" onClick={undo} disabled={!history.length} aria-label="1つ前に戻す">↶</button><button type="button" className="discover-action pass" onClick={() => swipe("pass")} disabled={!stack.length} aria-label="スキップ"><span aria-hidden="true">↗</span>次の候補</button><button type="button" className="discover-action like" onClick={() => swipe("like")} disabled={!stack.length} aria-label="しおりを開く"><span aria-hidden="true">♡</span>保存して詳細を見る</button></div>
        <div className="discover-deck-meta"><span className="discover-progress">{Math.min(index + 1, routes.length)} / {routes.length}</span>{stack[0] && <button type="button" onClick={() => setSelected(stack[0])}>保存せずに詳細を見る →</button>}</div>
        {notice && <div className="discover-toast" role="status"><span>{notice}</span>{history.length > 0 && <button type="button" onClick={undo}>元に戻す</button>}</div>}
        <p className="discover-data-note">地図上のスポットをもとにした旅の候補です。営業時間や実際の移動経路は、計画を作るときに確認できます。</p>
      </div>
    </section>
    {active && selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} onPlanInSearch={onPlanInSearch && (route => { setSelected(null); onPlanInSearch(route); })} />}
  </div>;
}
