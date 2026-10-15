import { transitRouteLabel } from "../TripTransit";
import { FacilityPhoto } from "../FacilityPhoto";
import { lockBodyScroll } from "../bodyScrollLock";
import { useEffect, useMemo, useRef, useState } from "react";
import { JourneyMap } from "../LazyMapView";
import type { RouteIdea } from "../SwipeCard";
import { routeSelection } from "../routeSelection";
import { buildRouteTimeline } from "../RouteTimeline";
import type { TimelineItem } from "../RouteTimeline";
import { isRecord, isRouteSuggestion } from "../apiValidation";
import type { RouteSuggestion } from "../types";
import type { DatasetRoute } from "./datasetTypes";
import { categoryIcon, formatMinutes } from "./DiscoverCard";
import { PlaceDescriptionToggle } from "./PlaceDetails";
import { placeRecommendation } from "./placeRecommendation";
import "./discover.css";
import { journeyOverview } from "./journeyStory";
import { JourneyReasons } from "./JourneyReasons";
import { useGoogleVenueInfo } from "./useGoogleVenueInfo";
import { openingConflict } from "../venueHours";

type RouteDetailModalProps = { route: DatasetRoute | RouteIdea; onClose: () => void; onPlanInSearch?: (route: DatasetRoute | RouteIdea) => void };

