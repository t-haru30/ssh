import { useEffect, useRef, useState } from "react";
import type { Place } from "./types";
import { isRecord } from "./apiValidation";
import { CitedText, readEvidence, SearchSuggestions } from "./VenueEvidence";
import "./journeyReview.css";
import { readOfficialNotices, type OfficialNotice } from "./officialNotices";

type Official = { url: string; status: "verified" | "link_only"; opening_hours: string | null; closed_days: string | null; admission: string | null; field_sources: Record<string, string>; notices: OfficialNotice[] };
type Step = { label: string; status: "ready" | "needs_check" | "unavailable" | "skipped" };
type Result = { place: Place; official: Official | null; evidence: ReturnType<typeof readEvidence> | null; steps: Step[]; missing: string[]; evidenceInvalid: boolean };
type Review = { checkedAt: string; results: Result[]; remaining: number; note: string };
const fields = { opening_hours: "開館・営業時間", closed_days: "休館・定休日", admission: "入館・利用料金" } as const;
const stepLabels = { ready: "確認できました", needs_check: "追加の確認が必要", unavailable: "取得できませんでした", skipped: "今回は省略" };
function publicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && (!url.port || url.port === "443" || url.port === "80")
      && url.hostname.includes(".") && !/^\d[\d.]+$/.test(url.hostname) && !url.hostname.includes(":")
      && !/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}
function readReview(value: unknown, places: Place[], date: string): Review {
  if (!isRecord(value) || value.departure_date !== date || typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at))
    || !Array.isArray(value.results) || value.results.length > Math.min(3, places.length)
    || !Number.isInteger(value.remaining_count) || Number(value.remaining_count) !== places.length - value.results.length
    || typeof value.note !== "string") throw new Error("確認結果の形式を読み取れませんでした。もう一度お試しください。");
  const seen = new Set<string>();
  const results = value.results.map((item): Result => {
    if (!isRecord(item) || typeof item.place_id !== "string" || seen.has(item.place_id)) throw new Error("行き先と確認結果が一致しませんでした。");
    const place = places.slice(0, 3).find(place => place.id === item.place_id);
    if (!place || !Array.isArray(item.steps) || !Array.isArray(item.missing_fields)) throw new Error("行き先と確認結果が一致しませんでした。");
    seen.add(place.id);
    const steps = item.steps.map((step): Step => {
      if (!isRecord(step) || typeof step.label !== "string" || !Object.hasOwn(stepLabels, String(step.status))) throw new Error("確認手順の形式を読み取れませんでした。");
      return { label: step.label, status: step.status as Step["status"] };
    });
    let official: Official | null = null;
    if (isRecord(item.official)) {
      const url = publicUrl(item.official.url);
      if (url && ["verified", "link_only"].includes(String(item.official.status))) {
        const source = item.official;
        const text = (key: string) => source.status === "verified" && typeof source[key] === "string" && source[key].trim() ? source[key].trim() : null;
        const field_sources: Record<string, string> = {};
        if (isRecord(source.field_sources)) for (const key of Object.keys(fields)) {
          const link = publicUrl(source.field_sources[key]);
          if (text(key) && link) field_sources[key] = link;
        }
        official = { url, status: source.status as Official["status"], opening_hours: text("opening_hours"), closed_days: text("closed_days"), admission: text("admission"), field_sources, notices: readOfficialNotices(source.notices, publicUrl) };
      }
    }
    let evidence = null, evidenceInvalid = false;
    if (item.evidence != null) { try { evidence = readEvidence(item.evidence, place.id); } catch { evidenceInvalid = true; } }
    const missingFields = item.missing_fields;
    const missing = Object.keys(fields).filter(key => !official?.[key as keyof typeof fields] || missingFields.includes(key));
    return { place, official, evidence, steps, missing, evidenceInvalid };
  });
  return { checkedAt: value.checked_at, results, remaining: Number(value.remaining_count), note: value.note };
}

