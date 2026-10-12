import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { buildRouteTimeline, RouteTimeline } from "../RouteTimeline";
import { isOrigin, isRecord, isRouteSuggestion } from "../apiValidation";
import type { Origin, Place, RouteSuggestion } from "../types";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { formatMinutes } from "./DiscoverCard";

const AREA_STARTS: Record<string, Origin> = {
  hokkaido: { name: "札幌中心", latitude: 43.0642, longitude: 141.3469 },
  tokyo: { name: "東京中心", latitude: 35.6762, longitude: 139.6503 },
  kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 },
  osaka: { name: "大阪中心", latitude: 34.6937, longitude: 135.5023 },
  fukuoka: { name: "福岡中心", latitude: 33.5904, longitude: 130.4017 },
  okinawa: { name: "那覇中心", latitude: 26.2124, longitude: 127.6809 },
};
const MapView = lazy(() => import("../MapView").then(({ MapView: Component }) => ({
  default: Component,
})));

type RouteDetailModalProps = {
  route: DatasetRoute | RouteIdea;
  onClose: () => void;
  onPlanInSearch?: (route: DatasetRoute | RouteIdea) => void;
};

function isDatasetRoute(route: DatasetRoute | RouteIdea): route is DatasetRoute {
  return "spots" in route;
}

function toPlace(spot: DatasetRoute["spots"][number], theme: Place["themes"][number]): Place {
  return {
    id: spot.place_id,
    name: spot.name,
    category: spot.category,
    description: "",
    access_point: "",
    latitude: spot.lat,
    longitude: spot.lng,
    themes: [theme],
  };
}

export function RouteDetailModal({ route, onClose, onPlanInSearch }: RouteDetailModalProps) {
  const [routeSuggestion, setRouteSuggestion] = useState<RouteSuggestion | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(true);
  const [currentOrigin, setCurrentOrigin] = useState<Origin | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const isStaticRoute = isDatasetRoute(route);
  const places = useMemo(
    () => isStaticRoute
      ? route.spots.map((spot) => toPlace(spot, route.theme))
      : route.places,
    [isStaticRoute, route],
  );
  const start = useMemo(
    () => isStaticRoute
      ? AREA_STARTS[route.area] ?? { name: "エリア中心", latitude: route.center[0], longitude: route.center[1] }
      : AREA_STARTS.kyoto,
    [isStaticRoute, route],
  );
  const origin = currentOrigin ?? start;
  const estimatedItems = useMemo(
    () => buildRouteTimeline(origin, places, "09:00", null),
    [places, origin],
  );
  const items = routeSuggestion?.timeline?.length
    ? routeSuggestion.timeline
    : estimatedItems;
  const coordinates: [number, number][] = isStaticRoute
    ? route.coordinates
    : route.places.map((place) => [place.latitude, place.longitude]);

  useEffect(() => {
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
  }, [places, origin]);

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
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="route-modal-backdrop" onClick={onClose}>
      <section
        className="route-modal"
        role="dialog"
        aria-modal="true"
        aria-label={route.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="route-modal-header">
          <div>
            <p className="eyebrow">
              YOUR PICK · {isStaticRoute ? `約${formatMinutes(route.estimated_minutes)}` : `${route.places.length}か所`}
            </p>
            <h2>{route.title}</h2>
          </div>
          <button type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button>
        </header>
        <div className="route-modal-map">
          <Suspense
            fallback={
              <div className="map-canvas map-canvas-placeholder" role="status">
                地図を読み込んでいます…
              </div>
            }
          >
            <MapView
              places={places}
              origin={origin}
              coordinates={[[origin.latitude, origin.longitude], ...coordinates]}
              legs={[]}
            />
          </Suspense>
        </div>
        <div className="discover-origin-control">
          <span>出発地: {origin.name}</span>
          <button
            type="button"
            onClick={() => void useCurrentLocation()}
            disabled={locationLoading}
          >
            {locationLoading ? "現在地を確認中…" : "現在地から出発"}
          </button>
          {currentOrigin && <button type="button" onClick={() => setCurrentOrigin(null)}>元の出発地に戻す</button>}
        </div>
        {locationError && <p className="result-note" role="alert">{locationError}</p>}
        {routeLoading && <p role="status">駅すぱあとで運行時刻を検索しています…</p>}
        {routeError && (
          <p className="result-note" role="status">
            {routeError} 推定時刻を表示しています。
          </p>
        )}
        <RouteTimeline items={items} />
        {onPlanInSearch && (
          <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(route)}>
            この条件で乗換つきの経路を作る
          </button>
        )}
        <p className="result-note">
          {routeSuggestion?.note ?? "経路情報を取得できない場合は、時刻の目安を表示します。"}
          {" "}出発時刻は09:00に設定しています。
        </p>
      </section>
    </div>
  );
}
