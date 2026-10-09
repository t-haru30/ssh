import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { MapView } from "./MapView";
import { IdeaDeck } from "./IdeaDeck";
import { buildDayTimeline, buildRouteTimeline, RouteTimeline, withRouteLegs } from "./RouteTimeline";
import type { Origin, Place, RouteLeg, RouteSuggestion, RouteSuggestions, RouteSuggestionRequest, RouteTimelineItem, Theme, OvernightItineraryRequest, OvernightItinerarySuggestion } from "./types";



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

function isRouteTimelineItem(value: unknown): value is RouteTimelineItem {
  if (!isRecord(value)) return false;
  if (value.type === "spot") {
    return (
      (value.role === "start" || value.role === "stop" || value.role === "finish")
      && (typeof value.place_id === "string" || value.place_id === null)
      && typeof value.name === "string"
      && typeof value.category === "string"
      && (typeof value.time === "string" || value.time === null)
      && typeof value.stay_minutes === "number"
    );
  }
  return (
    value.type === "transit"
    && value.mode === "public_transport"
    && typeof value.from_name === "string"
    && typeof value.to_name === "string"
    && (typeof value.start_time === "string" || value.start_time === null)
    && (typeof value.end_time === "string" || value.end_time === null)
    && (typeof value.duration_minutes === "number" || value.duration_minutes === null)
    && typeof value.is_estimate === "boolean"
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
    && (
      route.timeline === undefined
      || (Array.isArray(route.timeline) && route.timeline.every(isRouteTimelineItem))
    )
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

type SearchModeProps = {
  active: boolean;
};

export function SearchMode({ active }: SearchModeProps) {
  useEffect(() => {
    // display:none から戻った直後にMapLibreへ新しいコンテナサイズを通知する
    if (active) window.dispatchEvent(new Event("resize"));
  }, [active]);

  const [places, setPlaces] = useState<Place[]>([]);
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [originName, setOriginName] = useState("京都駅");
  const [theme, setTheme] = useState<Theme>("all");
  const [mood, setMood] = useState("");
  const [stopCount, setStopCount] = useState(3);
  const [departureDate, setDepartureDate] = useState(localDateInputValue);
    const [departureTime, setDepartureTime] = useState("09:00");
  const [isOvernight, setIsOvernight] = useState(false);
  const [showIdeaDeck, setShowIdeaDeck] = useState(false);
  const [ideaMapPlaces, setIdeaMapPlaces] = useState<Place[]>([]);
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>([]);
  const [overnightSuggestion, setOvernightSuggestion] = useState<OvernightItinerarySuggestion | null>(null);
  const [loading, setLoading] = useState(true);

  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeSourceWarning, setPlaceSourceWarning] = useState<string | null>(null);
  const [placeSourceState, setPlaceSourceState] = useState<"loading" | "success" | "error" | "idle">("loading");
  const [regenerationCount, setRegenerationCount] = useState(0);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const routeSwipeStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  useEffect(() => () => {
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    async function loadInitialData() {
      const [placesResult, originsResult] = await Promise.allSettled([
          fetchWithTimeout("/api/places", {}, INITIAL_DATA_TIMEOUT_MS),
          fetchWithTimeout("/api/origins", {}, INITIAL_DATA_TIMEOUT_MS),
      ]);
      try {
        let originData: Origin[] = [];
        let initialError: string | null = null;
        let placeWarning: string | null = null;

        if (originsResult.status === "fulfilled" && originsResult.value.ok) {
          const originPayload: unknown = await originsResult.value.json();
          if (Array.isArray(originPayload) && originPayload.every(isOrigin)) {
            originData = originPayload;
            setOrigins(originData);
          } else {
            initialError = "出発駅のデータ形式が不正です。";
          }
        } else {
          initialError = "出発駅を読み込めませんでした。APIサーバーを確認してください。";
        }

        if (placesResult.status === "fulfilled" && placesResult.value.ok) {
          const placePayload: unknown = await placesResult.value.json();
          if (Array.isArray(placePayload) && placePayload.every(isPlace)) {
            setPlaces(placePayload);
          } else {
            placeWarning = "候補地のデータ形式が不正です。";
          }
        } else if (placesResult.status === "fulfilled") {
          placeWarning = await readError(placesResult.value);
        } else {
          placeWarning = "候補地を読み込めませんでした。APIサーバーを確認してください。";
        }

        try {
          setPlaceSourceState("loading");
          const statusResponse = await fetchWithTimeout(
            "/api/places/status",
            {},
            INITIAL_DATA_TIMEOUT_MS,
          );
          const placeSourceStatus = statusResponse.ok
            ? await statusResponse.json() as { warning: string | null; state?: string }
            : { warning: null };
          setPlaceSourceWarning(placeSourceStatus.warning ?? placeWarning);
          setPlaceSourceState(
            placeSourceStatus.state === "success"
              ? "success"
              : placeSourceStatus.state === "error"
                ? "error"
                : "idle",
          );
        } catch {
          setPlaceSourceWarning(placeWarning);
          setPlaceSourceState("idle");
        }
        if (!originData.length) {
          initialError ??= "出発駅のデータがありません。";
        }
        if (initialError) {
          setError(initialError);
        }
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
    const mapPlaces = useMemo(() => {
    if (isOvernight && overnightSuggestion) {
      const allPlaces = overnightSuggestion.days.flatMap(d => d.places);
      return [overnightSuggestion.hotel, ...allPlaces];
    }
    return suggestions[0]?.places ?? places;
  }, [isOvernight, overnightSuggestion, suggestions, places]);

    const mapCoordinates = useMemo(() => {
    if (isOvernight && overnightSuggestion) {
      const coords: [number, number][] = [];
      overnightSuggestion.days.forEach(day => {
        if (day.coordinates) {
          coords.push(...day.coordinates);
        }
      });
      return coords;
    }
    return suggestions[0]?.coordinates ?? [];
  }, [isOvernight, overnightSuggestion, suggestions]);

  const mapLegs = useMemo(() => (
    isOvernight && overnightSuggestion
      ? overnightSuggestion.days.flatMap((day) => day.legs)
      : suggestions[0]?.legs ?? []
  ), [isOvernight, overnightSuggestion, suggestions]);

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
    setOvernightSuggestion(null);
    setSearching(true);

    const themeLabel = themes.find(t => t.id === theme)?.label || "";

    if (isOvernight) {
      const request: OvernightItineraryRequest = {
        query: mood.trim() || (theme === "all" ? "京都 観光" : `京都 ${themeLabel}`),
        departure_station: originName,
        departure_date: departureDate,
        departure_time: departureTime,
        stops_per_day: stopCount,
      };

      try {
        const response = await fetchWithTimeout("/api/itineraries/overnight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        }, REQUEST_TIMEOUT_MS);
        if (!response.ok) throw new Error(await readError(response));

        const rawPayload = await response.json() as Partial<OvernightItinerarySuggestion> & {
          days?: Array<OvernightItinerarySuggestion["days"][number] & {
            lunch?: OvernightItinerarySuggestion["days"][number]["lunch"];
          }>;
        };
        const payload: OvernightItinerarySuggestion = {
          ...rawPayload,
          days: (rawPayload.days ?? []).map((day) => ({
            ...day,
            lunch: day.lunch ?? {
              type: "lunch",
              place: null,
              start_time: "12:00",
              end_time: "13:00",
              reason: "昼食情報を取得できなかったため、昼食は要検討です。",
            },
          })),
        } as OvernightItinerarySuggestion;
        if (requestId === requestIdRef.current) {
          setOvernightSuggestion(payload);
        }
      } catch (cause) {
        if (requestId !== requestIdRef.current) return;
        setError(cause instanceof Error ? cause.message : "宿泊プランを取得できませんでした。");
      } finally {
        if (requestId === requestIdRef.current) {
          activeRequestRef.current = null;
          setSearching(false);
        }
      }
    } else {
      const request: RouteSuggestionRequest = {
        origin: originName,
        theme,
        stop_count: stopCount,
        departure_date: departureDate,
        departure_time: departureTime,
        variation: 0,
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
  }


  async function handleRegenerate() {
    if (searching || loading || suggestions.length === 0) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setError(null);
    setSearching(true);
    const nextRegenerationCount = regenerationCount + 1;
    setRegenerationCount(nextRegenerationCount);

    const request: RouteSuggestionRequest = {
      origin: originName,
      theme,
      stop_count: stopCount,
      departure_date: departureDate,
      departure_time: departureTime,
      variation: nextRegenerationCount,
    };
    try {
      const response = await fetchWithTimeout("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await readError(response));
      const payload: unknown = await response.json();
      if (!isRouteSuggestions(payload)) {
        throw new Error("ルートAPIから有効な候補が返されませんでした。");
      }
      if (requestId === requestIdRef.current) {
        setSuggestions(payload.routes);
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("再提案がタイムアウトしました。時間をおいて再度お試しください。");
      } else {
        setError(cause instanceof Error ? cause.message : "別のルートを取得できませんでした。");
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

  function handleRoutePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    routeSwipeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleRoutePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const start = routeSwipeStartRef.current;
    routeSwipeStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 80 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    void handleRegenerate();
  }

  return (
    <div
      className="tab-panel search-mode"
      id="panel-search"
      role="tabpanel"
      aria-labelledby="tab-search"
      hidden={!active}
    >
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

      {!showIdeaDeck ? (
        <button
          className="swipe-launch-button"
          type="button"
          onClick={() => setShowIdeaDeck(true)}
          disabled={loading || !origin}
        >
          <span aria-hidden="true">♡</span>
          スワイプで寄り道を見つける
          <small>経路検索の前に、気になるアイデアを選ぼう</small>
        </button>
      ) : origin ? (
        <IdeaDeck
          origin={origin}
          departureDate={departureDate}
          departureTime={departureTime}
          onActivePlacesChange={setIdeaMapPlaces}
          onClose={() => {
            setShowIdeaDeck(false);
            setIdeaMapPlaces([]);
          }}
        />
      ) : null}

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
              <h2 id="planner-title">旅のプランを立てる</h2>
            </div>
            <span className="step-number">01 <i>/ 02</i></span>
          </div>

          <div className="plan-type-toggle">
            <button 
              type="button" 
              className={!isOvernight ? "active" : ""} 
              onClick={() => setIsOvernight(false)}
            >日帰り</button>
            <button 
              type="button" 
              className={isOvernight ? "active" : ""} 
              onClick={() => setIsOvernight(true)}
            >1泊2日</button>
          </div>

          {!isOvernight && (
            <button className="random-button random-button-primary" type="button" onClick={() => void handleRandomRoute()} disabled={searching || loading}>
              {searching ? <><span className="button-spinner" /> おまかせルートを探しています</> : <>今の気分でどこかへ行く <span>✳</span></>}
            </button>
          )}


          <form onSubmit={handleSubmit}>
            {isOvernight && (
              <label className="mood-input">
                <span>今日の気分</span>
                <textarea
                  value={mood}
                  onChange={(event) => setMood(event.target.value)}
                  maxLength={500}
                  placeholder="例：温泉でのんびりしたい／自然の中で体を動かしたい／静かな場所で美味しいものを食べたい"
                  disabled={searching}
                  rows={3}
                />
              </label>
            )}
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
                <span>{isOvernight ? "1日あたりの立ち寄り先" : "立ち寄り先"}</span>
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
          {placeSourceState === "loading" && <p className="status-message" role="status">Yahoo! Local Searchから候補地を読み込んでいます…</p>}
          {placeSourceWarning && <div className="error-panel" role="status"><strong>Yahoo! Local Searchの検索状況</strong><span>{placeSourceWarning}</span></div>}
          {placeSourceState === "success" && !placeSourceWarning && <p className="status-message" role="status">Yahoo! Local Searchの候補地を表示しています。</p>}
        </section>

                <section className="map-card" aria-label="京都の候補地マップ">
          <div className="map-heading">
            <div><p className="eyebrow">KYOTO MAP</p><h2>寄り道スポット</h2></div>
            <span className="map-count">{showIdeaDeck ? `${ideaMapPlaces.length} SPOTS` : suggestions.length > 0 || overnightSuggestion ? `${mapPlaces.length} SPOTS` : "KYOTO"}</span>
          </div>
          <MapView
            places={showIdeaDeck ? ideaMapPlaces : mapPlaces}
            origin={overnightSuggestion?.origin ?? suggestions[0]?.origin ?? origin}
            coordinates={showIdeaDeck ? [] : mapCoordinates}
            legs={showIdeaDeck ? [] : mapLegs}
          />

          <div className="map-legend">
            <span className="legend-origin">出</span> 出発地
            <span className="legend-stop"><span>寺</span></span> カテゴリ別スポット
            {mapLegs.length > 0 && <span className="map-legend-note">線上のアイコンは経路に含まれる移動手段</span>}
          </div>
        </section>

      </div>

            <section className="results-section" aria-live="polite">
        <div className="section-heading results-heading">
          <div><p className="eyebrow">ROUTE IDEA</p><h2>{suggestions.length > 0 || overnightSuggestion ? "今日のよりみちルート" : "ルートの提案"}</h2></div>
          {(suggestions.length > 0 || overnightSuggestion) && <span className="result-date">{departureDate}</span>}
        </div>

        {suggestions.length === 0 && !overnightSuggestion && !error && (
          <div className="empty-state">
            <span className="empty-icon">↗</span>
            <div><strong>行き先の候補と実際の経路をご提案します</strong><p>出発駅とテーマを選んで、ルートを検索してください。</p></div>
          </div>
        )}

        {overnightSuggestion && (
          <div className="route-options">
            <article className="route-option">
              <h3>1泊2日宿泊プラン：{overnightSuggestion.hotel.name} に泊まる旅</h3>
              <div className="route-result">
                {overnightSuggestion.days.map((day) => (
                  <div key={day.day} className="overnight-day-section">
                    <h4>【Day {day.day}】 {day.date}</h4>
                    <RouteTimeline
                      items={buildDayTimeline(
                        day,
                        overnightSuggestion.origin,
                        overnightSuggestion.hotel,
                        day.day === 1 ? departureTime : "10:00",
                      )}
                    />
                  </div>
                ))}
              </div>
              <p className="result-note">{overnightSuggestion.note}</p>
            </article>
          </div>
        )}

        {suggestions[0] && (
          <div className="route-options">
            <article
              className="route-option route-swipe-card"
              key={suggestions[0].places.map((place) => place.id).join("-")}
              onPointerDown={handleRoutePointerDown}
              onPointerUp={handleRoutePointerUp}
              onPointerCancel={() => { routeSwipeStartRef.current = null; }}
            >
              <h3>おすすめルート</h3>
              {suggestions[0].title && <div className="route-copy"><h4>{suggestions[0].title}</h4>{suggestions[0].story && <p>{suggestions[0].story}</p>}</div>}
              <RouteTimeline
                items={withRouteLegs(
                  suggestions[0].timeline?.length
                    ? suggestions[0].timeline
                    : buildRouteTimeline(
                    suggestions[0].origin,
                    suggestions[0].places,
                    suggestions[0].departure_time,
                    suggestions[0].total_minutes,
                    ),
                  suggestions[0].legs,
                )}
              />
              <p className="result-note">{suggestions[0].note}</p>
            </article>
            <div className="route-swipe-controls">
              <p className="route-swipe-hint">カードを左右にスワイプして、次のルートを探せます</p>
              <button className="regenerate-button" type="button" onClick={() => void handleRegenerate()} disabled={searching || loading}>
                {searching ? <><span className="button-spinner" /> 別のルートを探しています</> : <>別のルートを探す <span>↻</span></>}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
