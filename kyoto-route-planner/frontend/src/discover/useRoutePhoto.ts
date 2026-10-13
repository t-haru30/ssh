import { useEffect, useState } from "react";
import type { Place } from "../types";

export type RoutePhoto = {
  status: "ready" | "unavailable";
  place_id: string | null; place_name: string | null;
  image_url: string | null; author_name: string | null; source_url: string | null;
  license_name: string | null; license_url: string | null;
  image_verified: boolean; ai_checked: boolean; note: string;
};
export type RoutePhotoState = { status: "idle" | "loading" | "ready" | "unavailable"; photo: RoutePhoto | null };
const IDLE: RoutePhotoState = { status: "idle", photo: null };
const LOADING: RoutePhotoState = { status: "loading", photo: null };
const UNAVAILABLE: RoutePhotoState = { status: "unavailable", photo: null };
const cache = new Map<string, { state: RoutePhotoState; expires: number }>();
type PendingPhoto = { controller: AbortController; users: number; promise: Promise<RoutePhotoState> };
const pending = new Map<string, PendingPhoto>();
const PHOTO_TIMEOUT_MS = 30_000;
function photoKey(places: Place[]) { return JSON.stringify(places.map(p => [p.id, p.name, p.latitude, p.longitude])); }
function cachedPhoto(key: string): RoutePhotoState | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.state;
  cache.delete(key);
  return null;
}
export function clearRoutePhotoCache() {
  for (const job of pending.values()) job.controller.abort();
  pending.clear(); cache.clear();
}
export function isRoutePhotoPrepared(input: Place[]) { return cachedPhoto(photoKey(input.slice(0, 3))) !== null; }
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
function loadImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    let decoding = false;
    function finish(success: boolean) {
      if (settled) return;
      settled = true; image.onload = null; image.onerror = null;
      signal.removeEventListener("abort", abort);
      if (success) resolve();
      else { image.removeAttribute("src"); reject(new Error("Photo could not be decoded")); }
    }
    function abort() { finish(false); }
    async function loaded() {
      if (settled || decoding) return;
      decoding = true;
      try { if (typeof image.decode === "function") await image.decode(); finish(!signal.aborted); }
      catch { finish(false); }
    }
    image.onload = loaded; image.onerror = () => finish(false);
    image.decoding = "async";
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    image.src = url;
    if (image.complete && image.naturalWidth > 0) void loaded();
  });
}

function acquirePhoto(places: Place[], key: string): PendingPhoto {
  const existing = pending.get(key);
  if (existing) { existing.users += 1; return existing; }
  const controller = new AbortController();
  const job: PendingPhoto = { controller, users: 1, promise: Promise.resolve(UNAVAILABLE) };
  pending.set(key, job);
  let stop!: () => void;
  const stopped = new Promise<RoutePhotoState>(resolve => { stop = () => resolve(UNAVAILABLE); });
  controller.signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, PHOTO_TIMEOUT_MS);
  // Defer the request so StrictMode and ownership changes can share one task.
  const request = Promise.resolve().then(async (): Promise<RoutePhotoState> => {
    if (controller.signal.aborted) return UNAVAILABLE;
    try {
      const response = await fetch("/api/routes/photo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ places }), signal: controller.signal });
      const photo = response.ok ? readPhoto(await response.json(), places) : null;
      if (!photo || controller.signal.aborted) return UNAVAILABLE;
      if (photo.status === "ready") {
        await loadImage(photo.image_url!, controller.signal);
        return { status: "ready", photo };
      }
      return { status: "unavailable", photo };
    } catch { return UNAVAILABLE; }
  });
  job.promise = Promise.race([request, stopped]).then(state => {
    if ((!controller.signal.aborted || timedOut) && pending.get(key) === job) {
      cache.set(key, { state, expires: Date.now() + (state.status === "ready" ? 6 * 60 * 60_000 : 60_000) });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return state;
  }).finally(() => {
    clearTimeout(timer); controller.signal.removeEventListener("abort", stop);
    if (pending.get(key) === job) pending.delete(key);
  });
  return job;
}

/** Metadata and image decoding share one deadline and one task per route. */
export async function prepareRoutePhoto(input: Place[], signal: AbortSignal): Promise<RoutePhotoState> {
  const places = input.slice(0, 3);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!places.length) return UNAVAILABLE;
  const key = photoKey(places);
  const cached = cachedPhoto(key);
  if (cached) return cached;
  const job = acquirePhoto(places, key);
  let abort!: () => void;
  try {
    return await Promise.race([job.promise, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", abort);
    job.users -= 1;
    // A card becoming the top card can take ownership in the same effect pass.
    void Promise.resolve().then(() => {
      if (job.users === 0 && pending.get(key) === job) { pending.delete(key); job.controller.abort(); }
    });
  }
}

export function useRoutePhoto(input: Place[], enabled: boolean): RoutePhotoState {
  const places = input.slice(0, 3);
  const key = photoKey(places);
  const [state, setState] = useState<RoutePhotoState>(IDLE);
  const [stateKey, setStateKey] = useState("");
  useEffect(() => {
    if (!enabled || !places.length) return;
    let alive = true;
    const controller = new AbortController();
    setStateKey(key); setState(cachedPhoto(key) ?? LOADING);
    void prepareRoutePhoto(places, controller.signal).then(next => {
      if (alive) { setStateKey(key); setState(next); }
    }).catch(() => {});
    return () => { alive = false; controller.abort(); };
    // Facility identity, rather than route title or object allocation, controls requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return enabled && places.length ? cachedPhoto(key) ?? (stateKey === key ? state : LOADING) : IDLE;
}
