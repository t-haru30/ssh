import { useState } from "react";
import { DiscoverMode } from "./discover/DiscoverMode";
import { SearchMode } from "./SearchMode";
import { ThemeSwitcher } from "./ThemeSwitcher";

type AppTab = "discover" | "search";

const tabs: { id: AppTab; label: string; caption: string }[] = [
  { id: "discover", label: "Discover", caption: "発見" },
  { id: "search", label: "Search", caption: "検索" },
];

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("discover");

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="京都よりみちルート ホーム">
          <span className="brand-mark">寄</span>
          <span>よりみち<span className="brand-light"> / KYOTO</span></span>
        </a>
        <div className="topbar-tools">
          <span className="sample-label"><span /> 駅すぱあと経路検索</span>
          <ThemeSwitcher />
        </div>
      </header>

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

      {/* 両方マウントしたまま hidden で切り替え、MapLibreを作り直さない */}
      <DiscoverMode active={activeTab === "discover"} />
      <SearchMode active={activeTab === "search"} />

      <footer className="footer">
        <p>POI：Yahoo! JAPAN API　·　地図：MapLibre / OpenFreeMap · © OpenStreetMap contributors</p>
        <p>観光地・施設の検索にはYahoo! Local Searchのみを利用します。APIエラーや候補不足時は、代替データを混在させず取得状況を表示します。</p>
        <p>スポットの順番は近接性による候補です。実際の徒歩道順・営業状況は各施設の公式情報をご確認ください。</p>
      </footer>
    </main>
  );
}

export default App;
