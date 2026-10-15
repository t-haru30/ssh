import { useEffect, useState } from "react";
import type { Place } from "../types";

type Photo = { status: "ready"; place_id: string; image_url: string; source_url: string; authors: { name: string; url: string }[] };
type Job = { controller: AbortController; users: number; promise: Promise<Photo | null> };
// Only unfinished requests are shared. Google content is not retained in a cache.
const pending = new Map<string, Job>();
function safe(value: unknown, image = false): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search.toLowerCase().includes("key=") &&
      (image ? u.hostname === "googleusercontent.com" || u.hostname.endsWith(".googleusercontent.com") : ["www.google.com", "google.com", "maps.google.com", "maps.app.goo.gl"].includes(u.hostname));
  } catch { return false; }
}
function acquire(payload: string, id: string): Job {
  const existing = pending.get(payload);
  if (existing) { existing.users++; return existing; }
  const controller = new AbortController();
  const job: Job = { controller, users: 1, promise: Promise.resolve(null) };
  pending.set(payload, job);
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  job.promise = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return null;
    try {
      const response = await fetch("/api/places/google-photo", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, cache: "no-store", signal: controller.signal });
      if (!response.ok) return null;
      const result = await response.json() as Photo | null;
      return !controller.signal.aborted && result?.status === "ready" && result.place_id === id && safe(result.image_url, true) && safe(result.source_url) && Array.isArray(result.authors) && result.authors.every(a => a && typeof a.name === "string" && safe(a.url)) ? result : null;
    } catch { return null; }
  }).finally(() => {
    window.clearTimeout(timeout);
    if (pending.get(payload) === job) pending.delete(payload);
  });
  return job;
}

export function useGooglePlacePhoto(place: Place, enabled: boolean) {
  // Recommendations, themes and descriptions cannot affect facility lookup.
  const identityTags = Object.fromEntries(["amenity", "tourism", "railway", "public_transport", "name", "name:ja", "name:en", "official_name"]
    .flatMap(key => place.tags?.[key] ? [[key, place.tags[key]]] : []));
  const payload = JSON.stringify({ id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude, address: place.address || "", category: place.category, tags: identityTags, description: "", access_point: "", themes: [] });
  const [state, setState] = useState<{ payload: string; photo: Photo | null } | null>(null);
  useEffect(() => {
    // A dialog or hidden tab does not change facility identity. Keep its current
    // display data in this mounted component, without a shared/persistent cache.
    if (!enabled || state?.payload === payload && state.photo) return;
    let alive = true;
    const job = acquire(payload, place.id);
    void job.promise.then(photo => { if (alive) setState({ payload, photo }); });
    return () => {
      alive = false;
      job.users--;
      void Promise.resolve().then(() => {
        if (job.users === 0 && pending.get(payload) === job) { pending.delete(payload); job.controller.abort(); }
      });
    };
  }, [enabled, payload, place.id]);
  return { photo: enabled && state?.payload === payload ? state.photo : null, discard: () => setState(null) };
}
