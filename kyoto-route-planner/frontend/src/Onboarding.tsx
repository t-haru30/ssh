import { useEffect, useRef } from "react";

export const ONBOARDING_STORAGE_KEY = "kyoto-route-planner:onboarding:v1";

export function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "done";
  } catch {
    return true;
  }
}

export function markOnboardingSeen() {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
  } catch {
    // 保存できなくてもアプリの利用には影響しない
  }
}

type OnboardingProps = {
  onClose: () => void;
};

const STEPS = [
  { title: "見つける", body: "行きたい都道府県と気分を選んで、旅のアイデアを見つけましょう。気になるルートはしおりを開いて詳しく。" },
  { title: "自分の予定に整える", body: "行き先を引き継いだら、時間と予算を設定。外したくない予定を固定して、残りの寄り道を調整できます。" },
  { title: "しおりを持って出かける", body: "交通経路を確認して準備完了。編集中の旅程は自動保存され、好きなルートは右上の「♥ 保存済み」から見返せます。" },
];

export function Onboarding({ onClose }: OnboardingProps) {
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="route-modal-backdrop" role="presentation">
      <div className="route-modal onboarding" role="dialog" aria-modal="true" aria-label="はじめての使い方">
        <p className="eyebrow">WELCOME</p>
        <h2>3ステップで旅のプランができます</h2>
        <ol className="onboarding-steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="onboarding-number" aria-hidden="true">{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <button ref={startRef} type="button" className="idea-primary-button" onClick={onClose}>はじめる</button>
      </div>
    </div>
  );
}
