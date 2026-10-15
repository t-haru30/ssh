import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type { Place } from "../types";
import { useGooglePlacePhoto } from "./useGooglePlacePhoto";
import { PhotoFigure, type PlacePhotoSnapshot } from "./PhotoFigure";

export function GooglePlacePhoto({ place, enabled, showName, showCredits = true, onPhoto, children }: { place: Place; enabled: boolean; showName: boolean; showCredits?: boolean; onPhoto?: (photo: PlacePhotoSnapshot | null) => void; children: ReactNode }) {
  const { photo, discard } = useGooglePlacePhoto(place, enabled);
  const snapshot = useMemo<PlacePhotoSnapshot | null>(() => photo ? { provider: "google", imageUrl: photo.image_url, sourceUrl: photo.source_url, authors: photo.authors } : null, [photo]);
  useEffect(() => { if (snapshot) onPhoto?.(snapshot); }, [snapshot, onPhoto]);
  if (!snapshot || !enabled) return <>{children}</>;
  return <PhotoFigure place={place} photo={snapshot} showName={showName} showCredits={showCredits} onError={() => { onPhoto?.(null); discard(); }} />;
}
