import { useEffect, useRef, useState } from "react";
import { clockMinutes, scheduleTrip, tripClock, type TripPlan } from "./dayTrip";
import { isRecord, isRouteTimelineItem } from "./apiValidation";
import type { RouteTimelineTransit } from "./types";

type Schedule = { stops: {id: string; start: number; end: number}[]; transits: RouteTimelineTransit[]; return_minute: number | null; problems: string[]; unknown: string[]; reasons?: string[] };
type Check = {place_id: string; name: string; business: string; notes: string[]; source: string | null; official_source: string | null; confirmed_date: boolean; windows: [number,number][] | null};
type Report = {checked_at: string; checks: Check[]; original: Schedule | null; proposal: Schedule | null; actions: string[]; note: string};
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");
const minute = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 10080;
function validSchedule(v: unknown): v is Schedule {
  return isRecord(v) && Array.isArray(v.stops) && v.stops.every(s => isRecord(s) && typeof s.id === "string" && minute(s.start) && minute(s.end) && s.end >= s.start) && Array.isArray(v.transits) && v.transits.every(t => isRouteTimelineItem(t) && t.type === "transit") && (v.return_minute === null || minute(v.return_minute)) && strings(v.problems) && strings(v.unknown) && (v.reasons === undefined || strings(v.reasons));
}
function safeLink(url: unknown): url is string {
  try { if (typeof url !== "string") return false; const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
export function auditProposal(plan: TripPlan, proposal: Schedule): TripPlan | null {
  if (plan.stops.some(s => s.completed) || proposal.problems.length || proposal.unknown.length || !proposal.stops.length || proposal.transits.length !== proposal.stops.length + 1 || proposal.transits.some(t => t.is_estimate || !minute(t.duration_minutes))) return null;
  const ids = proposal.stops.map(s => s.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !plan.stops.some(s => s.place.id === id)) || plan.stops.some(s => s.locked && !ids.includes(s.place.id))) return null;
  const stops = proposal.stops.map(row => {
    const old = plan.stops.find(s => s.place.id === row.id)!;
    if (row.start >= 1440 || row.end - row.start !== old.dwellMinutes || (old.locked && row.start !== old.start) || (old.anchorTime && row.start !== clockMinutes(old.anchorTime))) throw new Error("固定した時刻または滞在時間と変更案が一致しません。");
    return {...old, anchorTime:tripClock(row.start)};
  });
  const route = {...plan.transport.route, origin:plan.origin, return_to:plan.returnTo, places:stops.map(s => s.place), timeline:proposal.transits,
    total_minutes:proposal.transits.reduce((sum,t) => sum + t.duration_minutes!,0),
    fare_yen:proposal.transits.every(t => t.fare_yen != null) ? proposal.transits.reduce((sum,t) => sum + t.fare_yen!,0) : null,
    legs:proposal.transits.flatMap(t => t.legs ?? [])};
  const next = scheduleTrip(plan.input,plan.origin,plan.date,stops,{route,date:plan.date,time:plan.input.departureTime},plan.transportEstimate,plan.returnTo);
  if (next.returnMinute !== proposal.return_minute || next.returnMinute > clockMinutes(plan.input.departureTime) + plan.input.availableMinutes || next.stops.some((s,i) => s.start !== proposal.stops[i].start)) return null;
  return {...next,planningEstimates:plan.planningEstimates};
}

export function ItineraryAudit({plan,onAdopt}: {plan:TripPlan;onAdopt:(plan:TripPlan)=>void}) {
  const key = JSON.stringify(plan);
  const [report,setReport] = useState<{key:string;value:Report}|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const request = useRef<AbortController|null>(null);
  useEffect(() => { request.current?.abort(); request.current=null; setBusy(false); setReport(null); setError(""); return () => request.current?.abort(); },[key]);
  const result = report?.key === key ? report.value : null;
  let proposed: TripPlan|null = null;
  try { if (result?.proposal) proposed=auditProposal(plan,result.proposal); } catch { /* Invalid proposal cannot be adopted. */ }
  async function check() {
    if (request.current) return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError("");setReport(null);
    const timer=window.setTimeout(() => controller.abort(),105000);
    try {
      const response=await fetch("/api/itinerary/audit",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",signal:controller.signal,body:JSON.stringify({
        origin:{...plan.origin,name:plan.origin.name.slice(0,80)},return_to:{...plan.returnTo,name:plan.returnTo.name.slice(0,80)},departure_date:plan.date,departure_time:plan.input.departureTime,available_minutes:plan.input.availableMinutes,
        stops:plan.stops.map(s => ({place:s.place,dwell:s.dwellMinutes,locked:s.locked,start:s.start,anchor:s.anchorTime ? clockMinutes(s.anchorTime) : null}))})});
      if (!response.ok) throw new Error(response.status===429 ? "確認が混み合っています。少し待って再実行してください。" : "確認できませんでした。元の旅程は変更していません。");
      const value:unknown=await response.json();
      if (!isRecord(value) || typeof value.checked_at!=="string" || typeof value.note!=="string" || !strings(value.actions) || !Array.isArray(value.checks) || !value.checks.every(c => isRecord(c) && typeof c.place_id==="string" && typeof c.name==="string" && typeof c.business==="string" && strings(c.notes)) || (value.original!==null && !validSchedule(value.original)) || (value.proposal!==null && !validSchedule(value.proposal))) throw new Error("確認結果の形式が不正です。");
      if (!controller.signal.aborted) setReport({key,value:value as unknown as Report});
    } catch (e) { if (request.current===controller) setError(controller.signal.aborted ? "確認を中止しました。元の旅程は変更していません。" : e instanceof Error ? e.message : "確認できませんでした。"); }
    finally {clearTimeout(timer);if(request.current===controller){request.current=null;setBusy(false);}}
  }
  return <section className="trip-feasibility" aria-label="旅程の成立チェック">
    <h3>この旅程で、実際に回れる？</h3>
    <p>営業時間・閉業や臨時休業・公共交通の移動時間を確認し、必要なら修正案を作ります。採用するまで元の旅程は変わりません。</p>
    <small>最大8施設・経路2回分を確認します。Googleの営業時間検索と駅すぱあとを使用し、各APIの利用料金が発生する場合があります。</small>
    {plan.stops.some(s => s.completed) && <p>このチェックは出発前の旅程が対象です。訪問済みの記録は変更しません。</p>}
    <div><button type="button" disabled={busy || !plan.stops.length || plan.stops.some(s => s.completed)} onClick={() => void check()}>{busy ? "営業情報と移動時間を確認中…" : "営業・移動を確認して修正案を見る"}</button>
      {busy && <button type="button" onClick={() => request.current?.abort()}>確認を中止</button>}</div>
    {error && <p role="status">{error}</p>}
    {result && <div aria-live="polite">
      <p>確認日時：{new Date(result.checked_at).toLocaleString("ja-JP")}</p>
      <details><summary>確認した内容</summary><ol>{result.actions.map((text,i) => <li key={i}>{text}</li>)}</ol></details>
      {result.checks.map(c => <details key={c.place_id}><summary>{c.name}：{c.business==="closed" ? "閉業・閉館の登録" : c.business==="temporary" ? "一時休業の登録" : c.business==="operational" ? "営業継続の登録" : "営業状態未確認"}</summary>
        {c.confirmed_date && Array.isArray(c.windows) && c.windows.every(w => Array.isArray(w) && w.length===2 && w.every(minute)) && <p>訪問日の営業時間：{c.windows.length ? c.windows.map(([a,b]) => `${tripClock(a)}〜${tripClock(b)}`).join("、") : "営業する時間帯なし（休業告知を含む）"}</p>}
        {c.notes.map((note,i)=><p key={i}>{note}</p>)}
        {safeLink(c.source) && <a href={c.source} target="_blank" rel="noopener noreferrer" translate="no">Google Maps</a>}{safeLink(c.official_source) && <> · <a href={c.official_source} target="_blank" rel="noopener noreferrer">公式の休業告知</a></>}
      </details>)}
      {result.original && <><h4>現在の旅程の確認結果</h4><ul>{[...result.original.problems,...result.original.unknown].map((p,i)=><li key={i}>{p}</li>)}</ul>
        {!result.original.problems.length && !result.original.unknown.length && <p>取得できた営業時間・移動時間では、時間枠内に収まります。</p>}</>}
      {proposed && <><h4>修正案（まだ反映していません）</h4><ul>{result.proposal?.reasons?.map((r,i)=><li key={i}>{r}</li>)}</ul>
        <p>{plan.stops.length}か所 → {proposed.stops.length}か所 ／ 帰着 {tripClock(plan.returnMinute)} → {tripClock(proposed.returnMinute)}</p>
        <ol>{proposed.stops.map(s=><li key={s.place.id}>{tripClock(s.start)}〜{tripClock(s.end)} {s.place.name}</li>)}</ol>
        <button type="button" onClick={() => {if(proposed)onAdopt(proposed);}}>この修正案を採用する</button> <button type="button" onClick={() => setReport(null)}>元の旅程を残す</button></>}
      <p>{result.note}</p>
    </div>}
  </section>;
}
