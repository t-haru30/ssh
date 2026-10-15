import type { Place } from "../types";

// Keep the selected thumbnail's photo and attribution together while its dialog
// is open. This is component state only, never browser storage or a shared cache.
export type PlacePhotoSnapshot = {
  provider: "google" | "licensed";
  imageUrl: string;
  sourceUrl: string;
  authors: { name: string; url: string }[];
  license?: { name: string; url: string };
};

export function PhotoFigure({ place, photo, showName = true, showCredits = true, onError }: {
  place: Place; photo: PlacePhotoSnapshot; showName?: boolean; showCredits?: boolean; onError?: () => void;
}) {
  const google = photo.provider === "google";
  return <figure className={`route-photo-tile${google ? " google-place-photo" : ""}`} aria-label={`${place.name}の写真`}>
    <img src={photo.imageUrl} alt={place.name} decoding="async" onError={onError} />
    <figcaption>
      {showName && <strong>{place.name}</strong>}
      {google && <a className="google-maps-attribution" translate="no" href={photo.sourceUrl} target="_blank" rel="noopener noreferrer" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>Google Maps</a>}
      {showCredits && <>
        <span className="route-photo-tile-credit" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          {photo.authors.map((author, index) => <a key={index} href={author.url} target="_blank" rel="noopener noreferrer">{author.name}</a>)}
          {photo.license && <a href={photo.license.url} target="_blank" rel="noopener noreferrer">{photo.license.name}</a>}
          {!google && <small>トリミング</small>}
        </span>
        {google && <a className="google-photo-source" href={photo.sourceUrl} target="_blank" rel="noopener noreferrer" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>元の写真・問題を報告</a>}
      </>}
    </figcaption>
  </figure>;
}
