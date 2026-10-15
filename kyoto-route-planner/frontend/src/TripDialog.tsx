import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { lockBodyScroll } from "./bodyScrollLock";

export function TripDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const unlockScroll = lockBodyScroll();

    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { unlockScroll(); document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="trip-dialog-backdrop" onClick={onClose}>
    <section className="trip-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} onClick={event => event.stopPropagation()}>
      <header><h3>{title}</h3><button type="button" onClick={onClose} aria-label="ダイアログを閉じる">閉じる</button></header>
      {children}
    </section>
  </div>;
}