function addMinutes(time: string | null, minutes: number) {
  const match = time?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function RouteDetailModal({ route, onClose, onPlanInSearch }: RouteDetailModalProps) {
  const selection = useMemo(() => routeSelection(route), [route]);
  const { places, origin: start, dwellMinutes } = selection;
  const googleInfos = useGoogleVenueInfo(places, true);
  const itinerarySelection = useMemo(() => routeSelection(route, true), [route]);
  const [routeSuggestion, setRouteSuggestion] = useState<RouteSuggestion | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routePriority,setRoutePriority]=useState<"time"|"price">("time");
  const [preferNearbyAirport,setPreferNearbyAirport]=useState(true);
  const origin = itinerarySelection.origin;
  const previewPlaces = itinerarySelection.places;
  const previewDwell = itinerarySelection.dwellMinutes;
  const returnTo = selection.tripPlan?.returnTo ?? itinerarySelection.returnTo ?? origin;
  const departureTime = selection.tripPlan?.input.departureTime ?? itinerarySelection.departureTime ?? "09:00";
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  const journeyDate = selection.tripPlan?.date ?? today.toISOString().slice(0,10);
  const anchors = useMemo(() => selection.tripPlan
    ? Object.fromEntries(selection.tripPlan.stops.filter(stop => stop.anchorTime).map(stop => [stop.place.id, stop.anchorTime]))
    : itinerarySelection.anchorTimes ?? {}, [selection, itinerarySelection]);
  const includesTransfers = previewPlaces.length !== places.length;
  const isStaticRoute = "spots" in route;
  const estimatedTimeline = useMemo(() => "spots" in route ? buildRouteTimeline(start, places, route.departure_time ?? "09:00", route.estimated_minutes, {
    legs: route.legs, stayMinutes: route.spots.map(spot => spot.stay_minutes), spotDetails: route.spots.map(spot => spot.reason),
    mealTimes: route.spots.map(s => s.meal_time),
    mealLabels: route.spots.map(s => ({breakfast:"朝ごはん",lunch:"昼ごはん",dinner:"夜ごはん",break:"カフェ休憩",stop:undefined})[s.role]),
    dinnerIndexes: route.spots.flatMap((spot, index) => spot.role === "dinner" ? [index] : []),
    lunchIndexes: route.spots.flatMap((spot, index) => spot.role === "lunch" ? [index] : []),

  }) : buildRouteTimeline(origin, places, departureTime, null, { legs: [], stayMinutes: places.map(place => dwellMinutes[place.id] ?? 90) }), [route, origin, start, places, dwellMinutes]);
  const timeline = useMemo<TimelineItem[]>(() => routeSuggestion?.timeline?.length ? (routeSuggestion.timeline.length >= estimatedTimeline.length ? routeSuggestion.timeline : estimatedTimeline.map((item, index) => routeSuggestion.timeline?.[index] ?? item)).map(item => {
    if (item.type !== "spot" || item.role !== "stop") return item;
    const estimated = estimatedTimeline.find(candidate => candidate.type === "spot" && candidate.place_id === item.place_id);
    const stay = dwellMinutes[item.place_id ?? ""] ?? item.stay_minutes;
    return { ...item, stay_minutes: stay, departure_time: addMinutes(item.time, stay),
      ...(estimated?.type === "spot" ? { label: estimated.label, detail: estimated.detail } : {}) };
  }) : estimatedTimeline, [routeSuggestion, estimatedTimeline, dwellMinutes]);
  const coordinates: [number, number][] = places.map(place => [place.latitude, place.longitude]);
  const lastPreviewConditions = useRef("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selection.overnightSnapshot) return;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 55_000);
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const departureDate = selection.tripPlan?.date ?? now.toISOString().slice(0, 10);

    async function loadRoute() {
      const conditions = JSON.stringify([origin, returnTo, previewPlaces, previewDwell, departureDate, departureTime, anchors,routePriority,preferNearbyAirport]);
      if (lastPreviewConditions.current !== conditions) setRouteSuggestion(null);
      lastPreviewConditions.current = conditions;
      setRouteLoading(true);
      setRouteError(null);
      try {
        const response = await fetch("/api/routes/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            origin, return_to: returnTo,
            places: previewPlaces,
            stay_minutes: previewPlaces.map(place => previewDwell[place.id] ?? 90),
            meal_times: anchors,
            departure_date: departureDate,
            departure_time: departureTime,
            route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
          }),
        });
        if (!response.ok) {
          let message = `駅すぱあと経路検索に失敗しました（HTTP ${response.status}）。`;
          try {
            const payload: unknown = await response.json();
            if (isRecord(payload) && typeof payload.detail === "string") {
              message = payload.detail;
            }
          } catch {
            // Retain the HTTP status message when the error body is not JSON.
          }
          throw new Error(message);
        }
        const payload: unknown = await response.json();
        if (!isRouteSuggestion(payload)) {
          throw new Error("駅すぱあと経路検索から不正なデータが返されました。");
        }
        if (controller.signal.aborted) return;
        setRouteSuggestion(payload);
      } catch (error) {
        if (controller.signal.aborted && !timedOut) return;
        setRouteError(
          timedOut
            ? "駅すぱあと経路検索がタイムアウトしました。"
            : error instanceof Error
            ? error.message
            : "駅すぱあと経路検索に失敗しました。",
        );
      } finally {
        window.clearTimeout(timeoutId);
        if (!controller.signal.aborted || timedOut) setRouteLoading(false);
      }
    }

    void loadRoute();
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [previewPlaces, origin, previewDwell, returnTo, departureTime, anchors, selection.tripPlan?.date,routePriority,preferNearbyAirport]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const targets = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]');
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    const unlockScroll = lockBodyScroll();

    return () => { document.removeEventListener("keydown", onKeyDown); unlockScroll(); previousFocus?.focus(); };
  }, [onClose]);

  return <div className="route-modal-backdrop" onClick={onClose}>
    <section ref={dialogRef} className="route-modal discover-route-modal" role="dialog" aria-modal="true" aria-label={route.title} onClick={event => event.stopPropagation()}>
      <header className="route-modal-header"><div><p className="eyebrow">YOUR LITTLE JOURNEY</p><h2>{route.title}</h2></div><button ref={closeRef} type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button></header>
      <div className="discover-modal-scroll">
        <div className="discover-modal-facts"><span><strong>{places.length}</strong> か所を巡る旅のプラン</span>{isStaticRoute && <span>所要時間の目安 <strong>{formatMinutes(route.estimated_minutes)}</strong></span>}</div>
        {!isStaticRoute && route.story && <p className="discover-modal-story">{route.story}</p>}
        <div className="trip-route-options"><label>交通経路の優先<select value={routePriority} onChange={event=>setRoutePriority(event.target.value as "time"|"price")}><option value="time">速さ優先</option><option value="price">料金優先</option></select></label>
          {includesTransfers && <label className="route-airport-option"><input type="checkbox" checked={preferNearbyAirport} onChange={event=>setPreferNearbyAirport(event.target.checked)} />近くの空港を優先（那覇への往復）</label>}
        </div>
        <div className="route-modal-map"><JourneyMap places={places} origin={origin} returnTo={returnTo} coordinates={routeSuggestion?.coordinates?.length ? routeSuggestion.coordinates : [[origin.latitude, origin.longitude], ...coordinates, [returnTo.latitude, returnTo.longitude]]} legs={routeSuggestion?.legs ?? []} timeline={timeline} journeyDate={journeyDate} routeLoading={routeLoading} mapTokens={routeSuggestion?.timeline?.flatMap(item => item.type === "transit" && item.map_token ? [item.map_token] : [])} /></div>
        {"spots" in route && <div className="discover-modal-recommendation"><strong>この旅の楽しみ</strong><p>{journeyOverview(route,googleInfos)}</p><details><summary>立ち寄り先ごとのおすすめ理由</summary><JourneyReasons route={route} googleInfos={googleInfos} /></details></div>}
        {selection.overnightSnapshot && <p className="result-note">{selection.overnightSnapshot.nights}泊{selection.overnightSnapshot.nights + 1}日 · 宿泊先：{selection.overnightSnapshot.itinerary.hotel.name}。各日の旅程は「このルートで旅を計画する」から開けます。</p>}
        {routeLoading && <p className="result-note" role="status">交通経路を確認しています…</p>}
        {routeError && <p className="result-note" role="status">{routeError} 直前の検索結果またはモデルコースの目安を表示しています。</p>}
        <div className="trip-timeline-heading"><h3>今日のタイムライン</h3></div>
        {timeline.find(item => item.type === "spot" && item.role === "start")?.type === "spot" && (() => {
          const departure = timeline.find(item => item.type === "spot" && item.role === "start");
          return departure?.type === "spot" && <div className="trip-departure"><time>{departure.time}</time><div><strong>{departure.name}を出発</strong></div><span aria-hidden="true">START</span></div>;
        })()}
        <ol className="trip-stops discover-modal-timeline">
        {timeline.map((item, index) => {
          if (item.type === "transit") {
            const modes = item.legs?.length
              ? item.legs.map(leg => leg.line_name)
              : transitRouteLabel(item.transit_line).split("↓").map(label => label.trim()).filter(Boolean);
            return <li className="trip-leg discover-modal-leg" key={`transit-${index}`}>
              <details className="discover-modal-transit-details">
                <summary><span>移動の内訳</span><strong>{item.from_name} → {item.to_name}</strong><small>
                  {item.start_time && item.end_time ? `${item.start_time}〜${item.end_time}` : item.duration_minutes === null ? "所要時間未確認" : `約${formatMinutes(item.duration_minutes)}`}
                </small></summary>
                <div className="discover-modal-transit-content">
                  {item.summary && <p>{item.summary}</p>}
                  {item.legs?.length
                    ? <ol aria-label="区間ごとの交通手段">{item.legs.map((leg, legIndex) => <li key={`${legIndex}-${leg.line_name}`}><strong>{leg.line_name}</strong><span>{leg.from_name} → {leg.to_name}{leg.duration_minutes === null ? "" : ` · 約${formatMinutes(leg.duration_minutes)}`}</span></li>)}</ol>
                    : modes.length > 0 && <ol aria-label="利用する交通手段">{modes.map((mode, modeIndex) => <li key={`${modeIndex}-${mode}`}>{mode}</li>)}</ol>}
                  <p>{item.start_time && item.end_time ? `${item.is_estimate ? "目安" : "運行時刻"} ${item.start_time}〜${item.end_time}` : "運行時刻未確認"}
                    {item.fare_yen == null ? " · 運賃未確認" : ` · 運賃 ${item.fare_yen.toLocaleString("ja-JP")}円`}</p>
                </div>
              </details>
            </li>;
          }
          if (item.role === "start") return null;
          if (item.role === "finish") {
            const showPendingReturn = (includesTransfers || returnTo.latitude !== origin.latitude || returnTo.longitude !== origin.longitude) && !routeSuggestion;
            return <li className="discover-modal-finish" key={`finish-${index}`}>
              <div className="trip-departure"><time>{showPendingReturn ? "—" : item.time}</time><div><strong>帰着の目安 {showPendingReturn ? "交通検索後に表示" : item.time ?? "経路の確認が必要"} {returnTo.name}</strong></div><span aria-hidden="true">GOAL</span></div>
            </li>;
          }
          const place = places.find(candidate => candidate.id === item.place_id);
          const placeIndex = place ? places.findIndex(candidate => candidate.id === place.id) : -1;
          const stayMinutes = place ? dwellMinutes[place.id] : item.stay_minutes;
          const conflict = place && item.time
            ? openingConflict(googleInfos.find(info => info.place_id === place.id), journeyDate, Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3)), stayMinutes ?? 90)
            : null;
          const routeSpot = place && "spots" in route ? route.spots.find(spot => spot.place_id === place.id) : undefined;
          const recommendations = place
            ? routeSpot?.reason ? [routeSpot.reason] : placeRecommendation(place, { places, origin, theme: route.theme, stayMinutes })
            : [];
          return <li key={`spot-${index}-${item.place_id ?? item.name}`} className="trip-stop">
            <article>
              <div className="discover-modal-stop-visual">
                {place && <div className="discover-modal-stop-photo"><FacilityPhoto place={place} compact /></div>}
                <div className="trip-stop-header"><span className="trip-stop-number">{placeIndex < 0 ? "・" : String(placeIndex + 1).padStart(2, "0")}</span><div>
                  <time>{item.time}</time><h4>{item.name}</h4>
                </div></div>
              </div>
              <p className="trip-stop-meta">{item.label && `${item.label} · `}{categoryIcon(item.category)} {item.category}{stayMinutes !== undefined && ` · 滞在の目安 ${formatMinutes(stayMinutes)}`}</p>
              {conflict && <p className="error-panel" role="status">{conflict}</p>}
              {item.detail && <p className="trip-place-details">{item.detail}</p>}
              {place && <PlaceDescriptionToggle reasonSources={routeSpot?.reason_sources} place={place} stayMinutes={stayMinutes} recommendations={recommendations} />}
            </article>
          </li>;
        })}
        </ol>
      </div>
      <div className="discover-modal-footer"><p className="result-note">時刻は目安です。営業・運行情報は出発前にご確認ください。</p>{onPlanInSearch && <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(route)}>このルートで旅を計画する <span aria-hidden="true">→</span></button>}</div>
    </section>
  </div>;
}
