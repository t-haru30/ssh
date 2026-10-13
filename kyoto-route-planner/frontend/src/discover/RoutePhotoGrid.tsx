import type { Place } from "../types";
import { SpotPhoto } from "./SpotPhoto";
import "./routePhoto.css";

export function RoutePhotoGrid({ places, enabled }: { places: Place[]; enabled: boolean }) {
  return <div className="route-photo-grid" style={{ gridTemplateColumns: `repeat(${Math.min(2, places.length) || 1}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(places.length / 2) || 1}, minmax(0, 1fr))` }}>
    {places.map(place => <SpotPhoto key={place.id} place={place} enabled={enabled} />)}
  </div>;
}
