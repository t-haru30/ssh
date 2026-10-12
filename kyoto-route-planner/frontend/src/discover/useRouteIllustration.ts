import { useEffect, useState } from "react";
import type { Place, Theme } from "../types";
import { isRecord } from "../apiValidation";

export type RouteIllustrationRequest = {
  title: string;
  theme: Theme;
  places: Pick<Place, "id" | "name" | "category" | "description" | "latitude" | "longitude">[];
};
export type RouteIllustrationState = {
  status: "pending" | "ready" | "disabled" | "busy" | "error";
  key: string;
  imageUrl: string | null;
};
const results = new Map<string, RouteIllustrationState>();
const fallback: RouteIllustrationState = { status: "disabled", key: "", imageUrl: null };

function readState(data: unknown): RouteIllustrationState {
  if (!isRecord(data) || typeof data.key !== "string" || !/^[0-9a-f]{64}$/.test(data.key)
    || !["pending", "ready", "disabled", "busy", "error"].includes(String(data.status))) throw new Error("Invalid illustration response");
  const imageUrl = `/api/route-illustrations/${data.key}/image`;
  if (data.status === "ready" && data.image_url !== imageUrl) throw new Error("Invalid illustration URL");
  return { status: data.status as RouteIllustrationState["status"], key: data.key,
    imageUrl: data.status === "ready" ? imageUrl : null };
}

/** Start only for the active top card. Polling never starts another paid request. */
export function useRouteIllustration(request: RouteIllustrationRequest, enabled: boolean) {
  const body = JSON.stringify(request);
  const [result, setResult] = useState<{ body: string; state: RouteIllustrationState } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    let pollTimer: number | undefined;
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (active) setResult({ body, state: { ...fallback, status: "error" } });
    }, 150_000);
    function keep(state: RouteIllustrationState) {
      // Only completed images survive card remounts. A later visit can detect
      // newly configured credentials or recover from a temporary limit.
      if (state.status === "ready") {
        if (results.size >= 32) results.delete(results.keys().next().value!);
        results.set(body, state);
      }
      setResult({ body, state });
    }
    async function load(key?: string) {
      try {
        const response = await fetch(key ? `/api/route-illustrations/${key}` : "/api/route-illustrations", key
          ? { signal: controller.signal }
          : { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
        if (!response.ok) throw new Error("Illustration unavailable");
        const state = readState(await response.json());
        if (!active || controller.signal.aborted) return;
        keep(state);
        if (state.status === "pending") pollTimer = window.setTimeout(() => void load(state.key), 2000);
        else window.clearTimeout(timeout);
      } catch {
        window.clearTimeout(timeout);
        if (active && !controller.signal.aborted) keep({ ...fallback, status: "error" });
      }
    }
    const cached = results.get(body);
    if (cached) { keep(cached); window.clearTimeout(timeout); }
    else void load();
    return () => { active = false; window.clearTimeout(timeout); window.clearTimeout(pollTimer); controller.abort(); };
  }, [body, enabled]);
  return result?.body === body ? result.state : results.get(body) ?? fallback;
}

export function routeIllustrationRequest(title: string, theme: Theme, places: Place[]): RouteIllustrationRequest {
  return { title: title.slice(0, 500), theme, places: places.slice(0, 8).map(place => ({
    id: place.id, name: place.name, category: place.category, description: place.description.slice(0, 600),
    latitude: place.latitude, longitude: place.longitude,
  })) };
}