/** Remounting on itinerary identity discards evidence and cancels obsolete requests. */
export function JourneyReview({ places, departureDate }: { places: Place[]; departureDate: string }) {
  const identity = JSON.stringify([departureDate, places]);
  return <JourneyReviewSession key={identity} places={places} departureDate={departureDate} />;
}
function JourneyReviewSession({ places, departureDate }: { places: Place[]; departureDate: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); request.current = null; window.clearTimeout(timeout.current); }, []);
  function cancel() {
    request.current?.abort(); request.current = null; window.clearTimeout(timeout.current);
    setBusy(false); setMessage("確認を中止しました。必要なときにもう一度調べられます。");
  }
  async function investigate() {
    if (request.current || review || !places.length || places.length > 8) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage("");
    timeout.current = window.setTimeout(() => {
      if (request.current !== controller) return;
      controller.abort(); request.current = null; setBusy(false);
      setMessage("確認に時間がかかっています。時間をおいてもう一度お試しいただくか、各行き先の公式案内をご確認ください。");
    }, 50_000);
    try {
      const response = await fetch("/api/journey/review", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ places, departure_date: departureDate }), signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 429
        ? "ただいま確認が混み合っています。少し待ってからもう一度お試しください。"
        : "出発前の情報を取得できませんでした。時間をおいてもう一度お試しください。");
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error("確認結果を読み取れませんでした。もう一度お試しください。"); }
      if (request.current !== controller || controller.signal.aborted) return;
      setReview(readReview(data, places, departureDate));
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : "出発前の情報を取得できませんでした。");
    } finally {
      if (request.current === controller) { window.clearTimeout(timeout.current); request.current = null; setBusy(false); }
    }
  }
  return <section className="journey-review" aria-label="出発前のまとめて確認" aria-busy={busy}>
    <div className="journey-review-heading"><span aria-hidden="true">✓</span><div><h4>出発前に、行き先の情報を確認</h4><p>{departureDate}の旅 · 先頭から最大3か所の営業時間・休館日・料金をまとめます。</p></div></div>
    {!review && <><p className="journey-review-intro">公式ページを確認し、足りない情報はAIが出典付きで探します。調べた結果と、まだ確認が必要な項目を一覧にします。</p><div className="journey-review-actions"><button type="button" className="trip-primary" onClick={investigate} disabled={busy || !places.length || places.length > 8}>{busy ? "行き先の情報を確認しています…" : "出発前の情報をまとめて調べる"}</button>{busy && <button type="button" onClick={cancel}>確認を中止</button>}</div></>}
    {busy && <p role="status">公式案内と行き先を照合しています。確認が終わると、実行した手順と出典を表示します。</p>}
    {message && <p role="status" className="journey-review-notice">{message}</p>}
    {review && <details open className="journey-review-fold"><summary>確認結果を開く・閉じる</summary><p className="journey-review-summary" role="status">{review.results.length}か所の確認結果 · {new Date(review.checkedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} JST取得</p>
      <p className="journey-review-notice">出発日は表示上の参考です。当日の営業は自動確認していません。訪問前に最新の公式案内をご確認ください。</p>
      <ol className="journey-review-results">{review.results.map(result => <li key={result.place.id}>
        <div className="journey-review-result-title"><h5>{result.place.name}</h5><span className={result.missing.length ? "needs-check" : "is-ready"}>{result.missing.length ? "確認したい項目あり" : "公式案内を取得"}</span></div>
        <dl>{Object.entries(fields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{result.official?.[key as keyof typeof fields] ?? "未確認"}{result.official?.field_sources[key] && <> <a className="journey-review-source" href={result.official.field_sources[key]} target="_blank" rel="noopener noreferrer" aria-label={`${result.place.name}の${label}の出典`}>出典 ↗</a></>}</dd></div>)}</dl>
        {result.official?.notices.map(notice => <aside className="journey-review-official-notice" aria-label={`${result.place.name}の臨時休館のお知らせ`} key={notice.url}>
          <h5>臨時休館のお知らせ</h5><p>{notice.starts_on}〜{notice.ends_on}</p><p>{notice.text}</p>
          <a href={notice.url} target="_blank" rel="noopener noreferrer">臨時休館の公式出典</a>
        </aside>)}
        {result.official && <a href={result.official.url} target="_blank" rel="noopener noreferrer">{result.place.name}の公式案内を開く ↗</a>}
        {!!result.missing.length && <p className="journey-review-notice">要確認：{result.missing.map(key => fields[key as keyof typeof fields]).join("・")}</p>}
        <details className="journey-review-steps"><summary>実行した確認手順（{result.steps.length}件）</summary><ol>{result.steps.map((step, i) => <li key={i}><span>{step.label}</span><strong>{stepLabels[step.status]}</strong></li>)}</ol></details>
        {result.evidence?.status === "ready" && <div className="journey-review-evidence"><p className="venue-evidence-label">公式情報のAI要約</p><CitedText evidence={result.evidence} /><ul className="venue-evidence-sources">{result.evidence.sources.map(source => <li key={source.number}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.number}] {source.title} ↗</a></li>)}</ul><SearchSuggestions html={result.evidence.search_suggestions_html} /></div>}
        {result.evidence && result.evidence.status !== "ready" && <p className="journey-review-notice">{result.evidence.message || "追加の公式情報は確認できませんでした。"}</p>}
        {result.evidenceInvalid && <p className="journey-review-notice">追加情報の出典を確認できませんでした。公式案内でご確認ください。</p>}
      </li>)}</ol>
      {review.remaining > 0 && <p className="journey-review-notice">残り{review.remaining}か所は今回の一括確認の対象外です。各行き先の詳細からご確認ください。</p>}
      {review.note && <details><summary>確認の範囲</summary><p className="journey-review-notice">{review.note}</p></details>}
    </details>}
  </section>;
}
