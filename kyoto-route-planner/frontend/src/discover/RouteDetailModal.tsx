import { lazy, Suspense, useEffect, useMemo } from "react";
import { buildRouteTimeline, RouteTimeline } from "../RouteTimeline";
import type { Origin, Place } from "../types";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { formatMinutes } from "./DiscoverCard";

const KYOTO_STATION: Origin = { name: "京都駅", latitude: 34.985849, longitude: 135.758766 };
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
  const isStaticRoute = isDatasetRoute(route);
  const places = useMemo(
    () => isStaticRoute
      ? route.spots.map((spot) => toPlace(spot, route.theme))
      : route.places,
    [isStaticRoute, route],
  );
  const start = useMemo<Origin>(
    () => isStaticRoute
      ? { name: route.start.name, latitude: route.start.lat, longitude: route.start.lng }
      : KYOTO_STATION,
    [isStaticRoute, route],
  );
  const items = useMemo(() => {
    const plan = isStaticRoute
      ? {
        legs: route.legs,
        stayMinutes: route.spots.map((spot) => spot.stay_minutes),
        lunchIndexes: route.spots.flatMap((spot, index) => (spot.role === "lunch" ? [index] : [])),
      }
      : undefined;
    return buildRouteTimeline(start, places, "09:00", null, plan);
  }, [isStaticRoute, route, places, start]);
  const coordinates: [number, number][] = isStaticRoute
    ? route.coordinates
    : route.places.map((place) => [place.latitude, place.longitude]);

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
              origin={start}
              coordinates={[[start.latitude, start.longitude], ...coordinates]}
              legs={[]}
            />
          </Suspense>
        </div>
        <RouteTimeline items={items} />
        {onPlanInSearch && (
          <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(route)}>
            この条件で乗換つきの経路を作る
          </button>
        )}
        <p className="result-note">所要時間は直線距離からの目安です。実際の経路は「Search」タブで確認できます。</p>
      </section>
    </div>
  );
}
