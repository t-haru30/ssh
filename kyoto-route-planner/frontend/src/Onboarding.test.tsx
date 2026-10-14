import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Onboarding, ONBOARDING_STORAGE_KEY, setOnboardingSuppressed, shouldSuppressOnboarding } from "./Onboarding";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Onboarding", () => {
  it("is suppressed only when explicitly opted out", () => {
    expect(shouldSuppressOnboarding()).toBe(false);
    window.localStorage.setItem("kyoto-route-planner:onboarding:v1", "done");
    expect(shouldSuppressOnboarding()).toBe(false);
    setOnboardingSuppressed(true);
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
    expect(shouldSuppressOnboarding()).toBe(true);
    setOnboardingSuppressed(false);
    expect(shouldSuppressOnboarding()).toBe(false);
  });

  it("reflects an existing opt-out choice in the checkbox", () => {
    setOnboardingSuppressed(true);
    render(<Onboarding onClose={setOnboardingSuppressed} />);
    expect((screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(shouldSuppressOnboarding()).toBe(false);
  });

  it("requires reaching step three before starting or dismissing the guide", () => {
    let closed = 0;
    render(<Onboarding onClose={() => { closed += 1; }} />);
    const dialog = screen.getByRole("dialog", { name: "はじめての使い方" });
    expect(screen.queryByText("WELCOME")).toBeNull();
    expect(screen.queryByText("3つのステップで、旅のプランが完成")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("region", { name: "STEP 1 / 3: 検索条件を選ぶ" })).toBeTruthy();
    const stepHeader = screen.getByText("STEP 1 / 3").parentElement;
    expect(stepHeader?.querySelector("h3")?.textContent).toBe("検索条件を選ぶ");
    expect(screen.getByRole("img", { name: "条件を選んで旅を探す画面" })).toBeTruthy();
    expect(screen.getByText("友人と").className).toContain("onboarding-preview-chip-friend");
    expect(screen.getByText("自然を楽しむ").className).toContain("onboarding-preview-chip-active");
    expect(screen.getByText(/次へ：行き先を選ぶ/).className).toContain("onboarding-preview-button");
    expect(screen.queryByRole("button", { name: "はじめる" })).toBeNull();
    const checkbox = screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" });
    const onboardingFooter = checkbox.closest(".onboarding-footer");
    const nextButton = onboardingFooter?.querySelector(".onboarding-next-button");
    expect(nextButton?.textContent).toContain("次のステップを見る");
    expect((nextButton?.compareDocumentPosition(checkbox) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("region", { name: "STEP 1 / 3: 検索条件を選ぶ" }).querySelector(".onboarding-demo-controls .onboarding-next-button")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    expect(screen.getByRole("region", { name: "STEP 2 / 3: スワイプで旅を選ぶ" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "旅程カードを右へスワイプして保存する様子" })).toBeTruthy();
    expect(screen.queryByText("気になる旅は右へスワイプして保存。違うと思った旅は左へスワイプして次へ。")).toBeNull();
    expect(screen.getByRole("region", { name: "STEP 2 / 3: スワイプで旅を選ぶ" }).querySelector(".onboarding-step-description")).toBeNull();
    expect(screen.queryByRole("button", { name: "はじめる" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    expect(screen.getByRole("region", { name: "STEP 3 / 3: プランを編集する" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "訪問先と時間と予算を編集する画面" })).toBeTruthy();
    expect(screen.getByText("京都のカフェ")).toBeTruthy();
    expect(screen.getByText("京都のレストラン")).toBeTruthy();
    expect(screen.getByText("京都のレストラン").parentElement?.className).toBe("onboarding-plan-stop-name");
    expect(screen.getByText("¥3,000")).toBeTruthy();
    expect(screen.getByText("¥6,000")).toBeTruthy();
    expect(screen.getByText("¥6,000").parentElement?.className).toBe("onboarding-plan-budget-amount");
    expect(screen.queryByText("選んだ旅をもとに、訪問先や使える時間・予算を調整して自分のプランに仕上げます。")).toBeNull();
    expect(screen.getByRole("region", { name: "STEP 3 / 3: プランを編集する" }).querySelector(".onboarding-step-description")).toBeNull();
    expect(screen.getByRole("button", { name: "はじめる" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /前へ/ }));
    expect(screen.getByRole("region", { name: "STEP 2 / 3: スワイプで旅を選ぶ" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(closed).toBe(1);
    expect((screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);
    expect(dialog).toBeTruthy();
  });

  it("passes the opt-out choice when closing the welcome guide", () => {
    let suppressFuture = false;
    render(<Onboarding onClose={(suppress) => { suppressFuture = suppress; }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(suppressFuture).toBe(true);
  });
});
