import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LazyMapView } from "./LazyMapView";
import { IdeaDeck } from "./IdeaDeck";
import { buildDayTimeline, RouteTimeline } from "./RouteTimeline";
import { DayTripEditor, TripDialog } from "./DayTripEditor";
import { JourneyFileControls } from "./JourneyFileControls";
import { StationSearch } from "./StationSearch";
import { readLegacySavedPlan, readSearchForm, saveLegacyPlan, saveSearchForm } from "./searchState";
import type { JourneyDraft } from "./journeyDraft";
import type { TripPlan } from "./dayTrip";
import { readTripNumber } from "./dayTrip";
import { createInitialTrip } from "./initialTrip";
import { PREFERENCE_OPTIONS } from "./tripPreferences";
import type { SearchPreset } from "./routeSelection";
import { clearJourneyDraft, readJourneyDraft, saveJourneyDraft } from "./journeyDraft";
import { localPlaces } from "./localPlaces";
import "./dayTrip.css";
import { toFriendlyMessage } from "./friendlyError";
import { OVERNIGHT_STEPS, ProgressStatus, ROUTE_STEPS } from "./ProgressStatus";
import { isOrigin, isOvernightItinerary, isRecord, isRouteSuggestions, normalizeOvernightItinerary } from "./apiValidation";
import type { Origin, Preference, RouteSuggestion, RouteSuggestionRequest, Theme, OvernightItineraryRequest, OvernightItinerarySuggestion } from "./types";



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

export type { SearchPreset } from "./routeSelection";

type SearchModeProps = {
  active: boolean;
  preset?: SearchPreset | null;
};

