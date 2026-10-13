import { useEffect, useRef, useState } from "react";
import type { TravelerProfile } from "./travelerProfile";
import type { Theme } from "./types";

export function PreferenceTags({ theme, traveler, selected, onChange }: { theme: Theme; traveler: TravelerProfile; selected: string[]; onChange: (tags: string[]) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState("");
  const previousContext = useRef("");
  const [page, setPage] = useState<{ context: string; exclude: string[] } | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [retry, setRetry] = useState(0);
  const context = JSON.stringify({ theme, traveler: { companion: traveler.companion, pace: traveler.pace ?? "standard" } });
  useEffect(() => {
    const controller = new AbortController();
    if (previousContext.current !== context) { setTags([]); setPage(null); previousContext.current = context; }
    const excluded = page?.context === context ? page.exclude : [];
    setStatus("loading"); setFailure(""); setExhausted(false);
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    const debounce = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/preference-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: excluded.length ? JSON.stringify({ ...JSON.parse(context), exclude_tags: excluded }) : context, signal: controller.signal });
        const data = await response.json();
        const messages: Record<string, string> = {
          configuration: "AIの接続設定を確認できませんでした。",
          timeout: "AIの応答に時間がかかっています。少し待って再試行してください。",
          rate_limit: "AIの利用が集中しています。少し待って再試行してください。",
          connection: "AIへの接続ができませんでした。",
          provider: "AIサービスでエラーが発生しました。",
          invalid_response: "AIの応答からタグを読み取れませんでした。",
        };
        if (!disposed && (response.status === 429 || data?.reason)) setFailure(messages[response.status === 429 ? "rate_limit" : data.reason] ?? "");
        if (!response.ok || data.source !== "ai" || !Array.isArray(data.tags) || data.tags.length > 6 || !data.tags.every((tag: unknown) => typeof tag === "string" && tag.trim().length >= 2 && tag.length <= 20)) throw new Error();
        if (!controller.signal.aborted) { const fresh = (data.tags as string[]).filter(tag => !excluded.includes(tag)); setTags(current => [...new Set([...current, ...fresh])].slice(0, 60)); setExhausted(fresh.length === 0); setStatus("ready"); }
      } catch { if (!disposed) setStatus("error"); }
      finally { window.clearTimeout(timeout); }
    }, 700);
    let disposed = false;
    return () => { disposed = true; window.clearTimeout(debounce); window.clearTimeout(timeout); controller.abort(); };
  }, [context, retry, page]);
  return <fieldset className="discover-filter-group preference-ai-tags"><legend>✦ 好みから広がる、AIの提案タグ</legend>
    <p className="preference-tags-note">気になるものを選んで、おすすめに追加できます（4つまで）。</p>
    <div className="discover-theme-options">{[...new Set([...selected, ...tags])].map(tag => <button type="button" key={tag} aria-pressed={selected.includes(tag)} disabled={!selected.includes(tag) && selected.length >= 4} onClick={() => onChange(selected.includes(tag) ? selected.filter(item => item !== tag) : [...selected, tag])}>{selected.includes(tag) ? "✓ " : "＋ "}{tag}</button>)}</div>
    {status === "ready" && !exhausted && tags.length < 60 && <button type="button" className="preference-tags-more" onClick={() => setPage({ context, exclude: [...new Set([...selected, ...tags])] })}>＋ もっと提案を見る</button>}
    {status === "ready" && (exhausted || tags.length >= 60) && <p className="preference-tags-note" role="status">{exhausted ? "新しい提案タグは見つかりませんでした。好みを変えると別の提案を探せます。" : "60件のタグを表示しています。好みを変えると別の提案を探せます。"}</p>}
    {status === "loading" && <p className="preference-tags-note" role="status">選んだ好みからタグを考えています… このまま次へ進むこともできます。</p>}
    {status === "error" && <div className="preference-tags-note" role="status">{failure || "AIのタグを取得できませんでした。"}今の選択で進めます。<button type="button" onClick={() => setRetry(value => value + 1)}>もう一度提案する</button></div>}
  </fieldset>;
}
