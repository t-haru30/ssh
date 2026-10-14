import { ReasonSources } from "./reasonSources";
import { conciseReason } from "./conciseReason";
import { useMemo, useState } from "react";
import { SharedSwipeCard } from "../SharedSwipeCard";
import type { SharedSwipeDirection } from "../SharedSwipeCard";
import type { RouteIdea } from "../SwipeCard";
import type { DatasetRoute } from "./datasetTypes";
import { routeSelection } from "../routeSelection";
import { PlaceDetailsDialog } from "./PlaceDetails";
import { placeRecommendation } from "./placeRecommendation";
import "./routePhoto.css";
import { RoutePhotoGrid } from "./RoutePhotoGrid";
import { journeyOverview } from "./journeyStory";
import { JourneyReasons } from "./JourneyReasons";
import { useGoogleVenueInfo } from "./useGoogleVenueInfo";
import { GoogleVenueSummary } from "./GoogleVenueSummary";

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
  const aiRecommended = !isIdea && route.recommendation_source === "gemini";
  const fullReason = isIdea ? route.story : route.recommendation_reason || `${route.spots.length}か所をつないで、この街を少し深く。`;
  const selection = useMemo(() => routeSelection(route), [route]);
  const googleInfos = useGoogleVenueInfo(selection.places, active && depth === 0);
  const shortReason = isIdea ? fullReason : journeyOverview(route, googleInfos);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const selectedPlace = selection.places.find(place => place.id === selectedPlaceId);

  return (
    <><SharedSwipeCard
      theme={route.theme}
      title={route.title}
      description={shortReason}
      descriptionLabel="この旅の楽しみ"
      descriptionSupplement={googleInfos.filter(info => info.summary).map(info => <div key={info.place_id}><strong>{selection.places.find(place => place.id === info.place_id)?.name}</strong><GoogleVenueSummary info={info} /></div>)}
      recommendationSources={<>
        <details className="place-description-toggle" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          <summary>おすすめ理由の全文・出典</summary>
          <p>{shortReason}</p>
          {!isIdea && <><JourneyReasons route={route} googleInfos={googleInfos} /><ReasonSources sources={route.reason_sources?.filter(source => !route.spots.some(spot => spot.reason_sources?.some(item => item.url === source.url)))} /></>}
        </details>
      </>}
      recommendationLabel={aiRecommended ? "あなたへのおすすめ" : undefined}
      summary={isIdea
        ? `${route.places.length}か所を巡る旅のプラン`
        : `${route.travel_origin ? "到着後の観光" : "総所要時間"} 約${formatMinutes(route.estimated_minutes)}`}
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
          category: spot.role !== "stop" ? `${({breakfast:"朝ごはん",lunch:"昼ごはん",dinner:"夜ごはん"})[spot.role]} ${spot.meal_time ?? ""} · 営業時間は要確認` : spot.category,
          appeal: spot.reason && !/直線約|公式情報を確認できていません/.test(spot.reason) && !shortReason.includes(conciseReason(spot.reason)) ? conciseReason(spot.reason) : undefined,
          icon: categoryIcon(spot.category),
        }))}
      coverContent={selection.places.length ? <RoutePhotoGrid places={selection.places} enabled={depth < 3 && active} /> : undefined}
      onSpotSelect={setSelectedPlaceId}
      coverBadge={isIdea
        ? `${route.places.length}か所`
        : route.course === "full_day" ? "1日コース" : "半日コース"}
      depth={depth}
      isTop={depth === 0}
      isProcessing={!active || preparingNext || Boolean(selectedPlaceId)}
      swipeEnabled={active && !selectedPlaceId}
      acceptLabel="いいね"
      skipLabel="今回は見送る"
      exitDirection={sharedExitDirection}
      onSwipe={(direction) => onSwipe(direction === "accept" ? "like" : "pass")}
    />
    {depth === 0 && selectedPlace && <PlaceDetailsDialog
      key={selectedPlace.id}
      place={selectedPlace}
      stayMinutes={selection.dwellMinutes[selectedPlace.id]}
      reasonSources={!isIdea ? route.spots.find(spot => spot.place_id === selectedPlace.id)?.reason_sources : undefined}
      recommendations={!isIdea && route.spots.find(spot => spot.place_id === selectedPlace.id)?.reason
        ? [route.spots.find(spot => spot.place_id === selectedPlace.id)!.reason!]
        : placeRecommendation(selectedPlace, { places: selection.places, origin: selection.origin, theme: route.theme, stayMinutes: selection.dwellMinutes[selectedPlace.id] })}
      onClose={() => setSelectedPlaceId(null)}
    />}</>
  );
}