export function SearchMode({ active, preset }: SearchModeProps) {
  const [restoredDraft] = useState(readJourneyDraft);
  const [savedForm] = useState(readSearchForm);
  const [legacyPlan] = useState(readLegacySavedPlan);
  useEffect(() => {
    if (!preset) return;
    setTheme(preset.theme);
    setStopCount(Math.min(3, Math.max(1, preset.stopCount)));
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
    setSearching(false);
    setOriginName(preset.origin.name);
    setCustomOrigin(preset.origin);
    setReturnSame(true);
    setPreferences(preset.theme === "nature" ? ["nature"] : preset.theme === "food" ? ["food"] : preset.theme === "all" ? [] : ["culture"]);
    setIsOvernight(false);
    setShowIdeaDeck(false);
    setOvernightSuggestion(null);
    setDayTripPlan(null);
    setDraftRestored(false);
    setTripSession(preset.nonce);
    setSuggestions([{ origin: preset.origin, places: preset.places, legs: [], total_minutes: null,
      departure_time: null, arrival_time: null, fare_yen: null, title: preset.title, story: "選んだ行き先を引き継ぎました。予定を編集してから交通経路を検索できます。", note: "交通経路は未検索です。" }]);
    setTransportStamp({ date: "", time: "" });
    setError(null);
  }, [preset]);
  useEffect(() => {
    // display:none から戻った直後にMapLibreへ新しいコンテナサイズを通知する
    if (active) window.dispatchEvent(new Event("resize"));
  }, [active]);

  const places = localPlaces;
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [nearbyStations, setNearbyStations] = useState<Origin[]>(savedForm?.nearbyStations ?? []);
  const [originName, setOriginName] = useState(restoredDraft?.plan.origin.name ?? savedForm?.originName ?? legacyPlan?.suggestions[0]?.origin.name ?? "京都駅");
  const [customOrigin, setCustomOrigin] = useState<Origin | null>(restoredDraft?.plan.origin ?? savedForm?.customOrigin ?? legacyPlan?.suggestions[0]?.origin ?? null);
  const [returnSame, setReturnSame] = useState(() => restoredDraft ? restoredDraft.plan.origin.latitude === restoredDraft.plan.returnTo.latitude && restoredDraft.plan.origin.longitude === restoredDraft.plan.returnTo.longitude : savedForm?.returnSame ?? true);
  const [returnName, setReturnName] = useState(restoredDraft?.plan.returnTo.name ?? savedForm?.returnName ?? "大阪駅");
  const [customReturn, setCustomReturn] = useState<Origin | null>(restoredDraft?.plan.returnTo ?? savedForm?.customReturn ?? null);
  const [preferences, setPreferences] = useState<Preference[]>(restoredDraft ? restoredDraft.plan.input.preferences ?? [] : savedForm?.preferences ?? ["nature", "culture", "food"]);
  const [initialMinutes, setInitialMinutes] = useState(restoredDraft ? String(restoredDraft.plan.input.availableMinutes) : savedForm?.initialMinutes ?? "360");
  const [initialBudget, setInitialBudget] = useState(restoredDraft ? String(restoredDraft.plan.input.budget) : savedForm?.initialBudget ?? "5000");
  const [foodEstimate, setFoodEstimate] = useState(() => restoredDraft?.plan.planningEstimates ? String(restoredDraft.plan.planningEstimates.food ?? "") : savedForm?.foodEstimate ?? "1500");
  const [coffeeEstimate, setCoffeeEstimate] = useState(() => restoredDraft?.plan.planningEstimates ? String(restoredDraft.plan.planningEstimates.coffee ?? "") : savedForm?.coffeeEstimate ?? "600");
  const [initialTransportEstimate, setInitialTransportEstimate] = useState(restoredDraft ? String(restoredDraft.plan.transportEstimate ?? "") : savedForm?.initialTransportEstimate ?? "");
  const [theme, setTheme] = useState<Theme>(savedForm?.theme ?? "all");
  const [mood, setMood] = useState(savedForm?.mood ?? "");
  const [stopCount, setStopCount] = useState(Math.min(3, savedForm?.stopCount ?? 3));
  const [departureDate, setDepartureDate] = useState(() => restoredDraft?.plan.date ?? savedForm?.departureDate ?? localDateInputValue());
  const [departureTime, setDepartureTime] = useState(restoredDraft?.plan.input.departureTime ?? savedForm?.departureTime ?? "09:00");
  const [isOvernight, setIsOvernight] = useState(restoredDraft ? false : savedForm?.isOvernight ?? Boolean(legacyPlan?.overnightSuggestion));
  const [showIdeaDeck, setShowIdeaDeck] = useState(false);
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>(() => restoredDraft ? [{ ...restoredDraft.plan.transport.route, title: restoredDraft.title }] : legacyPlan?.suggestions ?? []);
  const [dayTripPlan, setDayTripPlan] = useState<TripPlan | null>(restoredDraft?.plan ?? null);
  const [tripSession, setTripSession] = useState(0);
  const [transportStamp, setTransportStamp] = useState(() => ({ date: restoredDraft?.plan.transport.date ?? "", time: restoredDraft?.plan.transport.time ?? "" }));
  const [draftRestored, setDraftRestored] = useState(Boolean(restoredDraft));
  const [draftSaved, setDraftSaved] = useState(Boolean(restoredDraft));
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [overnightSuggestion, setOvernightSuggestion] = useState<OvernightItinerarySuggestion | null>(restoredDraft ? null : legacyPlan?.overnightSuggestion ?? null);
  const [loading, setLoading] = useState(true);

  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerationCount, setRegenerationCount] = useState(savedForm?.regenerationCount ?? 0);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    saveSearchForm({ originName, nearbyStations, theme, mood, stopCount, departureDate, departureTime, isOvernight, regenerationCount,
      customOrigin, customReturn, returnSame, returnName, preferences, initialMinutes, initialBudget, foodEstimate, coffeeEstimate, initialTransportEstimate });
  }, [originName, nearbyStations, theme, mood, stopCount, departureDate, departureTime, isOvernight, regenerationCount, customOrigin, customReturn, returnSame, returnName, preferences, initialMinutes, initialBudget, foodEstimate, coffeeEstimate, initialTransportEstimate]);
  useEffect(() => { saveLegacyPlan(suggestions, overnightSuggestion); }, [suggestions, overnightSuggestion]);

  useEffect(() => {
    if (dayTripPlan) setDraftSaved(saveJourneyDraft(dayTripPlan, suggestions[0]?.title ?? "私のよりみち"));
  }, [dayTripPlan, suggestions]);
  useEffect(() => {
    if (!dayTripPlan) return;
    setInitialMinutes(String(dayTripPlan.input.availableMinutes));
    setInitialBudget(String(dayTripPlan.input.budget));
  }, [dayTripPlan?.input.availableMinutes, dayTripPlan?.input.budget]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    async function loadInitialData() {
      try {
        const response = await fetchWithTimeout("/api/origins", {}, INITIAL_DATA_TIMEOUT_MS);
        const payload: unknown = response.ok ? await response.json() : null;
        if (!Array.isArray(payload) || !payload.length || !payload.every(isOrigin)) {
          throw new Error("出発・帰着駅を読み込めませんでした。ローカルアプリを確認してください。");
        }
        setOrigins(payload);
      } catch (cause) {
        setError(toFriendlyMessage(cause, "駅を読み込めませんでした。ページを再読み込みしてください。"));
      } finally { setLoading(false); }
    }

    void loadInitialData();
  }, []);

  const origin = useMemo(
    () => [...(customOrigin ? [customOrigin] : []), ...nearbyStations, ...origins].find((item) => item.name === originName) ?? null,
    [nearbyStations, originName, origins, customOrigin],
  );
  const editingCandidates = localPlaces;
  const endpointOptions = useMemo(() => [...new Map([...(customOrigin ? [customOrigin] : []), ...(customReturn ? [customReturn] : []), ...nearbyStations, ...origins].map(item => [`${item.name}:${item.latitude}:${item.longitude}`, item])).values()], [customOrigin, customReturn, nearbyStations, origins]);
  const returnTo = returnSame ? origin : customReturn?.name === returnName ? customReturn : endpointOptions.find(item => item.name === returnName) ?? null;
  const hasCompleted = Boolean(dayTripPlan?.stops.some(stop => stop.completed));
  const mapPlaces = useMemo(() => {
    if (isOvernight && overnightSuggestion) {
      const allPlaces = overnightSuggestion.days.flatMap(d => d.places);
      return [overnightSuggestion.hotel, ...allPlaces];
    }
    return dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0]?.places ?? places;
  }, [isOvernight, overnightSuggestion, suggestions, places, dayTripPlan]);

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
    if (dayTripPlan) return [[dayTripPlan.origin.latitude, dayTripPlan.origin.longitude], ...dayTripPlan.stops.map(stop => [stop.place.latitude, stop.place.longitude]), [dayTripPlan.returnTo.latitude, dayTripPlan.returnTo.longitude]] as [number, number][];
    return suggestions[0]?.coordinates ?? [];
  }, [isOvernight, overnightSuggestion, suggestions, dayTripPlan]);

  const mapLegs = useMemo(() => (
    isOvernight && overnightSuggestion
      ? overnightSuggestion.days.flatMap((day) => day.legs)
      : dayTripPlan?.estimatedTravel ? [] : suggestions[0]?.legs ?? []
  ), [isOvernight, overnightSuggestion, suggestions, dayTripPlan]);

  const hasResult = isOvernight ? overnightSuggestion !== null : suggestions.length > 0;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(departureDate);
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime);
  const validDeparture = validDate && validTime;
  const editorDate = validDate ? departureDate : dayTripPlan?.date ?? localDateInputValue();
  const editorTime = validTime ? departureTime : dayTripPlan?.input.departureTime ?? "09:00";
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
    if (!hasResult || !container || typeof IntersectionObserver === "undefined") return;
    const targets = container.querySelectorAll<HTMLElement>("[data-spot-id]");
    if (targets.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      const last = visible[visible.length - 1];
      if (last) setActiveSpotId((last.target as HTMLElement).dataset.spotId ?? null);
    }, { rootMargin: "-35% 0px -35% 0px", threshold: 0 });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [hasResult, suggestions, overnightSuggestion, dayTripPlan]);

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
          setCustomOrigin(stations[0]);
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
            setCustomOrigin(fallback.origin);
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

  function importJourney(draft: JourneyDraft) {
    requestIdRef.current += 1; activeRequestRef.current?.abort(); setSearching(false);
    const plan = draft.plan;
    setCustomOrigin(plan.origin); setOriginName(plan.origin.name);
    setCustomReturn(plan.returnTo); setReturnName(plan.returnTo.name);
    setReturnSame(plan.origin.latitude === plan.returnTo.latitude && plan.origin.longitude === plan.returnTo.longitude);
    setDepartureDate(plan.date); setDepartureTime(plan.input.departureTime);
    setPreferences(plan.input.preferences ?? []);
    setInitialMinutes(String(plan.input.availableMinutes)); setInitialBudget(String(plan.input.budget));
    setFoodEstimate(String(plan.planningEstimates?.food ?? "")); setCoffeeEstimate(String(plan.planningEstimates?.coffee ?? ""));
    setInitialTransportEstimate(String(plan.transportEstimate ?? ""));
    setIsOvernight(false); setShowIdeaDeck(false); setOvernightSuggestion(null);
    setSuggestions([{ ...plan.transport.route, title: draft.title || "読み込んだ旅程" }]);
    setDayTripPlan(plan); setTransportStamp({ date: "", time: "" });
    setTripSession(current => current + 1); setDraftRestored(false); setError(null);
  }

  function proposeLocally() {
    try {
      if (!origin || !returnTo) throw new Error("出発駅と帰着駅を選んでください。");
      const optionalAmount = (value: string, label: string) => value.trim() === "" ? null : readTripNumber(value, label, 0, 50000);
      const plan = createInitialTrip({
        input: { departureTime, availableMinutes: readTripNumber(initialMinutes, "使える時間", 30, 720), budget: readTripNumber(initialBudget, "予算", 0, 50000), preferences },
        origin, returnTo, date: departureDate, candidates: editingCandidates, maxStops: stopCount,
        foodEstimate: optionalAmount(foodEstimate, "食事の計画用見積もり"), coffeeEstimate: optionalAmount(coffeeEstimate, "カフェの計画用見積もり"), transportEstimate: optionalAmount(initialTransportEstimate, "交通費の計画用見積もり"),
      });
      if (!plan.stops.length) throw new Error(plan.violations.join(" ") || "この条件に合う候補がありません。時間や行き先を見直してください。");
      setSuggestions([plan.transport.route]); setDayTripPlan(plan); setOvernightSuggestion(null);
      setTransportStamp({ date: "", time: "" }); setTripSession(Date.now()); setDraftRestored(false); setError(null);
    } catch (cause) { setError(toFriendlyMessage(cause)); }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {

    event.preventDefault();
    if (searching) return;
    if (!validDeparture) { setError("出発日と出発時刻を入力してください。現在の旅程は保持しています。"); return; }
    if (!isOvernight && !hasResult) { proposeLocally(); return; }
    if (!isOvernight && !returnTo) { setError("帰着駅を選んでください。"); return; }
    if (!isOvernight && dayTripPlan?.stops.length === 0) { setError("立ち寄り先を追加してから経路を検索してください。"); return; }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setError(null);
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
        ...(returnTo ? { return_to: returnTo.name, return_latitude: returnTo.latitude, return_longitude: returnTo.longitude } : {}),
        stop_count: stopCount,
        departure_date: departureDate,
        departure_time: departureTime,
        variation: 0,
        ...(suggestions[0] ? { selected_places: dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0].places } : {}),
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
          if (payload.routes.length === 0) throw new Error("スポットが見つかりませんでした。条件を変えて再試行してください。");
          setSuggestions(payload.routes);
          setOvernightSuggestion(null);
          setTransportStamp({ date: departureDate, time: departureTime });
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
    if (searching || loading || suggestions.length === 0 || dayTripPlan?.stops.length === 0) return;
    if (!validDeparture) { setError("出発日と出発時刻を入力してください。現在の旅程は保持しています。"); return; }
    if (!origin || !returnTo) { setError("出発駅と帰着駅を選んでください。"); return; }
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
      ...(returnTo ? { return_to: returnTo.name, return_latitude: returnTo.latitude, return_longitude: returnTo.longitude } : {}),
      stop_count: stopCount,
      departure_date: departureDate,
      departure_time: departureTime,
      variation: nextRegenerationCount,
      selected_places: dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0].places,
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
        if (payload.routes.length === 0) throw new Error("スポットが見つかりませんでした。条件を変えて再試行してください。");
        setSuggestions(payload.routes);
        setTransportStamp({ date: departureDate, time: departureTime });
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
          <p className="eyebrow">MAKE IT YOUR DAY</p>
          <h1>行きたいをつないで、<br /><em>私らしい一日</em>に。</h1>
          <p className="hero-description">
            発着地、使える時間と予算、好きな過ごし方から。<br className="desktop-break" />
            あなたに合う寄り道を提案し、大切な予定を残して調整できます。
          </p>
        </div>
        <div className="hero-stamp" aria-hidden="true"><span>旅</span><small>WANDER<br />WITH CARE</small></div>
      </section>

      <JourneyFileControls plan={isOvernight ? null : dayTripPlan} title={suggestions[0]?.title ?? "私のよりみち"} busy={searching} onImport={importJourney} />

      {showIdeaDeck && origin ? (
        <IdeaDeck
          origin={origin}
          departureDate={departureDate}
          departureTime={departureTime}
          onActivePlacesChange={() => {}}
          onItineraryChange={itinerary => {
            setSuggestions([{ ...itinerary, title: "選んだ寄り道の旅程", story: null,
              total_minutes: itinerary.estimated_total_minutes === null ? null : Math.max(0, itinerary.estimated_total_minutes - itinerary.places.length * 90),
              departure_time: departureTime, arrival_time: null }]);
            setCustomOrigin(itinerary.origin); setOriginName(itinerary.origin.name);
            setTransportStamp({ date: departureDate, time: departureTime });
            setDayTripPlan(null); setTripSession(Date.now()); setShowIdeaDeck(false);
          }}
          onClose={() => {
            setShowIdeaDeck(false);
          }}
        />
      ) : null}

      {!isOvernight && suggestions[0]?.title && (
        <section className="route-copy-banner visible" aria-live="polite">
          <p className="eyebrow">YOUR JOURNEY</p>
          <h2>{dayTripPlan && (dayTripPlan.stops.length !== suggestions[0].places.length || dayTripPlan.stops.some((stop, index) => stop.place.id !== suggestions[0].places[index]?.id))
            ? `${dayTripPlan.stops.map(stop => stop.place.name).join("と") || "寄り道を追加しましょう"}の旅程` : suggestions[0].title}</h2>
          <p>行き先をつなぎ、大切な予定を残して、あなたのペースに。</p>
        </section>
      )}

      {hasResult && (
        <div className="hero-map">
          <LazyMapView
            places={mapPlaces}
            origin={isOvernight ? overnightSuggestion?.origin ?? origin : dayTripPlan?.origin ?? origin}
            returnTo={isOvernight ? null : dayTripPlan?.returnTo ?? returnTo}
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
              disabled={hasCompleted}
              onClick={() => setIsOvernight(true)}
            >1泊2日</button>
          </div>

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
            {!isOvernight && hasResult && <p className="trip-selected-note"><strong>選んだスポットを保持しています</strong>{(dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0]?.places ?? []).map(place => place.name).join(" → ")}<br />行き先の追加・入れ替えは下の旅程から操作できます。</p>}
            {isOvernight && <fieldset className="theme-picker">
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
            </fieldset>}
            {!isOvernight && <fieldset className="trip-preferences">
              <legend>好きな過ごし方 <small>複数選べます</small></legend>
              <div className="trip-preference-options">{PREFERENCE_OPTIONS.map(item => <label key={item.value} className={preferences.includes(item.value) ? "selected" : ""}>
                <input type="checkbox" checked={preferences.includes(item.value)} disabled={searching} onChange={event => setPreferences(current => event.target.checked ? [...current, item.value] : current.filter(value => value !== item.value))} />
                <span>{item.label}</span>
              </label>)}</div>
              <small>{hasResult ? "行き先は保持し、おすすめの理由を更新します。" : "好みに合う場所を優先します。未選択なら、発着地から近い候補で提案します。"}</small>
            </fieldset>}

            <div className="form-fields">
              <div className="trip-station-fields">
                <StationSearch label="出発駅" value={origin} options={endpointOptions} onChange={station => { setCustomOrigin(station); setOriginName(station.name); }} disabled={loading || searching || locating || hasCompleted} />
                <button className="location-button" type="button" onClick={handleUseCurrentLocation} disabled={loading || searching || locating || hasCompleted}>{locating ? "取得中…" : "現在地から探す"}</button>
                <small>{hasCompleted ? "出発情報は訪問済みの記録に合わせて保持しています。変更する場合は、訪問済みを解除してください。" : "登録済みの駅を選ぶか、駅名を入力して候補から選べます。"}</small>
                {locationError && <small className="location-error" role="alert">{locationError}</small>}
              </div>
              {!isOvernight && <div className="trip-return-fields">
                <label className="trip-same-return"><input type="checkbox" checked={returnSame} onChange={event => setReturnSame(event.target.checked)} disabled={searching} />出発駅に戻る</label>
                {!returnSame && <><StationSearch label="帰着駅" value={returnTo} options={endpointOptions} onChange={station => { setCustomReturn(station); setReturnName(station.name); }} disabled={loading || searching} /><small>最後の寄り道から、この駅までの移動を含めます。</small></>}
              </div>}
              {!isOvernight && !hasResult && <div className="trip-initial-constraints">
                <div className="trip-initial-grid"><label><span>使える時間（分）</span><input type="number" min="30" max="720" step="1" value={initialMinutes} onChange={event => setInitialMinutes(event.target.value)} required /><small>出発から帰着まで · 30〜720分</small></label>
                <label><span>1人あたりの予算（円）</span><input type="number" min="0" max="50000" step="1" value={initialBudget} onChange={event => setInitialBudget(event.target.value)} required /><small>交通・施設・飲食を含む目標</small></label></div>
                <details className="trip-planning-estimates"><summary>提案用の見積もりを確認・変更</summary>
                  <p>以下は計画用の仮見積もりで、実際の料金ではありません。食事・カフェ候補の選び方に使います。空欄は未確認として扱います。</p>
                  <div className="trip-initial-grid"><label>食事1か所（円）<input type="number" min="0" max="50000" value={foodEstimate} onChange={event => setFoodEstimate(event.target.value)} placeholder="未確認" /></label><label>カフェ1か所（円）<input type="number" min="0" max="50000" value={coffeeEstimate} onChange={event => setCoffeeEstimate(event.target.value)} placeholder="未確認" /></label><label>交通費全体（円）<input type="number" min="0" max="50000" value={initialTransportEstimate} onChange={event => setInitialTransportEstimate(event.target.value)} placeholder="経路検索で確認" /></label></div>
                </details>
                <p className="trip-initial-note">食事1か所 {foodEstimate.trim() ? `${Number(foodEstimate).toLocaleString("ja-JP")}円` : "未確認"}・カフェ1か所 {coffeeEstimate.trim() ? `${Number(coffeeEstimate).toLocaleString("ja-JP")}円` : "未確認"}で仮計算。施設料金は未確認、移動時間は徒歩換算です。</p>
              </div>}
              <details className="form-advanced">
                <summary>
                  詳細設定：{departureDate} {departureTime}出発
                </summary>
                <div className="form-advanced-fields">
                  <label>
                    <span>出発日</span>
                    <input type="date" value={departureDate} onChange={(event) => setDepartureDate(event.target.value)} disabled={searching || hasCompleted} required />
                  </label>
                  <label>
                    <span>出発時刻</span>
                    <input type="time" value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} disabled={searching || hasCompleted} required />
                  </label>
                  {(!hasResult || isOvernight) && <label>
                    <span>{isOvernight ? "1日あたりの立ち寄り先" : "立ち寄り先"}</span>
                    <select value={stopCount} onChange={(event) => setStopCount(Number(event.target.value))} disabled={searching}>
                      <option value={1}>1か所</option>
                      <option value={2}>2か所</option>
                      <option value={3}>3か所</option>
                    </select>
                  </label>}
                </div>
              </details>
            </div>

            {!validDeparture && <p className="trip-pending" role="status">出発日と出発時刻を入力してください。入力中は直前の有効な日時を保持します。</p>}
            <button className="submit-button" type="submit" disabled={searching || loading || !validDeparture}>
              {searching ? <><span className="button-spinner" /> 実際の経路を検索しています</> : <>{!isOvernight ? hasResult ? "選んだスポットの交通経路を検索" : "この条件で旅程を提案する" : "旅のしおりを作る"} <span>↗</span></>}
            </button>
            <p className="form-footnote">{isOvernight ? "宿泊プランの検索は外部APIを利用します。" : "日帰りの提案・編集はこの端末内で計算します。交通経路の検索ボタンを押すと、外部APIで公共交通を確認します。"}</p>
          </form>

          {searching && <ProgressStatus steps={isOvernight ? OVERNIGHT_STEPS : ROUTE_STEPS} />}
          {error && !hasResult && <div className="error-panel" role="alert"><strong>ルートを表示できません</strong><span>{error}</span><button type="button" className="error-retry-button" disabled={searching || loading || !validDeparture} onClick={() => formRef.current?.requestSubmit()}>再試行</button></div>}
        </section>

      </div>

      {hasResult && (
        <div className="timeline-area" ref={timelineAreaRef}>
          {!isOvernight && <div className="journey-save-status" role="status">
            <span aria-hidden="true">{draftSaved ? "✓" : "!"}</span>
            <span>{draftRestored ? "前回の旅程を復元しました。続きから編集できます。" : draftSaved ? "このブラウザに自動保存しています。次回も続きから。" : "このブラウザには保存できません。しおりをコピーして残してください。"}</span>
            {draftRestored && <button type="button" onClick={() => setDraftRestored(false)} aria-label="復元のお知らせを閉じる">✕</button>}
          </div>}
          {departureDate < localDateInputValue() && <p className="error-panel" role="status">出発日が過去になっています。「条件を変更する」から日付を確認し、交通経路を再検索してください。</p>}
          <section className="results-section" aria-live="polite">
            <div className="section-heading results-heading">
              <div><p className="eyebrow">MY DAY TRIP</p><h2>私の旅のしおり</h2></div>
              <span className="result-date">{isOvernight ? departureDate : editorDate}</span>
            </div>
            {error && <div className="error-panel" role="alert"><strong>{isOvernight ? "ルートを表示できません" : "交通情報を更新できません"}</strong><span>{error} 現在の旅程は保持しています。</span><button type="button" className="error-retry-button" disabled={searching || loading || !validDeparture} onClick={() => formRef.current?.requestSubmit()}>再試行</button></div>}

        {isOvernight && overnightSuggestion && (
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

        {!isOvernight && suggestions[0] && (
          <div className="route-options">
            <DayTripEditor key={tripSession} source={suggestions[0]} sourceDate={transportStamp.date} sourceTime={transportStamp.time}
              origin={origin ?? suggestions[0].origin} returnTo={returnTo ?? origin ?? suggestions[0].origin} preferences={preferences} date={editorDate} departureTime={editorTime} candidates={editingCandidates}
              initialDwellMinutes={preset?.nonce === tripSession ? preset.dwellMinutes : undefined} initialPlan={dayTripPlan} busy={searching} onPlanChange={setDayTripPlan} />
            <div className="route-swipe-controls">
              <p className="route-swipe-hint">行き先と固定内容を保って、交通経路を確認できます。</p>
              <button className="regenerate-button" type="button" onClick={() => void handleRegenerate()} disabled={searching || loading || !validDeparture || dayTripPlan?.stops.length === 0}>
                {searching ? <><span className="button-spinner" /> 交通経路を検索しています</> : <>交通経路を再検索 <span>↻</span></>}
              </button>
              <button className="trip-start-over" type="button" disabled={searching} onClick={() => setConfirmStartOver(true)}>新しい旅程を作る</button>
            </div>
          </div>
        )}
          </section>
        </div>
      )}
      {confirmStartOver && <TripDialog title="新しい旅程を作りますか？" onClose={() => setConfirmStartOver(false)}>
        <p>現在の下書きを閉じ、行き先を選び直します。固定した予定も解除されます。残したい予定は「しおりを見る」からコピーしてください。</p>
        <div className="trip-dialog-actions"><button type="button" className="trip-primary" onClick={() => {
          const cleared = clearJourneyDraft(); setDraftRestored(false); setDraftSaved(false);
          if (!cleared) setError("ブラウザ内の前回の下書きを削除できませんでした。再読み込みすると前回の旅程が復元される場合があります。");
          setSuggestions([]); setDayTripPlan(null); setTripSession(Date.now()); setFormCollapsed(false); setConfirmStartOver(false);
        }}>下書きを閉じて新しく作る</button><button type="button" onClick={() => setConfirmStartOver(false)}>今の旅程を残す</button></div>
      </TripDialog>}
    </div>
  );
}
