import { JourneyChat } from "./JourneyChat";
import { FacilityPhoto } from "./FacilityPhoto";
import { TripTransit } from "./TripTransit";
import { OvernightSuggestion } from "./OvernightSuggestion";
import { lockBodyScroll } from "./bodyScrollLock";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Origin, Place, Preference, RouteSuggestion } from "./types";
import { facilityAllowance, transportMatches, completeNextStop, completedStopCount, undoLastCompletedStop, distanceKm, minimumDwell, MAX_TRIP_STOPS, newTripStop, readTripNumber, scheduleTrip, tripChanges, tripClock, clockMinutes } from "./dayTrip";
import type { TripPlan, TripStop } from "./dayTrip";
import { preferenceReason } from "./tripPreferences";
import { VenueEvidence } from "./VenueEvidence";
import { JourneyReview } from "./JourneyReview";
import { ItineraryAudit } from "./ItineraryAudit";
import { isRouteSuggestion, isRecord } from "./apiValidation";
import { toFriendlyMessage } from "./friendlyError";
import { useGoogleVenueInfo } from "./discover/useGoogleVenueInfo";
import { openingConflict } from "./venueHours";

const yen = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const costLabel = (plan: TripPlan) => plan.totalCost === null ? `合計未確認（概算 ${yen(plan.knownCost)}）` : `概算 ${yen(plan.totalCost)}`;
const durationLabel = (minutes: number) => `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}時間` : ""}${minutes % 60 || !minutes ? `${minutes % 60}分` : ""}`;

function isRoundTrip(plan: TripPlan) {
  return plan.origin.latitude === plan.returnTo.latitude && plan.origin.longitude === plan.returnTo.longitude;
}

function endpointsLabel(plan: TripPlan) {
  return isRoundTrip(plan)
    ? `${plan.origin.name}発着` : `${plan.origin.name}発 → ${plan.returnTo.name}着`;
}

function tripBookmark(plan: TripPlan) {
  return [
    `旅のしおり｜${plan.date}`,
    `${endpointsLabel(plan)} · ${plan.stops.length}か所`,
    `出発 ${plan.input.departureTime} → 帰着目安 ${plan.unknownTravelSegments?.length ? "交通情報未確認" : tripClock(plan.returnMinute)}`,
    `使える時間 ${durationLabel(plan.input.availableMinutes)} · 1人あたり予算 ${yen(plan.input.budget)}`,
    `費用：${costLabel(plan)}${plan.unknownCosts ? ` · ${plan.unknownCosts}項目が未入力・未確認` : ""}`,
    "",
    ...plan.stops.flatMap((stop, index) => [
      `${index + 1}. ${plan.unknownTravelSegments?.length && !stop.completed ? "時刻未確認" : `${tripClock(stop.start)}–${tripClock(stop.end)}`} ${stop.place.name}${stop.completed ? "［訪問済み］" : stop.locked ? "［固定］" : ""}`,
      `前の地点から${plan.unknownTravelSegments?.includes(index) ? "移動時間未確認" : `約${stop.travel}分`} · 滞在${stop.dwellMinutes}分${stop.wait ? ` · 待ち${stop.wait}分` : ""}`,
      `施設・飲食費：${stop.spending === null ? `ジャンル別の目安 ${yen(facilityAllowance(stop.place))}` : `利用者見積 ${yen(stop.spending)}`}${stop.anchorTime ? ` · ${stop.anchorTime}開始を指定` : ""}`,
      `この場所をおすすめする理由：${preferenceReason(stop.place, plan.input.preferences)}`,
      ...(stop.place.address ? [stop.place.address] : []),
    ]),
    "",
    `帰りは${plan.unknownTravelSegments?.length ? "交通情報未確認" : `約${plan.returnTravel}分 → ${tripClock(plan.returnMinute)}`} ${plan.returnTo.name}`,
    `${isRoundTrip(plan) ? "往復交通費" : "全区間の交通費"}：${plan.travelCost === null ? "未確認" : `${yen(plan.travelCost)}（${plan.transportEstimate === null ? "取得運賃・未取得区間は仮置き" : "利用者見積もり"}）`}`,
    plan.estimatedTravel ? "移動は直線距離からの徒歩概算です。交通経路は再検索してください。" : "取得済み区間は交通検索の所要時間、区間情報がない場合は合計時間からの概算です。",
    "営業時間・実際の発着時刻は未確認です。出発前に確認してください。",
    ...plan.violations.map(message => `確認：${message}`),
  ].join("\n");
}

export function TripDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const unlockScroll = lockBodyScroll();

    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { unlockScroll(); document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="trip-dialog-backdrop" onClick={onClose}>
    <section className="trip-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} onClick={event => event.stopPropagation()}>
      <header><h3>{title}</h3><button type="button" onClick={onClose} aria-label="ダイアログを閉じる">閉じる</button></header>
      {children}
    </section>
  </div>;
}

type Props = {
  source: RouteSuggestion;
  sourceDate: string;
  sourceTime: string;
  origin: Origin;
  returnTo?: Origin;
  preferences?: Preference[];
  date: string;
  departureTime: string;
  candidates: Place[];
  initialDwellMinutes?: Record<string, number>;
  initialAnchorTimes?: Record<string, string>;
  initialAvailableMinutes?: number;
  initialPlan?: TripPlan | null;
  busy?: boolean;
  onPlanChange: (plan: TripPlan) => void;
  routePriority?:"time"|"price";onRoutePriorityChange?:(value:"time"|"price")=>void;
  preferNearbyAirport?:boolean;onPreferNearbyAirportChange?:(value:boolean)=>void;
};

export function DayTripEditor({ source, sourceDate, sourceTime, origin, returnTo, preferences, date, departureTime, candidates, initialDwellMinutes, initialAnchorTimes, initialAvailableMinutes, initialPlan, busy, onPlanChange,routePriority:controlledPriority,onRoutePriorityChange,preferNearbyAirport:controlledAirport,onPreferNearbyAirportChange }: Props) {
  const destination = returnTo ?? initialPlan?.returnTo ?? origin;
  const currentPreferences = preferences ?? initialPlan?.input.preferences;
  const preferenceKey = JSON.stringify(currentPreferences ?? []);
  const originKey = JSON.stringify(origin);
  const destinationKey = JSON.stringify(destination);
  const [plan, setPlan] = useState(() => initialPlan ?? scheduleTrip(
    { departureTime, availableMinutes: initialAvailableMinutes ?? 360, budget: 5000, preferences: currentPreferences }, origin, date,
    source.places.map(place => ({ ...newTripStop(place, initialDwellMinutes?.[place.id]), anchorTime: initialAnchorTimes?.[place.id] ?? null })),
    { route: source, date: sourceDate, time: sourceTime }, null, destination,
  ));
  const [preview, setPreview] = useState<TripPlan | null>(null);
  const [localPriority,setLocalPriority]=useState<"time"|"price">("time");
  const [localAirport,setLocalAirport]=useState(true);
  const routePriority=controlledPriority??localPriority,preferNearbyAirport=controlledAirport??localAirport;
  const setRoutePriority=(value:"time"|"price")=>{setLocalPriority(value);onRoutePriorityChange?.(value);};
  const setPreferNearbyAirport=(value:boolean)=>{setLocalAirport(value);onPreferNearbyAirportChange?.(value);};
  const [history, setHistory] = useState<TripPlan[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [chooser, setChooser] = useState<{ swapId: string | null } | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchedPlaces, setSearchedPlaces] = useState<Place[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [relatedPlaces, setRelatedPlaces] = useState<Place[]>([]);
  const [candidateSuggestions, setCandidateSuggestions] = useState<string[]>([]);
  const [relatedNote, setRelatedNote] = useState("");
  const [relatedAvailable, setRelatedAvailable] = useState(false);
  const [candidateNote, setCandidateNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [transitState, setTransitState] = useState<"loading" | "ready" | "partial" | "failed">("loading");
  const googleInfos=useGoogleVenueInfo(plan.stops.map(s=>s.place).filter(p=>!['trip-arrival','trip-return'].includes(p.id)),transitState==="ready");
  const openingProblems=plan.stops.flatMap(s=>{
    const issue=openingConflict(googleInfos.find(info=>info.place_id===s.place.id),plan.date,s.start,s.dwellMinutes);
    return issue ? [`${s.place.name}：${issue}`] : [];
  });
  const [transitRetry, setTransitRetry] = useState(0);
  const [bookmarkOpen, setBookmarkOpen] = useState(false);
  const [visitDialog, setVisitDialog] = useState<"complete" | "undo" | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const candidateRequest = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousSource = useRef(source);
  const previousConditions = useRef({ originKey, destinationKey, date, departureTime, preferenceKey });

  useEffect(() => {
    if (previousSource.current === source) return;
    previousSource.current = source;
    setPlan(previous => ({ ...scheduleTrip(
      previous.input, previous.origin, previous.date,
      [...previous.stops.filter(stop => stop.completed), ...source.places.filter(place => !previous.stops.some(stop => stop.completed && stop.place.id === place.id)).slice(0, MAX_TRIP_STOPS - completedStopCount(previous.stops)).map(place => {
        const existing = previous.stops.find(stop => stop.place.id === place.id);
        return existing ? { ...existing, place } : newTripStop(place, initialDwellMinutes?.[place.id]);
      })],
      { route: source, date: sourceDate, time: sourceTime }, previous.transportEstimate, previous.returnTo,
    ), planningEstimates: previous.planningEstimates }));
    setPreview(null); setHistory([]); setEditId(null);
  }, [source, sourceDate, sourceTime, initialDwellMinutes]);
  useEffect(() => {
    const conditions = previousConditions.current;
    if (conditions.originKey === originKey && conditions.destinationKey === destinationKey && conditions.date === date
      && conditions.departureTime === departureTime && conditions.preferenceKey === preferenceKey) return;
    previousConditions.current = { originKey, destinationKey, date, departureTime, preferenceKey };
    setPlan(previous => ({ ...scheduleTrip(
      { ...previous.input,
        departureTime: conditions.departureTime === departureTime ? previous.input.departureTime : departureTime,
        preferences: conditions.preferenceKey === preferenceKey ? previous.input.preferences : currentPreferences,
      }, conditions.originKey === originKey ? previous.origin : origin, conditions.date === date ? previous.date : date,
      previous.stops, previous.transport, previous.transportEstimate,
      conditions.destinationKey === destinationKey ? previous.returnTo : destination,
    ), planningEstimates: previous.planningEstimates }));
    setPreview(null); setHistory([]);
  }, [originKey, destinationKey, date, departureTime, preferenceKey]);
  useEffect(() => { onPlanChange(plan); }, [plan, onPlanChange]);
  useEffect(() => () => candidateRequest.current?.abort(), []);
  useEffect(() => {
    candidateRequest.current?.abort(); candidateRequest.current = null;
    setSearching(false); setCandidateNote(""); setRelatedPlaces([]); setCandidateSuggestions([]); setRelatedNote(""); setRelatedAvailable(false);
  }, [search]);
  const transitKey = JSON.stringify([plan.origin, plan.returnTo, plan.date, plan.input.departureTime,routePriority,preferNearbyAirport,
    plan.stops.map(stop => [stop.place, stop.dwellMinutes, stop.anchorTime, stop.completed])]);
  const latestTransitKey = useRef(transitKey);
  latestTransitKey.current = transitKey;
  useEffect(() => {
    const controller = new AbortController();
    const snapshot = plan;
    let timeout: number | undefined;
    setTransitState("loading");
    const timer = window.setTimeout(async () => {
      setNotice("全区間の交通経路・運賃を確認中です…");
      let timedOut = false;
      timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
      try {
        const response = await fetch("/api/routes/preview", { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            origin: snapshot.origin, return_to: snapshot.returnTo, places: snapshot.stops.map(stop => stop.place),
            stay_minutes: snapshot.stops.map(stop => stop.dwellMinutes),
            meal_times: Object.fromEntries(snapshot.stops.filter(stop => stop.anchorTime).map(stop => [stop.place.id, stop.anchorTime])),
            departure_date: snapshot.date, departure_time: snapshot.input.departureTime,
            route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
          }) });
        if (!response.ok) throw new Error("交通検索を取得できませんでした。");
        const route: unknown = await response.json();
        if (!isRouteSuggestion(route)) throw new Error("交通検索の応答を確認できませんでした。");
        if (controller.signal.aborted || latestTransitKey.current !== transitKey) return;
        setPlan(current => ({ ...scheduleTrip(current.input, current.origin, current.date, current.stops,
          { route, date: current.date, time: current.input.departureTime }, current.transportEstimate, current.returnTo),
          planningEstimates: current.planningEstimates }));
        const complete = route.timeline?.filter(item => item.type === "transit").every(item => item.duration_minutes != null && !item.is_estimate) && route.total_minutes != null;
        setTransitState(complete ? "ready" : "partial");
        setNotice(complete ? "交通経路と所要時間を反映しました。" : "一部の経路を確認できませんでした。取得済みの経路は反映しています。");
      } catch {
        if (latestTransitKey.current === transitKey && (!controller.signal.aborted || timedOut)) {
          setTransitState("failed");
          setNotice("交通経路を確認できませんでした。現在の旅程を保持しています。再検索できます。");
        }
      } finally { window.clearTimeout(timeout); }
    }, 300);
    return () => { window.clearTimeout(timer); window.clearTimeout(timeout); controller.abort(); };
  }, [transitKey, transitRetry]);
  useEffect(() => {
    if (transitState !== "loading" && transportMatches(plan) && plan.transport.route.total_minutes != null
      && plan.transport.route.timeline?.filter(item => item.type === "transit").every(item => item.duration_minutes != null && !item.is_estimate)) setTransitState("ready");
  }, [plan.transport, transitState]);
  const candidateCenter = plan.stops.find(stop => stop.place.id === "trip-arrival")?.place ?? plan.stops[0]?.place ?? plan.origin;
  const options = useMemo(() => {
    const unique = new Map([...candidates, ...source.places, ...searchedPlaces].map(place => [place.id, place]));
    return [...unique.values()].filter(place => !plan.stops.some(stop => stop.place.id === place.id))
      .sort((first, second) => distanceKm(candidateCenter, first) - distanceKm(candidateCenter, second));
  }, [candidates, source.places, searchedPlaces, plan.stops, candidateCenter]);
  const visibleOptions = useMemo(() => {
    const query = search.trim().normalize("NFKC").toLocaleLowerCase("ja-JP");
    if (!query) return options;
    const searchIds = new Set(search.trim() === searchedQuery ? searchedPlaces.map(place => place.id) : []);
    return options.filter(place => searchIds.has(place.id)
      || `${place.name} ${place.category} ${place.address ?? ""}`.normalize("NFKC").toLocaleLowerCase("ja-JP").includes(query));
  }, [options, search, searchedPlaces, searchedQuery]);

  function applyTransit(index: number, result: import("./types").RouteTimelineTransit) {
    setPlan(plan => {
    const points = [plan.origin, ...plan.stops.map(stop => stop.place), plan.returnTo];
    const existing = transportMatches(plan) ? plan.transport.route.timeline?.filter(item => item.type === "transit") ?? [] : [];
    const timeline = points.slice(1).map((point, i) => i === index ? result : existing[i] ?? {
      type: "transit" as const, from_name: points[i].name, to_name: point.name, mode: "public_transport" as const,
      start_time: null, end_time: null, duration_minutes: null, is_estimate: true, fare_yen: null,
    });
    const total = timeline.every(item => item.duration_minutes !== null && !item.is_estimate)
      ? timeline.reduce((sum, item) => sum + item.duration_minutes!, 0) : null;
    const fare = timeline.every(item => item.fare_yen != null) ? timeline.reduce((sum, item) => sum + item.fare_yen!, 0) : null;
    const route = { ...plan.transport.route, origin: plan.origin, return_to: plan.returnTo, places: plan.stops.map(stop => stop.place),
      timeline, legs: timeline.flatMap(item => item.legs ?? []), total_minutes: total, fare_yen: fare };
    return { ...scheduleTrip(plan.input, plan.origin, plan.date, plan.stops,
      { route, date: plan.date, time: plan.input.departureTime }, plan.transportEstimate, plan.returnTo), planningEstimates: plan.planningEstimates };
    });
    setNotice("区間の経路・概算運賃を反映しました。");
  }
  function compute(stops: TripStop[], estimate = plan.transportEstimate) {
    return { ...scheduleTrip(plan.input, plan.origin, plan.date, stops, plan.transport, estimate, plan.returnTo), planningEstimates: plan.planningEstimates };
  }
  function adopt(next: TripPlan, message = "変更を旅程に反映しました。") {
    // Visit records can only change through their explicit confirmation dialog.
    // Discard older edit history at that boundary so ordinary Undo cannot erase it.
    const visitRecordChanged = completedStopCount(next.stops) !== completedStopCount(plan.stops);
    setHistory(current => visitRecordChanged ? [] : [...current.slice(-19), plan]);
    setPlan(next); setPreview(null); setEditId(null); setError(null); setNotice(message);
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  }
  function editStop(event: FormEvent<HTMLFormElement>, stop: TripStop) {
    event.preventDefault();
    if (stop.completed) return;
    try {
      const data = new FormData(event.currentTarget);
      const dwellMinutes = readTripNumber(String(data.get("dwell") ?? ""), "滞在時間", minimumDwell(stop.place), 360);
      const anchorTime = String(data.get("anchor") ?? "") || null;
      if (anchorTime && clockMinutes(anchorTime) < clockMinutes(plan.input.departureTime)) throw new Error("固定開始時刻は出発以降にしてください。");
      const spendingText = String(data.get("spending") ?? "");
      const spending = spendingText === "" ? null : readTripNumber(spendingText, "施設・飲食の見積もり", 0, 50000);
      const locked = data.get("locked") === "on" || anchorTime !== null;
      setPreview(compute(plan.stops.map(item => item.place.id === stop.place.id ? { ...item, dwellMinutes, anchorTime, spending, locked } : item)));
      setError(null);
    } catch (cause) { setError(toFriendlyMessage(cause)); }
  }
  function closeChooser() { candidateRequest.current?.abort(); candidateRequest.current = null; setSearching(false); setChooser(null); }
  async function findCandidates(event: FormEvent, includeRelated = false) {
    event.preventDefault();
    if (!search.trim() || searching) return;
    const controller = new AbortController();
    candidateRequest.current?.abort(); candidateRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    setSearching(true); setCandidateNote("");
    try {
      const response = await fetch("/api/search/places", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: search.trim(), center_latitude: candidateCenter.latitude, center_longitude: candidateCenter.longitude, include_related: includeRelated }), signal: controller.signal });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(data) && typeof data.detail === "string" ? data.detail : "候補を取得できませんでした。");
      if (!isRecord(data) || !Array.isArray(data.results)) throw new Error("候補の形式を確認できませんでした。");
      function readCandidates(hits: unknown[]): Place[] {
      const found: Place[] = [];
      for (const hit of hits) {
        if (!isRecord(hit) || !isRecord(hit.place)) continue;
        const place = hit.place;
        if (typeof place.id !== "string" || typeof place.name !== "string" || typeof place.latitude !== "number" || typeof place.longitude !== "number"
          || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180) continue;
        found.push({ id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude, category: typeof place.category === "string" ? place.category : "",
          address: typeof place.address === "string" ? place.address : "", description: typeof place.description === "string" ? place.description : "", access_point: "", themes: [], tags: isRecord(place.tags) ? Object.fromEntries(Object.entries(place.tags).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined });
      }
      return found;
      }
      const found = readCandidates(data.results);
      if (controller.signal.aborted || candidateRequest.current !== controller) return;
      setSearchedPlaces(found);
      setRelatedPlaces(Array.isArray(data.related_results) ? readCandidates(data.related_results) : []);
      setRelatedNote(typeof data.related_note === "string" ? data.related_note : "");
      setRelatedAvailable(data.related_available === true);
      setCandidateSuggestions(Array.isArray(data.suggestions) ? data.suggestions.filter((s): s is string => typeof s === "string").slice(0, 3) : []);
      setSearchedQuery(search.trim());
      setCandidateNote(found.length ? `${found.length}件見つかりました。` : "候補が見つかりませんでした。検索語を変えてみてください。");
    } catch (cause) {
      if (candidateRequest.current === controller) setCandidateNote(controller.signal.aborted ? "候補の検索がタイムアウトしました。再度検索できます。" : toFriendlyMessage(cause));
    } finally { window.clearTimeout(timer); if (candidateRequest.current === controller) { candidateRequest.current = null; setSearching(false); } }
  }
  function chooseCandidate(place: Place) {
    if (!chooser) return;
    const next = newTripStop(place);
    const stops = chooser.swapId ? plan.stops.map(stop => stop.place.id === chooser.swapId ? next : stop) : [...plan.stops];
    if (!chooser.swapId) { const returnIndex = stops.findIndex(stop => stop.place.id === "trip-return"); stops.splice(returnIndex < 0 ? stops.length : returnIndex, 0, next); }
    closeChooser(); setPreview(compute(stops, null));
  }
  const lockedCount = plan.stops.filter(stop => stop.locked).length;
  const completedCount = completedStopCount(plan.stops);
  const deadline = clockMinutes(plan.input.departureTime) + plan.input.availableMinutes;
  const changes = preview ? tripChanges(plan, preview) : [];
  const unknownTravel = Boolean(plan.unknownTravelSegments?.length);
  const previewFitsTime = !preview || preview.input.availableMinutes === plan.input.availableMinutes || (!preview.unknownTravelSegments?.length && preview.returnMinute <= clockMinutes(preview.input.departureTime) + preview.input.availableMinutes);
  const usedMinutes = plan.returnMinute - clockMinutes(plan.input.departureTime);
  const urgentCount = plan.violations.filter(message => !message.includes("未入力・未確認") && !message.includes("立ち寄り先がありません")).length;
  const bookmark = tripBookmark(plan);
  async function copyBookmark() {
    try {
      await navigator.clipboard.writeText(bookmark);
      setCopyNotice("しおりをコピーしました。");
    } catch {
      setCopyNotice("コピーできませんでした。下のしおりを選択してコピーできます。");
    }
  }
  return <section className="trip-editor" aria-labelledby="trip-editor-title"><fieldset className="trip-controls" disabled={busy}>
    <header className="trip-heading"><div><h3 id="trip-editor-title" tabIndex={-1} ref={headingRef}>今日の旅を、あなたのペースで</h3></div>{lockedCount > 0 && <span className="trip-lock-count">{lockedCount}件を固定中</span>}</header>
    {completedCount > 0 && <p className="trip-completed-note"><strong>{completedCount}か所を訪問済み</strong> 記録した場所・時刻・滞在時間を保ち、これからの予定を調整します。</p>}
    <div className="trip-overview"><span>{plan.stops.length}か所の寄り道</span></div>
    <OvernightSuggestion plan={plan} pending={transitState === "loading"} />
    <div className="trip-route-options"><label>交通経路の優先<select value={routePriority} onChange={event=>setRoutePriority(event.target.value as "time"|"price")}><option value="time">速さ優先</option><option value="price">料金優先</option></select></label>
      {plan.stops.some(s=>distanceKm(plan.origin,s.place)>500) && <label className="route-airport-option"><input type="checkbox" checked={preferNearbyAirport} onChange={event=>setPreferNearbyAirport(event.target.checked)} />近くの空港を優先（那覇への往復）</label>}
    </div>
    <div className="trip-route-status" role="status" aria-live="polite">
      {transitState === "loading" ? "公共交通の経路と、旅全体の所要時間を確認しています…" : transitState === "ready" ? `移動・滞在を含む総時間 約${durationLabel(usedMinutes)}` : unknownTravel ? "一部の交通経路が未確認です。" : `移動・滞在を含む総時間（概算）約${durationLabel(usedMinutes)}。未確認の区間があります。`}
      {transitState !== "loading" && <button type="button" onClick={() => setTransitRetry(v => v + 1)}>全区間を再検索</button>}
    </div>
    <div className="trip-summary" aria-label="現在の旅程の概要">
      <div className={!unknownTravel && usedMinutes > plan.input.availableMinutes ? "is-over" : ""}><small>出発 → 帰着の目安</small><strong>{plan.input.departureTime}<span aria-hidden="true"> → </span>{unknownTravel ? "交通経路の確認後" : tripClock(plan.returnMinute)}</strong><span>目標 {tripClock(deadline)} · {unknownTravel ? "交通情報が未確認" : deadline >= plan.returnMinute ? `余裕 ${deadline - plan.returnMinute}分` : `${plan.returnMinute - deadline}分超過`}</span>{!unknownTravel && <div className="trip-meter" role="meter" aria-label="使える時間に対する予定時間" aria-valuemin={0} aria-valuemax={plan.input.availableMinutes} aria-valuenow={Math.min(usedMinutes, plan.input.availableMinutes)} aria-valuetext={`${usedMinutes}分 / ${plan.input.availableMinutes}分${usedMinutes > plan.input.availableMinutes ? `、${usedMinutes - plan.input.availableMinutes}分超過` : ""}`}><i style={{ width: `${Math.min(100, usedMinutes / plan.input.availableMinutes * 100)}%` }} /></div>}<span>移動 {unknownTravel ? "未確認" : `約${plan.travelMinutes}分`} · 滞在 {plan.stops.reduce((total, stop) => total + stop.dwellMinutes, 0)}分</span></div>
      <div className={plan.knownCost > plan.input.budget ? "is-over" : ""}><small>1人あたりの費用</small><strong>{plan.totalCost === null ? plan.knownCost > 0 ? <>{yen(plan.knownCost)}<em>概算</em></> : "合計未確認" : yen(plan.totalCost)}</strong><span>予算 {yen(plan.input.budget)} · {plan.totalCost === null ? `合計未確認（残り${plan.unknownCosts}項目）` : "交通・施設・飲食の概算合計"}</span><div className="trip-meter" role="meter" aria-label="予算に対する概算費用" aria-valuemin={0} aria-valuemax={Math.max(1, plan.input.budget)} aria-valuenow={Math.min(plan.knownCost, Math.max(1, plan.input.budget))} aria-valuetext={`概算 ${yen(plan.knownCost)} / 予算 ${yen(plan.input.budget)}${plan.totalCost === null ? "、合計未確認のため予算内かは未判定" : ""}`}><i style={{ width: `${plan.input.budget ? Math.min(100, plan.knownCost / plan.input.budget * 100) : plan.knownCost ? 100 : 0}%` }} /></div><span>{plan.knownCost > plan.input.budget ? `概算だけで ${yen(plan.knownCost - plan.input.budget)}超過` : plan.totalCost === null ? "未確認の費用を含め、予算内かは未判定" : `予算との差 ${yen(plan.input.budget - plan.knownCost)}`}</span></div>
    </div>
    {plan.violations.length > 0 && <details className={`trip-warnings${urgentCount ? " is-urgent" : ""}`} open={urgentCount > 0}><summary>{urgentCount ? `時間・予算の確認が${urgentCount}件あります` : !plan.stops.length ? "寄り道を追加して旅を始めましょう" : `費用の確認が必要です · ${plan.unknownCosts}項目`}</summary><ul>{plan.violations.map(message => <li key={message}>{message}</li>)}</ul>{lockedCount > 0 && <p>固定した予定は保持しています。収まらない場合は、条件や固定内容を見直してください。</p>}</details>}
    {error && <p className="trip-error" role="alert">{error}</p>}
    <p className={`trip-live-message${notice ? " has-message" : ""}`} role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    <details className="trip-method-details"><summary>移動・費用の見積もりについて</summary><div>
    <p className="trip-travel-note">{plan.estimatedTravel ? "移動は直線距離からの徒歩概算です。予定の入れ替え・削除後は交通経路を再検索してください。" : "取得済みの区間は交通検索の所要時間を使用しています。区間情報がない場合は合計時間からの概算です。"} 営業時間・実際の発着時刻は未確認です。</p>
    <p className="trip-travel-note">{isRoundTrip(plan) ? "往復交通費" : "全区間の交通費"}：{plan.travelCost === null ? "未確認" : `${yen(plan.travelCost)}（${plan.transportEstimate === null ? "取得運賃・未取得区間は仮置き" : "利用者見積もり"}）`}</p>
    <p className="trip-travel-note">旅程を開いたときや行き先・日時・滞在時間を変えたときに交通経路を確認します。施設・飲食費は利用者の見積もりで、無料と確認できた予定には0円を入力してください。</p>
    <p className="trip-travel-note">おすすめの理由は、登録ジャンル・名称・テーマと好みを照合した説明です。営業時間や体験の評価は含みません。</p>
    {!plan.estimatedTravel && plan.transport.route.legs.length > 0 && <details className="trip-cost-details"><summary>取得した全区間の交通経路を見る</summary><ol>{plan.transport.route.legs.map((leg, index) => <li key={index}><p>{leg.from_name} → {leg.to_name} · {leg.line_name}{leg.duration_minutes === null ? "" : `（約${leg.duration_minutes}分）`}</p></li>)}</ol><p>各施設での滞在を含めた実ダイヤではありません。実際の出発前に確認してください。</p></details>}
    </div></details>
    {openingProblems.length>0 && <div className="error-panel" role="status"><strong>営業時間に合わせた見直しが必要です</strong><ul>{openingProblems.map(p=><li key={p}>{p}</li>)}</ul><p>下の確認から修正案を探すか、施設を入れ替えてください。</p></div>}
    <details className="trip-check-toggle" open={openingProblems.length>0 || undefined}><summary>営業時間・移動を確認する</summary><ItineraryAudit plan={plan} onAdopt={next => adopt(next, "営業・移動を再確認した修正案を採用しました。ひとつ前に戻すこともできます。")} /></details>
    <JourneyChat routePriority={routePriority} preferNearbyAirport={preferNearbyAirport} plan={plan} candidates={options} disabled={busy || preview !== null} onApply={next => adopt(next, "チャットの変更案を旅程に反映しました。")} />
    <details><summary>施設の料金・出発前の情報も調べる</summary><JourneyReview places={plan.stops.map(stop => stop.place)} departureDate={plan.date} /></details>
    <div className="trip-timeline-heading"><h4>今日のタイムライン</h4><button type="button" onClick={() => { setBookmarkOpen(true); setCopyNotice(""); }}>しおりを見る <span aria-hidden="true">↗</span></button></div>
    <div className="trip-departure"><time>{plan.input.departureTime}</time><div><strong>{plan.origin.name}を出発</strong></div><span aria-hidden="true">START</span></div>
    {!plan.stops.length && <div className="trip-empty"><span aria-hidden="true">＋</span><h4>次の寄り道を、ひとつ。</h4><p>下の「寄り道を追加」から行き先を選べます。<br />変更案を確認して、旅程に加えましょう。</p></div>}
    <ol className="trip-stops">
      {plan.stops.map((stop, index) => <li key={stop.place.id} data-spot-id={stop.place.id} className={`trip-stop${stop.completed ? " is-completed" : stop.locked ? " is-locked" : ""}`}>
        <TripTransit key={`${plan.date}:${plan.input.departureTime}:${JSON.stringify(plan.stops.map(item => [item.place.id, item.place.latitude, item.place.longitude, item.end]))}:${JSON.stringify(plan.origin)}:${index}`}
          from={index ? plan.stops[index - 1].place : plan.origin} to={stop.place} routePriority={routePriority} preferNearbyAirport={preferNearbyAirport} externalBusy={transitState === "loading"} date={plan.date}
          departureMinute={index ? plan.stops[index - 1].end : clockMinutes(plan.input.departureTime)}
          initial={transportMatches(plan) ? plan.transport.route.timeline?.filter(item => item.type === "transit")[index] : undefined}
          onResult={result => applyTransit(index, result)} />
        <article><FacilityPhoto place={stop.place} compact /><details className="trip-stop-fold"><summary><div className="trip-stop-header"><span className="trip-stop-number">{stop.completed ? "✓" : index + 1}</span><div><time>{unknownTravel && !stop.completed ? "交通経路の確認後に時刻を表示" : `${tripClock(stop.start)} — ${tripClock(stop.end)}`}{stop.completed ? "（記録）" : ""}</time><h4>{stop.place.name}</h4></div>{stop.completed ? <span className="trip-completed-badge">訪問済み</span> : stop.locked && <span className="trip-fixed-badge">固定中</span>}</div></summary>
          <div className="trip-recommendation"><strong>この場所をおすすめする理由</strong><p>{preferenceReason(stop.place, plan.input.preferences)}</p></div>
          <VenueEvidence place={stop.place} />
          <p className="trip-stop-meta">滞在 {stop.dwellMinutes}分 · {stop.spending === null ? `施設・飲食費の目安 ${yen(facilityAllowance(stop.place))}` : `利用者見積 ${yen(stop.spending)}`}{stop.anchorTime ? ` · ${stop.anchorTime}開始を指定` : ""}</p>
          {(stop.place.description || stop.place.address || stop.place.access_point) && <details className="trip-place-details"><summary aria-label={`${stop.place.name}の場所の詳細`}>場所の詳細{stop.place.category ? ` · ${stop.place.category}` : ""}</summary>{stop.place.description && <p>{stop.place.description}</p>}{stop.place.address && <p>{stop.place.address}</p>}{stop.place.access_point && <p>アクセス：{stop.place.access_point}</p>}</details>}
          <div className="trip-stop-actions">
            <button type="button" disabled={stop.completed} className={stop.locked ? "trip-pin active" : "trip-pin"} aria-pressed={stop.locked} aria-label={`${stop.place.name}${stop.locked ? "の固定を解除" : "を固定"}`} onClick={() => { if (!stop.completed) adopt(compute(plan.stops.map(item => item.place.id === stop.place.id ? { ...item, locked: !item.locked, anchorTime: item.locked ? null : item.anchorTime } : item)), stop.locked ? "固定を解除しました。" : "行き先と滞在時間を固定しました。"); }}>{stop.completed ? "記録を保護中" : stop.locked ? "● 固定中" : "○ 固定する"}</button>
            <button type="button" disabled={stop.completed} aria-expanded={editId === stop.place.id} aria-controls={`trip-edit-${index}`} aria-label={`${stop.place.name}の時間と費用を編集`} onClick={() => { setEditId(editId === stop.place.id ? null : stop.place.id); setError(null); }}>時間・費用</button>
            <button type="button" disabled={stop.locked} title={stop.locked ? "固定を解除すると入れ替えできます" : undefined} aria-label={`${stop.place.name}を入れ替える`} onClick={() => { setChooser({ swapId: stop.place.id }); setCandidateNote(""); }}>入れ替え</button>
            <button type="button" disabled={stop.locked} title={stop.locked ? "固定を解除すると削除できます" : undefined} aria-label={`${stop.place.name}を削除`} onClick={() => setPreview(compute(plan.stops.filter(item => item.place.id !== stop.place.id), null))}>削除</button>
          </div>
          {index === completedCount && <button type="button" className="trip-visit-button" aria-label={`${stop.place.name}を訪問済みにする`} onClick={() => setVisitDialog("complete")}>✓ 訪問済みにする</button>}
          {stop.completed && index === completedCount - 1 && <button type="button" className="trip-visit-undo" aria-label={`${stop.place.name}の訪問済みを解除`} onClick={() => setVisitDialog("undo")}>訪問済みを解除する</button>}
          {stop.locked && <p className="trip-fixed-help">{stop.completed ? "場所・開始・終了時刻・滞在時間を記録して保護しています。" : stop.anchorTime ? "開始時刻を指定 · 行き先・滞在時間を保持" : "行き先・滞在時間を保持 · 開始時刻は移動により変わります"}</p>}
          {editId === stop.place.id && <form className="trip-stop-edit" id={`trip-edit-${index}`} key={`${stop.place.id}-${stop.dwellMinutes}-${stop.spending}-${stop.anchorTime}`} onSubmit={event => editStop(event, stop)}>
            <div className="trip-field-grid"><label>滞在時間（分）<input name="dwell" type="number" min={minimumDwell(stop.place)} max="360" defaultValue={stop.dwellMinutes} required /></label><label>固定開始時刻（任意）<input name="anchor" type="time" defaultValue={stop.anchorTime ?? ""} /></label><label>施設・飲食の見積もり（円）<input name="spending" type="number" min="0" max="50000" defaultValue={stop.spending ?? facilityAllowance(stop.place)} placeholder="不明なら空欄" /></label></div>
            <label className="trip-checkbox"><input name="locked" type="checkbox" defaultChecked={stop.locked} />行き先と滞在時間を固定する</label><small>開始時刻を指定すると、この予定を固定します。費用は1人分の見積もりです。</small>
            <div className="trip-stop-actions"><button type="submit" className="trip-primary">変更を確認</button><button type="button" onClick={() => { setEditId(null); setError(null); }}>編集を閉じる</button></div>
          </form>}
        </details></article>
      </li>)}
    </ol>
    <TripTransit key={`return:${plan.date}:${JSON.stringify(plan.stops.map(item => [item.place.id, item.place.latitude, item.place.longitude, item.end]))}:${JSON.stringify(plan.returnTo)}`} from={plan.stops.at(-1)?.place ?? plan.origin} to={plan.returnTo} routePriority={routePriority} preferNearbyAirport={preferNearbyAirport} externalBusy={transitState === "loading"} date={plan.date} departureMinute={plan.stops.at(-1)?.end ?? clockMinutes(plan.input.departureTime)} initial={transportMatches(plan) ? plan.transport.route.timeline?.filter(item => item.type === "transit")[plan.stops.length] : undefined} onResult={result => applyTransit(plan.stops.length, result)} />
    <p className="trip-return"><span>{plan.unknownTravelSegments?.includes(plan.stops.length) ? "帰りの交通情報は未確認" : `帰りは約${plan.returnTravel}分`}</span><strong><time>{unknownTravel ? "交通経路の確認後" : tripClock(plan.returnMinute)}</time> {plan.returnTo.name}に帰着</strong><small>帰着時刻は目安です</small></p>
    <div className="trip-footer-actions"><button type="button" disabled={plan.stops.length >= MAX_TRIP_STOPS} onClick={() => { setChooser({ swapId: null }); setCandidateNote(""); }}>＋ 寄り道を追加</button><button type="button" disabled={history.length === 0} onClick={() => { const previous = history[history.length - 1]; if (!previous) return; setHistory(current => current.slice(0, -1)); setPlan(previous); setNotice("ひとつ前の旅程に戻しました。"); }}>ひとつ前に戻す</button></div>
    {plan.stops.length >= MAX_TRIP_STOPS && <p className="trip-travel-note">寄り道は8か所までです。入れ替え・削除して調整できます。</p>}
    {visitDialog && <TripDialog title={visitDialog === "complete" ? "訪問済みとして記録" : "訪問済みの記録を解除"} onClose={() => setVisitDialog(null)}>
      {visitDialog === "complete" ? <><p><strong>{plan.stops[completedCount]?.place.name}</strong></p><p>表示中の {tripClock(plan.stops[completedCount]?.start ?? 0)}〜{tripClock(plan.stops[completedCount]?.end ?? 0)} を記録します。以降の再計算では、この場所と時刻・滞在時間を変えません。</p><p>時刻を直す場合は、記録する前に「時間・費用」で調整してください。</p></> : <><p>{plan.stops[completedCount - 1]?.place.name} の訪問済みを解除します。場所と滞在時間の固定は残ります。</p><p>先の記録から順に解除すると、これまでの訪問順を保てます。</p></>}
      <div className="trip-dialog-actions"><button type="button" className="trip-primary" onClick={() => { adopt(visitDialog === "complete" ? completeNextStop(plan) : undoLastCompletedStop(plan), visitDialog === "complete" ? "訪問済みとして記録しました。これからの予定を調整できます。" : "訪問済みを解除しました。固定は残しています。"); setVisitDialog(null); }}>{visitDialog === "complete" ? "この時刻で記録する" : "訪問済みを解除する"}</button><button type="button" onClick={() => setVisitDialog(null)}>キャンセル</button></div>
    </TripDialog>}
    {bookmarkOpen && <TripDialog title="旅のしおり" onClose={() => setBookmarkOpen(false)}>
      <p>現在の旅程をテキストで持ち歩けます。時刻と費用は見積もりです。</p>
      <label>しおりの内容<textarea className="trip-bookmark" readOnly value={bookmark} onFocus={event => event.currentTarget.select()} rows={12} /></label>
      <p className="trip-copy-status" role="status" aria-live="polite">{copyNotice}</p>
      <div className="trip-dialog-actions"><button type="button" className="trip-primary" onClick={() => void copyBookmark()}>しおりをコピー</button><button type="button" onClick={() => setBookmarkOpen(false)}>旅程に戻る</button></div>
    </TripDialog>}
    {preview && <TripDialog title="旅程の変更を確認" onClose={() => setPreview(null)}>
      <p>反映するまで、現在の旅程はそのまま残ります。</p>
      <dl className="trip-comparison"><div><dt>帰着</dt><dd>{unknownTravel ? "時刻未確認" : tripClock(plan.returnMinute)} → <strong>{preview.unknownTravelSegments?.length ? "時刻未確認" : tripClock(preview.returnMinute)}</strong></dd></div><div><dt>費用</dt><dd>{costLabel(plan)} → <strong>{costLabel(preview)}</strong></dd></div><div><dt>予定</dt><dd>{plan.stops.length}か所 → <strong>{preview.stops.length}か所</strong>（固定 {preview.stops.filter(stop => stop.locked).length}件）</dd></div></dl>
      {changes.length ? <ul className="trip-change-list">{changes.map(message => <li key={message}>{message}</li>)}</ul> : <p>行き先・滞在時間に変更はありません。</p>}
      {!previewFitsTime && <p role="alert">この時間枠に収まる変更案がありません。元の旅程を残して、使える時間や固定した予定を見直してください。</p>}{preview.violations.length > 0 && <div className="trip-warnings"><strong>反映後も確認が必要です</strong><ul>{preview.violations.map(message => <li key={message}>{message}</li>)}</ul></div>}
      <div className="trip-dialog-actions"><button type="button" className="trip-primary" disabled={!previewFitsTime} onClick={() => adopt(preview)}>この変更を反映</button><button type="button" onClick={() => setPreview(null)}>現在の旅程を残す</button></div>
    </TripDialog>}
    {chooser && <TripDialog title={chooser.swapId ? "寄り道を入れ替える" : "寄り道を追加する"} onClose={closeChooser}>
      <p>施設名やジャンルで、周辺の寄り道を探せます。</p>
      <form className="trip-candidate-search" onSubmit={findCandidates}><label>候補を検索<input value={search} onChange={event => setSearch(event.target.value)} placeholder="例：カフェ、美術館、公園" maxLength={500} required /></label><button type="submit" aria-label="候補を検索" disabled={searching}>{searching ? "検索中…" : "ほかの候補も検索"}</button>{search && <button type="button" onClick={() => setSearch("")}>クリア</button>}</form>
      <p role="status">{candidateNote || `${visibleOptions.length}件の候補`}</p>
      {searchedQuery === search.trim() && candidateSuggestions.length > 0 && <aside className="trip-search-help"><strong>候補が少ないときは</strong><ul>{candidateSuggestions.filter(text => !text.includes("近隣の関連候補")).map(text => <li key={text}>{text}</li>)}</ul>{relatedAvailable && <button type="button" disabled={searching} onClick={event => void findCandidates(event, true)}>近隣の関連候補も探す</button>}</aside>}
      <div className="trip-candidates">{visibleOptions.map(place => <button type="button" key={place.id} onClick={() => chooseCandidate(place)}><strong>{place.name}</strong><small>{place.address || place.category || "施設・料金は未確認"} · 観光の起点から直線約{distanceKm(candidateCenter, place).toFixed(1)}km</small><span>この候補を選ぶ →</span></button>)}</div>
      {searchedQuery === search.trim() && relatedNote && <section className="trip-related-candidates" aria-label="近隣の関連候補"><h3>近隣の関連候補</h3><p className="trip-travel-note">{relatedNote}</p><div className="trip-candidates">{relatedPlaces.filter(place => !plan.stops.some(stop => stop.place.id === place.id) && !visibleOptions.some(item => item.id === place.id)).map(place => <button type="button" key={place.id} onClick={() => chooseCandidate(place)}><strong>{place.name}</strong><small>{place.address || place.category} · 関連候補</small><span>この候補を選ぶ →</span></button>)}</div>{!relatedPlaces.length && <p>近隣の関連候補も見つかりませんでした。地域やジャンルを変えてみてください。</p>}</section>}
      {!visibleOptions.length && !candidateNote && <p>一致する候補がありません。「ほかの候補も検索」で周辺を探せます。</p>}
    </TripDialog>}
  </fieldset></section>;
}

