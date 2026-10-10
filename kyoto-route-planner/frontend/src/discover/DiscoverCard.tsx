import { SharedSwipeCard } from "../SharedSwipeCard";
import type { SharedSwipeDirection } from "../SharedSwipeCard";
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
  route: DatasetRoute;
  depth: number;
  exitDirection: DiscoverDirection;
  onSwipe: (direction: DiscoverDirection) => void;
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe }: DiscoverCardProps) {
  const sharedExitDirection: SharedSwipeDirection = exitDirection === "like" ? "accept" : "skip";

  return (
    <SharedSwipeCard
      theme={route.theme}
      title={route.title}
      summary={`⏱ 総所要時間 約${formatMinutes(route.estimated_minutes)}`}
      spots={route.spots.map((spot) => ({
        id: spot.place_id,
        name: spot.name,
        category: spot.category,
        icon: categoryIcon(spot.category),
      }))}
      coverBadge={route.pattern === "full_day" ? "1日コース" : "半日コース"}
      depth={depth}
      isTop={depth === 0}
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
  );
}
