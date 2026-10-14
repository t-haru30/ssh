import type { Place } from "../types";
import { useRef } from "react";
import { SpotPhoto } from "./SpotPhoto";
import "./routePhoto.css";

export function RoutePhotoGrid({ places, enabled, onPlaceSelect }: { places: Place[]; enabled: boolean; onPlaceSelect?: (id: string) => void }) {
  return <div className="route-photo-grid" style={{ gridTemplateColumns: `repeat(${Math.min(2, places.length) || 1}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(places.length / 2) || 1}, minmax(0, 1fr))` }}>
    {places.map(place => <PhotoCell key={place.id} place={place} enabled={enabled} onSelect={onPlaceSelect} />)}
  </div>;
}

function PhotoCell({place, enabled, onSelect}: {place:Place;enabled:boolean;onSelect?: (id:string)=>void}) {
  const pointer=useRef<{x:number;y:number;moved:boolean}|null>(null);
  return <div className="route-photo-cell"><SpotPhoto place={place} enabled={enabled} />
    {onSelect && <button type="button" className="route-photo-open" aria-label={`${place.name}の詳細を見る`} aria-haspopup="dialog"
      onPointerDown={event=>{pointer.current={x:event.clientX,y:event.clientY,moved:false};}}
      onPointerMove={event=>{const p=pointer.current;if(p && Math.hypot(event.clientX-p.x,event.clientY-p.y)>8)p.moved=true;}}
      onPointerCancel={()=>{if(pointer.current)pointer.current.moved=true;}}
      onClick={event=>{event.stopPropagation();if(event.detail===0 || !pointer.current?.moved)onSelect(place.id);}} />}
  </div>;
}
