import { useState } from "react";
import { FavoriteRoutesPanel } from "./FavoriteRoutesPanel";
import { DiscoverMode } from "./discover/DiscoverMode";
import { SearchMode } from "./SearchMode";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useFavorites } from "./useFavorites";

type AppTab = "discover" | "search";

const tabs: { id: AppTab; label: string; caption: string }[] = [
  { id: "discover", label: "Discover", caption: "発見" },
  { id: "search", label: "Search", caption: "検索" },
];

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("discover");
  const [showFavorites, setShowFavorites] = useState(false);
  const { favorites, error } = useFavorites();

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="京都よりみちルート ホーム">
          <span className="brand-mark">寄</span>
          <span>よりみち<span className="brand-light"> / KYOTO</span></span>
        </a>
        <div className="topbar-tools">
          <button
            className="favorites-open-button"
            type="button"
            onClick={() => setShowFavorites(true)}
            aria-haspopup="dialog"
          >
            保存済み <span>{favorites.length}</span>
          </button>
          <span className="sample-label"><span /> 駅すぱあと経路検索</span>
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
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}<small>{tab.caption}</small>
          </button>
        ))}
      </div>

      <DiscoverMode active={activeTab === "discover"} />
      <SearchMode active={activeTab === "search"} />
      {showFavorites && <FavoriteRoutesPanel onClose={() => setShowFavorites(false)} />}

      <footer className="footer">
        <p>POI：Yahoo! JAPAN API　·　地図：MapLibre / OpenFreeMap · © OpenStreetMap contributors</p>
        <p>検索の候補地取得にはYahoo! Local Searchを利用します。DiscoverとSearchの事前サンプルモードは候補生成の外部APIを使いません（採用後の経路検索を除く）。</p>
        <p>スポットの順番は近接性による候補です。実際の徒歩道順・営業状況は各施設の公式情報をご確認ください。</p>
      </footer>
    </main>
  );
}

export default App;
