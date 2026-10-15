import type { Place } from "../types";
import { useCallback, useRef, useState } from "react";
import { SpotPhoto } from "./SpotPhoto";
import type { PlacePhotoSnapshot } from "./PhotoFigure";
import "./routePhoto.css";

export function RoutePhotoGrid({ places, enabled, showCredits = true, onPlaceSelect }: { places: Place[]; enabled: boolean; showCredits?: boolean; onPlaceSelect?: (id: string, photo?: PlacePhotoSnapshot) => void }) {
  const [selection,setSelection]=useState({key:"",index:0});
  const key=places.map(p=>p.id).join("|");
  const pageCount=Math.ceil(places.length/4);
  const index=selection.key===key ? Math.min(selection.index,Math.max(0,pageCount-1)) : 0;
  const visible=places.slice(index*4,index*4+4);
  return <div className={`route-photo-grid${pageCount>1 ? " has-photo-pages" : ""}`}>
    <div className={`route-photo-page${visible.length>1 ? " is-grid" : ""}`} aria-label="旅の行き先の写真">
      {visible.map(place=><PhotoCell key={`${place.id}:${place.name}:${place.latitude}:${place.longitude}`} place={place} enabled={enabled} showCredits={showCredits} onSelect={onPlaceSelect} />)}
    </div>
    {pageCount>1 && <div className="route-photo-pages" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
      <button type="button" aria-label="前の写真ページ" disabled={index===0} onClick={()=>setSelection({key,index:index-1})}>←</button>
      <span aria-live="polite">写真 {index+1} / {pageCount}</span>
      <button type="button" aria-label="次の写真ページ" disabled={index===pageCount-1} onClick={()=>setSelection({key,index:index+1})}>→</button>
    </div>}
  </div>;
}

function PhotoCell({place, enabled, showCredits, onSelect}: {place:Place;enabled:boolean;showCredits:boolean;onSelect?: (id:string, photo?:PlacePhotoSnapshot)=>void}) {
  const pointer=useRef<{x:number;y:number;moved:boolean}|null>(null);
  const photo = useRef<PlacePhotoSnapshot | null>(null);
  const rememberPhoto = useCallback((value: PlacePhotoSnapshot | null) => { photo.current = value; }, []);
  return <div className="route-photo-cell"><SpotPhoto place={place} enabled={enabled} showCredits={showCredits} onPhoto={rememberPhoto} />
    {onSelect && <button type="button" className="route-photo-open" aria-label={`${place.name}の詳細を見る`} aria-haspopup="dialog"
      onPointerDown={event=>{pointer.current={x:event.clientX,y:event.clientY,moved:false};}}
      onPointerMove={event=>{const p=pointer.current;if(p && Math.hypot(event.clientX-p.x,event.clientY-p.y)>8)p.moved=true;}}
      onPointerCancel={()=>{if(pointer.current)pointer.current.moved=true;}}
      onClick={event=>{event.stopPropagation();if(event.detail===0 || !pointer.current?.moved)onSelect(place.id,photo.current ?? undefined);}} />}
  </div>;
}
