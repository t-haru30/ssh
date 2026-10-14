import { transitModeLabel } from "../TripTransit";
import { FacilityPhoto } from "../FacilityPhoto";
import { lockBodyScroll } from "../bodyScrollLock";
import { useEffect, useMemo, useRef, useState } from "react";
import { JourneyMap } from "../LazyMapView";
import type { RouteIdea } from "../SwipeCard";
import { routeSelection } from "../routeSelection";
import { buildRouteTimeline } from "../RouteTimeline";
import type { TimelineItem } from "../RouteTimeline";
import { isOrigin, isRecord, isRouteSuggestion } from "../apiValidation";
import type { Origin, RouteSuggestion } from "../types";
import type { DatasetRoute } from "./datasetTypes";
import { categoryIcon, formatMinutes } from "./DiscoverCard";
import { VenueEvidence } from "../VenueEvidence";
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
  const [previewRequest, setPreviewRequest] = useState(0);
  const [routePriority,setRoutePriority]=useState<"time"|"price">("time");
  const [preferNearbyAirport,setPreferNearbyAirport]=useState(true);
  const [currentOrigin, setCurrentOrigin] = useState<Origin | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const origin = currentOrigin ?? itinerarySelection.origin;
  const previewPlaces = itinerarySelection.places;
  const previewDwell = itinerarySelection.dwellMinutes;
  const returnTo = selection.tripPlan?.returnTo ?? (currentOrigin ? origin : itinerarySelection.returnTo ?? origin);
  const departureTime = selection.tripPlan?.input.departureTime ?? itinerarySelection.departureTime ?? "09:00";
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  const journeyDate = selection.tripPlan?.date ?? today.toISOString().slice(0,10);
  const anchors = useMemo(() => selection.tripPlan
    ? Object.fromEntries(selection.tripPlan.stops.filter(stop => stop.anchorTime).map(stop => [stop.place.id, stop.anchorTime]))
    : itinerarySelection.anchorTimes ?? {}, [selection, itinerarySelection]);
  const includesTransfers = previewPlaces.length !== places.length;
  const isStaticRoute = "spots" in route;
  const estimatedTimeline = useMemo(() => "spots" in route ? buildRouteTimeline(currentOrigin ?? start, places, route.departure_time ?? "09:00", currentOrigin ? null : route.estimated_minutes, currentOrigin ? undefined : {
    legs: route.legs, stayMinutes: route.spots.map(spot => spot.stay_minutes), spotDetails: route.spots.map(spot => spot.reason),
    mealTimes: route.spots.map(s => s.meal_time),
    mealLabels: route.spots.map(s => ({breakfast:"朝ごはん",lunch:"昼ごはん",dinner:"夜ごはん",stop:undefined})[s.role]),
    dinnerIndexes: route.spots.flatMap((spot, index) => spot.role === "dinner" ? [index] : []),
    lunchIndexes: route.spots.flatMap((spot, index) => spot.role === "lunch" ? [index] : []),

  }) : buildRouteTimeline(origin, places, departureTime, null, { legs: [], stayMinutes: places.map(place => dwellMinutes[place.id] ?? 90) }), [route, origin, currentOrigin, places]);
  const timeline = useMemo<TimelineItem[]>(() => routeSuggestion?.timeline?.length ? (routeSuggestion.timeline.length >= estimatedTimeline.length ? routeSuggestion.timeline : estimatedTimeline.map((item, index) => routeSuggestion.timeline?.[index] ?? item)).map(item => {
    if (item.type !== "spot" || item.role !== "stop") return item;
    const estimated = estimatedTimeline.find(candidate => candidate.type === "spot" && candidate.place_id === item.place_id);
    const stay = dwellMinutes[item.place_id ?? ""] ?? item.stay_minutes;
    return { ...item, stay_minutes: stay, departure_time: addMinutes(item.time, stay),
      ...(estimated?.type === "spot" ? { label: estimated.label, detail: estimated.detail } : {}) };
  }) : estimatedTimeline, [routeSuggestion, estimatedTimeline, dwellMinutes]);
  const returnLeg = timeline[timeline.length - 2];
  const finish = timeline[timeline.length - 1];
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
  }, [previewPlaces, origin, previewDwell, previewRequest, returnTo, departureTime, anchors, selection.tripPlan?.date,routePriority,preferNearbyAirport]);

  async function useCurrentLocation() {
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationError("このブラウザでは位置情報を取得できません。");
      return;
    }

    setLocationLoading(true);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const { latitude, longitude } = coords;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(
            `/api/nearby-stations?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            let message = `現在地周辺の駅検索に失敗しました（HTTP ${response.status}）。`;
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
          if (!Array.isArray(payload) || !payload.every(isOrigin) || payload.length === 0) {
            throw new Error("現在地周辺の駅・停留所が見つかりませんでした。");
          }
          setCurrentOrigin(payload[0]);
        } catch (error) {
          setLocationError(
            error instanceof Error && error.name === "AbortError"
              ? "現在地周辺の駅検索がタイムアウトしました。"
              : error instanceof Error
              ? error.message
              : "現在地周辺の駅を検索できませんでした。",
          );
        } finally {
          window.clearTimeout(timeoutId);
          setLocationLoading(false);
        }
      },
      (error) => {
        setLocationError(
          error.code === GeolocationPositionError.PERMISSION_DENIED
            ? "位置情報が許可されていません。ブラウザの設定を確認してください。"
            : "現在地を取得できませんでした。位置情報の設定を確認してください。",
        );
        setLocationLoading(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

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
      <div className="discover-modal-facts"><span><strong>{places.length}</strong> か所を巡る旅のプラン</span>{isStaticRoute && <span>所要時間の目安 <strong>{formatMinutes(route.estimated_minutes)}</strong></span>}</div>
      {!isStaticRoute && route.story && <p className="discover-modal-story">{route.story}</p>}
      <div className="trip-route-options"><label>交通経路の優先<select value={routePriority} onChange={event=>setRoutePriority(event.target.value as "time"|"price")}><option value="time">速さ優先</option><option value="price">料金優先</option></select></label>
        {includesTransfers && <label className="route-airport-option"><input type="checkbox" checked={preferNearbyAirport} onChange={event=>setPreferNearbyAirport(event.target.checked)} />近くの空港を優先（那覇への往復）</label>}
      </div>
      <div className="route-modal-map"><JourneyMap places={places} origin={origin} returnTo={returnTo} coordinates={routeSuggestion?.coordinates?.length ? routeSuggestion.coordinates : [[origin.latitude, origin.longitude], ...coordinates, [returnTo.latitude, returnTo.longitude]]} legs={routeSuggestion?.legs ?? []} timeline={timeline} journeyDate={journeyDate} routeLoading={routeLoading} mapTokens={routeSuggestion?.timeline?.flatMap(item => item.type === "transit" && item.map_token ? [item.map_token] : [])} /></div>
      {"spots" in route && <div className="discover-modal-recommendation"><strong>この旅の楽しみ</strong><p>{journeyOverview(route,googleInfos)}</p><details><summary>立ち寄り先ごとのおすすめ理由</summary><JourneyReasons route={route} googleInfos={googleInfos} /></details></div>}
      <div className="discover-modal-section-heading"><h3>この旅で訪れる場所</h3><span>{places.length} SPOTS</span></div>
      <p className="discover-modal-origin">観光の起点：{start.name}</p>
      {!selection.overnightSnapshot && <div className="discover-origin-control"><button type="button" onClick={() => void useCurrentLocation()} disabled={locationLoading}>{locationLoading ? "現在地を確認中…" : "現在地から出発"}</button>{currentOrigin && <button type="button" onClick={() => setCurrentOrigin(null)}>元の出発地に戻す</button>}</div>}
      {locationError && <p className="result-note" role="alert">{locationError}</p>}
      {selection.overnightSnapshot ? <p className="result-note">{selection.overnightSnapshot.nights}泊{selection.overnightSnapshot.nights + 1}日 · 宿泊先：{selection.overnightSnapshot.itinerary.hotel.name}。各日の旅程は「このルートで旅を計画する」から開けます。</p> : <button type="button" className="discover-preview-button" disabled={routeLoading} onClick={() => setPreviewRequest(v => v + 1)}>{routeLoading ? "運行時刻を確認中…" : "交通経路を再検索する"}</button>}
      {routeLoading && <p className="result-note" role="status">交通経路を確認しています…</p>}
      {routeError && <p className="result-note" role="status">{routeError} 直前の検索結果またはモデルコースの目安を表示しています。</p>}
      {includesTransfers && <section className="discover-transfer-summary" aria-label="往復の移動">
        <h3>{origin.name}からの往復の移動</h3>
        <p>出発 {departureTime} · 帰着地 {returnTo.name}</p>
        {routeSuggestion?.timeline?.filter(item => item.type === "transit" && ["trip-arrival", "trip-return"].some(id => previewPlaces.find(place => place.id === id)?.name === item.to_name || previewPlaces.find(place => place.id === id)?.name === item.from_name)).map((item, index) => item.type === "transit" && <p key={index}>{item.from_name} → {item.to_name} · {transitModeLabel(item.mode)} · {item.transit_line ?? "路線未確認"}{item.start_time && item.end_time ? ` · ${item.start_time}〜${item.end_time}` : " · 時刻未確認"}{item.fare_yen != null ? ` · ${item.fare_yen.toLocaleString("ja-JP")}円` : " · 運賃未確認"}</p>)}
      </section>}
      <ol className="discover-modal-spots">{places.map((place, index) => {
        const visitIndex = timeline.findIndex(item => item.type === "spot" && item.role === "stop" && item.place_id === place.id);
        const transit = timeline[visitIndex - 1];
        const visit = timeline[visitIndex];
        const conflict=visit?.type==="spot" && visit.time ? openingConflict(googleInfos.find(info=>info.place_id===place.id),journeyDate,Number(visit.time.slice(0,2))*60+Number(visit.time.slice(3)),dwellMinutes[place.id]??90) : null;
        return <li key={`${index}-${place.id}`}><span className="discover-modal-spot-number">{String(index + 1).padStart(2, "0")}</span><div>
          {transit?.type === "transit" && <span className="discover-modal-transit">{"summary" in transit && !transit.transit_line ? transit.summary : `${transitModeLabel(transit.mode)} · ${transit.transit_line ?? "路線未確認"}${transit.fare_yen != null ? ` · ${transit.fare_yen.toLocaleString("ja-JP")}円` : ""}`}</span>}
          {transit?.type === "transit" && transit.start_time && transit.end_time && <span>{transit.is_estimate ? "目安" : "運行時刻"} {transit.start_time}〜{transit.end_time}</span>}
          <strong>{visit?.type === "spot" && <span className="discover-modal-time">{visit.time} </span>}{place.name}</strong>
          {conflict && <p className="error-panel" role="status">{conflict}</p>}
          <span>{visit?.type === "spot" && visit.label && `${visit.label} · `}{categoryIcon(place.category)} {place.category}{dwellMinutes[place.id] !== undefined && ` · 滞在の目安 ${formatMinutes(dwellMinutes[place.id])}`}</span>
          {visit?.type === "spot" && visit.detail && <span>{visit.detail}</span>}
          <FacilityPhoto place={place} />
          <PlaceDescriptionToggle reasonSources={"spots" in route ? route.spots[index]?.reason_sources : undefined} place={place} stayMinutes={dwellMinutes[place.id]} recommendations={"spots" in route && route.spots[index]?.reason ? [route.spots[index].reason!] : placeRecommendation(place, { places, origin, theme: route.theme, stayMinutes: dwellMinutes[place.id] })} />
        </div><VenueEvidence place={place} /></li>;
      })}</ol>
      {returnLeg?.type === "transit" && finish?.type === "spot" && <p className="discover-modal-return"><span>{returnLeg.transit_line ?? ("summary" in returnLeg ? returnLeg.summary : "移動経路は未確認")}</span><strong>帰着の目安 {(includesTransfers || returnTo.latitude !== origin.latitude || returnTo.longitude !== origin.longitude) && !routeSuggestion ? "交通検索後に表示" : finish.time ?? "経路の確認が必要"} {returnTo.name}</strong></p>}
      <div className="discover-modal-footer"><p className="result-note">時刻は目安です。営業・運行情報は出発前にご確認ください。</p>{onPlanInSearch && <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(currentOrigin ? "spots" in route ? { ...route, start: { ...route.start, name: origin.name, lat: origin.latitude, lng: origin.longitude } } : { ...route, origin } : route)}>このルートで旅を計画する <span aria-hidden="true">→</span></button>}</div>
    </section>
  </div>;
}
