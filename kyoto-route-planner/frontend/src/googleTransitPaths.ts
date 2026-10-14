import { loadGoogleRoutes, type LatLng } from "./googleMapsLoader";
export type PathSegment = { line_name:string;mode:string;coordinates:[number,number][];approximate:boolean };
type Step = {path?:LatLng[];travelMode?:string;transitDetails?:{transitLine?:{name?:string;vehicle?:{type?:string}}}};
type GoogleRoute = {path?:LatLng[];legs?:{steps?:Step[]}[];warnings?:string[]};
type RoutesLibrary = {Route:{computeRoutes:(request:Record<string,unknown>) => Promise<{routes?:GoogleRoute[]}>}};

async function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted","AbortError");
  let onAbort:() => void = () => {};
  try {
    return await Promise.race([work,new Promise<T>((_,reject) => {onAbort=() => reject(new DOMException("Aborted","AbortError"));signal.addEventListener("abort",onAbort,{once:true});})]);
  } finally {signal.removeEventListener("abort",onAbort);}
}

export async function computeGooglePaths(points: LatLng[], day:string, times:(string|null)[], signal:AbortSignal, travelMode:"TRANSIT"|"WALKING"="TRANSIT") {
  const allPairs=points.slice(1).map((to,index) => ({from:points[index],to,index})).filter(p => p.from.lat!==p.to.lat || p.from.lng!==p.to.lng).slice(0,9);
  // Walking is a separate, explicit preview. Do not turn long-distance transit
  // into an implausible walking itinerary or silently change the user's plan.
  const pairs=travelMode === "WALKING" ? allPairs.filter(p => Math.hypot((p.from.lat-p.to.lat)*111,(p.from.lng-p.to.lng)*111*Math.cos(p.from.lat*Math.PI/180))<=3) : allPairs;
  if (!pairs.length) return {segments:[],missing:false,warnings:[]};
  const budget=await fetch(`/api/maps/route-budget?count=${pairs.length}`,{method:"POST",signal});
  const permission:unknown=await budget.json();
  if (!budget.ok || !permission || typeof permission!=="object" || !("granted" in permission) || typeof permission.granted!=="number" || !Number.isInteger(permission.granted) || permission.granted<1) throw new Error("route_budget");
  const allowed=pairs.slice(0,Math.min(pairs.length,permission.granted));
  const {Route}=await loadGoogleRoutes() as unknown as RoutesLibrary;
  const segments:PathSegment[]=[];
  const warnings:string[]=[];
  let missing=allowed.length<pairs.length;
  // Transit has no intermediate-waypoint support: query each facility pair,
  // at its already-planned departure, with no automatic retries or mode changes.
  for (let start=0;start<allowed.length && !signal.aborted;start+=2) {
    const batch=await Promise.allSettled(allowed.slice(start,start+2).map(async pair => {
      const clock=times[pair.index] ?? times[0] ?? "09:00";
      const departure=clock && /^\d{2}:\d{2}$/.test(clock) && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T${clock}:00+09:00`) : undefined;
      const response=await abortable(Route.computeRoutes({origin:pair.from,destination:pair.to,travelMode,fields:["path","legs","warnings"],polylineQuality:"HIGH_QUALITY",...(travelMode === "TRANSIT" && departure ? {departureTime:departure} : {})}),signal);
      if (signal.aborted) throw new DOMException("Aborted","AbortError");
      const route=response.routes?.[0];
      if (!route) throw new Error("no_route");
      const convert=(path:LatLng[] = []):[number,number][] => path.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat)<=90 && Math.abs(p.lng)<=180).slice(0,10000).map(p => [p.lat,p.lng]);
      const steps=route.legs?.flatMap(leg => leg.steps ?? []) ?? [];
      const paths=steps.map(step => {
        const line=step.transitDetails?.transitLine;
        return {line_name:line?.name ?? "徒歩",mode:step.travelMode === "WALKING" ? "walk" : /BUS/.test(line?.vehicle?.type ?? "") ? "bus" : "train",coordinates:convert(step.path),approximate:false};
      }).filter(p => p.coordinates.length>=2);
      const fallback=convert(route.path);
      return {segments:paths.length ? paths : fallback.length>=2 ? [{line_name:travelMode === "WALKING" ? "徒歩の参考経路" : "公共交通の参考経路",mode:travelMode === "WALKING" ? "walk" : "public_transport",coordinates:fallback,approximate:false}] : [],warnings:route.warnings ?? []};
    }));
    for (const item of batch) if (item.status === "fulfilled") {segments.push(...item.value.segments);warnings.push(...item.value.warnings);} else {
      missing=true;
      // Keep credentials and request locations out of developer diagnostics.
      const message=item.reason instanceof Error ? item.reason.message : "unknown";
      console.warn("Google Routes request failed:",message.replace(/https?:\/\/\S+/g,"[url]").replace(/AIza[A-Za-z0-9_-]+/g,"[key]").replace(/-?\d+\.\d+/g,"[number]").slice(0,240));
    }
  }
  return {segments,missing,warnings:[...new Set(warnings)].slice(0,9)};
}
