import type { GoogleVenueInfo } from "./useGoogleVenueInfo";
export function GoogleVenueSummary({ info, showHours = false, showDetails = showHours }: { info?: GoogleVenueInfo; showHours?: boolean; showDetails?: boolean }) {
  if (!info) return null;
  return <section className="google-venue-summary" aria-label="Google Mapsの施設情報">
    <a className="google-venue-attribution" href={info.source_url} target="_blank" rel="noopener noreferrer">Google Maps</a>
    {info.display_name && <strong>{info.display_name}</strong>}
    {info.category && <span className="google-venue-category">{info.category}</span>}
    {info.summary && <p>{info.summary}</p>}
    {showDetails && info.address && <p>{info.address}</p>}
    {info.rating !== null && <p className="google-venue-rating">評価 {info.rating.toFixed(1)} / 5{info.rating_count !== null && `（${info.rating_count.toLocaleString("ja-JP")}件）`}</p>}
    {info.business_status === "closed" && <p>閉業の登録があります。別の立ち寄り先をご検討ください。</p>}
    {info.business_status === "temporary" && <p>臨時休業の登録があります。訪問前にご確認ください。</p>}
    {showHours && (info.opening_hours.length ? <details><summary>営業時間を見る</summary>{info.opening_hours.map(s => <div key={s}>{s}</div>)}</details> : <small>営業時間は未確認です。</small>)}
    {showDetails && info.website_url && <a href={info.website_url} target="_blank" rel="noopener noreferrer">施設のサイト・公式アカウント</a>}
  </section>;
}
