import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReasonSources, isReasonSources } from "./reasonSources";

afterEach(cleanup);
it("accepts legacy missing sources and rejects unsafe or malformed source data", () => {
  expect(isReasonSources(undefined)).toBe(true);
  expect(isReasonSources([{ title: "公式の庭園紹介", url: "https://garden.example.jp/about" }])).toBe(true);
  for (const url of ["javascript:alert(1)", "data:text/html,test", "https://127.0.0.1/", "https://[::1]/", "https://office.internal/", "https://user:secret@garden.example.jp/", "/relative"]) {
    expect(isReasonSources([{ title: "公式", url }])).toBe(false);
  }
  expect(isReasonSources([{ title: " ", url: "https://garden.example.jp/" }])).toBe(false);
  expect(isReasonSources({})).toBe(false);
});
it("renders safe sources once and keeps source interaction away from swipe/card handlers", () => {
  const onClick = vi.fn(), onPointerDown = vi.fn();
  const source = { title: "公式の庭園紹介", url: "https://garden.example.jp/about" };
  render(<div onClick={onClick} onPointerDown={onPointerDown}><ReasonSources sources={[source, source, { title: "危険", url: "javascript:alert(1)" }]} /></div>);
  const link = screen.getByRole("link", { name: source.title });
  expect(link.getAttribute("href")).toBe(source.url);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.pointerDown(link);
  fireEvent.click(link);
  expect(onClick).not.toHaveBeenCalled();
  expect(onPointerDown).not.toHaveBeenCalled();
});
