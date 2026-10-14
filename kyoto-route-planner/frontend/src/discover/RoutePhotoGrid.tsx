import type { Place } from "../types";
import { useRef, useState } from "react";
import { SpotPhoto } from "./SpotPhoto";
import "./routePhoto.css";

export function RoutePhotoGrid({ places, enabled, onPlaceSelect }: { places: Place[]; enabled: boolean; onPlaceSelect?: (id: string) => void }) {
  const [selection,setSelection]=useState({key:"",index:0});
  const key=places.map(p=>p.id).join("|");
  const index=selection.key===key ? Math.min(selection.index,Math.max(0,places.length-1)) : 0;
  return <div className={`route-photo-grid${places.length>1 ? " has-photo-pages" : ""}`}>
    {places[index] && <PhotoCell key={places[index].id} place={places[index]} enabled={enabled} onSelect={onPlaceSelect} />}
    {places.length>1 && <div className="route-photo-pages" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
      <button type="button" aria-label="前の施設の写真" disabled={index===0} onClick={()=>setSelection({key,index:index-1})}>←</button>
      <span aria-live="polite">{index+1} / {places.length}</span>
      <button type="button" aria-label="次の施設の写真" disabled={index===places.length-1} onClick={()=>setSelection({key,index:index+1})}>→</button>
    </div>}
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
