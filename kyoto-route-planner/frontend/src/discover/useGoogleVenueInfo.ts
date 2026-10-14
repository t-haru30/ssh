import { useEffect, useState } from "react";
import type { Place } from "../types";
import { isRecord } from "../apiValidation";
import { publicReasonUrl } from "./reasonSources";

export type GoogleVenueInfo = { place_id: string; status: "ready"; summary: string; category: string; primary_type: string; rating: number | null; rating_count: number | null; business_status: string; opening_hours: string[]; source_url: string; display_name?: string; address?: string; website_url?: string | null; official?: unknown };
export function useGoogleVenueInfo(places: Place[], enabled: boolean, includeOfficial = false) {
  const [state, setState] = useState<{key:string; infos:GoogleVenueInfo[]}>({key:"",infos:[]});
  const key = JSON.stringify(places);
  const requestKey = JSON.stringify([key, includeOfficial]);
  useEffect(() => {
    if (!enabled || !places.length || state.key === requestKey) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const response = await fetch(`/api/places/google-info${includeOfficial ? "?include_official=true" : ""}`, {method:"POST",headers:{"Content-Type":"application/json"},body:key,signal:controller.signal});
        const data: unknown = await response.json();
        if (!response.ok || !isRecord(data) || !Array.isArray(data.places)) return;
        const infos = data.places.filter((p): p is GoogleVenueInfo => isRecord(p) && p.status === "ready" && typeof p.place_id === "string" && places.some(place => place.id === p.place_id)
          && typeof p.summary === "string" && p.summary.length <= 2000 && typeof p.category === "string" && typeof p.primary_type === "string"
          && typeof p.business_status === "string" && (p.rating === null || typeof p.rating === "number" && p.rating >= 0 && p.rating <= 5)
          && (p.rating_count === null || typeof p.rating_count === "number" && Number.isInteger(p.rating_count) && p.rating_count >= 0)
          && (p.display_name === undefined || typeof p.display_name === "string" && p.display_name.length <= 200)
          && (p.address === undefined || typeof p.address === "string" && p.address.length <= 500)
          && (p.website_url == null || typeof p.website_url === "string" && Boolean(publicReasonUrl(p.website_url)))
          && Array.isArray(p.opening_hours) && p.opening_hours.length <= 7 && p.opening_hours.every(s => typeof s === "string") && typeof p.source_url === "string" && /^https:\/\/(?:(?:www\.|maps\.)?google\.com|maps\.app\.goo\.gl)\//.test(p.source_url) && Boolean(publicReasonUrl(p.source_url)));
        if (!controller.signal.aborted) setState({key:requestKey,infos});
      } catch { /* Official/catalog information remains available. */ }
      finally { window.clearTimeout(timeout); }
    });
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [key, enabled, includeOfficial]);
  // Display data is component-local: it never enters the facility DB/favourites.
  return enabled && state.key === requestKey ? state.infos : [];
}
