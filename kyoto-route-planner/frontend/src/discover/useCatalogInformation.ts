import {useEffect,useState} from 'react';
import type {Place} from '../types';
import {isOrigin,isRecord} from '../apiValidation';

export type CatalogInformation={place_id:string;name:string;latitude:number;longitude:number;status:string;revision:string;official:unknown;field_checked_at:Record<string,string>};

/** Only the open facility's public DB facts are refreshed; no Maps/Gemini calls. */
export function useCatalogInformation(place:Place) {
  const identity=JSON.stringify([place.id,place.name,place.latitude,place.longitude]);
  const [state,setState]=useState<{identity:string;record:CatalogInformation|null}>({identity:'',record:null});
  useEffect(()=>{
    if(!/^osm-(node|way|relation)-\d+$/.test(place.id))return;
    let active=true;let controller:AbortController|null=null;
    async function refresh(){
      if(!active||controller||document.visibilityState==='hidden')return;
      const current=new AbortController();controller=current;
      const timer=window.setTimeout(()=>current.abort(),8000);
      try{
        const response=await fetch('/api/places/current-information',{method:'POST',cache:'no-store',signal:current.signal,
          headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[place.id]})});
        const data:unknown=await response.json();
        if(!active||current.signal.aborted||!response.ok||!isRecord(data)||data.status!=='ready'||!Array.isArray(data.records)||data.records.length>1)return;
        const value=data.records[0];
        if(value!==undefined){
          if(!isRecord(value)||value.place_id!==place.id||!isRecord(value.official)||!isRecord(value.field_checked_at)||!Object.values(value.field_checked_at).every(date=>typeof date==='string')
            ||typeof value.revision!=='string'||!/^[a-f0-9]{64}$/.test(value.revision)||!['updated','conflict','failed','needs_review'].includes(String(value.status))
            ||!isOrigin(value)
            ||value.name.normalize('NFKC').replace(/\s/g,'')!==place.name.normalize('NFKC').replace(/\s/g,'')
            ||Math.hypot((value.latitude-place.latitude)*111,(value.longitude-place.longitude)*111*Math.cos(place.latitude*Math.PI/180))>.5)return;
        }
        const record=value ? value as CatalogInformation : null;
        setState(previous=>previous.identity===identity&&previous.record?.revision===record?.revision ? previous : {identity,record});
      }catch{/* Keep the last accepted information during a temporary DB outage. */}
      finally{window.clearTimeout(timer);if(controller===current)controller=null;}
    }
    void refresh();
    const interval=window.setInterval(()=>void refresh(),60000);
    const resume=()=>void refresh();window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
    return()=>{active=false;controller?.abort();window.clearInterval(interval);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
  },[identity]);
  return state.identity===identity ? state.record : null;
}
