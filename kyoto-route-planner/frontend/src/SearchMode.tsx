import { usePrefecture } from "./PrefectureContext";
import { distanceKm, transportMatches } from "./dayTrip";
import { currentLocation } from "./currentLocation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LazyMapView } from "./LazyMapView";
import { buildDayTimeline, RouteTimeline } from "./RouteTimeline";
import { DayTripEditor, TripDialog } from "./DayTripEditor";
import { JourneyFileControls } from "./JourneyFileControls";
import { StationSearch } from "./StationSearch";
import { TravelRangeControl } from "./TravelRangeControl";
import { readLegacySavedPlan, readSearchForm, saveLegacyPlan, saveSearchForm } from "./searchState";
import type { JourneyDraft } from "./journeyDraft";
import type { TripPlan } from "./dayTrip";
import { readTripNumber } from "./dayTrip";
import { createInitialTrip } from "./initialTrip";
import { PREFERENCE_OPTIONS } from "./tripPreferences";
import type { SearchPreset } from "./routeSelection";
import { clearJourneyDraft, readJourneyDraft, saveJourneyDraft } from "./journeyDraft";
import { localPlaces } from "./localPlaces";
import { favoriteId, useFavorites } from "./useFavorites";
import { savedJourney } from "./savedJourney";
import { parseOvernightSnapshot, savedOvernight, type OvernightSnapshot } from "./overnightFavorite";
import { fetchWithTimeout, readApiError as readError } from "./apiClient";
import "./dayTrip.css";
import { toFriendlyMessage } from "./friendlyError";
import { OVERNIGHT_STEPS, ProgressStatus, ROUTE_STEPS } from "./ProgressStatus";
import { isOrigin, isOvernightItinerary, isRecord, isRouteSuggestion, isRouteSuggestions, normalizeOvernightItinerary } from "./apiValidation";
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

function validDepartureDate(value: string) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
}
function submittedDeparture(form: HTMLFormElement | null, date: string, time: string) {
  const fields = form ? new FormData(form) : null;
  const departureDate = String(fields?.get("departure_date") ?? date);
  const departureTime = String(fields?.get("departure_time") ?? time);
  return { departureDate, departureTime, valid: validDepartureDate(departureDate) && /^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime) };
}

export type { SearchPreset } from "./routeSelection";

type SearchModeProps = {
  active: boolean;
  preset?: SearchPreset | null;
  editingOnly?: boolean;
  onDiscover?: () => void;
};

