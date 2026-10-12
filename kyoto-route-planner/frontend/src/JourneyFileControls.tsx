import { useEffect, useRef, useState } from "react";
import { TripDialog } from "./DayTripEditor";
import { completedStopCount, tripClock } from "./dayTrip";
import type { TripPlan } from "./dayTrip";
import type { JourneyDraft } from "./journeyDraft";
import { MAX_JOURNEY_FILE_BYTES, parseJourneyFile, serializeJourneyFile } from "./journeyFile";

export function JourneyFileControls({ plan, title, busy = false, onImport }: {
  plan: TripPlan | null; title: string; busy?: boolean; onImport: (draft: JourneyDraft) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<JourneyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  const disabled = busy || reading;
  async function readFile(file: File) {
    const token = ++request.current;
    setReading(true); setError(null); setPreview(null);
    try {
      if (file.size > MAX_JOURNEY_FILE_BYTES) throw new Error("保存ファイルは200KB以内にしてください。");
      const text = await file.text();
      if (!mounted.current || token !== request.current) return;
      setPreview(parseJourneyFile(text));
    } catch (cause) {
      if (mounted.current && token === request.current) setError(cause instanceof Error ? cause.message : "JSONファイルを読み取れませんでした。");
    } finally {
      if (mounted.current && token === request.current) setReading(false);
    }
  }
  function download() {
    if (!plan || disabled) return;
    setError(null);
    let url: string | null = null;
    try {
      const text = serializeJourneyFile(plan, title);
      url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `ConcierGO-${plan.date}.json`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSONファイルを書き出せませんでした。");
    } finally {
      if (url) { const downloaded = url; window.setTimeout(() => URL.revokeObjectURL(downloaded), 1000); }
    }
  }
  return <div className="journey-file-controls">
    {plan && <button type="button" disabled={disabled} onClick={download}>JSONを書き出す</button>}
    <button type="button" disabled={disabled} onClick={() => input.current?.click()}>{reading ? "JSONを読み込み中…" : "JSONを読み込む"}</button>
    <input ref={input} hidden type="file" accept=".json,application/json" aria-label="旅程のJSONファイル" disabled={disabled}
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file && !disabled) void readFile(file);
      }} />
    {error && <p role="alert">{error}</p>}
    {preview && <TripDialog title="読み込む旅程を確認" onClose={() => setPreview(null)}>
      <p>{preview.title || "ConcierGOの旅"}</p>
      <dl>
        <dt>日付</dt><dd>{preview.plan.date}</dd>
        <dt>出発・帰着先</dt><dd>{preview.plan.origin.name} → {preview.plan.returnTo.name}</dd>
        <dt>立ち寄り先</dt><dd>{preview.plan.stops.length}か所（訪問済み {completedStopCount(preview.plan.stops)}か所）</dd>
        <dt>出発・帰着目安</dt><dd>{preview.plan.input.departureTime} → {tripClock(preview.plan.returnMinute)}</dd>
        <dt>使える時間・予算</dt><dd>{preview.plan.input.availableMinutes}分・{preview.plan.input.budget.toLocaleString("ja-JP")}円</dd>
      </dl>
      <p>移動情報は未確認です。帰着時刻は概算です。AIの説明文は保存ファイルに含まれません。</p>
      <p>読み込むと現在の旅程を置き換えます。</p>
      <div className="trip-dialog-actions">
        <button type="button" className="trip-primary" disabled={disabled} onClick={() => { onImport(preview); setPreview(null); }}>この旅程を読み込む</button>
        <button type="button" onClick={() => setPreview(null)}>キャンセル</button>
      </div>
    </TripDialog>}
  </div>;
}
