import { useEffect, useState } from "react";
import type { Place } from "../types";

export type RoutePhoto = {
  status: "ready" | "unavailable";
  place_id: string | null; place_name: string | null;
  image_url: string | null; author_name: string | null; source_url: string | null;
  license_name: string | null; license_url: string | null;
  image_verified: boolean; ai_checked: boolean; note: string;
};
type State = { status: "idle" | "loading" | "ready" | "unavailable"; photo: RoutePhoto | null };
const cache = new Map<string, RoutePhoto>();
export function clearRoutePhotoCache() { cache.clear(); }
function safeUrl(value: unknown, check: (url: URL) => boolean) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && check(url); } catch { return false; }
}
function readPhoto(value: unknown, places: Place[]): RoutePhoto | null {
  if (!value || typeof value !== "object") return null;
  const p = value as RoutePhoto;
  if (p.status === "unavailable") return { ...p, status: "unavailable" };
  if (p.status !== "ready" || p.image_verified !== true || typeof p.ai_checked !== "boolean"
    || !places.some(place => place.id === p.place_id && place.name === p.place_name)
    || typeof p.author_name !== "string" || !p.author_name.trim() || typeof p.license_name !== "string" || !p.license_name.trim()
    || !safeUrl(p.image_url, url => ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname))
    || !safeUrl(p.source_url, url => ["commons.wikimedia.org", "ja.wikipedia.org"].includes(url.hostname) && /^\/wiki\/File:.+/.test(decodeURIComponent(url.pathname)))
    || !safeUrl(p.license_url, url => ["creativecommons.org", "www.creativecommons.org"].includes(url.hostname) && !url.search && !url.hash && /^\/(?:licenses\/(?:by|by-sa)\/(?:1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/(?:[a-z-]+\/?|deed\.[a-z-]+)?)?$/.test(url.pathname))) return null;
  return p;
}
export function useRoutePhoto(input: Place[], enabled: boolean): State {
  const places = input.slice(0, 3);
  const key = JSON.stringify(places.map(p => [p.id, p.name, p.latitude, p.longitude]));
  const [state, setState] = useState<State>({ status: "idle", photo: null });
  const [stateKey, setStateKey] = useState("");
  useEffect(() => {
    if (!enabled || !places.length) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (photo: RoutePhoto | null) => { if (alive) { setStateKey(key); setState({ status: photo?.status === "ready" ? "ready" : "unavailable", photo }); } };
    // The first StrictMode probe is cleaned up before this microtask starts a request.
    void Promise.resolve().then(async () => {
      if (!alive) return;
      const cached = cache.get(key);
      if (cached) { finish(cached); return; }
      setStateKey(key); setState({ status: "loading", photo: null });
      timer = setTimeout(() => { finish(null); alive = false; controller.abort(); }, 30_000);
      try {
        const response = await fetch("/api/routes/photo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ places }), signal: controller.signal });
        const photo = response.ok ? readPhoto(await response.json(), places) : null;
        if (!alive) return;
        if (photo) { cache.set(key, photo); if (cache.size > 32) cache.delete(cache.keys().next().value!); }
        finish(photo);
      } catch { finish(null); }
      finally { clearTimeout(timer); }
    });
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
    // Facility identity, rather than route title or object allocation, controls requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return enabled && stateKey === key ? state : { status: "idle", photo: null };
}
