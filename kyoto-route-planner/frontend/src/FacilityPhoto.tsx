import { useEffect, useRef, useState } from "react";
import type { Place } from "./types";
import { SpotPhoto } from "./discover/SpotPhoto";
import "./facilityPhoto.css";

export function FacilityPhoto({place, compact = false}: {place: Place; compact?: boolean}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, {rootMargin:"150px"});
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  if (["trip-arrival", "trip-return"].includes(place.id)) return null;
  return <div ref={root} className={`facility-photo${compact ? " facility-photo-compact" : ""}`}><SpotPhoto key={`${place.id}:${place.latitude}:${place.longitude}`} place={place} enabled={visible} showName={false} /></div>;
}
