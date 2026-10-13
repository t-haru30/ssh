import { FacilityPhoto } from "../FacilityPhoto";
import { lockBodyScroll } from "../bodyScrollLock";
import { ReasonSources } from "./reasonSources";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
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

const MapView = lazy(() => import("../MapView").then(({ MapView: Component }) => ({ default: Component })));
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
  const [routeSuggestion, setRouteSuggestion] = useState<RouteSuggestion | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [currentOrigin, setCurrentOrigin] = useState<Origin | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const origin = currentOrigin ?? start;
  const isStaticRoute = "spots" in route;
  const estimatedTimeline = useMemo(() => "spots" in route ? buildRouteTimeline(origin, places, "09:00", currentOrigin ? null : route.estimated_minutes, currentOrigin ? undefined : {
    legs: route.legs, stayMinutes: route.spots.map(spot => spot.stay_minutes), spotDetails: route.spots.map(spot => spot.reason),
    lunchIndexes: route.spots.flatMap((spot, index) => spot.role === "lunch" ? [index] : []),
    returnByMinutes: route.course === "full_day" ? 19 * 60 : undefined,
  }) : [], [route, origin, currentOrigin, places]);
  const timeline = useMemo<TimelineItem[]>(() => routeSuggestion?.timeline?.length ? routeSuggestion.timeline.map(item => {
    if (item.type !== "spot" || item.role !== "stop") return item;
    const estimated = estimatedTimeline.find(candidate => candidate.type === "spot" && candidate.place_id === item.place_id);
    const stay = dwellMinutes[item.place_id ?? ""] ?? item.stay_minutes;
    return { ...item, stay_minutes: stay, departure_time: addMinutes(item.time, stay),
      ...(estimated?.type === "spot" ? { label: estimated.label, detail: estimated.detail } : {}) };
  }) : estimatedTimeline, [routeSuggestion, estimatedTimeline, dwellMinutes]);
  const returnLeg = timeline[timeline.length - 2];
  const finish = timeline[timeline.length - 1];
  const coordinates: [number, number][] = places.map(place => [place.latitude, place.longitude]);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (previewRequest === 0 || selection.overnightSnapshot) return;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 55_000);
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const departureDate = now.toISOString().slice(0, 10);

    async function loadRoute() {
      setRouteLoading(true);
      setRouteSuggestion(null);
      setRouteError(null);
      try {
        const response = await fetch("/api/routes/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            origin,
            places,
            stay_minutes: places.map(place => dwellMinutes[place.id] ?? 90),
            departure_date: departureDate,
            departure_time: "09:00",
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
  }, [places, origin, dwellMinutes, previewRequest]);

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
      <div className="route-modal-map"><Suspense fallback={<div className="map-canvas map-canvas-placeholder" role="status">地図を読み込んでいます…</div>}><MapView places={places} origin={origin} coordinates={[[origin.latitude, origin.longitude], ...coordinates, ...(isStaticRoute ? [[origin.latitude, origin.longitude] as [number, number]] : [])]} legs={[]} /></Suspense></div>
      {"spots" in route && route.recommendation_source === "gemini" && route.recommendation_reason && <div className="discover-modal-recommendation"><span className="discover-recommendation-label">✦ AIが選んだおすすめ</span><p>{route.recommendation_reason}</p><ReasonSources sources={route.reason_sources} /></div>}
      <div className="discover-modal-section-heading"><h3>この旅で訪れる場所</h3><span>{places.length} SPOTS</span></div>
      {route.travel_origin && <p>出発地：{route.travel_origin.name} → 観光の起点：{start.name}。到着時刻・帰着時刻は交通検索後に確定します。</p>}
      <p className="discover-modal-origin">{isStaticRoute ? "現地09:00開始のモデルコース：" : "観光の起点："}{origin.name}<small>現地での仮の時刻です。出発地からの移動は旅程編集で確認できます</small></p>
      {!selection.overnightSnapshot && <div className="discover-origin-control"><button type="button" onClick={() => void useCurrentLocation()} disabled={locationLoading}>{locationLoading ? "現在地を確認中…" : "現在地から出発"}</button>{currentOrigin && <button type="button" onClick={() => setCurrentOrigin(null)}>元の出発地に戻す</button>}</div>}
      {locationError && <p className="result-note" role="alert">{locationError}</p>}
      {selection.overnightSnapshot ? <p className="result-note">{selection.overnightSnapshot.nights}泊{selection.overnightSnapshot.nights + 1}日 · 宿泊先：{selection.overnightSnapshot.itinerary.hotel.name}。各日の旅程は「このルートで旅を計画する」から開けます。</p> : <button type="button" className="discover-preview-button" disabled={routeLoading} onClick={() => setPreviewRequest(v => v + 1)}>{routeLoading ? "運行時刻を確認中…" : "運行時刻を確認する"}</button>}
      {routeLoading && <p className="result-note" role="status">駅すぱあとで運行時刻を検索しています…</p>}
      {routeError && <p className="result-note" role="status">{routeError} 推定時刻を表示しています。</p>}
      <ol className="discover-modal-spots">{places.map((place, index) => {
        const transit = timeline[index * 2 + 1];
        const visit = timeline[index * 2 + 2];
        return <li key={`${index}-${place.id}`}><span className="discover-modal-spot-number">{String(index + 1).padStart(2, "0")}</span><div>
          {transit?.type === "transit" && <span className="discover-modal-transit">{transit.transit_line ? `${/バス|bus/i.test(transit.transit_line) ? "🚌" : "🚆"} ${transit.transit_line}` : "summary" in transit ? transit.summary : "移動"}</span>}
          {transit?.type === "transit" && transit.start_time && transit.end_time && <span>{transit.is_estimate ? "目安" : "運行時刻"} {transit.start_time}〜{transit.end_time}</span>}
          <strong>{visit?.type === "spot" && <span className="discover-modal-time">{visit.time} </span>}{place.name}</strong>
          <span>{visit?.type === "spot" && visit.label && `${visit.label} · `}{categoryIcon(place.category)} {place.category}{dwellMinutes[place.id] !== undefined && ` · 滞在の目安 ${formatMinutes(dwellMinutes[place.id])}`}</span>
          {visit?.type === "spot" && visit.detail && <span>{visit.detail}</span>}
          <FacilityPhoto place={place} />
          <PlaceDescriptionToggle reasonSources={"spots" in route ? route.spots[index]?.reason_sources : undefined} place={place} stayMinutes={dwellMinutes[place.id]} recommendations={"spots" in route && route.spots[index]?.reason ? [route.spots[index].reason!] : placeRecommendation(place, { places, origin, theme: route.theme, stayMinutes: dwellMinutes[place.id] })} />
        </div><VenueEvidence place={place} /></li>;
      })}</ol>
      {returnLeg?.type === "transit" && finish?.type === "spot" && <p className="discover-modal-return"><span>{returnLeg.transit_line ?? ("summary" in returnLeg ? returnLeg.summary : "移動")}</span><strong>帰着の目安 {finish.time} {origin.name}</strong></p>}
      <div className="discover-modal-footer"><p className="result-note">訪問順と所要時間は目安です。営業時間や移動手段を確認して、旅の計画を仕上げましょう。</p>{onPlanInSearch && <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(currentOrigin ? "spots" in route ? { ...route, start: { ...route.start, name: origin.name, lat: origin.latitude, lng: origin.longitude } } : { ...route, origin } : route)}>このルートで旅を計画する <span aria-hidden="true">→</span></button>}</div>
    </section>
  </div>;
}
