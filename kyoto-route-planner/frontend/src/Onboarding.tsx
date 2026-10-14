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
  { title: "検索条件を選ぶ", body: "誰と行くか、旅の気分、行き先、出発地点を順番に選びます。", demo: "条件を選んで旅を探す画面" },
  { title: "スワイプで旅を選ぶ", body: "気になる旅は右へスワイプして保存。違うと思った旅は左へスワイプして次へ。", demo: "旅程カードを右へスワイプして保存する様子" },
  { title: "プランを編集する", body: "選んだ旅をもとに、訪問先や使える時間・予算を調整して自分のプランに仕上げます。", demo: "訪問先と時間と予算を編集する画面" },
];

export function Onboarding({ onClose }: OnboardingProps) {
  const firstTabRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [suppressFuture, setSuppressFuture] = useState(shouldSuppressOnboarding);
  const step = STEPS[activeStep];

  useEffect(() => {
    firstTabRef.current?.focus();
  }, []);

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
        <p className="eyebrow">WELCOME</p>
        <h2>3つのステップで、旅のプランが完成</h2>
        <p className="onboarding-intro">条件を選んで、旅を見つけて、自分だけのプランに。</p>
        <div className="onboarding-step-tabs" role="tablist" aria-label="旅づくりの3ステップ">
          {STEPS.map((item, index) => (
            <button
              key={item.title}
              ref={index === 0 ? firstTabRef : undefined}
              type="button"
              id={`onboarding-tab-${index + 1}`}
              role="tab"
              aria-selected={activeStep === index}
              aria-controls="onboarding-step-panel"
              tabIndex={activeStep === index ? 0 : -1}
              disabled={index > furthestStep}
              onKeyDown={(event) => {
                const offset = event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 0;
                if (!offset) return;
                event.preventDefault();
                const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
                const next = Math.max(0, Math.min(furthestStep, index + offset));
                setActiveStep(next);
                tabs[next]?.focus();
              }}
              onClick={() => { if (index <= furthestStep) setActiveStep(index); }}
            >
              <span>{`STEP ${index + 1}`}</span>
              {item.title}
            </button>
          ))}
        </div>
        <section
          className={`onboarding-step-panel onboarding-demo-${activeStep + 1}`}
          id="onboarding-step-panel"
          role="tabpanel"
          aria-labelledby={`onboarding-tab-${activeStep + 1}`}
        >
          <p className="onboarding-step-count">{`STEP ${activeStep + 1} / 3`}</p>
          <div className="onboarding-demo" role="img" aria-label={step.demo}>
            {activeStep === 0 && (
              <div className="onboarding-search-preview" aria-hidden="true">
                <span className="onboarding-preview-label">誰と出かけますか？</span>
                <span className="onboarding-preview-chip">友人と</span>
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
                <span className="onboarding-plan-stop"><b>11:30</b><i />京都のカフェ</span>
                <span className="onboarding-plan-budget">予算 <strong>¥5,000</strong><span> ━━━━━</span></span>
              </div>
            )}
          </div>
          <h3>{step.title}</h3>
          <p className="onboarding-step-description">{step.body}</p>
          <div className="onboarding-demo-controls">
            <button type="button" onClick={() => setActiveStep((current) => Math.max(0, current - 1))} disabled={activeStep === 0}>← 前へ</button>
            {activeStep < STEPS.length - 1
              ? <button type="button" className="idea-primary-button" onClick={() => {
                const next = Math.min(STEPS.length - 1, activeStep + 1);
                setFurthestStep((furthest) => Math.max(furthest, next));
                setActiveStep(next);
              }}>次のステップを見る →</button>
              : <button ref={startRef} type="button" className="idea-primary-button onboarding-start-button" onClick={() => onClose(suppressFuture)}>はじめる</button>}
          </div>
        </section>
        <label className="onboarding-suppress-option">
          <input type="checkbox" checked={suppressFuture} onChange={(event) => setSuppressFuture(event.currentTarget.checked)} />
          <span>今後、使い方の説明を表示しない</span>
        </label>
      </div>
    </div>
  );
}
