import { useMemo, useState } from "react";
import { SharedSwipeCard } from "../SharedSwipeCard";
import type { SharedSwipeDirection } from "../SharedSwipeCard";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { routeSelection } from "../routeSelection";
import { PlaceDetailsDialog } from "./PlaceDetails";
import { placeRecommendation } from "./placeRecommendation";
import { useRoutePhoto } from "./useRoutePhoto";
import "./routePhoto.css";

export type DiscoverDirection = "like" | "pass";

const categoryIcons: Record<string, string> = {
  寺院: "🏯",
  神社: "⛩️",
  自然: "🌿",
  グルメ: "🍵",
  名所: "📍",
};

export function categoryIcon(category: string) {
  return categoryIcons[category] ?? "📍";
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
  onSwipe: (direction: DiscoverDirection) => void;
  active?: boolean;
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe, active = true }: DiscoverCardProps) {
  const sharedExitDirection: SharedSwipeDirection = exitDirection === "like" ? "accept" : "skip";
  const isIdea = "places" in route;
  const selection = useMemo(() => routeSelection(route), [route]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const selectedPlace = selection.places.find(place => place.id === selectedPlaceId);
  const photoState = useRoutePhoto(selection.places, depth === 0 && active);
  const photo = photoState.photo?.status === "ready" ? photoState.photo : null;
  const imageStatus = photoState.status === "loading" ? "施設の写真を確認しています…"
    : photo ? "実際の施設写真 · 施設名・位置を照合"
    : "この旅で出会う場所を、行き先の説明から見てみましょう。";

  return (
    <><SharedSwipeCard
      theme={route.theme}
      title={route.title}
      description={isIdea ? route.story : `${route.spots.length}か所をつないで、この街を少し深く。`}
      summary={isIdea
        ? `${route.places.length}か所を巡る旅のプラン`
        : `⏱ 総所要時間 約${formatMinutes(route.estimated_minutes)}`}
      spots={isIdea
        ? route.places.map((place) => ({
          id: place.id,
          name: place.name,
          category: place.category,
          icon: categoryIcon(place.category),
        }))
        : route.spots.map((spot) => ({
          id: spot.place_id,
          name: spot.name,
          category: spot.category,
          icon: categoryIcon(spot.category),
        }))}
      imageUrl={photo?.image_url}
      photoPlaceName={photo?.place_name}
      authorName={photo?.author_name}
      sourceUrl={photo?.source_url}
      licenseName={photo?.license_name}
      licenseUrl={photo?.license_url}
      imageStatus={imageStatus}
      onSpotSelect={setSelectedPlaceId}
      coverBadge={isIdea
        ? `${route.places.length}か所`
        : route.course === "full_day" ? "1日コース" : "半日コース"}
      depth={depth}
      isTop={depth === 0}
      acceptLabel="しおりを開く"
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
    {depth === 0 && selectedPlace && <PlaceDetailsDialog
      key={selectedPlace.id}
      place={selectedPlace}
      stayMinutes={selection.dwellMinutes[selectedPlace.id]}
      recommendations={placeRecommendation(selectedPlace, { places: selection.places, origin: selection.origin, theme: route.theme, stayMinutes: selection.dwellMinutes[selectedPlace.id] })}
      onClose={() => setSelectedPlaceId(null)}
    />}</>
  );
}
