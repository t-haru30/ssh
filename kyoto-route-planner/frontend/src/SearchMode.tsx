import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { LazyMapView } from "./LazyMapView";
import { buildDayTimeline, buildRouteTimeline, RouteTimeline, withRouteLegs } from "./RouteTimeline";
import { toFriendlyMessage } from "./friendlyError";
import { OVERNIGHT_STEPS, ProgressStatus, ROUTE_STEPS } from "./ProgressStatus";
import { isOrigin, isOvernightItinerary, isPlace, isRecord, isRouteSuggestions, normalizeOvernightItinerary } from "./apiValidation";
import type { Origin, Place, RouteSuggestion, RouteSuggestionRequest, Theme, OvernightItineraryRequest, OvernightItinerarySuggestion } from "./types";



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
const SAVED_PLAN_STORAGE_KEY = "kyoto-route-planner:saved-plan:v1";
const SEARCH_FORM_STORAGE_KEY = "kyoto-route-planner:search-form:v1";

type SavedSearchFormState = {
  originName: string;
  nearbyStations: Origin[];
  theme: Theme;
  mood: string;
  stopCount: number;
  departureDate: string;
  departureTime: string;
  isOvernight: boolean;
  regenerationCount: number;
};

function isSavedSearchFormState(value: unknown): value is SavedSearchFormState {
  return isRecord(value)
    && typeof value.originName === "string"
    && Array.isArray(value.nearbyStations)
    && value.nearbyStations.every(isOrigin)
    && themes.some((item) => item.id === value.theme)
    && typeof value.mood === "string"
    && (value.stopCount === 1 || value.stopCount === 2 || value.stopCount === 3)
    && typeof value.departureDate === "string"
    && typeof value.departureTime === "string"
    && typeof value.isOvernight === "boolean"
    && typeof value.regenerationCount === "number"
    && Number.isInteger(value.regenerationCount)
    && value.regenerationCount >= 0;
}

function isSavedPlan(value: unknown): value is {
  suggestions: RouteSuggestion[];
  overnightSuggestion: OvernightItinerarySuggestion | null;
} {
  return isRecord(value)
    && Array.isArray(value.suggestions)
    && isRouteSuggestions({ routes: value.suggestions })
    && (value.overnightSuggestion === null || isOvernightItinerary(value.overnightSuggestion));
}

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

function nearestKnownOrigin(origins: Origin[], latitude: number, longitude: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  let best: { origin: Origin; km: number } | null = null;
  for (const origin of origins) {
    const dLat = toRad(origin.latitude - latitude);
    const dLng = toRad(origin.longitude - longitude);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(latitude)) * Math.cos(toRad(origin.latitude)) * Math.sin(dLng / 2) ** 2;
    const km = 6371 * 2 * Math.asin(Math.sqrt(a));
    if (!best || km < best.km) best = { origin, km };
  }
  return best;
}

export type SearchPreset = { theme: Theme; stopCount: number; nonce: number };

type SearchModeProps = {
  active: boolean;
  preset?: SearchPreset | null;
};

