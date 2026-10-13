import { expect, it } from "vitest";
import { lockBodyScroll } from "./bodyScrollLock";
it("restores scrolling when overlapping dialogs close in either order", () => {
  document.body.style.overflow = "";
  const first = lockBodyScroll(), second = lockBodyScroll();
  first();
  expect(document.body.style.overflow).toBe("hidden");
  second();
  expect(document.body.style.overflow).toBe("");
  second();
  expect(document.body.style.overflow).toBe("");
});
