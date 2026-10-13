import { useEffect, useState } from "react";
import type { Place } from "../types";
import { isRecord } from "../apiValidation";
import { CitedText, readEvidence, SearchSuggestions } from "../VenueEvidence";

type SearchState = { identity: string; busy: boolean; evidence: ReturnType<typeof readEvidence> | null; error: string };

/** Only mounted inside a destination that the person has opened. Results stay in memory. */
export function OfficialPlaceSearch({ place }: { place: Place }) {
  const identity = JSON.stringify([place.id, place.name, place.latitude, place.longitude, place.address ?? ""]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SearchState>({ identity, busy: true, evidence: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: number | undefined;
    setState({ identity, busy: true, evidence: null, error: "" });
    async function search() {
      timer = window.setTimeout(() => {
        controller.abort();
        if (active) setState({ identity, busy: false, evidence: null, error: "公式案内の検索がタイムアウトしました。施設名の検索リンクからご確認いただくか、時間をおいて再検索してください。" });
      }, 55_000);
      try {
        const response = await fetch("/api/places/official-evidence", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(place), signal: controller.signal,
        });
        const data: unknown = await response.json();
        if (!response.ok) throw new Error(isRecord(data) && typeof data.detail === "string" ? data.detail : "公式案内を検索できませんでした。施設名の検索リンクからご確認ください。");
        const evidence = readEvidence(data, place.id);
        if (active && !controller.signal.aborted) setState({ identity, busy: false, evidence, error: "" });
      } catch (cause) {
        if (active && !controller.signal.aborted) setState({ identity, busy: false, evidence: null,
          error: cause instanceof Error ? cause.message : "公式案内を検索できませんでした。施設名の検索リンクからご確認ください。" });
      } finally { window.clearTimeout(timer); }
    }
    // StrictMode's setup/cleanup probe must not start a second paid search.
    void Promise.resolve().then(() => { if (active) void search(); });
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
    // A changed facility starts a new request; ordinary renders do not repeat it.
  }, [identity, attempt]);

  const current = state.identity === identity ? state : { identity, busy: true, evidence: null, error: "" };
  const evidence = current.evidence;
  const bodyStart = evidence?.text.includes("\n\n") ? evidence.text.indexOf("\n\n") + 2 : 0;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`${place.name} ${place.address ?? ""} 公式 開館時間 休館日 料金`)}`;
  return <section className="venue-evidence" aria-label={`${place.name}の公式案内を検索`} aria-busy={current.busy}>
    <div className="venue-evidence-heading"><strong>AIで公式案内を確認</strong></div>
    {current.busy ? <p className="venue-evidence-status" role="status">Google検索で公式サイト・開館時間を確認しています…</p>
      : evidence?.status === "ready" ? <>
        <p className="venue-evidence-label" role="status">公式情報のAI要約</p>
        {bodyStart > 0 && <details className="venue-evidence-match"><summary>施設名・所在地の確認</summary><CitedText evidence={evidence} end={bodyStart} /></details>}
        <CitedText evidence={evidence} start={bodyStart} />
        <ul className="venue-evidence-sources">{evidence.sources.map(source => <li key={source.number}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.number}] {source.title} <span aria-hidden="true">↗</span></a></li>)}</ul>
        <SearchSuggestions html={evidence.search_suggestions_html} />
        <p className="venue-evidence-footnote">取得 {new Date(evidence.checked_at!).toLocaleDateString("ja-JP")} · 公開情報のAI要約です。臨時休館や料金の変更は、訪問前に出典の公式案内をご確認ください。</p>
      </> : evidence && <p className="venue-evidence-status" role="status">{evidence.message || (evidence.status === "unconfigured" ? "公式案内の検索は現在利用できません。施設名の検索リンクからご確認ください。" : "この施設の公式情報を十分に確認できませんでした。施設名の検索リンクからご確認ください。")}</p>}
    {current.error && <p className="venue-evidence-status is-error" role="alert">{current.error}</p>}
    <a href={searchUrl} target="_blank" rel="noopener noreferrer">施設名で公式案内を探す <span aria-hidden="true">↗</span></a>
    {!current.busy && <button type="button" className="venue-evidence-button" onClick={() => setAttempt(value => value + 1)}>公式案内をもう一度検索する <span aria-hidden="true">↻</span></button>}
  </section>;
}
