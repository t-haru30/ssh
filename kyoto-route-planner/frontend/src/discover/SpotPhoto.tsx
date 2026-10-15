import { useEffect, useMemo, useState } from "react";
import type { Place } from "../types";
import { useRoutePhoto } from "./useRoutePhoto";
import { GooglePlacePhoto } from "./GooglePlacePhoto";
import { categoryArtwork } from "./categoryArtwork";
import { PhotoFigure, type PlacePhotoSnapshot } from "./PhotoFigure";
import "./routePhoto.css";

export function SpotPhoto({ place, enabled, showName = true, showCredits = true, onPhoto }: { place: Place; enabled: boolean; showName?: boolean; showCredits?: boolean; onPhoto?: (photo: PlacePhotoSnapshot | null) => void }) {
  const { status, photo } = useRoutePhoto([place], enabled);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const ready = photo?.status === "ready" && photo.image_url && failedUrl !== photo.image_url;
  const artwork = categoryArtwork(place);
  const snapshot = useMemo<PlacePhotoSnapshot | null>(() => ready ? { provider: "licensed", imageUrl: photo.image_url!, sourceUrl: photo.source_url!,
    authors: [{ name: photo.author_name!, url: photo.source_url! }], license: { name: photo.license_name!, url: photo.license_url! } } : null, [ready, photo]);
  useEffect(() => { if (snapshot) onPhoto?.(snapshot); }, [snapshot, onPhoto]);
  return <GooglePlacePhoto key={`${place.id}:${place.latitude}:${place.longitude}`} place={place} enabled={enabled && !ready && (status === "unavailable" || status === "ready")} showName={showName} showCredits={showCredits} onPhoto={onPhoto}>
    {snapshot ? <PhotoFigure place={place} photo={snapshot} showName={showName} showCredits={showCredits} onError={() => { onPhoto?.(null); setFailedUrl(photo!.image_url); }} />
      : <figure className="route-photo-tile" aria-label={`${place.name}のジャンルイメージ`}>
        <div className="route-category-image"><svg className="route-category-art" viewBox={`${artwork.column} ${artwork.row} 1 1`} preserveAspectRatio="xMidYMid slice" aria-hidden="true"><image href={artwork.image} width={artwork.columns} height={artwork.rows} /></svg><span className="route-category-badge"><span>AI生成・ジャンルイメージ</span><b>{artwork.label}</b></span></div>
        <figcaption>{showName && <strong>{place.name}</strong>}</figcaption>
      </figure>}
  </GooglePlacePhoto>;
}
