import { PreviewTransit } from "./PreviewTransit";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, FormEvent } from "react";
import type { TripPlan } from "./dayTrip";
import { distanceKm, scheduleTrip, transportMatches, tripChanges, tripClock } from "./dayTrip";
import type { Place } from "./types";
import { isRecord, isRouteSuggestion } from "./apiValidation";
import { chatPayload, readChatProposal } from "./journeyChatState";
import type { ChatMessage } from "./journeyChatState";
import { LazyMapView } from "./LazyMapView";
import { FacilityPhoto } from "./FacilityPhoto";
import { useMobileLayout } from "./useMobileLayout";
import "./journeyChat.css";

function journeyTimeRange(plan: TripPlan) {
  const departure = plan.input.departureTime.replace(/^0(?=\d:)/, "");
  return `${departure}~${tripClock(plan.returnMinute)}`;
}

export function JourneyChat({ plan, candidates, onApply, disabled = false,routePriority="time",preferNearbyAirport=true }: {
  plan: TripPlan; candidates: Place[]; onApply: (plan: TripPlan) => void; disabled?: boolean;
  routePriority?:"time"|"price";preferNearbyAirport?:boolean;
}) {
  const [chatVisible, setChatVisible] = useState(true);
  const [mapVisible, setMapVisible] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<"chat" | "preview" | "map">("chat");
  const mobile = useMobileLayout();
  const [mobileOpen, setMobileOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!mobile || !mobileOpen || !dialog.current) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    const viewport = window.visualViewport;
    const update = () => {
      element.style.height = `${viewport?.height ?? window.innerHeight}px`;
      element.style.top = `${viewport?.offsetTop ?? 0}px`;
    };
    update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    return () => {
      element.close(); document.body.style.overflow = previousOverflow;
      viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update);
    };
  }, [mobile, mobileOpen]);
  const [chatWidth, setChatWidth] = useState(45);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const panels = useRef<HTMLDivElement>(null);
  const mapDrag = useRef<{ x: number; width: number; ratio: number } | null>(null);
  const editorRatio = editorWidth ?? (chatVisible ? 56.5 : 40);
  const resizeMap = (value: number) => setEditorWidth(Math.max(30, Math.min(75, value)));
  const workspace = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; ratio: number } | null>(null);
  const resize = (value: number) => setChatWidth(Math.max(30, Math.min(70, value)));
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [draggedStop, setDraggedStop] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState("");
  const [view, setView] = useState<"current" | "changes">("current");
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setHost(document.getElementById("journey-workspace-slot")); }, []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [routeStatus, setRouteStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [routeRetry, setRouteRetry] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [proposal, setProposal] = useState<{ base: string; plan: TripPlan } | null>(null);
  const request = useRef<AbortController | null>(null);
  const identity = JSON.stringify(plan);
  const latest = useRef(identity); latest.current = identity;
  useEffect(() => {
    if (request.current) setError("旅程や移動時間が更新されたため、相談を中断しました。最新の旅程でもう一度相談してください。");
    request.current?.abort(); request.current = null;
    setWorking(false); setProposal(null); setSteps([]); setReplacing(null); setDraggedStop(null); setDropTarget(null); setReorderError("");
    // A changed applied plan invalidates any pending preview and in-flight reply.
  }, [identity]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, working, proposal]);

  function cancel() {
    request.current?.abort(); request.current = null;
    setWorking(false); setError("相談を中止しました。現在の旅程は変更していません。");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || text.length > 1200 || request.current || disabled) return;
    const controller = new AbortController(); request.current = controller;
    const base = identity;
    const editing = proposal?.base === base ? proposal.plan : plan;
    const pool = [...candidates, ...plan.stops.map(s => s.place), ...editing.stops.map(s => s.place)];
    const context = messages.slice(-12);
    setMessages(current => [...current.slice(-19), { role: "user", text }]);
    setInput(""); setError(""); setSteps([]); setWorking(true);
    const timer = window.setTimeout(() => controller.abort(), 70_000);
    try {
      const response = await fetch("/api/journey/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatPayload(editing, pool, text, context, editing === plan ? undefined : plan)), signal: controller.signal });
      const data: unknown = await response.json();
      if (request.current !== controller || latest.current !== base || controller.signal.aborted) return;
      if (!response.ok) throw new Error(isRecord(data) && typeof data.detail === "string" ? data.detail : "AIチャットに接続できませんでした。");
      if (!isRecord(data) || typeof data.message !== "string" || data.message.length > 3000
        || !Array.isArray(data.steps) || data.steps.length > 6 || !data.steps.every(s => typeof s === "string" && s.length <= 3000)) throw new Error("返答の形式を確認できませんでした。");
      const next = data.proposal == null ? null : readChatProposal(data.proposal, editing, pool, data.discovered_candidates ?? [], plan);
      setSteps(data.steps as string[]);
      setMessages(current => [...current.slice(-19), { role: "assistant", text: data.message as string }]);
      if (next) {
        setRouteStatus("loading");
        setRouteRetry(current => current + 1);
        setProposal({ base, plan: next }); setView("changes");
        // Preserve the suggested itinerary for follow-up requests without claiming adoption.
        setMessages(current => [...current, { role: "assistant",
          text: "変更案を用意しました。旅程プレビューで確認できます。",
          context: `未反映の変更案：${next.stops.map(s => `${s.place.name}（ID:${s.place.id}、${s.dwellMinutes}分）`).join(" → ")}` }]);
      }
    } catch (cause) {
      if (request.current === controller && latest.current === base) setError(controller.signal.aborted
        ? "回答に時間がかかっています。時間を置いて再度相談してください。"
        : cause instanceof Error ? cause.message : "相談を完了できませんでした。");
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; setWorking(false); }
    }
  }
  const pending = proposal?.base === identity ? proposal.plan : null;
  const routeRequestKey = pending ? JSON.stringify([identity, pending.origin, pending.returnTo, pending.date, pending.input, pending.stops.map(s => [s.place, s.dwellMinutes, s.anchorTime]),routePriority,preferNearbyAirport]) : "";
  useEffect(() => {
    if (!pending) { setRouteStatus("idle"); return; }
    const snapshot = pending;
    const controller = new AbortController();
    let expired = false;
    setRouteStatus("loading");
    const timeout = window.setTimeout(() => { expired = true; controller.abort(); setRouteStatus("failed"); }, 55000);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/routes/preview", {method:"POST", signal:controller.signal, headers:{"Content-Type":"application/json"}, body:JSON.stringify({
            origin:snapshot.origin, return_to:snapshot.returnTo, places:snapshot.stops.map(s => s.place), stay_minutes:snapshot.stops.map(s => s.dwellMinutes),
            meal_times:Object.fromEntries(snapshot.stops.filter(s => s.anchorTime).map(s => [s.place.id,s.anchorTime])), departure_date:snapshot.date, departure_time:snapshot.input.departureTime,
            route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
          })});
          const route: unknown = await response.json();
          if (!response.ok || !isRouteSuggestion(route)) throw new Error();
          if (controller.signal.aborted) return;
          const next = {...scheduleTrip(snapshot.input, snapshot.origin, snapshot.date, snapshot.stops, {route,date:snapshot.date,time:snapshot.input.departureTime}, snapshot.transportEstimate, snapshot.returnTo, {checkPlanningLimits:false}), planningEstimates:snapshot.planningEstimates};
          if (!transportMatches(next)) throw new Error();
          setProposal(current => current?.plan === snapshot ? {...current,plan:next} : current);
          setRouteStatus("idle");
        } catch { if (!controller.signal.aborted || expired) setRouteStatus("failed"); }
        finally { window.clearTimeout(timeout); }
      })();
    }, 300);
    return () => { window.clearTimeout(timer); window.clearTimeout(timeout); controller.abort(); };
  }, [routeRequestKey, routeRetry]);
  const shown = pending && view === "changes" ? pending : plan;
  const reviewing = shown === pending;
  const removed = pending ? plan.stops.filter(s => !pending.stops.some(n => n.place.id === s.place.id)) : [];
  const timeline = transportMatches(shown) ? shown.transport.route.timeline ?? [] : [];
  const replaceOrigin = shown.stops.find(s => s.place.id === replacing)?.place ?? shown.origin;
  const replacements = [...new Map(candidates.map(p => [p.id, p])).values()]
    .filter(p => !shown.stops.some(s => s.place.id === p.id) && distanceKm(replaceOrigin, p) <= 20)
    .sort((a, b) => distanceKm(replaceOrigin, a) - distanceKm(replaceOrigin, b)).slice(0, 30);
  function replacePlace(oldId: string, nextId: string) {
    if (working || disabled) return;
    const old = shown.stops.find(s => s.place.id === oldId);
    if (!old || old.locked || old.completed) return;
    try {
      const next = readChatProposal({ stops: shown.stops.map(s => ({ id: s.place.id === oldId ? nextId : s.place.id, dwell: s.dwellMinutes })) }, plan, [...candidates, ...shown.stops.map(s => s.place)]);
      setRouteStatus("loading");
      setProposal({ base: identity, plan: next }); setView("changes"); setReplacing(null); setError("");
      setMessages(current => [...current, {role: "assistant", text: `${old.place.name}を${next.stops.find(s => s.place.id === nextId)!.place.name}に入れ替える案です。地図と時間を確認して反映してください。`}, { role: "assistant", text: "", context: `未反映の変更案：${next.stops.map(s => `${s.place.name}（ID:${s.place.id}、${s.dwellMinutes}分）`).join(" → ")}` }]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "入れ替えできませんでした。"); }
  }
  function canMove(from: number, to: number) {
    return !working && !disabled && from >= 0 && to >= 0 && to < shown.stops.length && from !== to
      && !shown.stops.slice(Math.min(from, to), Math.max(from, to) + 1).some(s => s.locked || s.completed);
  }
  function moveStop(id: string, to: number) {
    const from = shown.stops.findIndex(s => s.place.id === id);
    setDraggedStop(null); setDropTarget(null);
    if (!canMove(from, to)) return;
    const stops = [...shown.stops]; const [stop] = stops.splice(from, 1); stops.splice(to, 0, stop);
    try {
      const next = readChatProposal({stops: stops.map(s => ({id:s.place.id, dwell:s.dwellMinutes}))}, plan, [...candidates, ...shown.stops.map(s => s.place)]);
      setRouteStatus("loading");
      setProposal({base:identity, plan:next}); setView("changes"); setReorderError("");
      setMessages(current => [...current, {role:"assistant",text:`${stop.place.name}を${to + 1}番目に移動する案です。移動時間を再計算しました。確認して反映してください。`}, {role:"assistant",text:"",context:`未反映の変更案：${next.stops.map(s => `${s.place.name}（ID:${s.place.id}、${s.dwellMinutes}分）`).join(" → ")}`}]);
    } catch (cause) { setReorderError(cause instanceof Error ? cause.message : "並べ替えできませんでした。"); }
  }
  function transitBetween(index: number) {
    const from = index ? shown.stops[index - 1].place.name : shown.origin.name;
    const to = shown.stops[index]?.place.name ?? shown.returnTo.name;
    const minutes = shown.stops[index]?.travel ?? shown.returnTravel;
    const transit = timeline.filter(t => t.type === "transit")[index];
    return <PreviewTransit from={from} to={to} minutes={minutes} unknown={shown.unknownTravelSegments?.includes(index)} loading={reviewing && routeStatus === "loading"} transit={transit} places={[shown.origin, ...shown.stops.map(s => s.place), shown.returnTo]} />;
  }
  const money = (p: TripPlan) => p.totalCost === null ? "未確認" : `${p.totalCost.toLocaleString("ja-JP")}円`;
  function applyProposal() {
    if (!pending || proposal?.base !== latest.current || working || disabled || routeStatus === "loading" || pending.violations.length) return;
    onApply(pending); setProposal(null); setView("current");
    setMessages(current => [...current, {role:"assistant", text:"変更案を旅程に反映しました。「旅程」「マップ」で確認できます。"}]);
  }
  const content = <section className="journey-chat" data-mobile-panel={mobilePanel} aria-labelledby="journey-chat-title">
    {mobile && <header className="journey-mobile-header"><button type="button" autoFocus onClick={() => mobilePanel === "chat" ? setMobileOpen(false) : setMobilePanel("chat")}>{mobilePanel === "chat" ? "← 編集画面" : "← 会話に戻る"}</button><strong>旅の相談</strong><span>{working ? "考え中…" : pending ? "変更案あり" : "ConcierGO"}</span></header>}
    <header className="journey-workspace-header">
      <div><span className="journey-workspace-icon" aria-hidden="true">✦</span><div><h3 id="journey-chat-title">相談しながら、旅を整える</h3><p>希望を伝える → 変更案を確認 → 旅程に反映</p></div></div>
      <span className={`journey-state ${working ? "is-working" : pending ? "is-pending" : ""}`}>{working ? "相談中" : pending ? "変更案があります" : "現在の旅程を編集中"}</span>
      <button type="button" className="journey-preview-toggle" aria-expanded={chatVisible} aria-controls="journey-chat-panel" onClick={() => setChatVisible(v => !v)}>{chatVisible ? "チャットを隠す" : "チャットを表示"}</button>
      <button type="button" className="journey-preview-toggle" aria-expanded={mapVisible} aria-controls="journey-map-panel" onClick={() => setMapVisible(v => !v)}>{mapVisible ? "マップを隠す" : "マップを表示"}</button>
    </header>
    <div className="journey-mobile-nav" role="group" aria-label="旅程エディターの表示">
      <button type="button" aria-pressed={mobilePanel === "chat"} aria-controls="journey-chat-panel" onClick={() => { setChatVisible(true); setMobilePanel("chat"); }}>チャット</button>
      <button type="button" aria-pressed={mobilePanel === "preview"} aria-controls="journey-preview-panel" onClick={() => setMobilePanel("preview")}>旅程{pending ? " ●" : ""}</button>
      <button type="button" aria-pressed={mobilePanel === "map"} aria-controls="journey-map-panel" onClick={() => { setMapVisible(true); setMobilePanel("map"); }}>マップ</button>
    </div>
    <div ref={panels} style={{ "--editor-width": `${editorRatio}%` } as CSSProperties} className={`journey-workspace-body ${mapVisible ? "has-map" : ""} ${chatVisible ? "" : "chat-hidden"}`}><div ref={workspace} className={`journey-editor-panes ${chatVisible ? "" : "is-chat-hidden"}`} style={{ "--chat-width": `${chatWidth}%` } as CSSProperties}>
      <div id="journey-chat-panel" className="journey-conversation" hidden={!chatVisible}>
        <div className="journey-pane-label"><span>チャット</span><span>ConcierGO</span></div>
        <div className="journey-chat-log" ref={log} role="log" aria-label="旅程の相談履歴" aria-live="polite">
          {!messages.length && <div className="journey-chat-welcome"><span aria-hidden="true">✦</span><h4>どんな一日にしましょう？</h4><p>追加したい場所や、変えたい予定を<br />いつもの言葉で伝えてください。</p>
            <div className="journey-chat-examples">{["近くのカフェを追加したい", "立ち寄り先を減らして、ゆっくり過ごしたい", "最後の場所で30分長く過ごしたい"].map((text, i) => <button type="button" key={text} disabled={working || disabled} onClick={() => { setInput(text); composer.current?.focus(); }}><span aria-hidden="true">{["＋", "↘", "◷"][i]}</span>{text}<span aria-hidden="true">↗</span></button>)}</div>
          </div>}
          {messages.filter(m => !m.context).map((m, i) => <div key={i} className={`journey-chat-message ${m.role}`}><strong>{m.role === "user" ? "あなた" : "✦ ConcierGO"}</strong><p>{m.text}</p></div>)}
          {pending && <article className="journey-change-card" aria-label="会話内の変更案">
            <span>未反映の変更案</span><h4>この旅程に変更しますか？</h4>
            <ul>{tripChanges(plan, pending).map((change, i) => <li key={i}>{change}</li>)}</ul>
            <dl><div><dt>帰着</dt><dd>{tripClock(plan.returnMinute)} → {tripClock(pending.returnMinute)}</dd></div><div><dt>概算費用</dt><dd>{money(plan)} → {money(pending)}</dd></div></dl>
            <p>{routeStatus === "loading" ? "移動時間を確認しています…" : routeStatus === "failed" ? "経路取得に失敗したため、徒歩概算です。" : "移動・費用は概算です。営業状況は未確認です。"}</p>
            {pending.violations.length > 0 && <p role="alert">{pending.violations.join(" ")}</p>}
            <button type="button" className="trip-primary" disabled={working || disabled || routeStatus === "loading" || pending.violations.length > 0} onClick={applyProposal}>この案を旅程に反映</button>
            <div><button type="button" onClick={() => {setView("changes");setMobilePanel("preview");}}>旅程を見る</button><button type="button" onClick={() => {setView("changes");setMapVisible(true);setMobilePanel("map");}}>マップで確認</button></div>
            <button type="button" disabled={working} onClick={() => {setProposal(null);setView("current");setMessages(current => [...current,{role:"assistant",text:"変更案を見送りました。現在の旅程はそのままです。"}]);}}>この案を見送る</button>
          </article>}
          {working && <div className="journey-working" role="status"><span className="journey-pulse" aria-hidden="true" /><div><strong>変更案を考えています</strong><p>必要な候補を調べ、移動時間と変更内容を確認します。</p></div></div>}
        </div>
        {steps.length > 0 && <details className="journey-checks"><summary>調べたこと・確認したこと <span>{steps.length}件</span></summary><ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol></details>}
        {error && <p role="alert" className="trip-error">{error}</p>}
        {disabled && <p className="journey-disabled-note">編集中の条件や変更案を確定すると、相談を続けられます。</p>}
        <form className="journey-composer" onSubmit={submit}>
          <label htmlFor="journey-chat-input">旅程への希望</label>
          {pending && <p className="journey-disabled-note">追加の指示は、この変更案に反映します。</p>}
          <textarea ref={composer} id="journey-chat-input" value={input} maxLength={1200} rows={3} disabled={working || disabled} onChange={e => setInput(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder="例：昼食のあとに、近くのカフェを追加して" />
          <div className="journey-composer-footer"><span>Ctrl / ⌘ + Enter で送信</span>{working ? <button type="button" onClick={cancel}>中止</button> : <button type="submit" className="trip-primary" disabled={disabled || !input.trim()}>相談する <span aria-hidden="true">↑</span></button>}</div>
        </form>
        <p className="journey-privacy">現在の旅程と候補をAIに送信します。反映するまで旅程は変わりません。</p>
      </div>
      <div className="journey-resizer" role="separator" aria-label="チャットとプレビューの幅" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(chatWidth)} aria-valuetext={`チャット ${Math.round(chatWidth)}%、プレビュー ${100 - Math.round(chatWidth)}%`} tabIndex={chatVisible ? 0 : -1} hidden={!chatVisible}
        onPointerDown={e => { if (e.button !== 0) return; const width = workspace.current?.getBoundingClientRect().width; if (!width) return; drag.current = { x: e.clientX, width, ratio: chatWidth }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
        onPointerMove={e => { if (drag.current) resize(drag.current.ratio + (e.clientX - drag.current.x) / drag.current.width * 100); }}
        onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => resize(45)} onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); resize(e.key === "Home" ? 30 : e.key === "End" ? 70 : chatWidth + (e.key === "ArrowLeft" ? -2 : 2)); } }} title="ドラッグまたは左右キーで幅を調整。ダブルクリックで元に戻す"><span aria-hidden="true">⋮</span></div>
      <div id="journey-preview-panel" className={`journey-artifact ${reviewing ? "is-reviewing" : ""}`}>
        <div className="journey-pane-label"><span>旅程プレビュー</span><div className="journey-view-switch" role="group" aria-label="表示する旅程"><button type="button" aria-pressed={!reviewing} onClick={() => setView("current")}>現在の旅程</button><button type="button" disabled={!pending} aria-pressed={reviewing} onClick={() => setView("changes")}>変更案{pending ? " ●" : ""}</button></div></div>

        <div className="journey-artifact-scroll">
          <div className="journey-artifact-heading"><span>{shown.date.replaceAll("-", "/")} · {shown.stops.length}か所</span><h4>{reviewing ? "旅程の変更案" : "いまの旅程"}</h4><p>{shown.origin.name} → {shown.returnTo.name}</p></div>
          <div className="journey-artifact-stats"><div><span>出発〜帰着の目安</span><strong>{reviewing && <del>{journeyTimeRange(plan)}</del>}{journeyTimeRange(shown)}</strong></div><div><span>1人あたりの概算</span><strong>{reviewing && money(plan) !== money(shown) && <del>{money(plan)}</del>}{money(shown)}</strong></div></div>
          {reviewing && <div className="journey-diff-summary"><strong>今回の変更</strong><ul>{shown.stops.some((s, i) => plan.stops.some(o => o.place.id === s.place.id) && plan.stops[i]?.place.id !== s.place.id) && <li>訪問順を変更：{shown.stops.map(s => s.place.name).join(" → ")}</li>}{tripChanges(plan, pending!).map((change, i) => <li key={i}>{change}</li>)}</ul></div>}
          {reviewing && routeStatus === "loading" && <p role="status" className="journey-sort-hint">全区間の経路・移動時間を取得しています…</p>}
          {reviewing && routeStatus === "failed" && <p role="status">交通経路を取得できませんでした。徒歩概算を表示しています。<button type="button" onClick={() => setRouteRetry(v => v + 1)}>経路を再取得</button></p>}
          {reviewing && shown.violations.length > 0 && <p role="alert">{shown.violations.join(" ")}</p>}
          <p className="journey-sort-hint">⋮⋮ をドラッグして順番を変更できます。固定・訪問済みの位置は保持します。</p>
          {reorderError && <p role="alert" className="trip-error">{reorderError}</p>}
          <ol className="journey-artifact-stops">{shown.stops.map((s, i) => {
            const oldIndex = plan.stops.findIndex(o => o.place.id === s.place.id);
            const old = plan.stops[oldIndex];
            const added = reviewing && !old;
            const changed = reviewing && old && (old.dwellMinutes !== s.dwellMinutes || oldIndex !== i);
            return <Fragment key={s.place.id}>{transitBetween(i)}<li data-stop-id={s.place.id} className={`${added ? "is-added" : changed ? "is-changed" : ""} ${dropTarget === s.place.id ? "is-drop-target" : ""} ${draggedStop === s.place.id ? "is-dragging" : ""}`}
              onDragOver={e => { if (draggedStop && canMove(shown.stops.findIndex(o => o.place.id === draggedStop), i)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(s.place.id); } }}
              onDrop={e => { e.preventDefault(); if (draggedStop) moveStop(draggedStop, i); }}><button type="button" className="journey-drag-handle" aria-label={`${s.place.name}の並べ替え`} title="ドラッグして移動（上下キーでも移動）" disabled={working || disabled || s.locked || s.completed} draggable={!working && !disabled && !s.locked && !s.completed}
                onDragStart={e => { setDraggedStop(s.place.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.place.id); }} onDragEnd={() => { setDraggedStop(null); setDropTarget(null); }}
                onKeyDown={e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); moveStop(s.place.id, i + (e.key === "ArrowUp" ? -1 : 1)); } }}>⋮⋮</button><span className="journey-stop-index">{added ? "+" : i + 1}</span><div><div className="journey-stop-top"><time>{tripClock(s.start)} — {tripClock(s.end)}</time><span className="journey-stop-badge">{added ? "追加" : changed ? "変更" : s.completed ? "訪問済み" : s.locked ? "固定" : ""}</span></div><strong className="journey-preview-name">{s.place.name}</strong><FacilityPhoto place={s.place} compact /><p>{changed && old.dwellMinutes !== s.dwellMinutes && <><del>{old.dwellMinutes}分</del> → </>}{s.dwellMinutes}分の滞在{changed && oldIndex !== i && ` · ${oldIndex + 1}番目から移動`}</p><button type="button" className="journey-replace-button" aria-label={`プレビューで${s.place.name}を入れ替える`} disabled={working || disabled || s.locked || s.completed} onClick={() => setReplacing(replacing === s.place.id ? null : s.place.id)}>施設を入れ替える</button>
              {replacing === s.place.id && <div className="journey-replace-picker"><label>入れ替え先<select aria-label={`${s.place.name}の入れ替え先`} value="" onChange={e => replacePlace(s.place.id, e.target.value)}><option value="" disabled>近くの候補から選択</option>{replacements.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{!replacements.length && <p>手元の候補がありません。チャットで希望を伝えてください。</p>}<button type="button" onClick={() => { setInput(`「${s.place.name}」を別の施設に入れ替えたい。ほかの予定は残して、候補を提案して。`); setReplacing(null); setChatVisible(true); window.requestAnimationFrame(() => composer.current?.focus()); }}>AIに入れ替えを相談する</button></div>}
              <div className="journey-move-actions"><button type="button" aria-label={`${s.place.name}を前へ移動`} disabled={!canMove(i,i-1)} onClick={() => moveStop(s.place.id,i-1)}>↑ 前へ</button><button type="button" aria-label={`${s.place.name}を後へ移動`} disabled={!canMove(i,i+1)} onClick={() => moveStop(s.place.id,i+1)}>↓ 後へ</button></div></div></li></Fragment>;
          })}{transitBetween(shown.stops.length)}</ol>
          {reviewing && removed.length > 0 && <div className="journey-removed"><strong>外す予定</strong>{removed.map(s => <p key={s.place.id}>− <del>{s.place.name}</del></p>)}</div>}
          <p className="journey-artifact-note">{reviewing ? "移動・費用は概算です。営業時間・営業状況は未確認です。" : "固定した予定と訪問済みの記録は、相談しても保持されます。"}</p>
          {reviewing && shown.stops.some(s => s.place.tags?.source === "OpenPOI API") && <p className="journey-source">追加候補の出典：<a href="https://openpoiapi.com/attribution.html" target="_blank" rel="noreferrer">OpenPOI API</a></p>}
          {reviewing && shown.stops.some(s => s.place.id.startsWith("osm-cafe-")) && <p className="journey-source">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>（ODbL）</p>}
        </div>
        <div className="journey-review-footer">{pending ? <><p>確認してから反映。反映後も「ひとつ前に戻す」で取り消せます。</p><div className="journey-chat-actions"><button type="button" disabled={working} onClick={() => { setProposal(null); setView("current"); setMessages(current => [...current, { role: "assistant", text: "変更案を見送り、現在の旅程を残しました。" }]); }}>現在の旅程を残す</button><button type="button" className="trip-primary" disabled={working || disabled || !reviewing || routeStatus === "loading" || pending.violations.length > 0} onClick={() => {
          if (proposal?.base !== latest.current) return;
          onApply(pending); setProposal(null); setView("current");
          setMessages(current => [...current, { role: "assistant", text: "変更案を旅程に反映しました。続けて相談できます。" }]);
        }}>この変更を反映 <span aria-hidden="true">✓</span></button></div></> : <p>{working ? "現在の旅程を残したまま、変更案を作成しています。" : "相談すると、ここで変更前後を比べられます。"}</p>}</div>
      </div>
    </div>
    <div className="journey-resizer journey-map-resizer" role="separator" aria-label="旅程プレビューとマップの幅" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={75} aria-valuenow={Math.round(editorRatio)} aria-valuetext={`旅程側 ${Math.round(editorRatio)}%、マップ ${100 - Math.round(editorRatio)}%`} tabIndex={mapVisible ? 0 : -1} hidden={!mapVisible}
      onPointerDown={e => { if (e.button !== 0) return; const width = panels.current?.getBoundingClientRect().width; if (!width) return; mapDrag.current = { x: e.clientX, width, ratio: editorRatio }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
      onPointerMove={e => { if (mapDrag.current) resizeMap(mapDrag.current.ratio + (e.clientX - mapDrag.current.x) / mapDrag.current.width * 100); }}
      onPointerUp={e => { mapDrag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { mapDrag.current = null; }} onLostPointerCapture={() => { mapDrag.current = null; }}
      onDoubleClick={() => setEditorWidth(null)} onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); resizeMap(e.key === "Home" ? 30 : e.key === "End" ? 75 : editorRatio + (e.key === "ArrowLeft" ? -2 : 2)); } }} title="ドラッグまたは左右キーで幅を調整。ダブルクリックで元に戻す"><span aria-hidden="true">⋮</span></div>
    <section id="journey-map-panel" className="journey-map-panel" aria-label="旅程マップ" hidden={!mapVisible}>
      <div className="journey-pane-label"><span>マップ · {reviewing ? "変更案" : "現在の旅程"}</span><button type="button" onClick={() => setMapVisible(false)}>マップを閉じる</button></div>
      {mapVisible && <div className="journey-large-map" id="journey-map"><LazyMapView initialMode="routes" routeLoading={routeStatus === "loading"} places={shown.stops.map(s => s.place)} origin={shown.origin} returnTo={shown.returnTo} journeyDate={shown.date} timeline={timeline} mapTokens={timeline.flatMap(t => t.type === "transit" && t.map_token ? [t.map_token] : [])} /></div>}
    </section>
    </div>
  </section>;
  const launcher = <button type="button" className="journey-mobile-launcher" onClick={() => {setChatVisible(true);setMobilePanel("chat");setMobileOpen(true);}}>✦ AIに相談{pending ? " · 変更案あり" : "して旅程を編集"}</button>;
  return <>{host ? createPortal(mobile ? launcher : content, host) : mobile ? launcher : content}{mobile && mobileOpen && createPortal(<dialog className="journey-mobile-dialog" ref={dialog} aria-label="旅程をチャットで編集" onCancel={() => setMobileOpen(false)}>{content}</dialog>, document.body)}</>;
}

