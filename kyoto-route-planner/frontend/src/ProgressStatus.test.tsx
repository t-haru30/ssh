import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ProgressStatus } from "./ProgressStatus";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ProgressStatus", () => {
  it("advances through steps and warns when slow", () => {
    render(<ProgressStatus steps={["A", "B", "C"]} stepIntervalMs={1000} slowAfterMs={2500} />);
    expect(screen.getByText("A…")).toBeTruthy();
    expect(screen.queryByText(/通常より時間がかかっています/)).toBeNull();

    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText("✓ A")).toBeTruthy();
    expect(screen.getByText("B…")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("C…")).toBeTruthy();
    expect(screen.getByText(/通常より時間がかかっています/)).toBeTruthy();
  });
});
