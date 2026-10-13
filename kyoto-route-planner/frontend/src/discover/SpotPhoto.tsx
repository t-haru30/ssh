import { useState } from "react";
import type { Place } from "../types";
import { useRoutePhoto } from "./useRoutePhoto";
import { GooglePlacePhoto } from "./GooglePlacePhoto";
import "./routePhoto.css";

export function categoryPosition(place: Place): string {
  const category = `${place.category} ${place.name}`;
  if (/カフェ|喫茶|コーヒー|coffee|cafe/i.test(category)) return "0% 0%";
  if (/飲食|レストラン|グルメ|食堂|料理|food|restaurant/i.test(category)) return "50% 0%";
  if (/博物館|美術館|資料館|記念館|museum|gallery/i.test(category)) return "100% 0%";
  if (/寺|神社|神宮|temple|shrine/i.test(category)) return "0% 100%";
  if (/公園|庭園|自然|山|海|川|park|garden|nature/i.test(category)) return "50% 100%";
  return "100% 100%";
}

export function SpotPhoto({ place, enabled, showName = true }: { place: Place; enabled: boolean; showName?: boolean }) {
  const { status, photo } = useRoutePhoto([place], enabled);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const ready = photo?.status === "ready" && photo.image_url && failedUrl !== photo.image_url;
  return <GooglePlacePhoto key={`${place.id}:${place.latitude}:${place.longitude}`} place={place} enabled={enabled && !ready && (status === "unavailable" || status === "ready")} showName={showName}><figure className="route-photo-tile" aria-label={`${place.name}の${ready ? "写真" : "ジャンルイメージ"}`}>
    {ready ? <img src={photo.image_url!} alt={place.name} decoding="async" onError={() => setFailedUrl(photo.image_url)} />
      : <div className="route-category-image" style={{ backgroundPosition: categoryPosition(place) }}><span>AI生成・ジャンルイメージ</span>{(status === "loading" || status === "idle") && <small>実際の写真を確認中</small>}</div>}
    <figcaption>{showName && <strong>{place.name}</strong>}
      {ready && <span className="route-photo-tile-credit" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <a href={photo.source_url!} target="_blank" rel="noopener noreferrer">{photo.author_name}</a>
        <a href={photo.license_url!} target="_blank" rel="noopener noreferrer">{photo.license_name}</a><small>トリミング</small>
      </span>}
    </figcaption>
  </figure></GooglePlacePhoto>;
}
