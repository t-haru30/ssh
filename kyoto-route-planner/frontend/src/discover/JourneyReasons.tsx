import type { DatasetRoute } from "./datasetTypes";
import { ReasonSources } from "./reasonSources";
import { stopRecommendation } from "./journeyStory";
import type { GoogleVenueInfo } from "./useGoogleVenueInfo";
import { GoogleVenueSummary } from "./GoogleVenueSummary";

export function JourneyReasons({ route, googleInfos = [] }: { route: DatasetRoute; googleInfos?: GoogleVenueInfo[] }) {
  return <ol className="journey-reasons">{route.spots.map((spot, index) => {
    const googleInfo = googleInfos.find(info => info.place_id === spot.place_id);
    const {fit, facts, unconfirmed} = stopRecommendation(route, index, googleInfo);
    return <li key={spot.place_id}><strong>{spot.name}</strong><GoogleVenueSummary info={googleInfo} />{!googleInfo?.summary && facts && <p>{facts}</p>}<p>{fit}</p>
      <ReasonSources sources={spot.reason_sources} />
      {unconfirmed && !googleInfo?.summary && <small>{spot.role !== "stop" ? "お店の特徴・提供メニューは公式案内でご確認ください。" : "施設の詳しい見どころは公式案内でご確認ください。"}</small>}
    </li>;
  })}</ol>;
}
