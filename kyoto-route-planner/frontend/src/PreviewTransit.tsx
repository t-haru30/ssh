import type { Origin, RouteTimelineTransit } from "./types";
import { transitPlaceName } from "./transitPlaceName";

const modeLabel = (mode: string) => ({train:"電車",bus:"バス",walk:"徒歩",walking:"徒歩",car:"車"}[mode] ?? "移動");

export function PreviewTransit({from,to,minutes,unknown,loading,transit,places}: {
  from:string;to:string;minutes:number;unknown?:boolean;loading:boolean;
  transit?:RouteTimelineTransit;places:Origin[];
}) {
  const legs=transit?.legs ?? [];
  return <li className="journey-between-stops" aria-label={`プレビューの移動：${from}から${to}`}>
    <div className="preview-transit">
      <div className="preview-transit-heading"><strong>{unknown ? "移動時間未確認" : `移動 約${minutes}分`}</strong>{transit?.fare_yen != null && <span>概算 {transit.fare_yen.toLocaleString("ja-JP")}円</span>}</div>
      {legs.length > 0 && <div className="preview-transit-modes" aria-label="移動手段の順番">{legs.map((leg,index) => <span key={index}>{index > 0 && <span className="preview-transit-arrow" aria-hidden="true">›</span>}<span className={`preview-mode preview-mode--${leg.mode}`}>{modeLabel(leg.mode)}</span></span>)}</div>}
      {!transit && <p className="preview-transit-note">{loading ? "交通経路を検索中…" : "距離からの徒歩概算"}</p>}
      {transit && <details className="preview-transit-details"><summary>経路・乗換を見る</summary>
        <div className="preview-transit-endpoint"><span>出発</span>{from}</div>
        {legs.length ? <ol className="preview-transit-legs">{legs.map((leg,index) => {
          const label=modeLabel(leg.mode);
          const walking=leg.mode === "walk" || leg.mode === "walking";
          const riding=leg.mode === "train" || leg.mode === "bus";
          const previous=legs[index-1];
          const transfer=riding && previous && (previous.mode === "train" || previous.mode === "bus");
          return <li key={index} className={`preview-transit-leg preview-transit-leg--${leg.mode}`}>
            {transfer && <div className="preview-leg-transfer">↓ {transitPlaceName(leg.from_name,places)}で乗り換え</div>}
            <div className="preview-leg-heading"><span className="preview-leg-number">{index+1}</span><span className="preview-leg-mode">{label}</span>{leg.duration_minutes != null && <span className="preview-leg-duration">約{leg.duration_minutes}分</span>}</div>
            {!walking && leg.line_name && leg.line_name !== "移動" && <strong className="preview-leg-line">{leg.line_name}</strong>}
            <div className="preview-leg-stations"><div><small>{riding ? "乗車" : "から"}</small><span>{transitPlaceName(leg.from_name,places)}</span></div><div><small>{riding ? "下車" : "まで"}</small><span>{transitPlaceName(leg.to_name,places)}</span></div></div>
          </li>;
        })}</ol> : <p className="preview-transit-note">{transit.transit_line || "区間の詳細はありません。"}</p>}
        <div className="preview-transit-endpoint"><span>到着</span>{to}</div>
        <p className="preview-transit-note">所要時間は待ち時間・乗り換えを含む目安です。</p>
      </details>}
    </div>
  </li>;
}
