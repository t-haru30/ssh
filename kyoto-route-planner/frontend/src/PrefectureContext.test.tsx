import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { PrefectureProvider, usePrefecture } from "./PrefectureContext";

function wrapper({ children }: { children: ReactNode }) {
  return <PrefectureProvider>{children}</PrefectureProvider>;
}

describe("usePrefecture", () => {
  it("defaults to Kyoto and supports selecting a future prefecture", () => {
    const { result } = renderHook(() => usePrefecture(), { wrapper });

    expect(result.current.prefecture).toEqual({ code: "26", name: "京都府" });
    act(() => result.current.setPrefectureCode("13"));
    expect(result.current.prefecture).toEqual({ code: "13", name: "東京都" });
  });
});
