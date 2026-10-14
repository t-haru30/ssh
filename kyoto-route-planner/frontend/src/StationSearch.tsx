import { useEffect, useId, useRef, useState } from "react";
import type { Origin } from "./types";
import { isOrigin, isRecord } from "./apiValidation";
import "./stationSearch.css";

type Candidate = Origin & { code?: string; prefecture?: string; lines?: string[] };
type Props = { label: string; value: Origin | null; options: Origin[]; onChange: (origin: Origin, prefecture?: string) => void; disabled?: boolean; prefecture?: { name: string; code: string }; optionLayout?: "select" | "buttons" };
const identity = (origin: Origin) => `${origin.name}|${origin.latitude}|${origin.longitude}`;

export function StationSearch({ label, value, options, onChange, disabled = false, prefecture, optionLayout = "select" }: Props) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  function cancel() {
    generation.current++;
    controller.current?.abort();
    setLoading(false); setQuery(""); setResults([]); setStatus(""); setExpanded(false);
  }
  useEffect(() => { cancel(); setShowMore(false); }, [prefecture?.code]);
  async function search() {
    if (!query.trim() || disabled || loading) return;
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setResults([]); setStatus("駅を検索しています…");
    const timer = window.setTimeout(() => request.abort(), 15000);
    try {
      const response = await fetch(`/api/stations/search?q=${encodeURIComponent(query.trim())}${prefecture ? `&prefecture_code=${encodeURIComponent(prefecture.code)}` : ""}`, { signal: request.signal });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = typeof payload === "object" && payload !== null && "detail" in payload && typeof payload.detail === "string" ? payload.detail : "駅を検索できませんでした。再度お試しください。";
        throw new Error(message);
      }
      if (!Array.isArray(payload) || !payload.every(item => isRecord(item) && typeof item.code === "string" && typeof item.prefecture === "string" && Array.isArray(item.lines) && item.lines.every((line: unknown) => typeof line === "string") && isOrigin(item))) throw new Error("駅検索の結果を確認できませんでした。");
      if (current !== generation.current) return;
      const filtered = prefecture ? payload.filter(item => item.prefecture === prefecture.name) : payload;
      setResults(filtered);
      setStatus(filtered.length ? `${filtered.length}件の候補があります。駅を選択してください（最大5件）。` : `${prefecture?.name ?? "指定条件"}に該当する駅がありません。駅名を変えて検索してください。`);
    } catch (error) {
      if (current === generation.current) setStatus(request.signal.aborted ? "駅検索がタイムアウトしました。再度お試しください。" : error instanceof Error ? error.message : "駅を検索できませんでした。");
    } finally {
      window.clearTimeout(timer);
      if (current === generation.current) setLoading(false);
    }
  }
  const registered = [...new Map([...options, ...(value ? [value] : [])].map(item => [identity(item), item])).values()];
  const mainOptions = registered.slice(0, 3);
  const moreOptions = registered.slice(3);
  function choose(candidate: Candidate) {
    const qualified = candidate.prefecture && !candidate.name.includes(candidate.prefecture) ? `${candidate.name}（${candidate.prefecture}）` : candidate.name;
    onChange({ name: qualified.length <= 80 ? qualified : candidate.name, latitude: candidate.latitude, longitude: candidate.longitude }, candidate.prefecture);
    cancel();
  }
  function stationButton(station: Origin) {
    return <button type="button" key={identity(station)} aria-pressed={Boolean(value && identity(station) === identity(value))} onClick={() => choose(station)}>{station.name}</button>;
  }
  return <fieldset className={`station-search${optionLayout === "buttons" ? " station-search--buttons" : ""}`} disabled={disabled}>
    <legend>{label}</legend>
    {optionLayout === "buttons" ? <>
      <div className="station-choice-grid" aria-label="主要駅の候補">{mainOptions.map(stationButton)}</div>
      {showMore && <div id={`${id}-more`} className="station-more-options">
        {moreOptions.length ? <div className="station-choice-grid" aria-label="ほかの駅の候補">{moreOptions.map(stationButton)}</div>
          : <p>追加候補が見つからない場合は、駅名で探せます。</p>}
      </div>}
      <p className="station-current-selection">{value ? <>選択中：<strong>{value.name}</strong></> : "駅を選んでください"}</p>
      <div className="station-choice-actions">
        <button type="button" aria-expanded={showMore} aria-controls={`${id}-more`} onClick={() => setShowMore(current => !current)}>{showMore ? "候補を閉じる" : "ほかの候補を見る"}</button>
        <button type="button" aria-expanded={expanded} aria-controls={`${id}-search`} onClick={() => expanded ? cancel() : setExpanded(true)}>駅名で探す</button>
      </div>
    </> : <>
    <div className="station-search-default">
      <select aria-label={label} value={value ? identity(value) : ""} onChange={event => { const station = registered.find(item => identity(item) === event.target.value); if (station) choose(station); }}>
        <option value="" disabled>駅を選択してください</option>
        {registered.map(item => <option key={identity(item)} value={identity(item)}>{item.name}</option>)}
      </select>
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-search`} onClick={() => expanded ? cancel() : setExpanded(true)}>駅名で探す</button>
    </div>
    </>}
    {expanded && <div id={`${id}-search`} className="station-search-panel">
    <label htmlFor={id}>駅名を入力</label>
    <div className="station-search-controls">
      <input id={id} value={query} maxLength={80} placeholder={prefecture ? `${prefecture.name}内の駅名` : "例: 京都、東京"} onChange={event => { generation.current++; controller.current?.abort(); setLoading(false); setQuery(event.target.value); setResults([]); setStatus(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void search(); } if (event.key === "Escape") cancel(); }} />
      <button type="button" onClick={() => void search()} disabled={loading || !query.trim()}>駅を検索</button>
      <button type="button" onClick={cancel}>キャンセル</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    {results.length > 0 && <ul className="station-search-results" aria-label="駅検索の候補">{results.map(item => <li key={item.code}><button type="button" onClick={() => choose(item)}><strong>{item.name}</strong>{" "}<small>{[item.prefecture, ...(item.lines ?? [])].filter(Boolean).join(" · ")}</small></button></li>)}</ul>}
    </div>}
  </fieldset>;
}