export function SearchMode({ active, preset, editingOnly = false, onDiscover }: SearchModeProps) {
  const { prefecture } = usePrefecture();
  const { favorites, saveFavorite, replaceFavorite, isFavorite } = useFavorites();
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [restoredDraft] = useState(readJourneyDraft);
  const [sourceFavoriteId, setSourceFavoriteId] = useState(restoredDraft?.sourceFavoriteId);
  const [savedForm] = useState(readSearchForm);
  const [legacyPlan] = useState(readLegacySavedPlan);
  const [planTitle, setPlanTitle] = useState(restoredDraft?.title ?? preset?.title ?? legacyPlan?.suggestions[0]?.title ?? "私のConcierGO");
  useEffect(() => {
    if (!preset) return;
    setSourceFavoriteId(preset.sourceFavoriteId);
    setPlanTitle(preset.title);
    setTheme(preset.theme);
    setStopCount(Math.min(3, Math.max(1, preset.stopCount)));
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
    setSearching(false);
    if (preset.overnightSnapshot) {
      try {
        const snapshot = parseOvernightSnapshot(preset.overnightSnapshot);
        clearJourneyDraft();
        setOvernightResult({ snapshot, theme: preset.theme });
        setIsOvernight(true); setOvernightSuggestion(snapshot.itinerary); setDayTripPlan(null); setSuggestions([]);
        setOriginName(snapshot.itinerary.origin.name); setCustomOrigin(snapshot.itinerary.origin);
        setDepartureDate(snapshot.departureDate); setDepartureTime(snapshot.departureTime);
        setNights(snapshot.nights); setStopCount(snapshot.stopsPerDay); setTravelRadius(snapshot.radius); setMood(snapshot.mood);
        setError(null); setSaveNotice("保存した宿泊旅程を開きました。交通情報は未確認です。"); setDraftRestored(false);
        setTripSession(preset.nonce); setTransportStamp({ date: "", time: "" });
      } catch (cause) { setError(toFriendlyMessage(cause)); }
      return;
    }
    setOriginName(preset.origin.name);
    setCustomOrigin(preset.origin);
    setReturnSame(!preset.returnTo || preset.origin.latitude === preset.returnTo.latitude && preset.origin.longitude === preset.returnTo.longitude);
    if (preset.returnTo) { setCustomReturn(preset.returnTo); setReturnName(preset.returnTo.name); }
    setPreferences(preset.theme === "nature" ? ["nature"] : preset.theme === "food" ? ["food"] : preset.theme === "all" ? [] : ["culture"]);
    if (preset.departureTime && !preset.tripPlan) setDepartureTime(preset.departureTime);
    setIsOvernight(false);
    setOvernightSuggestion(null);
    setDayTripPlan(preset.tripPlan ?? null);
    if (preset.tripPlan) {
      setDepartureDate(preset.tripPlan.date); setDepartureTime(preset.tripPlan.input.departureTime);
      setPreferences(preset.tripPlan.input.preferences ?? []);
    }
    setSaveNotice(null);
    setDraftRestored(false);
    setTripSession(preset.nonce);
    setSuggestions([{ origin: preset.origin, places: preset.places, legs: [], total_minutes: null,
      departure_time: null, arrival_time: null, fare_yen: null, title: preset.title, story: "選んだ行き先を引き継ぎ、交通経路を自動で確認します。", note: "交通経路を確認しています。" }]);
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
  const [nights, setNights] = useState(savedForm?.nights ?? 1);
  const [travelRadius, setTravelRadius] = useState(savedForm?.travelRadius ?? 30);
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>(() => restoredDraft ? [{ ...restoredDraft.plan.transport.route, title: restoredDraft.title }] : legacyPlan?.suggestions ?? []);
  const [dayTripPlan, setDayTripPlan] = useState<TripPlan | null>(restoredDraft?.plan ?? null);
  const [routePriority,setRoutePriority]=useState<"time"|"price">("time");
  const [preferNearbyAirport,setPreferNearbyAirport]=useState(true);
  const [tripSession, setTripSession] = useState(0);
  const [transportStamp, setTransportStamp] = useState(() => ({ date: restoredDraft?.plan.transport.date ?? "", time: restoredDraft?.plan.transport.time ?? "" }));
  const [draftRestored, setDraftRestored] = useState(Boolean(restoredDraft));
  const [draftSaved, setDraftSaved] = useState(Boolean(restoredDraft));
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [overnightSuggestion, setOvernightSuggestion] = useState<OvernightItinerarySuggestion | null>(restoredDraft ? null : legacyPlan?.overnightSuggestion ?? null);
  const [overnightResult, setOvernightResult] = useState<{ snapshot: OvernightSnapshot; theme: Theme } | null>(() => {
    if (!restoredDraft && legacyPlan?.overnightResult) return legacyPlan.overnightResult;
    if (restoredDraft || !legacyPlan?.overnightSuggestion || !savedForm) return null;
    try { return { theme: savedForm.theme, snapshot: parseOvernightSnapshot({ version: 1, itinerary: legacyPlan.overnightSuggestion,
      departureDate: savedForm.departureDate, departureTime: savedForm.departureTime, nights: legacyPlan.overnightSuggestion.days.length - 1,
      stopsPerDay: savedForm.stopCount, radius: savedForm.travelRadius ?? 30, mood: savedForm.mood }) }; } catch { return null; }
  });
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
      customOrigin, customReturn, returnSame, returnName, preferences, initialMinutes, initialBudget, foodEstimate, coffeeEstimate, initialTransportEstimate, nights, travelRadius });
  }, [originName, nearbyStations, theme, mood, stopCount, departureDate, departureTime, isOvernight, regenerationCount, customOrigin, customReturn, returnSame, returnName, preferences, initialMinutes, initialBudget, foodEstimate, coffeeEstimate, initialTransportEstimate, nights, travelRadius]);
  useEffect(() => { saveLegacyPlan(suggestions, overnightSuggestion, overnightResult); }, [suggestions, overnightSuggestion, overnightResult]);

  useEffect(() => {
    if (dayTripPlan) setDraftSaved(saveJourneyDraft(dayTripPlan, planTitle.trim() || "私のConcierGO", sourceFavoriteId));
  }, [dayTripPlan, planTitle, sourceFavoriteId]);
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
  const validDate = validDepartureDate(departureDate);
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

  const autoSearchNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!active || preset?.overnightSnapshot || !preset?.autoSearch || loading || autoSearchNonce.current === preset.nonce || !suggestions[0]
      || suggestions[0].places.map(p => p.id).join("|") !== preset.places.map(p => p.id).join("|")) return;
    autoSearchNonce.current = preset.nonce;
    formRef.current?.requestSubmit();
  }, [active, preset, loading, suggestions]);

  const locationGeneration = useRef(0);
  useEffect(() => { setLocating(false); return () => { locationGeneration.current++; }; }, [active, preset?.nonce]);
  async function handleUseCurrentLocation() {
    const generation = ++locationGeneration.current;
    setLocating(true); setLocationError(null);
    try {
      const coordinates = await currentLocation();
      if (generation !== locationGeneration.current) return;
      const position = { name: "現在地", ...coordinates };
      // Keep the actual position even when the station provider is unavailable.
      setCustomOrigin(position); setOriginName(position.name);
      try {
        const response = await fetchWithTimeout(`/api/nearby-stations?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}`, {}, INITIAL_DATA_TIMEOUT_MS);
        if (!response.ok) throw new Error("station lookup failed");
        const payload: unknown = await response.json();
        if (!Array.isArray(payload) || !payload.every(isOrigin)) throw new Error("invalid stations");
        if (generation !== locationGeneration.current) return;
        const stations = payload.filter(station => distanceKm(position, station) <= 20);
        setNearbyStations(stations);
        if (stations[0]) { setCustomOrigin(stations[0]); setOriginName(stations[0].name); }
        else setLocationError("現在地を出発地に設定しました。周辺駅は駅名から選べます。");
      } catch {
        if (generation === locationGeneration.current) setLocationError("現在地を出発地に設定しました。周辺駅の検索はできなかったため、必要なら駅名から選んでください。");
      }
    } catch (cause) {
      if (generation === locationGeneration.current) setLocationError(cause instanceof Error ? cause.message : "現在地を取得できませんでした。");
    } finally { if (generation === locationGeneration.current) setLocating(false); }
  }

  function importJourney(draft: JourneyDraft) {
    setPlanTitle(draft.title);
    setSourceFavoriteId(undefined);
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
    setIsOvernight(false); setOvernightSuggestion(null);
    setSuggestions([{ ...plan.transport.route, title: draft.title || "読み込んだ旅程" }]);
    setDayTripPlan(plan); setTransportStamp({ date: "", time: "" });
    setTripSession(current => current + 1); setDraftRestored(false); setError(null);
  }

  function proposeLocally(date = departureDate, time = departureTime) {
    try {
      if (!origin || !returnTo) throw new Error("出発駅と帰着駅を選んでください。");
      const optionalAmount = (value: string, label: string) => value.trim() === "" ? null : readTripNumber(value, label, 0, 50000);
      const plan = createInitialTrip({
        input: { departureTime: time, availableMinutes: readTripNumber(initialMinutes, "使える時間", 30, 720), budget: readTripNumber(initialBudget, "予算", 0, 50000), preferences },
        origin, returnTo, date, candidates: editingCandidates, maxStops: stopCount, radiusKm: travelRadius,
        foodEstimate: optionalAmount(foodEstimate, "食事の計画用見積もり"), coffeeEstimate: optionalAmount(coffeeEstimate, "カフェの計画用見積もり"), transportEstimate: optionalAmount(initialTransportEstimate, "交通費の計画用見積もり"),
      });
      if (!plan.stops.length) throw new Error(plan.violations.join(" ") || "この条件に合う候補がありません。時間や行き先を見直してください。");
      setPlanTitle(plan.transport.route.title ?? "私のConcierGO"); setSuggestions([plan.transport.route]); setDayTripPlan(plan); setOvernightSuggestion(null);
      setTransportStamp({ date: "", time: "" }); setTripSession(Date.now()); setDraftRestored(false); setError(null);
    } catch (cause) { setError(toFriendlyMessage(cause)); }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {

    event.preventDefault();
    if (searching || (editingOnly && !hasResult)) return;
    const submitted = submittedDeparture(event.currentTarget, departureDate, departureTime);
    if (!submitted.valid) { setError("出発日と出発時刻を入力してください。現在の旅程は保持しています。"); return; }
    const requestDate = submitted.departureDate, requestTime = submitted.departureTime;
    setDepartureDate(requestDate); setDepartureTime(requestTime);
    if (!isOvernight && !hasResult) { proposeLocally(requestDate, requestTime); return; }
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
        departure_date: requestDate,
        departure_time: requestTime,
        stops_per_day: stopCount,
        nights, radius_km: travelRadius,
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
          const snapshot = parseOvernightSnapshot({ version: 1, itinerary: payload, departureDate: request.departure_date,
            departureTime: request.departure_time, nights: request.nights, stopsPerDay: request.stops_per_day, radius: request.radius_km, mood });
          setOvernightResult({ snapshot, theme });
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
        departure_date: requestDate,
        departure_time: requestTime,
        variation: 0, radius_km: travelRadius,
        ...(suggestions[0] ? { selected_places: dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0].places } : {}),
      };

      try {
        const response = await fetchWithTimeout(dayTripPlan ? "/api/routes/preview" : "/api/routes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dayTripPlan ? {
            origin, return_to:returnTo, places:dayTripPlan.stops.map(stop=>stop.place),
            stay_minutes:dayTripPlan.stops.map(stop=>stop.dwellMinutes),
            meal_times:Object.fromEntries(dayTripPlan.stops.filter(stop=>stop.anchorTime).map(stop=>[stop.place.id,stop.anchorTime])),
            departure_date:requestDate,departure_time:requestTime,
            route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
          } : request),
          signal: controller.signal,
        }, REQUEST_TIMEOUT_MS);
        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const rawPayload: unknown = await response.json();
        const payload:unknown = dayTripPlan && isRouteSuggestion(rawPayload) ? {routes:[rawPayload]} : rawPayload;
        if (!isRouteSuggestions(payload)) {
          throw new Error("ルートAPIから有効な候補が返されませんでした。");
        }

        if (requestId === requestIdRef.current) {
          if (payload.routes.length === 0) throw new Error("スポットが見つかりませんでした。条件を変えて再試行してください。");
          setSuggestions(payload.routes.map((route, index) => ({ ...route, title: suggestions[index]?.title ?? route.title })));
          setOvernightSuggestion(null);
          setTransportStamp({ date: requestDate, time: requestTime });
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
    const submitted = submittedDeparture(formRef.current, departureDate, departureTime);
    if (!submitted.valid) { setError("出発日と出発時刻を入力してください。現在の旅程は保持しています。"); return; }
    const requestDate = submitted.departureDate, requestTime = submitted.departureTime;
    setDepartureDate(requestDate); setDepartureTime(requestTime);
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
      departure_date: requestDate,
      departure_time: requestTime,
      variation: nextRegenerationCount, radius_km: travelRadius,
      selected_places: dayTripPlan?.stops.map(stop => stop.place) ?? suggestions[0].places,
    };
    try {
      const response = await fetchWithTimeout(dayTripPlan ? "/api/routes/preview" : "/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dayTripPlan ? {
          origin, return_to:returnTo, places:dayTripPlan.stops.map(stop=>stop.place),
          stay_minutes:dayTripPlan.stops.map(stop=>stop.dwellMinutes),
          meal_times:Object.fromEntries(dayTripPlan.stops.filter(stop=>stop.anchorTime).map(stop=>[stop.place.id,stop.anchorTime])),
          departure_date:requestDate,departure_time:requestTime,
          route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
        } : request),
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) throw new Error(await readError(response));
      const rawPayload: unknown = await response.json();
      const payload:unknown = dayTripPlan && isRouteSuggestion(rawPayload) ? {routes:[rawPayload]} : rawPayload;
      if (!isRouteSuggestions(payload)) {
        throw new Error("ルートAPIから有効な候補が返されませんでした。");
      }
      if (requestId === requestIdRef.current) {
        if (payload.routes.length === 0) throw new Error("スポットが見つかりませんでした。条件を変えて再試行してください。");
        setSuggestions(payload.routes);
        setTransportStamp({ date: requestDate, time: requestTime });
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
      {!editingOnly && <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">MAKE IT YOUR DAY</p>
          <h1>{editingOnly ? <>選んだ旅を、<br /><em>自分らしく</em>整える。</> : <>行きたいをつないで、<br /><em>私らしい一日</em>に。</>}</h1>
          <p className="hero-description">
            {editingOnly ? "立ち寄り先や順番、滞在時間を調整しましょう。" : "発着地、時間と予算から、あなたに合う寄り道を提案します。"}
          </p>
        </div>
        <div className="hero-stamp" aria-hidden="true"><span>旅</span><small>WANDER<br />WITH CARE</small></div>
      </section>}

      <JourneyFileControls plan={isOvernight ? null : dayTripPlan} title={planTitle.trim() || "私のConcierGO"} busy={searching} onImport={importJourney} />

      {!isOvernight && suggestions[0]?.title && (
        <section className="route-copy-banner visible" aria-live="polite">
          <h2>{planTitle.trim() || "私のConcierGO"}</h2>
        </section>
      )}

      {hasResult && !isOvernight && <div id="journey-workspace-slot" className="journey-workspace-slot" />}
      {hasResult && (isOvernight || !dayTripPlan) && (
        <div className="hero-map" id="journey-map">
          <LazyMapView
            visible={active}
            places={mapPlaces}
            origin={isOvernight ? overnightSuggestion?.origin ?? origin : dayTripPlan?.origin ?? origin}
            returnTo={isOvernight ? null : dayTripPlan?.returnTo ?? returnTo}
            coordinates={mapCoordinates}
            legs={mapLegs}
            journeyDate={dayTripPlan?.date ?? departureDate}
            timeline={dayTripPlan ? transportMatches(dayTripPlan) ? dayTripPlan.transport.route.timeline ?? [] : [] : suggestions[0]?.timeline ?? []}
            mapTokens={(dayTripPlan ? transportMatches(dayTripPlan) ? dayTripPlan.transport.route.timeline ?? [] : [] : suggestions[0]?.timeline ?? []).flatMap(item => item.type === "transit" && item.map_token ? [item.map_token] : [])}
            fitDuration={1200}
            activeSpotId={activeSpotId}
          />
        </div>
      )}

      {editingOnly && !hasResult && <section className="discovery-question"><h2>{favorites.length ? "編集したい旅程を選びましょう" : "まずは、気になる旅を選びましょう"}</h2><p>{favorites.length ? "下の保存した旅程から選ぶか、新しい旅を見つけられます。" : "「見つける」で旅程を選ぶと、ここで行き先・順番・時間を編集できます。"}</p><button type="button" className="idea-primary-button" onClick={onDiscover}>旅を見つける →</button></section>}
      {(!editingOnly || hasResult) && <div className={`search-stage${hasResult ? " has-result" : ""}`}>
        {hasResult && <div className="trip-departure-fields" aria-label="旅の出発日時">
          <label>出発日<input name="departure_date" form="journey-conditions" type="date" value={departureDate} onChange={event=>setDepartureDate(event.target.value)} disabled={searching || hasCompleted} required /></label>
          <label>出発時刻<input name="departure_time" form="journey-conditions" type="time" value={departureTime} onChange={event=>setDepartureTime(event.target.value)} disabled={searching || hasCompleted} required /></label>
          <button type="button" className="idea-primary-button" disabled={searching || loading || !validDeparture || hasCompleted} onClick={()=>formRef.current?.requestSubmit()}>{searching ? "交通情報を更新中…" : "この日時で交通情報を更新"}</button>
        </div>}
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
              <h2 id="planner-title">{editingOnly ? "旅程の条件を編集" : "旅のプランを立てる"}</h2>
            </div>
            <span className="step-number">01 <i>/ 02</i></span>
          </div>

          {!editingOnly && <div className="plan-type-toggle">
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
            >宿泊あり</button>
          </div>

          }
          <form id="journey-conditions" ref={formRef} onSubmit={handleSubmit}>
            <div className="journey-form-intro"><span>01</span><div><strong>旅の条件を決めましょう</strong><p>行きたい場所と、過ごせる時間から。</p></div></div>
            <div className="journey-range-fields">
              <TravelRangeControl label="移動範囲・出発地からの半径（km）" value={travelRadius} onChange={setTravelRadius} disabled={searching} hint="県境を越えて、この範囲内の候補を探します。" />
              {isOvernight && <label>泊数<select value={nights} disabled={searching} onChange={event => setNights(Number(event.target.value))}>{[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}泊{n + 1}日</option>)}</select><small>同じ宿を拠点に提案します。経路検索は1日あたり最大2回です。</small></label>}
            </div>
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
                <StationSearch label="出発駅" value={origin} options={endpointOptions} onChange={station => { locationGeneration.current++; setLocating(false); setCustomOrigin(station); setOriginName(station.name); }} disabled={loading || searching || locating || hasCompleted} />
                <button className="location-button" type="button" onClick={handleUseCurrentLocation} disabled={loading || searching || locating || hasCompleted}>{locating ? "取得中…" : "現在地から探す"}</button>
                <small>{hasCompleted ? "出発情報は訪問済みの記録に合わせて保持しています。変更する場合は、訪問済みを解除してください。" : "登録済みの駅を選ぶか、駅名を入力して候補から選べます。"}</small>
                {locationError && <small className="location-error" role="alert">{locationError}</small>}
              </div>
              {!isOvernight && <div className="trip-return-fields">
                <label className="trip-same-return"><input type="checkbox" checked={returnSame} onChange={event => setReturnSame(event.target.checked)} disabled={searching} />出発駅に戻る</label>
                {<><StationSearch label="帰着駅" value={returnSame ? origin : returnTo} options={endpointOptions} onChange={station => { setCustomReturn(station); setReturnName(station.name); }} disabled={returnSame || loading || searching} /><small>{returnSame ? "出発駅と同じ駅に戻ります。" : "最後の寄り道から、この駅までの移動を含めます。"}</small></>}
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
                  {!hasResult && <label>
                    <span>出発日</span>
                    <input name="departure_date" type="date" value={departureDate} onChange={(event) => setDepartureDate(event.target.value)} disabled={searching || hasCompleted} required />
                  </label>}
                  {!hasResult && <label>
                    <span>出発時刻</span>
                    <input name="departure_time" type="time" value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} disabled={searching || hasCompleted} required />
                  </label>}
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


          {error && !hasResult && <div className="error-panel" role="alert"><strong>ルートを表示できません</strong><span>{error}</span><button type="button" className="error-retry-button" disabled={searching || loading || !validDeparture} onClick={() => formRef.current?.requestSubmit()}>再試行</button></div>}
        </section>

      </div>

      }
      {searching && <div className="journey-loading-overlay"><ProgressStatus steps={isOvernight ? OVERNIGHT_STEPS : ROUTE_STEPS} onCancel={() => { requestIdRef.current += 1; activeRequestRef.current?.abort(); setSearching(false); }} /></div>}
      {hasResult && (
        <div className="timeline-area" ref={timelineAreaRef} id="journey-timeline">
          {!isOvernight && (draftRestored || !draftSaved) && <div className="journey-save-status" role="status">
            <span aria-hidden="true">{draftSaved ? "✓" : "!"}</span>
            <span>{draftRestored ? "前回の旅程を復元しました。続きから編集できます。" : "このブラウザには保存できません。しおりをコピーして残してください。"}</span>
            {draftRestored && <button type="button" onClick={() => setDraftRestored(false)} aria-label="復元のお知らせを閉じる">✕</button>}
          </div>}
          {departureDate < localDateInputValue() && <p className="error-panel" role="status">出発日が過去になっています。上の「出発日」を変更し、交通情報を更新してください。</p>}
          <section className="results-section" aria-live="polite">
            <div className="section-heading results-heading">
              <div><h2>私の旅のしおり</h2>{!isOvernight && <label className="plan-title-input">プラン名<input maxLength={500} value={planTitle} placeholder="旅の名前を入力" onChange={event => setPlanTitle(event.target.value)} /></label>}</div>
              <button type="button" className="journey-save-button" disabled={searching || (isOvernight ? !overnightResult : !dayTripPlan?.stops.length)} onClick={() => {
                try {
                  const idea = isOvernight && overnightResult ? savedOvernight(overnightResult.snapshot, overnightResult.theme)
                    : dayTripPlan ? savedJourney(dayTripPlan, theme, planTitle) : null;
                  if (!idea) return;
                  if (sourceFavoriteId && favorites.some(favorite => favorite.id === sourceFavoriteId)) {
                    setSaveNotice(replaceFavorite(sourceFavoriteId, idea) ? "元のプランを更新しました。「編集済み」として保存しています。" : "元のプランを更新できませんでした。元の保存内容は保持しています。");
                    return;
                  }
                  if (isFavorite(idea)) { setSaveNotice("この旅程はすでに保存済みです。"); return; }
                  if (saveFavorite(idea)) {
                    setSourceFavoriteId(favoriteId(idea, idea.prefecture_code ?? prefecture.code));
                    setSaveNotice("保存しました。「保存済み」からいつでも開けます。");
                  } else setSaveNotice("保存できませんでした。画面上部の保存機能の案内をご確認ください。");
                } catch (cause) { setSaveNotice(toFriendlyMessage(cause, "旅程を保存できませんでした。しおりをコピーして残してください。")); }
              }}>♡ この旅程を保存</button>
              <span className="result-date">{isOvernight ? overnightResult?.snapshot.departureDate ?? overnightSuggestion?.days[0]?.date ?? departureDate : editorDate}</span>
            </div>
            {saveNotice && <p className="journey-save-notice" role="status">{saveNotice}</p>}
            {error && <div className="error-panel" role="alert"><strong>{isOvernight ? "ルートを表示できません" : "交通情報を更新できません"}</strong><span>{error} 現在の旅程は保持しています。</span><button type="button" className="error-retry-button" disabled={searching || loading || !validDeparture} onClick={() => formRef.current?.requestSubmit()}>再試行</button></div>}

        {isOvernight && overnightSuggestion && (
          <div className="route-options">
            <article className="route-option">
              <h3>{overnightSuggestion.days.length - 1}泊{overnightSuggestion.days.length}日宿泊プラン：{overnightSuggestion.hotel.name} に泊まる旅</h3>
              <div className="route-result">
                {overnightSuggestion.fare_yen !== undefined && (
                  <p className="fare-estimate" aria-live="polite">
                    <strong>{overnightSuggestion.days.length}日間の交通費概算（1人分）</strong>
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
              routePriority={routePriority} onRoutePriorityChange={setRoutePriority} preferNearbyAirport={preferNearbyAirport} onPreferNearbyAirportChange={setPreferNearbyAirport}
              origin={origin ?? suggestions[0].origin} returnTo={returnTo ?? origin ?? suggestions[0].origin} preferences={preferences} date={editorDate} departureTime={editorTime} candidates={editingCandidates}
              initialAnchorTimes={preset?.nonce === tripSession ? preset.anchorTimes : undefined} initialAvailableMinutes={preset?.nonce === tripSession ? preset.availableMinutes : undefined} initialDwellMinutes={preset?.nonce === tripSession ? preset.dwellMinutes : undefined} initialPlan={dayTripPlan} busy={searching} onPlanChange={setDayTripPlan} />
            <div className="route-swipe-controls">
              <button className="regenerate-button" type="button" onClick={() => void handleRegenerate()} disabled={searching || loading || !validDeparture || dayTripPlan?.stops.length === 0}>
                {searching ? <><span className="button-spinner" /> 交通経路を検索しています</> : <>交通経路を再検索 <span>↻</span></>}
              </button>
              <button className="trip-start-over" type="button" disabled={searching} onClick={() => editingOnly ? onDiscover?.() : setConfirmStartOver(true)}>{editingOnly ? "別の旅を見つける" : "新しい旅程を作る"}</button>
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
          setPlanTitle("私のConcierGO"); setSourceFavoriteId(undefined); setSuggestions([]); setDayTripPlan(null); setTripSession(Date.now()); setFormCollapsed(false); setConfirmStartOver(false);
        }}>下書きを閉じて新しく作る</button><button type="button" onClick={() => setConfirmStartOver(false)}>今の旅程を残す</button></div>
      </TripDialog>}
    </div>
  );
}
