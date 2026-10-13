import { useState } from "react";
import { isDiscoverResponse } from "./dynamicRoutes";
import type { DatasetRoute } from "./datasetTypes";
import { isRecord } from "../apiValidation";

export type JourneyReviewData = {
  id: string; status: "passed" | "proposal" | "unresolved"; recorded: boolean;
  issues: string[]; actions: string[]; unresolved: string[]; limitations: string;
  proposals: { original_id: string | null; original_title: string; original_stops: string[]; original_minutes: number; reasons: string[]; route: DatasetRoute }[];
};
const texts = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 30 && x.every(t => typeof t === "string" && t.length <= 2000);
export function isJourneyReview(x: unknown): x is JourneyReviewData {
  return isRecord(x) && typeof x.id === "string" && /^[a-f0-9]{32}$/.test(x.id)
    && ["passed", "proposal", "unresolved"].includes(String(x.status)) && typeof x.recorded === "boolean"
    && texts(x.issues) && texts(x.actions) && texts(x.unresolved) && typeof x.limitations === "string" && x.limitations.length <= 2000
    && Array.isArray(x.proposals) && x.proposals.length <= 3 && x.proposals.every(p => isRecord(p)
      && (p.original_id === null || typeof p.original_id === "string") && typeof p.original_title === "string"
      && texts(p.original_stops) && texts(p.reasons) && typeof p.original_minutes === "number" && Number.isFinite(p.original_minutes)
      && isDiscoverResponse({routes:[p.route],note:""}));
}

export function JourneyReview({ report, onAdopt, onRestore }: { report: JourneyReviewData; onAdopt: (route: DatasetRoute) => void; onRestore: () => void }) {
  const [adopted, setAdopted] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function record(decision: string) {
    if (!report.recorded) { setMessage("操作は反映しました。判断履歴は保存できませんでした。"); return; }
    try {
      const response = await fetch(`/api/discover/reviews/${report.id}/decision?decision=${decision}`, {method:"POST"});
      if (!response.ok) throw new Error();
      setMessage("選択を判断履歴に記録しました。");
    } catch { setMessage("操作は反映しました。判断履歴は保存できませんでした。"); }
  }
  return <section className="journey-review" aria-label="旅程の点検と変更案">
    <h3>{report.status === "passed" ? "旅程を点検しました" : report.status === "proposal" ? "条件に合う変更案があります" : "確認できなかった条件があります"}</h3>
    <p>{report.status === "passed" ? "観光範囲・構成・概算時間の条件を満たしています。" : "元の旅程を残しています。変更内容を確認して選んでください。"}</p>
    <details><summary>点検した内容と判断理由</summary>
      {report.issues.map(text => <p key={text}>{text}</p>)}
      {report.actions.map(text => <p key={text}>{text}</p>)}
      <p>追加検索は最大1回・8秒まで。履歴は最大2,000件。次回点検時に30日を超えた履歴を削除します。</p>
      {!report.recorded && <p>今回の点検履歴を保存できませんでした。</p>}
    </details>
    {report.proposals.map(p => <article key={p.route.id}>
      <p><strong>元の旅程</strong> · 約{p.original_minutes}分</p><p>{p.original_stops.join(" → ") || p.original_title}</p>
      <p><strong>変更案</strong> · 約{p.route.estimated_minutes}分</p><p>{p.route.spots.map(s => s.name).join(" → ")}</p>
      <p>追加：{p.route.spots.filter(s => !p.original_stops.includes(s.name)).map(s => s.name).join("・") || "なし"}<br />削除：{p.original_stops.filter(name => !p.route.spots.some(s => s.name === name)).join("・") || "なし（順番を調整）"}</p>
      <p>{p.reasons.join(" ")} 条件を満たす組み合わせに見直しました。</p>
      <button type="button" disabled={adopted === p.route.id} onClick={() => { onAdopt(p.route); setAdopted(p.route.id); void record(`adopt:${p.route.id}`); }}>{adopted === p.route.id ? "この変更案を表示中" : "変更案を採用して見る"}</button>
    </article>)}
    {report.proposals.length > 0 && <button type="button" onClick={() => { onRestore(); setAdopted(null); void record("keep"); }}>元の旅程を使う</button>}
    {report.unresolved.length > 0 && <p role="status">未解決：{report.unresolved.join(" ")} 条件を変更するか、元の候補を確認してください。</p>}
    <p className="result-note">{report.limitations}</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
