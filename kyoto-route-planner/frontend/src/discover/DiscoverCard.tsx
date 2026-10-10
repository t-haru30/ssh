import { SharedSwipeCard } from "../SharedSwipeCard";
import type { SharedSwipeDirection } from "../SharedSwipeCard";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";

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
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe }: DiscoverCardProps) {
  const sharedExitDirection: SharedSwipeDirection = exitDirection === "like" ? "accept" : "skip";
  const isIdea = "places" in route;

  return (
    <SharedSwipeCard
      theme={route.theme}
      title={route.title}
      description={isIdea ? route.story : undefined}
      summary={isIdea
        ? `${route.places.length}か所のスポットを巡るよりみち`
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
      imageUrl={isIdea ? route.image_url : undefined}
      authorName={isIdea ? route.author_name : undefined}
      sourceUrl={isIdea ? route.source_url : undefined}
      licenseName={isIdea ? route.license_name : undefined}
      licenseUrl={isIdea ? route.license_url : undefined}
      coverBadge={isIdea
        ? `${route.places.length}か所`
        : route.pattern === "full_day" ? "1日コース" : "半日コース"}
      depth={depth}
      isTop={depth === 0}
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
  );
}
