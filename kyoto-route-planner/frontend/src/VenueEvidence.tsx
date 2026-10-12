import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Place } from "./types";
import { isRecord } from "./apiValidation";
import "./venueEvidence.css";

type Source = { number: number; title: string; url: string };
type Citation = { end: number; sources: number[] };
type Evidence = { place_id: string; status: "ready" | "unconfigured" | "unverified"; message: string;
  text: string; sources: Source[]; citations: Citation[]; search_suggestions_html: string; checked_at: string | null };

function httpsLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && (!url.port || url.port === "443")
      && url.hostname.includes(".") && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)
      && !/\.(localhost|local|internal)$/.test(url.hostname);
  } catch { return false; }
}

function safeSuggestions(html: string) {
  if (!html.trim() || html.length > 100000 || /@import|url\s*\(|expression\s*\(/i.test(html)) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set(["HTML", "HEAD", "BODY", "STYLE", "DIV", "SPAN", "A", "SVG", "PATH", "G", "CIRCLE", "RECT", "DEFS", "LINEARGRADIENT", "STOP", "POLYGON", "POLYLINE", "TITLE", "BR", "P"]);
  return [...doc.querySelectorAll("*")].every(element => allowed.has(element.tagName.toUpperCase())
    && [...element.attributes].every(attribute => !/^on/i.test(attribute.name)
      && !["src", "srcdoc", "formaction"].includes(attribute.name)
      && !/javascript\s*:/i.test(attribute.value)
      && (!["href", "xlink:href"].includes(attribute.name) || attribute.value.startsWith("#") || httpsLink(attribute.value))));
}

export function readEvidence(value: unknown, placeId: string): Evidence {
  if (!isRecord(value) || value.place_id !== placeId || !["ready", "unconfigured", "unverified"].includes(String(value.status))
    || typeof value.message !== "string" || typeof value.text !== "string" || value.text.length > 3500
    || !Array.isArray(value.sources) || !Array.isArray(value.citations) || typeof value.search_suggestions_html !== "string"
    || (value.checked_at !== null && (typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at))))) throw new Error("要約の形式を確認できませんでした。");
  const sources: Source[] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || !Number.isInteger(source.number) || Number(source.number) < 1 || typeof source.title !== "string" || !httpsLink(source.url)) throw new Error("出典の形式を確認できませんでした。");
    sources.push(source as Source);
  }
  const citations: Citation[] = [];
  let previous = 0;
  for (const citation of value.citations) {
    if (!isRecord(citation) || !Number.isInteger(citation.end) || Number(citation.end) <= previous || Number(citation.end) > value.text.length
      || !Array.isArray(citation.sources) || !citation.sources.length || !citation.sources.every(number => sources.some(source => source.number === number))) throw new Error("要約と出典の対応を確認できませんでした。");
    previous = Number(citation.end);
    citations.push(citation as Citation);
  }
  if (value.status === "ready" && (!value.text.trim() || !sources.length || !citations.length || !value.checked_at || !safeSuggestions(value.search_suggestions_html))) throw new Error("出典付きの要約を確認できませんでした。");
  return { ...value, sources, citations } as Evidence;
}

function SearchSuggestions({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Provider-supplied, validated HTML only. Shadow DOM contains the widget's CSS;
    // it is not an iframe and does not change Google's branding, markup or links.
    const root = ref.current?.shadowRoot ?? ref.current?.attachShadow({ mode: "open" });
    if (root) root.innerHTML = html;
    return () => { if (root) root.innerHTML = ""; };
  }, [html]);
  return <div className="venue-search-suggestions" aria-label="Google検索の関連情報" ref={ref} />;
}

