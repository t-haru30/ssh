import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { RouteIdea } from "../SwipeCard";
import { usePrefecture } from "../PrefectureContext";
import type { PrefectureCode } from "../PrefectureContext";
import { favoriteId, useFavorites } from "../useFavorites";
import { routeSelection } from "../routeSelection";
import { DiscoverCard, formatMinutes } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute, RouteDatasetIndex } from "./datasetTypes";
import { localOrigins } from "../localPlaces";
import prefectureIndex from "../data/routes/index.json";
import "./discover.css";
import { TravelRangeControl } from "../TravelRangeControl";
import { composeLocalRoutes, isDiscoverResponse } from "./dynamicRoutes";
import { ProgressStatus, ROUTE_STEPS } from "../ProgressStatus";

const indexEntries = [...(prefectureIndex as RouteDatasetIndex).prefectures].sort((a, b) => a.prefecture_code.localeCompare(b.prefecture_code));
const themes = [
  { id: "all", label: "おまかせ", icon: "✦" }, { id: "history", label: "歴史・街歩き", icon: "◷" },
  { id: "temple", label: "寺社めぐり", icon: "⛩" }, { id: "nature", label: "自然・景色", icon: "❋" }, { id: "food", label: "グルメ", icon: "♨" },
] as const;
type ThemeFilter = (typeof themes)[number]["id"];
type BrowseState = { index: number; history: Array<{ savedId: string | null; liked: boolean }> };
const EMPTY_BROWSE: BrowseState = { index: 0, history: [] };
const destinations = [
  { area: "kyoto", caption: "古都の風景に出会う", mark: "京" }, { area: "hokkaido", caption: "北の街を歩く", mark: "北" },
  { area: "nagano", caption: "山のある街へ", mark: "山" }, { area: "okinawa", caption: "南の島で過ごす休日", mark: "島" },
];
type DiscoverModeProps = { active: boolean; onPlanInSearch?: (route: DatasetRoute | RouteIdea, searchTransport?: boolean) => void };

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
  const [radius, setRadius] = useState(30);
  const [crossPrefecture, setCrossPrefecture] = useState(true);
  const [variation, setVariation] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [remote, setRemote] = useState<{ key: string; routes: DatasetRoute[]; note: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const filtersRef = useRef<HTMLElement>(null);
  const entry = indexEntries.find(item => item.id === area)!;
  const origin = useMemo(() => localOrigins[area] ?? ({ name: `${entry.name}・エリア中心`, latitude: entry.center[0], longitude: entry.center[1] }), [entry, area]);
  const conditionsKey = `${area}:${theme}:${pattern}:${radius}:${crossPrefecture}:${variation}`;
  const localRoutes = useMemo(() => composeLocalRoutes({ entry, origin, theme, course: pattern, radius, crossPrefecture, variation }), [entry, origin, theme, pattern, radius, crossPrefecture, variation]);
  const routes = remote?.key === conditionsKey ? remote.routes : localRoutes;
  const collectionKey = `${conditionsKey}:${remote?.key === conditionsKey ? "api" : "local"}`;
  useEffect(() => { requestRef.current?.abort(); requestRef.current = null; setGenerating(false); setSelected(null); setNotice(null); }, [conditionsKey]);
  useEffect(() => () => requestRef.current?.abort(), []);
  async function generate() {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setGenerating(true); setNotice(null);
    try {
      const response = await fetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ area, prefecture_name: entry.name, origin, theme, course: pattern, radius_km: radius, cross_prefecture: crossPrefecture, variation, count: 12 }) });
      if (!response.ok) throw new Error("候補を取得できませんでした。");
      const data: unknown = await response.json();
      if (!isDiscoverResponse(data)) throw new Error("候補データの形式が正しくありません。");
      if (!controller.signal.aborted && requestRef.current === controller) { setRemote({ key: conditionsKey, ...data }); updateCollection(EMPTY_BROWSE); }
    } catch {
      if (requestRef.current === controller) setNotice("同梱の施設候補から作成したルートを表示しています。サーバーからの取得は再試行できます。");
    } finally { window.clearTimeout(timer); if (requestRef.current === controller) setGenerating(false); }
  }
  const { index, history } = collections[collectionKey] ?? EMPTY_BROWSE;
  const stack = routes.slice(index, index + 3);
  const areaName = indexEntries.find(entry => entry.id === area)?.name ?? area;

  function chooseArea(nextArea: string) {
    setArea(nextArea); setSelected(null); setNotice(null);
    const entry = indexEntries.find(candidate => candidate.id === nextArea);
    if (entry) setPrefectureCode(entry.prefecture_code as PrefectureCode);
  }
  function updateCollection(next: BrowseState) { setCollections(current => ({ ...current, [collectionKey]: next })); }
  function undo() {
    if (!history.length) return;
    const savedId = history[history.length - 1].savedId;
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
        title: current.title, story: `${current.spots.length}か所を巡る、約${formatMinutes(current.estimated_minutes)}の旅のプラン。`,
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
    updateCollection({ index: index + 1, history: [...history, { savedId, liked: direction === "like" }] });
  }

  return <div className="tab-panel discover-mode" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
    <section className="discover-hero" aria-labelledby="discover-title">
      <div className="discover-hero-copy"><p className="eyebrow">A LITTLE DETOUR, A NEW DISCOVERY</p><h1 id="discover-title">次の休日、<br />心が向くほうへ。</h1><p>行き先選びから、時間と予算の調整まで。<br />あなただけの旅を、一冊のしおりに。</p><button type="button" className="discover-hero-action" onClick={() => { resultsRef.current?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); resultsHeadingRef.current?.focus({ preventScroll: true }); }}>旅の候補を見る <span aria-hidden="true">↓</span></button><span className="discover-hero-note">47都道府県に対応 · 施設の公式情報はAIが検索をお手伝い</span></div>
      <div className="discover-hero-art" aria-hidden="true"><img src="/images/yorimichi-journey.webp" alt="" /><span className="discover-art-image-caption">いつもの日常から、少し遠くへ。</span></div>
    </section>
    <section className="discover-destinations" aria-label="おすすめの行き先">
      <div className="discover-destination-heading"><span className="eyebrow">WHERE TO NEXT?</span><h2>気になる街から</h2></div>
      <div className="discover-destination-list">{destinations.map(destination => {
        const entry = indexEntries.find(item => item.id === destination.area);
        return <button key={destination.area} type="button" className={`discover-destination destination-${destination.area}`} aria-pressed={area === destination.area} onClick={() => chooseArea(destination.area)}><span className="discover-destination-mark" aria-hidden="true">{destination.mark}</span><span><strong>{entry?.name}</strong><small>{destination.caption}</small></span><span aria-hidden="true">↗</span></button>;
      })}</div>
    </section>
    <ol className="journey-flow" aria-label="旅づくりの流れ"><li><span>01</span><div><strong>気になる旅を見つける</strong><small>街と気分から、行き先の候補を。</small></div></li><li><span>02</span><div><strong>自分の予定に整える</strong><small>時間・予算に合わせて、自由に編集。</small></div></li><li><span>03</span><div><strong>確認して、出かける</strong><small>交通・公式情報を確認し、しおりを保存。</small></div></li></ol>
    <section className="discover-workspace" aria-label="旅の候補を探す">
      <aside className="discover-filters" ref={filtersRef} tabIndex={-1}><p className="eyebrow">MAKE IT YOURS</p><h2>どんな旅にしよう？</h2>
        <label className="prefecture-picker">都道府県<select value={area} onChange={event => chooseArea(event.target.value)}>{indexEntries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <fieldset className="discover-filter-group"><legend>いまの気分</legend><div className="discover-theme-options">{themes.map(item => <button type="button" key={item.id} aria-pressed={theme === item.id} onClick={() => { setTheme(item.id); setNotice(null); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</div></fieldset>
        <fieldset className="discover-filter-group"><legend>使える時間</legend><div className="discover-duration-options">{([{ id: "all", label: "指定なし" }, { id: "half_day", label: "半日" }, { id: "full_day", label: "1日" }] as const).map(item => <button key={item.id} type="button" aria-pressed={pattern === item.id} onClick={() => { setPattern(item.id); setNotice(null); }}>{item.label}</button>)}</div></fieldset>
        <fieldset className="discover-filter-group discover-range"><legend>移動範囲</legend>
          <TravelRangeControl value={radius} onChange={setRadius} />
          <label className="range-checkbox"><input type="checkbox" checked={crossPrefecture} onChange={event => setCrossPrefecture(event.target.checked)} />県をまたぐ候補も含める</label>
          <small>{origin.name}を中心に、指定した範囲内で探します。</small>
        </fieldset>
        <button type="button" className="idea-primary-button discover-generate" onClick={() => void generate()} disabled={generating}>経路を見つける <span aria-hidden="true">↗</span></button>
        <button type="button" className="discover-refresh" onClick={() => setVariation(v => v + 1)} disabled={generating}>別の組み合わせを見る ↻</button>
        <div className="discover-howto"><span aria-hidden="true">♡</span><strong>ひらめきを、旅のしおりに。</strong><p>気になるルートを保存したら、出発地や滞在時間を調整して、自分だけの旅に。</p></div>
      </aside>
      <div className="discover-results" ref={resultsRef}><header className="discover-results-heading"><div><p className="eyebrow">YOUR DISCOVERIES</p><h2 ref={resultsHeadingRef} tabIndex={-1}>{areaName}{crossPrefecture ? "周辺" : "内"}の旅のプラン</h2></div><span className="discover-result-count">{routes.length}件の候補</span></header>
        <p className="discover-fallback-status" role="status">{theme === "all" ? "すべての気分" : themes.find(item => item.id === theme)?.label} · {pattern === "all" ? "時間の指定なし" : pattern === "half_day" ? "半日コース" : "1日コース"}</p>
        <div className="discover-conditions-summary"><span>{origin.name}発 · 半径{radius}km</span><button type="button" onClick={() => { filtersRef.current?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); filtersRef.current?.focus({ preventScroll: true }); }}>条件を変更 <span aria-hidden="true">↑</span></button></div>
        {generating && <ProgressStatus title="あなたの旅を組み立てています" steps={ROUTE_STEPS} onCancel={() => { requestRef.current?.abort(); requestRef.current = null; setGenerating(false); }} />}
        <div className="discover-stack" aria-busy={generating}><AnimatePresence custom={exitDirection}>{stack.map((route, depth) => ({ route, depth })).reverse().map(({ route, depth }) => <DiscoverCard key={route.id} route={route} depth={depth} active={active && !generating} exitDirection={exitDirection} onSwipe={swipe} />)}</AnimatePresence>
          {routes.length === 0 && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">⌁</span><strong>この条件の候補は、まだありません</strong><p>気分や時間を変えると、新しいConcierGOが見つかるかも。</p><button type="button" className="idea-primary-button" onClick={() => { setTheme("all"); setPattern("all"); }}>すべての候補を見る</button></div>}
          {routes.length > 0 && !stack.length && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">✦</span><strong>すべてのルートを見ました</strong><p>お気に入りの旅は「保存済み」から見返せます。</p><button type="button" className="idea-primary-button" onClick={() => { updateCollection(EMPTY_BROWSE); setNotice(null); }}>最初から見直す ↻</button></div>}
        </div>
        <div className="discover-actions"><button type="button" className="discover-action undo" onClick={undo} disabled={!history.length} aria-label="1つ前に戻す">↶</button><button type="button" className="discover-action pass" onClick={() => swipe("pass")} disabled={!stack.length} aria-label="スキップ"><span aria-hidden="true">↗</span>次の候補</button><button type="button" className="discover-action like" onClick={() => swipe("like")} disabled={!stack.length} aria-label="しおりを開く"><span aria-hidden="true">♡</span>保存して詳細を見る</button></div>
        <div className="discover-deck-meta"><span className="discover-progress">{Math.min(index + 1, routes.length)} / {routes.length}</span>{stack[0] && <button type="button" onClick={() => setSelected(stack[0])}>保存せずに詳細を見る →</button>}</div>
        {notice && <div className="discover-toast" role="status"><span>{notice}</span>{history.length > 0 && <button type="button" onClick={undo}>元に戻す</button>}</div>}
        <details className="discover-data-note"><summary>移動時間・提案の範囲について</summary><p>{remote?.key === conditionsKey ? remote.note : `施設候補から条件に合わせて作成しました。半径${radius}km以内で検索範囲を自動調整します。候補が少ない場合はスポット数を減らします。移動時間は推定です。`}</p></details>
        {onPlanInSearch && <button type="button" className="idea-primary-button discover-plan-button" disabled={generating || !routes.length} onClick={() => { const likedIndex = history.map(item => item.liked).lastIndexOf(true); const route = selected ?? (likedIndex >= 0 ? routes[likedIndex] : stack[0]) ?? routes[0]; if (route) { setSelected(null); onPlanInSearch(route, true); } }}>この条件で乗換つきの経路を作る <span aria-hidden="true">→</span></button>}
      </div>
    </section>
    {active && selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} onPlanInSearch={onPlanInSearch && (route => { setSelected(null); onPlanInSearch(route); })} />}
  </div>;
}
