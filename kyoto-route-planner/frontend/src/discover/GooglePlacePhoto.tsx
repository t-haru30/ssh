import type { ReactNode } from "react";
import type { Place } from "../types";
import { useGooglePlacePhoto } from "./useGooglePlacePhoto";

export function GooglePlacePhoto({ place, enabled, showName, children }: { place: Place; enabled: boolean; showName: boolean; children: ReactNode }) {
  const { photo, discard } = useGooglePlacePhoto(place, enabled);
  if (!photo || !enabled) return <>{children}</>;
  return <figure className="route-photo-tile google-place-photo" aria-label={`${place.name}の写真`}>
    <img src={photo.image_url} alt={place.name} decoding="async" onError={discard} />
    <figcaption onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {showName && <strong>{place.name}</strong>}
      <a className="google-maps-attribution" translate="no" href={photo.source_url} target="_blank" rel="noopener noreferrer">Google Maps</a>
      <span className="route-photo-tile-credit">{photo.authors.map((author, i) => <a key={i} href={author.url} target="_blank" rel="noopener noreferrer">{author.name}</a>)}</span>
      <a className="google-photo-source" href={photo.source_url} target="_blank" rel="noopener noreferrer">元の写真・問題を報告</a>
    </figcaption>
  </figure>;
}
