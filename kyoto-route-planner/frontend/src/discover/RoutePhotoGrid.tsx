import { useState } from "react";
import type { Place } from "../types";
import { useRoutePhoto } from "./useRoutePhoto";
import "./routePhoto.css";

function SpotPhoto({ place, enabled }: { place: Place; enabled: boolean }) {
  const { status, photo } = useRoutePhoto([place], enabled);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const ready = photo?.status === "ready" && photo.image_url && failedUrl !== photo.image_url;
  return <figure className="route-photo-tile" aria-label={`${place.name}の写真`}>
    {ready ? <img src={photo.image_url!} alt={place.name} decoding="async" onError={() => setFailedUrl(photo.image_url)} />
      : <div className="route-photo-tile-placeholder"><span aria-hidden="true">⌖</span><small>{status === "loading" || status === "idle" ? "写真を確認中" : "写真なし"}</small></div>}
    <figcaption><strong>{place.name}</strong>
      {ready && <span className="route-photo-tile-credit" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <a href={photo.source_url!} target="_blank" rel="noopener noreferrer">{photo.author_name}</a>
        <a href={photo.license_url!} target="_blank" rel="noopener noreferrer">{photo.license_name}</a><small>トリミング</small>
      </span>}
    </figcaption>
  </figure>;
}

export function RoutePhotoGrid({ places, enabled }: { places: Place[]; enabled: boolean }) {
  return <div className="route-photo-grid" style={{ gridTemplateRows: `repeat(${Math.ceil(places.length / 2)}, minmax(0, 1fr))` }}>
    {places.map(place => <SpotPhoto key={place.id} place={place} enabled={enabled} />)}
  </div>;
}
