import { useEffect, useState } from "react";

type ProgressStatusProps = {
  steps: string[];
  title?: string;
  stepIntervalMs?: number;
  slowAfterMs?: number;
  onCancel?: () => void;
};

export const OVERNIGHT_STEPS = [
  "宿泊先を探しています",
  "観光スポットを選んでいます",
  "移動経路を計算しています",
  "1日ごとのスケジュールにまとめています",
];

export const ROUTE_STEPS = [
  "立ち寄り先を選んでいます",
  "巡る順番を決めています",
  "移動経路を計算しています",
];

// 外部APIの待ち時間中に進捗の目安を見せ、止まっていないことを伝える
export function ProgressStatus({ steps, title = "旅のしおりを組み立てています", stepIntervalMs = 4000, slowAfterMs = 15000, onCancel }: ProgressStatusProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, []);

  const current = Math.min(Math.floor(elapsed / stepIntervalMs), steps.length - 1);

  return (
    <div className="progress-status" role="status" aria-live="polite">
      <div className="journey-loader-art" aria-hidden="true"><span>⌖</span><i /><i /><i /></div>
      {title && <strong>{title}</strong>}
      <p className="progress-description">行きたい場所をつないで、あなたの旅に。</p>
      <small>処理の目安を表示しています。完了すると旅程に切り替わります。</small>
      <ol>
        {steps.map((step, index) => (
          <li key={step} className={index < current ? "done" : index === current ? "current" : undefined}>
            {index < current ? "✓ " : ""}{step}{index === current ? "…" : ""}
          </li>
        ))}
      </ol>
      {elapsed >= slowAfterMs && (
        <small>通常より時間がかかっています。もう少しお待ちください（最大 約1分）。</small>
      )}
      {onCancel && <button type="button" className="progress-cancel" onClick={onCancel}>検索を中止する</button>}
    </div>
  );
}
