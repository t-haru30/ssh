import { SharedSwipeCard } from "./SharedSwipeCard";
import type { SharedSwipeDirection } from "./SharedSwipeCard";
import type { Place } from "./types";

export type SwipeDirection = SharedSwipeDirection;

export type RouteIdea = {
  theme: Place["themes"][number];
  title: string;
  story: string;
  places: Place[];
  image_url: string | null;
  author_name: string | null;
  source_url: string | null;
  license_name: string | null;
  license_url: string | null;
  copywriting_source: "gemini" | "fallback";
  note: string;
};

type SwipeCardProps = {
  idea: RouteIdea;
  depth: number;
  isProcessing: boolean;
  exitDirection?: SwipeDirection;
  onSwipe: (direction: SwipeDirection) => void;
};

function getApproximateDistanceKm(places: Place[]) {
  const earthRadiusKm = 6371;
  return places.slice(1).reduce((total, place, index) => {
    const previous = places[index];
    const toRadians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(place.latitude - previous.latitude);
    const longitudeDelta = toRadians(place.longitude - previous.longitude);
    const latitude1 = toRadians(previous.latitude);
    const latitude2 = toRadians(place.latitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
    return total + 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
  }, 0);
}

export function SwipeCard({
  idea,
  depth,
  isProcessing,
  exitDirection = "accept",
  onSwipe,
}: SwipeCardProps) {
  const approximateDistanceKm = getApproximateDistanceKm(idea.places);
  const distanceLabel = approximateDistanceKm >= 1
    ? `${approximateDistanceKm.toFixed(1)} km`
    : `${Math.round(approximateDistanceKm * 1000)} m`;

  return (
    <SharedSwipeCard
      theme={idea.theme}
      title={idea.title}
      description={idea.story}
      summary={idea.places.length > 1
        ? `スポット間の直線距離（目安） 約${distanceLabel}`
        : undefined}
      spots={idea.places.map((place) => ({
        id: place.id,
        name: place.name,
        category: place.category,
      }))}
      imageUrl={idea.image_url}
      authorName={idea.author_name}
      sourceUrl={idea.source_url}
      licenseName={idea.license_name}
      licenseUrl={idea.license_url}
      coverBadge={`${idea.places.length}か所`}
      depth={depth}
      isTop={depth === 0}
      isProcessing={isProcessing}
      exitDirection={exitDirection}
      onSwipe={onSwipe}
    />
  );
}
