import { useState } from "react";
import type { Place } from "../types";
import { useRoutePhoto } from "./useRoutePhoto";
import { GooglePlacePhoto } from "./GooglePlacePhoto";
import { categoryArtwork } from "./categoryArtwork";
import "./routePhoto.css";

export function SpotPhoto({ place, enabled, showName = true }: { place: Place; enabled: boolean; showName?: boolean }) {
  const { status, photo } = useRoutePhoto([place], enabled);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const ready = photo?.status === "ready" && photo.image_url && failedUrl !== photo.image_url;
  const artwork = categoryArtwork(place);
  return <GooglePlacePhoto key={`${place.id}:${place.latitude}:${place.longitude}`} place={place} enabled={enabled && !ready && (status === "unavailable" || status === "ready")} showName={showName}><figure className="route-photo-tile" aria-label={`${place.name}の${ready ? "写真" : "ジャンルイメージ"}`}>
    {ready ? <img src={photo.image_url!} alt={place.name} decoding="async" onError={() => setFailedUrl(photo.image_url)} />
      : <div className="route-category-image"><svg className="route-category-art" viewBox={`${artwork.column} ${artwork.row} 1 1`} preserveAspectRatio="xMidYMid slice" aria-hidden="true"><image href={artwork.image} width={artwork.columns} height={artwork.rows} /></svg><span className="route-category-badge"><span>AI生成・ジャンルイメージ</span><b>{artwork.label}</b></span></div>}
    <figcaption>{showName && <strong>{place.name}</strong>}
      {ready && <span className="route-photo-tile-credit" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <a href={photo.source_url!} target="_blank" rel="noopener noreferrer">{photo.author_name}</a>
        <a href={photo.license_url!} target="_blank" rel="noopener noreferrer">{photo.license_name}</a><small>トリミング</small>
      </span>}
    </figcaption>
  </figure></GooglePlacePhoto>;
}
