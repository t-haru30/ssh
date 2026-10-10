import { useEffect, useMemo } from "react";
import { MapView } from "../MapView";
import { buildRouteTimeline, RouteTimeline } from "../RouteTimeline";
import type { Origin, Place } from "../types";
import type { DatasetRoute } from "./datasetTypes";
import { formatMinutes } from "./DiscoverCard";

const START: Origin = { name: "京都駅", latitude: 34.985849, longitude: 135.758766 };

type RouteDetailModalProps = {
  route: DatasetRoute;
  onClose: () => void;
};

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

export function RouteDetailModal({ route, onClose }: RouteDetailModalProps) {
  const places = useMemo(() => route.spots.map((spot) => toPlace(spot, route.theme)), [route]);
  const items = useMemo(() => buildRouteTimeline(START, places, "09:00", null), [places]);

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
            <p className="eyebrow">YOUR PICK · 約{formatMinutes(route.estimated_minutes)}</p>
            <h2>{route.title}</h2>
          </div>
          <button type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button>
        </header>
        <div className="route-modal-map">
          <MapView places={places} origin={START} coordinates={[[START.latitude, START.longitude], ...route.coordinates]} legs={[]} />
        </div>
        <RouteTimeline items={items} />
        <p className="result-note">所要時間は直線距離からの目安です。実際の経路は「Search」タブで確認できます。</p>
      </section>
    </div>
  );
}
