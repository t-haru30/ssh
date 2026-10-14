import { useEffect, useRef, useState } from "react";
import type { MapViewProps } from "./MapView";
import { loadGoogleMaps, type GoogleMapsApi, type LatLng } from "./googleMapsLoader";
import { googleMapsUrl } from "./mapLinks";
import "./googleJourneyMap.css";
import { computeGooglePaths } from "./googleTransitPaths";

type PathSegment = { line_name: string; mode: string; coordinates: [number,number][]; approximate: boolean };
function readPaths(data: unknown): { segments: PathSegment[]; missing: boolean } | null {
  if (!data || typeof data !== "object" || !("routes" in data) || !Array.isArray(data.routes) || data.routes.length > 9) return null;
  const segments: PathSegment[] = [];
  let missing = false;
  for (const route of data.routes) {
    if (!route || typeof route !== "object" || !Array.isArray(route.segments)) return null;
    missing ||= route.status !== "ready";
    for (const segment of route.segments) {
      if (!segment || typeof segment.line_name !== "string" || typeof segment.mode !== "string" || typeof segment.approximate !== "boolean" || !Array.isArray(segment.coordinates) || segment.coordinates.length < 2 || segment.coordinates.length > 10000
        || !segment.coordinates.every((p:unknown) => Array.isArray(p) && p.length === 2 && p.every((n:unknown) => typeof n === "number" && Number.isFinite(n)) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)) return null;
      segments.push(segment);
    }
  }
  return {segments,missing};
}
export function GoogleJourneyMap({places,origin,returnTo = origin,activeSpotId = null,mapTokens = [],timeline = [],journeyDate = "",routeLoading = false,visible=true,initialMode="overview"}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<InstanceType<GoogleMapsApi["Map"]> | null>(null);
  const fitRef = useRef<(all: boolean) => void>(() => {});
  const fittedKey = useRef("");
  const [api,setApi] = useState<GoogleMapsApi | null>(null);
  const [failed,setFailed] = useState(false);
  const [retry,setRetry] = useState(0);
  const [mode,setMode] = useState<"overview"|"routes"|"walk">(initialMode);
  const [scope,setScope] = useState<"area"|"all">("area");
  const [pathState,setPathState] = useState<{key:string;segments:PathSegment[];missing:boolean;warnings?:string[]}>({key:"",segments:[],missing:false});
  const [pathLoading,setPathLoading] = useState(false);
  const [pathError,setPathError] = useState(false);
  const tokensKey = JSON.stringify([...new Set(mapTokens)].filter(token => /^[a-f0-9]{32}$/.test(token)).slice(0,9));
  const points=[...(origin ? [{lat:origin.latitude,lng:origin.longitude}] : []),...places.map(p => ({lat:p.latitude,lng:p.longitude})),...(returnTo ? [{lat:returnTo.latitude,lng:returnTo.longitude}] : [])];
  const times=timeline.flatMap(item => item.type === "transit" ? [item.start_time] : []);
  const pathKey=mode === "walk" ? JSON.stringify(["walk",points]) : tokensKey;
  const paths = pathState.key === pathKey ? pathState.segments : [];
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    void loadGoogleMaps().then(value => { if (!disposed) setApi(value); }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  },[retry]);
  useEffect(() => {
    if (!api || !container.current) return;
    mapRef.current = new api.Map(container.current,{center:{lat:origin?.latitude ?? 35.004,lng:origin?.longitude ?? 135.7681},zoom:12,mapId:api.mapId ?? "DEMO_MAP_ID",mapTypeControl:false,streetViewControl:false,fullscreenControl:true,gestureHandling:"cooperative"});
    fittedKey.current = "";
    return () => { mapRef.current = null; };
  },[api]);
  useEffect(()=>{
    if (!api || !visible || !container.current) return;
    let wasVisible=false;
    const refresh=()=>{
      const map=mapRef.current, node=container.current;
      if (!map || !node) return;
      const shown=node.getBoundingClientRect().width>0 && node.getBoundingClientRect().height>0;
      if (shown && !wasVisible) {api.event?.trigger(map,"resize");if(!fittedKey.current)fitRef.current(false);}
      wasVisible=shown;
    };
    const frame=requestAnimationFrame(refresh);
    const observer=typeof ResizeObserver!=="undefined" ? new ResizeObserver(refresh) : null;
    observer?.observe(container.current);
    return()=>{cancelAnimationFrame(frame);observer?.disconnect();};
  },[api,visible]);
  useEffect(() => {
    const map=mapRef.current;
    if (!api?.TransitLayer || !map || mode !== "routes") return;
    const layer=new api.TransitLayer(); layer.setMap(map);
    return () => layer.setMap(null);
  },[api,mode]);
  useEffect(() => {
    // Routes API does not supply Japanese transit. Never keep calling a known
    // unsupported mode, and never substitute driving geometry for a train/bus.
    if (!api || mode === "overview" || mode === "routes" && (api.routeProvider === "google" || routeLoading || tokensKey === "[]") || points.length<2 || pathState.key === pathKey) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(),40000);
    setPathLoading(true); setPathError(false);
    void (async () => {
      try {
        if (mode === "walk") {
          const parsed=await computeGooglePaths(points,journeyDate,times,controller.signal,"WALKING");
          if (!controller.signal.aborted) setPathState({key:pathKey,...parsed});
          return;
        }
        const response = await fetch("/api/routes/map-path",{method:"POST",headers:{"Content-Type":"application/json"},body:tokensKey,signal:controller.signal});
        const parsed = readPaths(await response.json());
        if (!response.ok || !parsed) throw new Error();
        if (!controller.signal.aborted) setPathState({key:pathKey,...parsed});
      } catch { if (!disposed) setPathError(true); }
      finally { window.clearTimeout(timeout); if (!disposed) setPathLoading(false); }
    })();
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); setPathLoading(false); };
  },[mode,api,pathKey,pathState.key,retry,routeLoading]);
  useEffect(() => {
    const map = mapRef.current;
    if (!api || !map) return;
    const point = (p:{latitude:number;longitude:number}):LatLng => ({lat:p.latitude,lng:p.longitude});
    const locations = [...(origin ? [{...origin,id:"origin",label:"出発"}] : []),...places.map((p,i) => ({...p,label:String(i+1)})),
      ...(returnTo && (!origin || returnTo.latitude !== origin.latitude || returnTo.longitude !== origin.longitude) ? [{...returnTo,id:"return",label:"帰着"}] : [])];
    const popups: InstanceType<GoogleMapsApi["InfoWindow"]>[] = [];
    const markers = locations.map(location => {
      const pin = document.createElement("button");
      pin.type = "button"; pin.className = `google-journey-pin${activeSpotId === location.id ? " is-active" : ""}`; pin.textContent = location.label; pin.setAttribute("aria-label",`${location.label} ${location.name}`);
      const marker = new api.AdvancedMarkerElement({map,position:point(location),content:pin,title:location.name});
      const content = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = location.name;
      const link = document.createElement("a"); link.textContent = "Google Mapsで開く"; link.href = googleMapsUrl(location); link.target = "_blank"; link.rel = "noopener noreferrer";
      content.className = "google-journey-popup"; content.append(title,link);
      const popup = new api.InfoWindow({content}); popups.push(popup);
      pin.addEventListener("click",() => { popups.forEach(p => p.close()); popup.open({map,anchor:marker}); });
      return marker;
    });
    const direct = [...(origin ? [point(origin)] : []),...places.map(point),...(returnTo ? [point(returnTo)] : [])];
    const lines = mode === "overview" ? [{coordinates:direct,color:"#b36a51",approximate:true}] : mode === "routes" && api.routeProvider === "google" ? [] : paths.map(path => ({coordinates:path.coordinates.map(([lat,lng]) => ({lat,lng})),color:path.mode === "train" ? "#3b6cc4" : path.mode === "bus" ? "#b36a51" : "#3f805b",approximate:path.approximate}));
    const polylines = lines.filter(line => line.coordinates.length >= 2).map(line => new api.Polyline({map,path:line.coordinates,strokeColor:line.color,strokeWeight:4,strokeOpacity:line.approximate ? 0 : .9,
      ...(line.approximate ? {icons:[{icon:{path:"M 0,-1 0,1",strokeColor:line.color,strokeOpacity:1,scale:2},offset:"0",repeat:"10px"}]} : {})}));
    fitRef.current = all => {
      const bounds = new api.LatLngBounds();
      const targets = all ? direct : places.map(point);
      targets.forEach(p => bounds.extend(p));
      if (targets.length > 1) map.fitBounds(bounds,45);
      else if (targets.length) { map.panTo(targets[0]); map.setZoom(14); }
    };
    // Layer changes, fetched paths and scroll-spy highlights must not undo the
    // user's chosen area/zoom. Fit again only when the journey's points change.
    const locationKey=JSON.stringify(direct);
    if (visible && fittedKey.current !== locationKey) { fittedKey.current=locationKey; setScope("area"); fitRef.current(false); }
    return () => { markers.forEach(marker => {marker.map = null;}); polylines.forEach(line => line.setMap(null)); popups.forEach(p => p.close()); };
  },[api,origin,returnTo,places,mode,pathState,pathKey,activeSpotId,visible]);
  const mapPlace = places[0] ?? origin;
  const namedPoints=[...(origin ? [origin] : []),...places,...(returnTo ? [returnTo] : [])];
  const connections=namedPoints.slice(1).flatMap((to,index) => {
    const from=namedPoints[index];
    if (from.latitude === to.latitude && from.longitude === to.longitude) return [];
    const leg=timeline.filter(item => item.type === "transit")[index];
    const url=`https://www.google.com/maps/dir/?${new URLSearchParams({api:"1",origin:from.name,destination:to.name,travelmode:"transit"})}`;
    return [{from,to,url,leg}];
  });
  const googleTransit=mode === "routes" && api?.routeProvider === "google";
  return <section className="map-frame google-journey-map" aria-label="旅程のGoogle Maps">
    <div className="journey-map-controls"><div role="group" aria-label="地図の線の表示"><button type="button" aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>つながり（直線）</button><button type="button" aria-pressed={mode === "routes"} onClick={() => setMode("routes")}>電車・バス</button><button type="button" aria-pressed={mode === "walk"} onClick={() => setMode("walk")}>徒歩経路</button></div><div className="journey-map-scope" role="group" aria-label="地図の表示範囲"><button type="button" aria-pressed={scope === "area"} onClick={() => {setScope("area");fitRef.current(false);}}>観光エリア</button><button type="button" aria-pressed={scope === "all"} onClick={() => {setScope("all");fitRef.current(true);}}>全体</button></div></div>
    <div className="map-canvas" ref={container} aria-label="旅程のスポット地図" />
    {!api && <div className="journey-map-placeholder" role="status">{failed ? <>地図を表示できません。{mapPlace && <a href={googleMapsUrl(mapPlace)} target="_blank" rel="noopener noreferrer">Google Mapsで確認する</a>}<button type="button" onClick={() => setRetry(v => v+1)}>再読み込み</button></> : "Google Mapsを読み込んでいます…"}</div>}
    <p className="journey-map-legend" role="status">{mode === "overview" ? "訪問順を直線で表示しています。" : googleTransit ? "背景は周辺の路線図です。この旅の乗換経路は区間ごとに開けます。" : pathLoading || routeLoading ? "経路を読み込んでいます…" : mode === "routes" && tokensKey === "[]" ? "交通経路の検索後に表示します。" : pathError || !paths.length ? mode === "walk" && !pathError && !pathState.missing ? "近距離の徒歩経路はありません。電車・バスの経路をご確認ください。" : "経路線を取得できませんでした。" : mode === "walk" ? <>緑：徒歩の参考経路。旅程の移動手段は変わりません。{pathState.missing && "未取得の区間があります。"}</> : <>青：鉄道　茶：バス　緑：徒歩。{pathState.missing && "未取得の区間があります。"}破線は停留所・接続地点間の目安です。経路：駅すぱあと</>}{!googleTransit && mode !== "overview" && (pathError || pathState.missing && !paths.length && !pathLoading || !paths.length && !pathLoading && !routeLoading && mode === "routes") && <button type="button" onClick={() => {setPathState({key:"",segments:[],missing:false});setRetry(v => v+1);}}>再試行</button>}</p>
    {googleTransit && <details className="journey-transit-links"><summary>区間ごとの乗換経路</summary>{connections.map(({from,to,url,leg},index) => <a href={url} key={`${index}-${from.name}`} target="_blank" rel="noopener noreferrer"><span>{from.name} → {to.name} ↗</span>{leg?.transit_line && <small>{leg.transit_line}</small>}</a>)}</details>}
    {mode !== "overview" && !googleTransit && pathState.key === pathKey && Boolean(pathState.warnings?.length) && <details className="journey-map-warnings"><summary>経路の注意事項</summary>{pathState.warnings!.map(w => <p key={w}>{w}</p>)}</details>}
  </section>;
}

