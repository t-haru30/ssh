import { LazyMapView } from "./LazyMapView";
import { transportMatches } from "./dayTrip";
import type { TripPlan } from "./dayTrip";
import { useMobileLayout } from "./useMobileLayout";

export function MobileTripMap({ plan, routeLoading }: { plan: TripPlan; routeLoading: boolean }) {
  const mobile = useMobileLayout();
  if (!mobile) return null;
  const timeline = transportMatches(plan) ? plan.transport.route.timeline ?? [] : [];
  return <section className="trip-booklet-map" aria-label="しおりの旅程マップ">
    <h4>旅程マップ</h4>
    <LazyMapView initialMode="routes" places={plan.stops.map(stop => stop.place)}
      origin={plan.origin} returnTo={plan.returnTo} journeyDate={plan.date}
      routeLoading={routeLoading} timeline={timeline}
      mapTokens={timeline.flatMap(item => item.type === "transit" && item.map_token ? [item.map_token] : [])} />
  </section>;
}
