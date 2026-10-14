import { useEffect, useState } from "react";
import { StationSearch } from "./StationSearch";
import { isOrigin, isRecord } from "./apiValidation";
import type { Origin } from "./types";
import gatewayPresets from "./data/gatewayPresets.json";

const candidates = new Map<string, Origin[]>();
const presets:Record<string,Origin[]>=gatewayPresets.gateways;
function mergeOptions(...groups:Origin[][]) {
  const seen=new Map<string,Origin>();
  for(const p of groups.flat())if(!seen.has(p.name))seen.set(p.name,{name:p.name,latitude:p.latitude,longitude:p.longitude});
  return [...seen.values()];
}

export function DestinationGatewaySearch({ area, prefecture, fallback, value, onChange }: {
  area: string; prefecture: { name: string; code: string }; fallback: Origin; value: Origin;
  onChange: (origin: Origin, prefecture?: string) => void;
}) {
  const bundled=mergeOptions([fallback],presets[area]??[]);
  const [options, setOptions] = useState<Origin[]>(bundled);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [expanded,setExpanded]=useState(false);
  const key = JSON.stringify([area, fallback,expanded]);
  useEffect(() => {
    const cached = candidates.get(key);
    setOptions(current=>cached ?? (expanded ? mergeOptions(bundled,current) : bundled)); setFailed(false);
    if (cached) { setMessage(""); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), 26_000);
    setMessage(bundled.length>1 ? "" : "周辺の駅を探しています…");
    void (async () => {
      try {
        const response = await fetch("/api/destination-gateways", { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ area, origin: fallback, ...(expanded ? {expanded:true} : {}) }) });
        const data: unknown = await response.json();
        if (!response.ok || !isRecord(data) || !Array.isArray(data.places) || !data.places.every(isOrigin)) throw new Error();
        if (controller.signal.aborted) return;
        const found = data.places.map(place => ({ name: /駅|空港|港$|バスターミナル/.test(place.name) ? place.name : `${place.name}駅`, latitude: place.latitude, longitude: place.longitude }));
        const all = mergeOptions(bundled,found);
        const added = all.length > 1;
        if (added) candidates.set(key, all);
        setOptions(all); setFailed(!added);
        setMessage(added ? "" : "周辺の候補が少ないため、駅名でも検索できます。");
      } catch {
        if (!controller.signal.aborted || controller.signal.reason?.name === "TimeoutError") {
          setFailed(bundled.length<=1); setMessage(bundled.length>1 ? "ほかの駅は駅名で検索できます。" : "周辺の駅を取得できませんでした。駅名で検索できます。");
        }
      } finally { window.clearTimeout(timer); }
    })();
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, retry]);
  return <div className="destination-gateways">
    <StationSearch label="行き先の駅・観光の起点" optionLayout="buttons" value={value} options={options} prefecture={prefecture} onChange={onChange} onMoreOptions={()=>setExpanded(true)} />
    {message && <p className="preference-tags-note" role="status">{message}</p>}
    {failed && <button type="button" onClick={() => setRetry(v => v + 1)}>周辺の駅を再検索</button>}
  </div>;
}
