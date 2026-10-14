import { useEffect, useRef, useState } from "react";

export const ONBOARDING_STORAGE_KEY = "kyoto-route-planner:onboarding:suppressed:v1";

export function shouldSuppressOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function setOnboardingSuppressed(suppress: boolean) {
  try {
    if (suppress) window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
    else window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; keep the guide usable for this visit.
  }
}

type OnboardingProps = {
  onClose: (suppressFuture: boolean) => void;
};

const STEPS = [
  { title: "検索条件を選ぶ", demo: "条件を選んで旅を探す画面" },
  { title: "スワイプで旅を選ぶ", demo: "旅程カードを右へスワイプして保存する様子" },
  { title: "プランを編集する", demo: "訪問先と時間と予算を編集する画面" },
];

export function Onboarding({ onClose }: OnboardingProps) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [suppressFuture, setSuppressFuture] = useState(shouldSuppressOnboarding);
  const step = STEPS[activeStep];

  useEffect(() => {
    actionRef.current?.focus();
  }, [activeStep]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && activeStep === STEPS.length - 1) onClose(suppressFuture);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeStep, onClose, suppressFuture]);

  return (
    <div className="route-modal-backdrop" role="presentation">
      <div className="route-modal onboarding" role="dialog" aria-modal="true" aria-label="はじめての使い方">
        <section
          className={`onboarding-step-panel onboarding-demo-${activeStep + 1}`}
          role="region"
          aria-label={`STEP ${activeStep + 1} / 3: ${step.title}`}
          aria-live="polite"
        >
          <div className="onboarding-step-header">
            <p className="onboarding-step-count">{`STEP ${activeStep + 1} / 3`}</p>
            <h3>{step.title}</h3>
          </div>
          <div className="onboarding-demo" role="img" aria-label={step.demo}>
            {activeStep === 0 && (
              <div className="onboarding-search-preview" aria-hidden="true">
                <span className="onboarding-preview-label">誰と出かけますか？</span>
                <span className="onboarding-preview-chip onboarding-preview-chip-friend">友人と</span>
                <span className="onboarding-preview-label">旅の気分</span>
                <span className="onboarding-preview-chip onboarding-preview-chip-active">自然を楽しむ</span>
                <span className="onboarding-preview-button">次へ：行き先を選ぶ →</span>
              </div>
            )}
            {activeStep === 1 && (
              <div className="onboarding-swipe-stage" aria-hidden="true">
                <span className="onboarding-swipe-stamp onboarding-swipe-stamp-save">保存</span>
                <span className="onboarding-swipe-stamp onboarding-swipe-stamp-skip">見送り</span>
                <div className="onboarding-swipe-card">
                  <span className="onboarding-swipe-card-scene" />
                  <span className="onboarding-swipe-card-title">鴨川さんぽ</span>
                  <span className="onboarding-swipe-card-caption">週末の小さな旅</span>
                </div>
              </div>
            )}
            {activeStep === 2 && (
              <div className="onboarding-plan-preview" aria-hidden="true">
                <span className="onboarding-preview-label">今日のプラン</span>
                <span className="onboarding-plan-stop"><b>10:00</b><i />鴨川を散歩</span>
                <span className="onboarding-plan-stop onboarding-plan-stop-edit">
                  <b>11:30</b><i />
                  <span className="onboarding-plan-stop-name">
                    <span>京都のカフェ</span>
                    <span>京都のレストラン</span>
                  </span>
                </span>
                  <span className="onboarding-plan-budget">予算 <span className="onboarding-plan-budget-amount">
                    <span>¥3,000</span>
                    <span>¥6,000</span>
                  </span><span className="onboarding-plan-budget-meter"> ━━━━━</span></span>
              </div>
            )}
          </div>
          <div className="onboarding-demo-controls">
            <button type="button" onClick={() => setActiveStep((current) => Math.max(0, current - 1))} disabled={activeStep === 0}>← 前へ</button>
            {activeStep === STEPS.length - 1 && (
              <button ref={actionRef} type="button" className="idea-primary-button onboarding-start-button" onClick={() => onClose(suppressFuture)}>はじめる</button>
            )}
          </div>
        </section>
        <div className="onboarding-footer">
          {activeStep < STEPS.length - 1 && (
            <button ref={actionRef} type="button" className="idea-primary-button onboarding-next-button" onClick={() => {
                setActiveStep((current) => Math.min(STEPS.length - 1, current + 1));
            }}>次のステップを見る →</button>
          )}
          <label className="onboarding-suppress-option">
            <input type="checkbox" checked={suppressFuture} onChange={(event) => setSuppressFuture(event.currentTarget.checked)} />
            <span>今後、使い方の説明を表示しない</span>
          </label>
        </div>
      </div>
    </div>
  );
}
