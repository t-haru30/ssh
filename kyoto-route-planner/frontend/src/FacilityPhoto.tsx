import { useEffect, useRef, useState } from "react";
import type { Place } from "./types";
import { SpotPhoto } from "./discover/SpotPhoto";
import { PhotoFigure, type PlacePhotoSnapshot } from "./discover/PhotoFigure";
import "./facilityPhoto.css";

export function FacilityPhoto({place, compact = false, photo}: {place: Place; compact?: boolean; photo?:PlacePhotoSnapshot}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, {rootMargin:"150px"});
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={root} className={`facility-photo${compact ? " facility-photo-compact" : ""}`}>{photo && failedUrl !== photo.imageUrl
    ? <PhotoFigure place={place} photo={photo} showName={false} onError={()=>setFailedUrl(photo.imageUrl)} />
    : <SpotPhoto key={`${place.id}:${place.latitude}:${place.longitude}`} place={place} enabled={visible} showName={false} />}</div>;
}