function CitedText({ evidence, start = 0, end = evidence.text.length }: { evidence: Evidence; start?: number; end?: number }) {
  const content: ReactNode[] = [];
  let offset = start;
  for (const citation of evidence.citations.filter(item => item.end > start && item.end <= end)) {
    content.push(evidence.text.slice(offset, citation.end));
    content.push(<sup key={citation.end}>{citation.sources.map(number => {
      const source = evidence.sources.find(item => item.number === number)!;
      return <a key={number} href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`出典${number}：${source.title}`}>[{number}]</a>;
    })}</sup>);
    offset = citation.end;
  }
  content.push(evidence.text.slice(offset, end));
  return <p className="venue-evidence-text">{content}</p>;
}

export function VenueEvidence({ place }: { place: Place }) {
  const [result, setResult] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLDivElement>(null);
  const identity = `${place.id}:${place.name}:${place.latitude}:${place.longitude}:${place.address ?? ""}`;
  const bodyStart = result?.text.includes("\n\n") ? result.text.indexOf("\n\n") + 2 : 0;
  useEffect(() => {
    controller.current?.abort(); controller.current = null;
    setResult(null); setError(""); setBusy(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [identity]);

  async function investigate() {
    if (controller.current || result?.status === "ready") return;
    const current = new AbortController();
    controller.current = current; setBusy(true); setError(""); setResult(null);
    const timeout = window.setTimeout(() => current.abort(), 55000);
    try {
      const response = await fetch("/api/recommendations/evidence", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ place: { id: place.id, name: place.name, category: place.category, latitude: place.latitude, longitude: place.longitude,
          address: place.address ?? "", description: "", access_point: "", themes: [] } }) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(data) && typeof data.detail === "string" ? data.detail : "口コミ・公開情報を取得できませんでした。");
      const evidence = readEvidence(data, place.id);
      if (controller.current === current && !current.signal.aborted) {
        setResult(evidence);
        if (evidence.status === "ready") window.requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
      }
    } catch (cause) {
      if (controller.current === current) setError(current.signal.aborted ? "検索がタイムアウトしました。時間をおいて再度お試しください。" : cause instanceof Error ? cause.message : "口コミ・公開情報を取得できませんでした。");
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === current) { controller.current = null; setBusy(false); }
    }
  }

  return <section className="venue-evidence" aria-label={`${place.name}の口コミと公開情報`} aria-busy={busy}>
    <div className="venue-evidence-heading" ref={heading} tabIndex={-1}><strong>この場所の見どころ</strong></div>
    {result?.status === "ready" ? <>
      <p className="venue-evidence-label" role="status">口コミなどのAI要約</p>
      {bodyStart > 0 && <details className="venue-evidence-match"><summary>施設名・所在地の確認</summary><CitedText evidence={result} end={bodyStart} /></details>}
      <CitedText evidence={result} start={bodyStart} />
      <details className="venue-evidence-source-details"><summary>参考ページ（{result.sources.length}件）</summary><ul className="venue-evidence-sources">{result.sources.map(source => <li key={source.number}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.number}] {source.title} <span aria-hidden="true">↗</span></a></li>)}</ul></details>
      <SearchSuggestions html={result.search_suggestions_html} />
      <p className="venue-evidence-footnote">取得 {new Date(result.checked_at!).toLocaleDateString("ja-JP")} · 一部の公開情報の要約です。訪問前に掲載元をご確認ください。</p>
    </> : <>
      <p className="venue-evidence-intro">口コミや公式情報から、魅力と注意点を短くまとめます。</p>
      <button type="button" className="venue-evidence-button" onClick={investigate} disabled={busy} aria-label={`${place.name}の口コミ・公開情報を調べる`}>{busy ? "口コミ・公開情報を調べています…" : error || result ? "もう一度調べる" : "口コミ・公開情報を調べる"}<span aria-hidden="true">{busy ? "◌" : "↗"}</span></button>
      <p className="venue-evidence-footnote">押した施設だけ外部検索します · 検索・生成のAPI利用料金がかかる場合があります</p>
      {busy && <p className="venue-evidence-status" role="status">施設・支店を照合し、公開情報を探しています。</p>}
      {result && <p className="venue-evidence-status" role="status">{result.message}</p>}
    </>}
    {error && <p className="venue-evidence-status is-error" role="alert">{error}</p>}
  </section>;
}
