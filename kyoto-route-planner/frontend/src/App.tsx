import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MapView } from "./MapView";
import type { Origin, Place, RouteLeg, RouteSuggestion, RouteSuggestions, RouteSuggestionRequest, Theme } from "./types";

const themes: { id: Theme; label: string; icon: string }[] = [
  { id: "all", label: "おまかせ", icon: "✳" },
  { id: "history", label: "歴史・文化", icon: "◈" },
  { id: "temple", label: "神社・寺院", icon: "⛩" },
  { id: "nature", label: "自然・景色", icon: "❋" },
  { id: "food", label: "食・商店街", icon: "◉" },
];

function localDateInputValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function formatDuration(minutes: number | null) {
  if (minutes === null) return "時間情報なし";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}時間${remainder}分` : `${remainder}分`;
}

function modeLabel(mode: string) {
  if (mode.toLowerCase().includes("train")) return "電車";
  if (mode.toLowerCase().includes("bus")) return "バス";
  if (mode.toLowerCase().includes("walk")) return "徒歩";
  return "乗換・移動";
}

const REQUEST_TIMEOUT_MS = 60_000;
const INITIAL_DATA_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const timeout = new AbortController();
  const combined = new AbortController();
  const timeoutId = window.setTimeout(() => timeout.abort(), timeoutMs);
  const abortCombined = () => combined.abort();
  timeout.signal.addEventListener("abort", abortCombined, { once: true });
  init.signal?.addEventListener("abort", abortCombined, { once: true });
  if (timeout.signal.aborted || init.signal?.aborted) {
    combined.abort();
  }
  try {
    return await fetch(input, { ...init, signal: combined.signal });
  } finally {
    window.clearTimeout(timeoutId);
    timeout.signal.removeEventListener("abort", abortCombined);
    init.signal?.removeEventListener("abort", abortCombined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlace(value: unknown): value is Place {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.category === "string"
    && typeof value.description === "string"
    && typeof value.latitude === "number"
    && typeof value.longitude === "number"
  );
}

function isOrigin(value: unknown): value is Origin {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && typeof value.latitude === "number"
    && typeof value.longitude === "number"
  );
}

function isRouteLeg(value: unknown): value is RouteLeg {
  return (
    isRecord(value)
    && typeof value.from_name === "string"
    && typeof value.to_name === "string"
    && typeof value.line_name === "string"
    && typeof value.mode === "string"
  );
}

function isRouteSuggestions(value: unknown): value is RouteSuggestions {
  if (!isRecord(value) || !Array.isArray(value.routes) || value.routes.length === 0) {
    return false;
  }
  return value.routes.every((route) => (
    isRecord(route)
    && Array.isArray(route.places)
    && route.places.length > 0
    && route.places.every(isPlace)
    && Array.isArray(route.legs)
    && route.legs.every(isRouteLeg)
    && isOrigin(route.origin)
    && (route.title === null || typeof route.title === "string")
    && (route.story === null || typeof route.story === "string")
    && typeof route.note === "string"
  ));
}

async function readError(response: Response) {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "detail" in payload && typeof payload.detail === "string") {
      return payload.detail;
    }
  } catch {
    // The response may not contain JSON when the API server is unavailable.
  }
  return "ルートを取得できませんでした。APIサーバーの状態を確認してください。";
}

function App() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [originName, setOriginName] = useState("京都駅");
  const [theme, setTheme] = useState<Theme>("all");
  const [stopCount, setStopCount] = useState(3);
  const [departureDate, setDepartureDate] = useState(localDateInputValue);
  const [departureTime, setDepartureTime] = useState("09:00");
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeSourceWarning, setPlaceSourceWarning] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    async function loadInitialData() {
      try {
        const [placesResponse, originsResponse] = await Promise.all([
          fetchWithTimeout("/api/places", {}, INITIAL_DATA_TIMEOUT_MS),
          fetchWithTimeout("/api/origins", {}, INITIAL_DATA_TIMEOUT_MS),
        ]);
        if (!placesResponse.ok) {
          throw new Error(await readError(placesResponse));
        }
        if (!originsResponse.ok) {
          throw new Error("アプリの候補地を読み込めませんでした。APIサーバーを確認してください。");
        }
        const [placePayload, originPayload] = await Promise.all([
          placesResponse.json() as Promise<unknown>,
          originsResponse.json() as Promise<unknown>,
        ]);
        if (
          !Array.isArray(placePayload)
          || !Array.isArray(originPayload)
          || !placePayload.every(isPlace)
          || !originPayload.every(isOrigin)
        ) {
          throw new Error("候補地または出発駅のデータ形式が不正です。");
        }
        const placeData = placePayload as Place[];
        const originData = originPayload as Origin[];
        const statusResponse = await fetchWithTimeout(
          "/api/places/status",
          {},
          INITIAL_DATA_TIMEOUT_MS,
        );
        const placeSourceStatus = statusResponse.ok
          ? await statusResponse.json() as { warning: string | null }
          : { warning: null };
        if (!placeData.length || !originData.length) {
          throw new Error("候補地または出発駅のデータがありません。");
        }
        setPlaces(placeData);
        setOrigins(originData);
        setPlaceSourceWarning(placeSourceStatus.warning);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "初期データを読み込めませんでした。");
      } finally {
        setLoading(false);
      }
    }

    void loadInitialData();
  }, []);

  const origin = useMemo(
    () => origins.find((item) => item.name === originName) ?? null,
    [originName, origins],
  );
  const mapPlaces = suggestions[0]?.places ?? places;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setError(null);
    setSuggestions([]);
    setSearching(true);

    const request: RouteSuggestionRequest = {
      origin: originName,
      theme,
      stop_count: stopCount,
      departure_date: departureDate,
      departure_time: departureTime,
    };

    try {
      const response = await fetchWithTimeout("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload: unknown = await response.json();
      if (!isRouteSuggestions(payload)) {
        throw new Error("ルートAPIから有効な候補が返されませんでした。");
      }
      if (requestId === requestIdRef.current) {
        setSuggestions(payload.routes);
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("ルート検索がタイムアウトしました。時間をおいて再度お試しください。");
      } else {
        setError(cause instanceof Error ? cause.message : "ルートを取得できませんでした。");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        activeRequestRef.current = null;
        setSearching(false);
      }
    }
  }

  async function handleRandomRoute() {
    if (searching || loading) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setError(null);
    setSuggestions([]);
    setSearching(true);

    try {
      const response = await fetchWithTimeout("/api/routes/random", {
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload: unknown = await response.json();
      if (!isRouteSuggestions(payload)) {
        throw new Error("ルートAPIから有効な候補が返されませんでした。");
      }
      if (requestId === requestIdRef.current) {
        setSuggestions(payload.routes);
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("ルート検索がタイムアウトしました。時間をおいて再度お試しください。");
      } else {
        setError(cause instanceof Error ? cause.message : "ルートを取得できませんでした。");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        activeRequestRef.current = null;
        setSearching(false);
      }
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="京都よりみちルート ホーム">
          <span className="brand-mark">寄</span>
          <span>よりみち<span className="brand-light"> / KYOTO</span></span>
        </a>
        <span className="sample-label"><span /> 駅すぱあと経路検索</span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">KYOTO · ONE DAY TRIP</p>
          <h1>京都の一日を、<br /><em>よりみち</em>から。</h1>
          <p className="hero-description">
            気分に合わせて行き先を選ぶと、駅すぱあとAPIが<br className="desktop-break" />
            公共交通のルートを検索します。
          </p>
        </div>
        <div className="hero-stamp" aria-hidden="true"><span>京</span><small>WANDER<br />WITH CARE</small></div>
      </section>

      <section className={`route-copy-banner${suggestions.length > 0 ? " visible" : ""}`} aria-live="polite">
        {suggestions[0]?.title ? (
          <>
            <p className="eyebrow">YOUR KYOTO STORY</p>
            <h2>{suggestions[0].title}</h2>
            {suggestions[0].story && <p>{suggestions[0].story}</p>}
          </>
        ) : (
          <>
            <p className="eyebrow">ONE TAP JOURNEY</p>
            <h2>今の気分で、どこかへ行く。</h2>
            <p>テーマも立ち寄り先もおまかせ。京都の寄り道をひとつ見つけます。</p>
          </>
        )}
      </section>

      <div className="content-grid">
        <section className="planner-card" aria-labelledby="planner-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR JOURNEY</p>
              <h2 id="planner-title">旅の気分を選ぶ</h2>
            </div>
            <span className="step-number">01 <i>/ 02</i></span>
          </div>

          <button className="random-button random-button-primary" type="button" onClick={() => void handleRandomRoute()} disabled={searching || loading}>
            {searching ? <><span className="button-spinner" /> おまかせルートを探しています</> : <>今の気分でどこかへ行く <span>✳</span></>}
          </button>

          <form onSubmit={handleSubmit}>
            <fieldset className="theme-picker">
              <legend>今日はどんな寄り道をしたい？</legend>
              <div className="theme-options">
                {themes.map((item) => (
                  <button
                    className={`theme-chip${theme === item.id ? " selected" : ""}`}
                    type="button"
                    key={item.id}
                    onClick={() => setTheme(item.id)}
                    disabled={searching}
                    aria-pressed={theme === item.id}
                  >
                    <span>{item.icon}</span>{item.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="form-fields">
              <label>
                <span>出発駅</span>
                <select value={originName} onChange={(event) => setOriginName(event.target.value)} disabled={loading || searching}>
                  {origins.map((item) => (
                    <option value={item.name} key={item.name}>
                      {item.name.endsWith("駅") ? item.name : `${item.name}駅`}
                    </option>
                  ))}
                </select>
                <small>スポット候補は京都駅周辺2kmから取得します。</small>
              </label>
              <label>
                <span>出発日</span>
                <input type="date" value={departureDate} onChange={(event) => setDepartureDate(event.target.value)} disabled={searching} required />
              </label>
              <label>
                <span>出発時刻</span>
                <input type="time" value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} disabled={searching} required />
              </label>
              <label>
                <span>立ち寄り先</span>
                <select value={stopCount} onChange={(event) => setStopCount(Number(event.target.value))} disabled={searching}>
                  <option value={1}>1か所</option>
                  <option value={2}>2か所</option>
                  <option value={3}>3か所</option>
                </select>
              </label>
            </div>

            <button className="submit-button" type="submit" disabled={searching || loading}>
              {searching ? <><span className="button-spinner" /> 実際の経路を検索しています</> : <>この条件でルートを提案 <span>↗</span></>}
            </button>
            <p className="form-footnote">検索ボタンまたはおまかせボタンを押した時だけ、駅すぱあとAPIに問い合わせます。</p>
          </form>

          {error && <div className="error-panel" role="alert"><strong>ルートを表示できません</strong><span>{error}</span></div>}
          {placeSourceWarning && <div className="error-panel" role="status"><strong>検索サーバーの負荷を抑えています</strong><span>{placeSourceWarning}</span></div>}
          {loading && <p className="status-message">候補地を読み込んでいます…</p>}
        </section>

        <section className="map-card" aria-label="京都の候補地マップ">
          <div className="map-heading">
            <div><p className="eyebrow">KYOTO MAP</p><h2>寄り道スポット</h2></div>
            <span className="map-count">{suggestions.length > 0 ? `${suggestions[0].places.length} SPOTS` : "KYOTO"}</span>
          </div>
          <MapView places={mapPlaces} origin={suggestions[0]?.origin ?? origin} />
          <div className="map-legend"><span className="legend-origin">出</span> 出発駅 <span className="legend-stop">1</span> 立ち寄り先</div>
        </section>
      </div>

      <section className="results-section" aria-live="polite">
        <div className="section-heading results-heading">
          <div><p className="eyebrow">ROUTE IDEA</p><h2>{suggestions.length > 0 ? "今日のよりみちルート" : "ルートの提案"}</h2></div>
          {suggestions.length > 0 && <span className="result-date">{departureDate}</span>}
        </div>

        {suggestions.length === 0 && !error && (
          <div className="empty-state">
            <span className="empty-icon">↗</span>
            <div><strong>行き先の候補と実際の経路をご提案します</strong><p>出発駅とテーマを選んで、ルートを検索してください。</p></div>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="route-options">
            {suggestions.map((suggestion, index) => (
            <article className="route-option" key={`${suggestion.places.map((place) => place.id).join("-")}-${index}`}>
              <h3>ルート {index + 1}</h3>
          {suggestion.title && <div className="route-copy"><h4>{suggestion.title}</h4>{suggestion.story && <p>{suggestion.story}</p>}</div>}
          <div className="route-result">
            <div className="stop-list">
              <div className="route-endpoint"><span className="endpoint-dot" /><div><small>START · RETURN</small><strong>{suggestion.origin.name}</strong></div></div>
              {suggestion.places.map((place, index) => (
                <div className="suggested-place" key={place.id}>
                  <span className="place-number">{String(index + 1).padStart(2, "0")}</span>
                  <div><small>{place.category} · 座標から公共交通を検索</small><strong>{place.name}</strong><p>{place.description || "OpenStreetMapのPOI"}</p></div>
                </div>
              ))}
              <div className="route-endpoint"><span className="endpoint-dot finish" /><div><small>FINISH</small><strong>{suggestion.origin.name}</strong></div></div>
            </div>

            <div className="transit-card">
              <div className="transit-summary">
                <div><small>ESTIMATED TRANSIT TIME</small><strong>{formatDuration(suggestion.total_minutes)}</strong></div>
                <div className="transit-clock"><span>出発</span><strong>{suggestion.departure_time ?? departureTime}</strong>{suggestion.arrival_time && <><span>到着</span><strong>{suggestion.arrival_time}</strong></>}</div>
              </div>
              <h3>公共交通の経路</h3>
              {suggestion.legs.length > 0 ? (
                <ol className="leg-list">
                  {suggestion.legs.map((leg, index) => <LegRow leg={leg} index={index} key={`${index}-${leg.line_name}`} />)}
                </ol>
              ) : (
                <p className="no-leg-detail">経路は検索されましたが、区間の詳細はAPIから返されませんでした。</p>
              )}
              <p className="result-note">{suggestion.note}</p>
            </div>
          </div>
            </article>
            ))}
          </div>
        )}
      </section>

      <footer className="footer">
        <p>POI：Overpass API / © OpenStreetMap contributors　·　地図：MapLibre / OpenFreeMap</p>
        <p>POI検索結果は24時間キャッシュします。公開検索サーバーの利用制限時は、連続アクセスを避けて一時停止します。</p>
        <p>スポットの順番は近接性による候補です。実際の徒歩道順・営業状況は各施設の公式情報をご確認ください。</p>
      </footer>
    </main>
  );
}

function LegRow({ leg, index }: { leg: RouteLeg; index: number }) {
  return (
    <li className="leg-row">
      <span className={`leg-icon leg-${leg.mode.toLowerCase()}`}>{modeLabel(leg.mode) === "電車" ? "電" : modeLabel(leg.mode) === "バス" ? "バ" : modeLabel(leg.mode) === "徒歩" ? "歩" : "›"}</span>
      <div className="leg-copy">
        <span>{leg.from_name} <b>→</b> {leg.to_name}</span>
        <strong>{leg.line_name}</strong>
      </div>
      <span className="leg-duration">{leg.duration_minutes === null ? modeLabel(leg.mode) : `${leg.duration_minutes}分`}</span>
      {index === 0 && <span className="sr-only">最初の経路区間</span>}
    </li>
  );
}

export default App;
