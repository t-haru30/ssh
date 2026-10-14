import { useEffect, useState } from "react";
import { SavedRoutesList } from "./SavedRoutesList";
import { DiscoverMode } from "./discover/DiscoverMode";
import { SearchMode } from "./SearchMode";
import type { SearchPreset } from "./SearchMode";
import { routeSelection } from "./routeSelection";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Onboarding, markOnboardingSeen } from "./Onboarding";
import { useFavorites } from "./useFavorites";
import { readJourneyDraft } from "./journeyDraft";
import { TripDialog } from "./DayTripEditor";

type AppTab = "discover" | "search";
const ACTIVE_TAB_STORAGE_KEY = "kyoto-route-planner:active-tab:v1";

const tabs: { id: AppTab; label: string; caption: string }[] = [
  { id: "discover", label: "見つける", caption: "気分から旅を探す" },
  { id: "search", label: "旅程を編集", caption: "選んだ旅を自分らしく" },
];

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    try { const saved = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY); if (saved === "search" || saved === "discover") return saved; } catch { /* Storage can be disabled. */ }
    return readJourneyDraft() ? "search" : "discover";
  });
  const [homeRequest, setHomeRequest] = useState(0);
  const [searchPreset, setSearchPreset] = useState<SearchPreset | null>(null);
  const [pendingPreset, setPendingPreset] = useState<{ selection: SearchPreset; currentTitle: string } | null>(null);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const { favorites, error } = useFavorites();

  useEffect(() => { try { localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab); } catch { /* Keep the app usable without storage. */ } }, [activeTab]);

  function closeOnboarding() {
    markOnboardingSeen();
    setShowOnboarding(false);
  }
  function planInSearch(route: Parameters<typeof routeSelection>[0], searchTransport = false) {
    const routeIds = "spots" in route ? route.spots.map(spot => spot.place_id) : route.places.map(place => place.id);
    // Replacement keeps the original favourite ID even when the title or stops
    // change. Resolve that ID before opening a stale card from the liked list.
    const source = favorites.find(item => ("id" in route && item.id === route.id)
      || item.id === `${item.prefecture_code}:${routeIds.slice().sort().join("|")}`
      || (item.title === route.title && item.places.length === routeIds.length && item.places.every(place => routeIds.includes(place.id))));
    const selection = routeSelection(source?.edited ? source : route, true);
    selection.autoSearch = searchTransport;
    selection.sourceFavoriteId = source?.id;
    const current = readJourneyDraft();
    const samePlaces = !selection.tripPlan && !selection.overnightSnapshot && current
      && current.plan.origin.latitude === selection.origin.latitude && current.plan.origin.longitude === selection.origin.longitude
      && current.plan.stops.length === selection.places.length
      && current.plan.stops.every((stop, index) => stop.place.id === selection.places[index].id
        && stop.place.latitude === selection.places[index].latitude && stop.place.longitude === selection.places[index].longitude);
    if (current && !samePlaces) { setPendingPreset({ selection, currentTitle: current.title }); return; }
    openPlanner(samePlaces && !searchTransport ? null : selection);
  }
  function openPlanner(selection: SearchPreset | null) {
    if (selection) setSearchPreset(selection);
    setActiveTab("search");
    setShowFavorites(false);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => { setActiveTab("discover"); setShowFavorites(false); setHomeRequest(value => value + 1); window.scrollTo?.({ top: 0 }); }} aria-label="ConcierGO ホーム">
          <span className="brand-mark" aria-hidden="true">C<span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 19 19 5M5 5h14v14" /></svg></span></span>
          <span>ConcierGO<span className="brand-light"> 小さな旅のしおり</span></span>
        </button>
        <div className="topbar-tools">
          <button
            className="favorites-open-button"
            type="button"
            onClick={() => setShowFavorites(true)}
            aria-haspopup="dialog"
          >
            ♥ 保存済み <span>{favorites.length}</span>
          </button>
          <button type="button" className="help-button" onClick={() => setShowOnboarding(true)} aria-label="使い方を見る">?</button>
          <ThemeSwitcher />
        </div>
      </header>
      {error && <p className="favorites-global-error" role="alert">保存機能: {error}</p>}

      <div className="mode-tabs" role="tablist" aria-label="表示モード">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "discover" : event.key === "End" ? "search" : activeTab === "discover" ? "search" : "discover";
              setActiveTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            {tab.label}<small>{tab.caption}</small>
          </button>
        ))}
      </div>

      <DiscoverMode
        homeRequest={homeRequest}
        active={activeTab === "discover"}
        onPlanInSearch={planInSearch}
      />
      <SearchMode active={activeTab === "search"} preset={searchPreset} editingOnly onDiscover={() => setActiveTab("discover")} />
      {showFavorites && <SavedRoutesList onClose={() => setShowFavorites(false)} onPlanInSearch={planInSearch} onGoHome={() => { setShowFavorites(false); setActiveTab("discover"); }} />}
      {showOnboarding && <Onboarding onClose={closeOnboarding} />}
      {pendingPreset && <TripDialog title="編集中のしおりを置き換えますか？" onClose={() => setPendingPreset(null)}>
        <p>新しいルートを選ぶと、このブラウザの下書きが置き換わります。残しておきたい予定は、先に「しおりを見る」からコピーできます。</p>
        <dl className="trip-comparison"><div><dt>現在の旅</dt><dd>{pendingPreset.currentTitle}</dd></div><div><dt>新しい旅</dt><dd>{pendingPreset.selection.title}</dd></div></dl>
        <div className="trip-dialog-actions"><button type="button" className="trip-primary" onClick={() => { openPlanner(pendingPreset.selection); setPendingPreset(null); }}>新しいルートで編集する</button><button type="button" onClick={() => setPendingPreset(null)}>今の下書きを残す</button></div>
      </TripDialog>}

      <footer className="footer">
        <p className="footer-signature">ConcierGO <span>まだ知らない一日へ。</span></p>
        <div className="mobile-preferences"><ThemeSwitcher /></div>
        <p>旅程と費用は目安です。お出かけ前に、営業時間・料金・運行情報をご確認ください。</p>
        <p>旅の候補：<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · <a href="https://openpoiapi.com/attribution.html" target="_blank" rel="noreferrer">OpenPOI API</a> · <a href="/data-sources.html">データの出典・ダウンロード</a></p>
        <details><summary>地図と情報について</summary>
          <p>経路検索：駅すぱあと · 地図・施設紹介：Google Maps。写真や施設検索の出典は、それぞれの表示で確認できます。</p>
          <p>直線は訪問順、徒歩経路は道路の参考表示です。電車・バスの乗換経路は区間ごとのリンクから確認できます。</p>
          <p>編集中の旅程と保存済みルートは、このブラウザに保存されます。</p>
        </details>
      </footer>
    </main>
  );
}

export default App;
