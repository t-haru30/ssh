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
  preparingNext?: boolean;
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe, active = true, preparingNext = false }: DiscoverCardProps) {
  const sharedExitDirection: SharedSwipeDirection = exitDirection === "like" ? "accept" : "skip";
  const isIdea = "places" in route;
  const aiRecommended = !isIdea && route.recommendation_source === "gemini";
  const selection = useMemo(() => routeSelection(route), [route]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const selectedPlace = selection.places.find(place => place.id === selectedPlaceId);
  const photoState = useRoutePhoto(selection.places, depth < 3 && active);
  const photo = photoState.photo?.status === "ready" ? photoState.photo : null;
  const imageStatus = photoState.status === "loading" || photoState.status === "idle" ? "施設の写真を確認しています…"
    : photo ? "実際の施設写真 · 施設名・位置を照合"
    : photoState.failureReason === "lookup_failed" || photoState.photo?.failure_reason === "lookup_failed" ? "写真の取得が完了しませんでした。行き先の説明は開けます。"
    : "行き先と照合できる実写真がないため、写真を表示していません。";

  return (
    <><SharedSwipeCard
      theme={route.theme}
      title={route.title}
      description={isIdea ? route.story : route.recommendation_reason || `${route.spots.length}か所をつないで、この街を少し深く。`}
      recommendationLabel={aiRecommended ? "AIが選んだおすすめ" : undefined}
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
      imageReady={photoState.status === "ready"}
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
      isProcessing={preparingNext}
      acceptLabel="しおりを開く"
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
    {depth === 0 && selectedPlace && <PlaceDetailsDialog
      key={selectedPlace.id}
      place={selectedPlace}
      stayMinutes={selection.dwellMinutes[selectedPlace.id]}
      recommendations={aiRecommended && route.spots.find(spot => spot.place_id === selectedPlace.id)?.reason
        ? [route.spots.find(spot => spot.place_id === selectedPlace.id)!.reason!]
        : placeRecommendation(selectedPlace, { places: selection.places, origin: selection.origin, theme: route.theme, stayMinutes: selection.dwellMinutes[selectedPlace.id] })}
      onClose={() => setSelectedPlaceId(null)}
    />}</>
  );
}