export function SearchMode({ active, preset }: SearchModeProps) {
  useEffect(() => {
    if (!preset) return;
    setTheme(preset.theme);
    setStopCount(Math.min(3, Math.max(1, preset.stopCount)));
  }, [preset]);
  useEffect(() => {
    // display:none から戻った直後にMapLibreへ新しいコンテナサイズを通知する
    if (active) window.dispatchEvent(new Event("resize"));
  }, [active]);

  const [places, setPlaces] = useState<Place[]>([]);
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [nearbyStations, setNearbyStations] = useState<Origin[]>([]);
  const [originName, setOriginName] = useState("京都駅");
  const [theme, setTheme] = useState<Theme>("all");
  const [mood, setMood] = useState("");
  const [stopCount, setStopCount] = useState(3);
  const [departureDate, setDepartureDate] = useState(localDateInputValue);
    const [departureTime, setDepartureTime] = useState("09:00");
  const [isOvernight, setIsOvernight] = useState(false);
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>([]);
  const [overnightSuggestion, setOvernightSuggestion] = useState<OvernightItinerarySuggestion | null>(null);
  const [loading, setLoading] = useState(true);

  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeSourceWarning, setPlaceSourceWarning] = useState<string | null>(null);
  const [placeSourceState, setPlaceSourceState] = useState<"loading" | "success" | "error" | "idle">("loading");
  const [regenerationCount, setRegenerationCount] = useState(0);
  const [hasRestoredSavedState, setHasRestoredSavedState] = useState(false);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const routeSwipeStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  useEffect(() => {
    try {
      const serializedPlan = window.localStorage.getItem(SAVED_PLAN_STORAGE_KEY);
      if (serializedPlan) {
        const savedPlan: unknown = JSON.parse(serializedPlan);
        if (!isSavedPlan(savedPlan)) {
          throw new Error("Saved route data has an invalid format.");
        }
        setSuggestions(savedPlan.suggestions);
        setOvernightSuggestion(savedPlan.overnightSuggestion);
      }
    } catch (cause) {
      console.error("Failed to restore saved route from localStorage.", cause);
    }

    try {
      const serializedForm = window.localStorage.getItem(SEARCH_FORM_STORAGE_KEY);
      if (serializedForm) {
        const savedForm: unknown = JSON.parse(serializedForm);
        if (!isSavedSearchFormState(savedForm)) {
          throw new Error("Saved search form data has an invalid format.");
        }
        setOriginName(savedForm.originName);
        setNearbyStations(savedForm.nearbyStations);
        setTheme(savedForm.theme);
        setMood(savedForm.mood);
        setStopCount(savedForm.stopCount);
        setDepartureDate(savedForm.departureDate);
        setDepartureTime(savedForm.departureTime);
        setIsOvernight(savedForm.isOvernight);
        setRegenerationCount(savedForm.regenerationCount);
      }
    } catch (cause) {
      console.error("Failed to restore search form from localStorage.", cause);
    } finally {
      setHasRestoredSavedState(true);
    }
  }, []);

  useEffect(() => {
    if (!hasRestoredSavedState) return;
    try {
      if (suggestions.length === 0 && !overnightSuggestion) {
        window.localStorage.removeItem(SAVED_PLAN_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(
        SAVED_PLAN_STORAGE_KEY,
        JSON.stringify({ suggestions, overnightSuggestion }),
      );
    } catch (cause) {
      console.error("Failed to save route to localStorage.", cause);
    }
  }, [hasRestoredSavedState, overnightSuggestion, suggestions]);

  useEffect(() => {
    if (!hasRestoredSavedState) return;
    const formState: SavedSearchFormState = {
      originName,
      nearbyStations,
      theme,
      mood,
      stopCount,
      departureDate,
      departureTime,
      isOvernight,
      regenerationCount,
    };
    try {
      window.localStorage.setItem(SEARCH_FORM_STORAGE_KEY, JSON.stringify(formState));
    } catch (cause) {
      console.error("Failed to save search form to localStorage.", cause);
    }
  }, [
    departureDate,
    departureTime,
    hasRestoredSavedState,
    isOvernight,
    mood,
    nearbyStations,
    originName,
    regenerationCount,
    stopCount,
    theme,
  ]);

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
        setError(toFriendlyMessage(cause, "初期データを読み込めませんでした。ページを再読み込みしてください。"));
      } finally {
        setLoading(false);
      }
    }

    void loadInitialData();
  }, []);

  const origin = useMemo(
    () => [...nearbyStations, ...origins].find((item) => item.name === originName) ?? null,
    [nearbyStations, originName, origins],
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

  const hasResult = suggestions.length > 0 || overnightSuggestion !== null;
  const [formCollapsed, setFormCollapsed] = useState(false);
  const [activeSpotId, setActiveSpotId] = useState<string | null>(null);
  const timelineAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFormCollapsed(hasResult);
  }, [hasResult]);

  // Scroll Spy: 画面中央の帯に入ったスポットをハイライトする
  useEffect(() => {
    setActiveSpotId(null);
    const container = timelineAreaRef.current;
    if (!hasResult || !container) return;
    const targets = container.querySelectorAll<HTMLElement>("[data-spot-id]");
    if (targets.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      const last = visible[visible.length - 1];
      if (last) setActiveSpotId((last.target as HTMLElement).dataset.spotId ?? null);
    }, { rootMargin: "-35% 0px -35% 0px", threshold: 0 });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [hasResult, suggestions, overnightSuggestion]);

  function handleUseCurrentLocation() {
    setLocationError(null);
    if (!navigator.geolocation) {
      const error = new Error("Geolocation is not supported by this browser.");
      console.error("[current-location] Geolocation API is unavailable.", error);
      const message = "このブラウザでは位置情報を取得できません。出発駅を手動で入力してください。";
      setLocationError(message);
      window.alert(message);
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        console.log("[current-location] Coordinates received.", { latitude, longitude });
        try {
          const response = await fetchWithTimeout(
            `/api/nearby-stations?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
            {},
            INITIAL_DATA_TIMEOUT_MS,
          );
          if (!response.ok) {
            throw new Error(await readError(response));
          }
          const payload: unknown = await response.json();
          if (!Array.isArray(payload) || !payload.every(isOrigin)) {
            throw new Error("現在地周辺の駅・停留所データ形式が不正です。");
          }
          if (payload.length === 0) {
            throw new Error("現在地周辺に駅・停留所が見つかりませんでした。");
          }
          const stations = payload as Origin[];
          setNearbyStations(stations);
          setOriginName(stations[0].name);
          setLocationError(null);
          console.log("[current-location] Nearby departures loaded.", {
            count: stations.length,
            departure: stations[0].name,
            latitude,
            longitude,
          });
        } catch (cause) {
          console.error("[current-location] Nearby station lookup failed.", cause);
          const fallback = nearestKnownOrigin(origins, latitude, longitude);
          if (fallback) {
            setOriginName(fallback.origin.name);
            setLocationError(
              `最寄り駅の自動検索に失敗したため、現在地に近い候補の「${fallback.origin.name}」（約${fallback.km.toFixed(1)}km）を選択しました。違う場合は手動で変更してください。`,
            );
          } else {
            const message = "現在地周辺の駅・停留所を特定できませんでした。出発駅を手動で入力してください。";
            setLocationError(message);
            window.alert(message);
          }
        } finally {
          setLocating(false);
        }
      },
      (error) => {
        console.error("[current-location] Geolocation failed.", {
          code: error.code,
          message: error.message,
          error,
        });
        const message = error.code === GeolocationPositionError.PERMISSION_DENIED
          ? "位置情報が許可されていません。ブラウザの設定を確認してください。"
          : error.code === GeolocationPositionError.POSITION_UNAVAILABLE
            ? "位置情報を取得できません。端末の位置情報設定や通信状況を確認してください。"
            : error.code === GeolocationPositionError.TIMEOUT
              ? "位置情報の取得がタイムアウトしました。もう一度お試しください。"
              : "現在地を取得できませんでした。出発駅を手動で入力してください。";
        setLocating(false);
        setLocationError(message);
        window.alert(message);
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  }

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
        query: mood.trim() || (theme === "all" ? "観光" : themeLabel),
        departure_station: originName,
        ...(origin ? {
          origin_latitude: origin.latitude,
          origin_longitude: origin.longitude,
        } : {}),
        departure_date: departureDate,
        departure_time: departureTime,
        stops_per_day: stopCount,
        hotel_query: `${originName} ホテル 旅館`,
      };

      try {
        const response = await fetchWithTimeout("/api/itineraries/overnight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        }, REQUEST_TIMEOUT_MS);
        if (!response.ok) throw new Error(await readError(response));

        const rawPayload: unknown = await response.json();
        if (!isRecord(rawPayload) || !Array.isArray(rawPayload.days)) {
          throw new Error("宿泊ルートAPIから有効な旅程が返されませんでした。");
        }
        const normalizedPayload = normalizeOvernightItinerary(rawPayload);
        if (!isOvernightItinerary(normalizedPayload)) {
          throw new Error("宿泊ルートAPIから有効な旅程が返されませんでした。");
        }
        const payload: OvernightItinerarySuggestion = normalizedPayload;
        if (requestId === requestIdRef.current) {
          setOvernightSuggestion(payload);
        }
      } catch (cause) {
        if (requestId !== requestIdRef.current) return;
        setError(toFriendlyMessage(cause));
      } finally {
        if (requestId === requestIdRef.current) {
          activeRequestRef.current = null;
          setSearching(false);
        }
      }
    } else {
      const request: RouteSuggestionRequest = {
        origin: originName,
        ...(origin ? {
          origin_latitude: origin.latitude,
          origin_longitude: origin.longitude,
        } : {}),
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
          if (payload.routes.length === 0) {
            setError("スポットが見つかりませんでした。条件を変えて再試行してください。");
          } else {
            setSuggestions(payload.routes);
          }
        }
      } catch (cause) {
        if (requestId !== requestIdRef.current) return;
        if (cause instanceof DOMException && cause.name === "AbortError") {
          setError("ルート検索がタイムアウトしました。時間をおいて再度お試しください。");
        } else {
          setError(toFriendlyMessage(cause));
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
      ...(origin ? {
        origin_latitude: origin.latitude,
        origin_longitude: origin.longitude,
      } : {}),
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
        if (payload.routes.length === 0) {
          setError("スポットが見つかりませんでした。条件を変えて再試行してください。");
        } else {
          setSuggestions(payload.routes);
        }
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("再提案がタイムアウトしました。時間をおいて再度お試しください。");
      } else {
        setError(toFriendlyMessage(cause));
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
      const params = new URLSearchParams({ origin: originName });
      if (origin) {
        params.set("origin_latitude", String(origin.latitude));
        params.set("origin_longitude", String(origin.longitude));
      }
      const response = await fetchWithTimeout(`/api/routes/random?${params.toString()}`, {
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
        if (payload.routes.length === 0) {
          setError("スポットが見つかりませんでした。条件を変えて再試行してください。");
        } else {
          setSuggestions(payload.routes);
        }
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("ルート検索がタイムアウトしました。時間をおいて再度お試しください。");
      } else {
        setError(toFriendlyMessage(cause));
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
      className={`tab-panel search-mode${hasResult ? " search-mode--result" : ""}`}
      id="panel-search"
      role="tabpanel"
      aria-labelledby="tab-search"
      hidden={!active}
    >
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">TICKET &amp; JOURNEY</p>
          <h1>旅の一日を、<br /><em>ConcierGO</em>から。</h1>
          <p className="hero-description">
            気分に合わせて行き先を選ぶと、駅すぱあとAPIが<br className="desktop-break" />
            公共交通のルートを検索します。
          </p>
        </div>
        <div className="hero-stamp" aria-hidden="true"><span>旅</span><small>WANDER<br />WITH CARE</small></div>
      </section>

      {suggestions[0]?.title && (
        <section className="route-copy-banner visible" aria-live="polite">
          <p className="eyebrow">YOUR KYOTO STORY</p>
          <h2>{suggestions[0].title}</h2>
          {suggestions[0].story && <p>{suggestions[0].story}</p>}
        </section>
      )}

      {hasResult && (
        <div className="hero-map">
          <LazyMapView
            places={mapPlaces}
            origin={overnightSuggestion?.origin ?? suggestions[0]?.origin ?? origin}
            coordinates={mapCoordinates}
            legs={mapLegs}
            fitDuration={1200}
            activeSpotId={activeSpotId}
          />
        </div>
      )}

      <div className={`search-stage${hasResult ? " has-result" : ""}`}>
        {hasResult && (
          <button
            className="form-toggle-button"
            type="button"
            aria-expanded={!formCollapsed}
            aria-controls="planner-card"
            onClick={() => setFormCollapsed((value) => !value)}
          >
            {formCollapsed ? "条件を変更する" : "条件を閉じる"}
            <span aria-hidden="true">{formCollapsed ? "▾" : "▴"}</span>
          </button>
        )}
        <section
          className={`planner-card${hasResult && formCollapsed ? " collapsed" : ""}`}
          id="planner-card"
          aria-labelledby="planner-title"
        >
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
            <button className="random-button random-button-primary nowrap" type="button" onClick={() => void handleRandomRoute()} disabled={searching || loading}>
              {searching ? <><span className="button-spinner" /> おまかせルートを探しています</> : <>今の気分でどこかへ行く <span>✳</span></>}
            </button>
          )}


          <form ref={formRef} onSubmit={handleSubmit}>
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
                <div className="origin-input-row">
                  <select value={originName} onChange={(event) => setOriginName(event.target.value)} disabled={loading || searching || locating}>
                    {nearbyStations.length > 0 && (
                      <optgroup label="現在地周辺">
                        {nearbyStations.map((item) => (
                          <option value={item.name} key={`${item.name}:${item.latitude}:${item.longitude}`}>
                            {item.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="主要駅">
                      {origins.map((item) => (
                        <option value={item.name} key={item.name}>
                          {/[駅)）]$/.test(item.name) ? item.name : `${item.name}駅`}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <button
                    className="location-button nowrap"
                    type="button"
                    onClick={handleUseCurrentLocation}
                    disabled={loading || searching || locating}
                  >
                    {locating ? "取得中…" : "現在地から探す"}
                  </button>
                </div>
                <small>スポット候補は出発駅の周辺から取得します。</small>
                {locationError && <small className="location-error" role="alert">{locationError}</small>}
              </label>
              <details className="form-advanced">
                <summary>
                  詳細設定：{departureDate} {departureTime}出発・{stopCount}か所
                </summary>
                <div className="form-advanced-fields">
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
              </details>
            </div>

            <button className="submit-button nowrap" type="submit" disabled={searching || loading}>
              {searching ? <><span className="button-spinner" /> 実際の経路を検索しています</> : <>旅のしおりを作る <span>↗</span></>}
            </button>
            <p className="form-footnote">検索ボタンまたはおまかせボタンを押した時だけ、駅すぱあとAPIに問い合わせます。</p>
          </form>

          {searching && <ProgressStatus steps={isOvernight ? OVERNIGHT_STEPS : ROUTE_STEPS} />}
          {error && (
            <div className="error-panel" role="alert">
              <strong>ルートを表示できません</strong>
              <span>{error}</span>
              <button
                className="error-retry-button nowrap"
                type="button"
                onClick={() => formRef.current?.requestSubmit()}
                disabled={searching || loading}
              >
                再試行
              </button>
            </div>
          )}
          {placeSourceState === "loading" && <p className="status-message" role="status">Yahoo! Local Searchから候補地を読み込んでいます…</p>}
          {placeSourceWarning && <div className="error-panel" role="status"><strong>Yahoo! Local Searchの検索状況</strong><span>{placeSourceWarning}</span></div>}
          {placeSourceState === "success" && !placeSourceWarning && places.length > 0 && <p className="status-message" role="status">Yahoo! Local Searchの候補地を表示しています。</p>}
          {placeSourceState === "success" && places.length === 0 && (
            <p className="status-message" role="status">スポットが見つかりませんでした。条件を変えて再試行してください。</p>
          )}
        </section>

      </div>

      {hasResult && (
        <div className="timeline-area" ref={timelineAreaRef}>
          <section className="results-section" aria-live="polite">
            <div className="section-heading results-heading">
              <div><p className="eyebrow">ROUTE IDEA</p><h2>今日のConcierGOルート</h2></div>
              <span className="result-date">{departureDate}</span>
            </div>
            {error && <div className="error-panel" role="alert"><strong>ルートを表示できません</strong><span>{error}</span></div>}

        {overnightSuggestion && (
          <div className="route-options">
            <article className="route-option">
              <h3>1泊2日宿泊プラン：{overnightSuggestion.hotel.name} に泊まる旅</h3>
              <div className="route-result">
                {overnightSuggestion.fare_yen !== undefined && (
                  <p className="fare-estimate" aria-live="polite">
                    <strong>1泊2日の交通費概算（1人分）</strong>
                    <span>
                      {overnightSuggestion.fare_yen === null
                        ? "全日分を取得できませんでした"
                        : `約${overnightSuggestion.fare_yen.toLocaleString("ja-JP")}円`}
                    </span>
                    <small>時刻表を使わない経路探索による目安です。各日の経路を別々に検索して合算しています。</small>
                  </p>
                )}
                {overnightSuggestion.days.map((day) => (
                  <div key={day.day} className="overnight-day-section">
                    <h4>【Day {day.day}】 {day.date}</h4>
                    {day.fare_yen !== undefined && (
                      <p className="fare-estimate" aria-live="polite">
                        <strong>Day {day.day} 交通費概算</strong>
                        <span>
                          {day.fare_yen === null
                            ? "取得できませんでした"
                            : `約${day.fare_yen.toLocaleString("ja-JP")}円`}
                        </span>
                      </p>
                    )}
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
              {suggestions[0].fare_yen !== undefined && (
                <p className="fare-estimate" aria-live="polite">
                  <strong>交通費の概算（1人分・往復）</strong>
                  <span>
                    {suggestions[0].fare_yen === null
                      ? "取得できませんでした"
                      : `約${suggestions[0].fare_yen.toLocaleString("ja-JP")}円`}
                  </span>
                  <small>時刻表を使わない経路探索による目安です。実際の経路・運賃と異なる場合があります。</small>
                </p>
              )}
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
      )}
    </div>
  );
}
