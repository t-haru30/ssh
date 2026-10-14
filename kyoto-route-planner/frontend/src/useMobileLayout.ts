import { useSyncExternalStore } from "react";

const mobileQuery = "(max-width:650px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(mobileQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(mobileQuery).matches ?? false, () => false);
}
