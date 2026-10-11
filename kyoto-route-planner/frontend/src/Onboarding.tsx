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
  { title: "見つける", body: "「見つける」タブで、カードを右にスワイプ（または♡）すると気になるルートを保存できます。左は次へ。" },
  { title: "保存する", body: "保存したルートは右上の「♥ 保存済み」からいつでも見返せます。" },
  { title: "経路を作る", body: "「経路を作る」タブで出発駅と日付を選ぶと、実際の乗換を含む旅のしおりができます。1泊2日も選べます。" },
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
