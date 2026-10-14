import type { GoogleVenueInfo } from "./discover/useGoogleVenueInfo";
import type {Place} from "./types";
export function osmVisitFits(place:Place,minute:number,dwell:number) {
  const value=place.tags?.opening_hours;
  if(!value || value==="24/7")return true;
  if(/PH|SH|sunrise|sunset|["()]/.test(value))return true;
  const days=["Su","Mo","Tu","We","Th","Fr","Sa"],today=days[new Date().getDay()];
  const windows:[number,number][]=[];
  for(const clause of value.split(";")) {
    const match=/^\s*((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)?\s*((?:\d{2}:\d{2}-\d{2}:\d{2})(?:\s*,\s*\d{2}:\d{2}-\d{2}:\d{2})*|off|closed)\s*$/.exec(clause);
    if(!match)return true;
    const active=new Set<string>(match[1] ? [] : days);
    for(const part of (match[1]??"").split(",")) {
      const [a,b]=part.split("-");
      if(b) {let i=days.indexOf(a);for(let n=0;n<7;n++,i=(i+1)%7){active.add(days[i]);if(days[i]===b)break;}}
      else if(a)active.add(a);
    }
    if(!active.has(today))continue;
    if(/off|closed/.test(match[2])){windows.length=0;continue;}
    for(const span of match[2].split(",")) {
      const [a,b]=span.trim().split("-").map(s=>Number(s.slice(0,2))*60+Number(s.slice(3)));
      if(a>1440 || b>1440)return true;
      windows.push([a,b>a ? b : b+1440]);
    }
  }
  return windows.some(([a,b])=>a<=minute && minute+dwell<=b);
}
export function openingConflict(info:GoogleVenueInfo|undefined,date:string,start:number,dwell:number) {
  if(!info)return null;
  if(info.business_status==="closed" || info.business_status==="temporary")return `${info.display_name || "この施設"}は休業・閉業の登録があります。別の施設をご検討ください。`;
  const day=new Date(`${date}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+Math.floor(start/1440));
  const windows=info.weekly_hours?.[day.getUTCDay()];
  if(!windows)return null;
  const minute=start%1440;
  return windows.some(([a,b])=>a<=minute && minute+dwell<=b) ? null : "予定時刻が通常の営業時間外です。訪問時刻か施設の変更が必要です。特別営業日は公式案内をご確認ください。";
}
