export type LatLng = { lat: number; lng: number };
type MapInstance = { fitBounds: (bounds: unknown, padding?: number) => void; panTo: (point: LatLng) => void; setZoom: (zoom: number) => void };
export type GoogleMapsApi = {
  mapId?: string;
  routeProvider?: "google" | "ekispert";
  Map: new (container: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Polyline: new (options: Record<string, unknown>) => { setMap: (map: MapInstance | null) => void };
  TransitLayer?: new () => { setMap: (map: MapInstance | null) => void };
  LatLngBounds: new () => { extend: (point: LatLng) => void };
  InfoWindow: new (options: Record<string, unknown>) => { open: (options: Record<string, unknown>) => void; close: () => void };
  AdvancedMarkerElement: new (options: Record<string, unknown>) => { map: MapInstance | null; addListener: (event: string, callback: () => void) => void };
};
declare global {
  interface Window { google?: { maps: { importLibrary: (name: string) => Promise<Record<string, unknown>> } }; conciergoMapsReady?: () => void }
}
let loading: Promise<GoogleMapsApi> | null = null;
export function loadGoogleMaps(): Promise<GoogleMapsApi> {
  if (loading) return loading;
  loading = (async () => {
    const response = await fetch("/api/maps/config");
    const config: unknown = await response.json();
    if (!response.ok || !config || typeof config !== "object" || !("browser_key" in config) || typeof config.browser_key !== "string" || !config.browser_key) throw new Error("maps_configuration");
    const browserKey = config.browser_key;
    if (!window.google?.maps?.importLibrary) await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const timeout = window.setTimeout(() => { cleanup(); script.remove(); reject(new Error("maps_timeout")); }, 15000);
      const cleanup = () => { window.clearTimeout(timeout); delete window.conciergoMapsReady; };
      window.conciergoMapsReady = () => { cleanup(); resolve(); };
      script.onerror = () => { cleanup(); script.remove(); reject(new Error("maps_connection")); };
      script.async = true;
      script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({key:browserKey,loading:"async",callback:"conciergoMapsReady",v:"quarterly",language:"ja",region:"JP"})}`;
      document.head.append(script);
    });
    if (!window.google?.maps) throw new Error("maps_unavailable");
    const [maps, marker, core] = await Promise.all([window.google.maps.importLibrary("maps"), window.google.maps.importLibrary("marker"), window.google.maps.importLibrary("core")]);
    return {...maps,...marker,...core,mapId:"map_id" in config && typeof config.map_id === "string" ? config.map_id : "DEMO_MAP_ID",routeProvider:"route_provider" in config && config.route_provider === "ekispert" ? "ekispert" : "google"} as unknown as GoogleMapsApi;
  })().catch(error => { loading = null; throw error; });
  return loading;
}

export async function loadGoogleRoutes() {
  if (!window.google?.maps) throw new Error("maps_unavailable");
  return await window.google.maps.importLibrary("routes");
}
