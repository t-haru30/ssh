import { useMemo } from "react";
import { SharedSwipeCard } from "../SharedSwipeCard";
import type { SharedSwipeDirection } from "../SharedSwipeCard";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { routeSelection } from "../routeSelection";
import "./routePhoto.css";
import { RoutePhotoGrid } from "./RoutePhotoGrid";
import "./discoverCard.css";

export type DiscoverDirection = "like" | "pass";

export function categoryIcon(category: string) {
  const path = /グルメ|飲食|カフェ|レストラン/.test(category)
    ? "M7 3v7m-3-7v4a3 3 0 0 0 6 0V3M7 10v11m10-18v18m0-18c-3 2-4 5-4 8h4"
    : /神社|寺院/.test(category) ? "M3 6h18M5 9h14M7 6v15m10-15v15M4 3h16"
    : /自然|公園/.test(category) ? "M4 20C4 9 11 4 20 4c0 10-5 16-12 16m-4 0L16 8"
    : /博物館|美術館/.test(category) ? "m3 9 9-6 9 6H3Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18"
    : "M12 21s7-7 7-12A7 7 0 0 0 5 9c0 5 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z";
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

type DiscoverCardProps = {
  route: DatasetRoute | RouteIdea;
  depth: number;
  exitDirection: DiscoverDirection;
  onSwipe: (direction: DiscoverDirection) => boolean | void;
  active?: boolean;
  preparingNext?: boolean;
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe, active = true, preparingNext = false }: DiscoverCardProps) {
  const sharedExitDirection: SharedSwipeDirection = exitDirection === "like" ? "accept" : "skip";
  const isIdea = "places" in route;
  const selection = useMemo(() => routeSelection(route), [route]);

  return (
    <SharedSwipeCard
      presentation="visual"
      theme={route.theme}
      title={route.title}
      summary={isIdea
        ? `${route.places.length}か所を巡る旅のプラン`
        : `${route.travel_origin ? "到着後の観光" : "総所要時間"} 約${formatMinutes(route.estimated_minutes)}`}
      spots={[]}
      coverContent={selection.places.length ? <RoutePhotoGrid places={selection.places} enabled={depth < 3 && active} /> : undefined}
      coverBadge={isIdea
        ? `${route.places.length}か所`
        : route.course === "full_day" ? "1日コース" : "半日コース"}
      depth={depth}
      isTop={depth === 0}
      isProcessing={!active || preparingNext}
      swipeEnabled={active}
      acceptLabel="いいね"
      skipLabel="今回は見送る"
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
  );
}
