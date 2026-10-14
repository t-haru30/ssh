import { FacilityPhoto } from "../FacilityPhoto";
import { ReasonSources, type ReasonSource } from "./reasonSources";
import { useEffect, useState } from "react";
import type { Place } from "../types";
import { TripDialog } from "../DayTripEditor";
import { isRecord } from "../apiValidation";
import { readOfficialNotices, type OfficialNotice } from "../officialNotices";
import { googleMapsUrl } from "../mapLinks";
import { OfficialPlaceSearch } from "./OfficialPlaceSearch";
import "./placeDetails.css";
import { useGoogleVenueInfo } from "./useGoogleVenueInfo";
import { GoogleVenueSummary } from "./GoogleVenueSummary";

type Introduction = {
  description: string;
  source_url: string;
  source_title: string;
  license_url: string;
  license_name: string;
};

type OfficialInfo = {
  url: string;
  description: string | null;
  description_source_url: string;
  highlights: string[];
  opening_hours: string | null;
  closed_days: string | null;
  admission: string | null;
  field_sources: Partial<Record<"opening_hours" | "closed_days" | "admission", string>>;
  notices: OfficialNotice[];
  checked_at: string | null;
  status: "verified" | "link_only";
};

function publicWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
      || /^\d[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
    return url.href;
  } catch { return null; }
}

function readOfficial(value: unknown): OfficialInfo | null {
  if (!isRecord(value)) return null;
  const url = publicWebUrl(value.url);
  if (!url || (value.status !== "verified" && value.status !== "link_only")) return null;
  const text = (key: string) => typeof value[key] === "string" && value[key].trim() ? (value[key] as string).trim() : null;
  const verified = value.status === "verified";
  const field_sources: OfficialInfo["field_sources"] = {};
  if (verified && isRecord(value.field_sources)) {
    for (const key of ["opening_hours", "closed_days", "admission"] as const) {
      const source = publicWebUrl(value.field_sources[key]);
      if (text(key) && source) field_sources[key] = source;
    }
  }
  return { url, status: value.status, description: text("description"),
    field_sources, notices: readOfficialNotices(value.notices, publicWebUrl),
    description_source_url: publicWebUrl(value.description_source_url) ?? url,
    highlights: Array.isArray(value.highlights) ? value.highlights.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 3) : [],
    opening_hours: verified ? text("opening_hours") : null, closed_days: verified ? text("closed_days") : null,
    admission: verified ? text("admission") : null, checked_at: verified ? text("checked_at") : null };
}

function readIntroduction(value: unknown): Introduction | null {
  if (!isRecord(value)) return null;
  const keys = ["description", "source_url", "source_title", "license_url", "license_name"] as const;
  if (!keys.every(key => typeof value[key] === "string" && value[key].trim())) return null;
  try {
    const source = new URL(value.source_url as string);
    const license = new URL(value.license_url as string);
    if (source.protocol !== "https:" || source.hostname !== "ja.wikipedia.org"
      || license.protocol !== "https:" || license.hostname !== "creativecommons.org") return null;
  } catch { return null; }
  return Object.fromEntries(keys.map(key => [key, value[key]])) as Introduction;
}

/** Mounted only after a person opens a destination; browsing cards makes no API calls. */
export function PlaceIntroduction({ place, stayMinutes, recommendations = [], reasonSources, enableOfficialSearch = true }: { place: Place; stayMinutes?: number; recommendations?: string[]; reasonSources?: ReasonSource[]; enableOfficialSearch?: boolean }) {
  const googleInfos = useGoogleVenueInfo([place], enableOfficialSearch, true);
  const googleInfo = googleInfos[0];
  const [introduction, setIntroduction] = useState<Introduction | null>(null);
  const [catalogOfficial, setOfficial] = useState<OfficialInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const identity = JSON.stringify([place.id, place.name, place.latitude, place.longitude, place.address ?? ""]);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), 17_000);
    setIntroduction(null);
    setOfficial(null);
    setLoading(true);
    setLoadedIdentity(null);
    async function load() {
      try {
        const response = await fetch("/api/places/description", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(place), signal: controller.signal,
        });
        const data: unknown = response.ok ? await response.json() : null;
        if (active && !controller.signal.aborted) {
          setIntroduction(readIntroduction(data));
          setOfficial(isRecord(data) ? readOfficial(data.official) : null);
        }
      } catch { /* The visit hint and map remain available when no verified article exists. */ }
      finally { window.clearTimeout(timer); if (active) { setLoading(false); setLoadedIdentity(identity); } }
    }
    void load();
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [place]);

  const mapUrl = `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=17/${place.latitude}/${place.longitude}`;
  const routeNote = place.description.trim();
  const hasRouteNote = routeNote && !recommendations.some(reason => reason.trim() === routeNote) && !/^.{1,4}[都道府県]$/.test(routeNote);
  const matchedOfficial = readOfficial(googleInfo?.official);
  const official = catalogOfficial?.description ? catalogOfficial : matchedOfficial ?? catalogOfficial;
  const needsOfficialSearch = enableOfficialSearch && (!official || !official.opening_hours || !official.closed_days || !official.admission);
  const detailsLoading = loading || loadedIdentity !== identity;
  return <div className="place-introduction">
    <GoogleVenueSummary info={googleInfos[0]} showDetails />
    <div className="place-details-facts"><span>{place.category}</span>{stayMinutes !== undefined && <span>滞在の目安 {stayMinutes}分</span>}</div>
    {place.address && <p className="place-details-address">{place.address}</p>}
    {hasRouteNote && <div className="place-route-reason"><h4>旅のポイント</h4><p>{routeNote}</p></div>}
    {recommendations.length > 0 && (!official?.description || !recommendations.every(reason => /公式情報を確認できていません/.test(reason))) && <section className="place-recommendation" aria-label="この旅でのおすすめポイント"><h4>この旅でのおすすめポイント</h4>
      <ul>{[...new Set(recommendations)].map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      <ReasonSources sources={reasonSources} />
    </section>}
    {Boolean(official?.highlights.length) && <section className="place-official-highlights" aria-label="施設の見どころ"><h4>施設の見どころ</h4>
      <ul>{official!.highlights.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      <p className="place-details-source">見どころの参考：<a href={official!.description_source_url} target="_blank" rel="noopener noreferrer">施設の公式紹介</a></p>
    </section>}
    {detailsLoading ? <p role="status" className="place-details-status">この場所の説明を確認しています…</p>
      : official?.description ? <div className="place-details-description"><h4>この場所について</h4><p>{official.description}</p><p className="place-details-source">出典：<a href={official.description_source_url} target="_blank" rel="noopener noreferrer">施設の公式紹介</a>をもとに作成</p></div>
      : introduction ? <div className="place-details-description"><h4>この場所について</h4><p>{introduction.description}</p>
        <p className="place-details-source">出典：<a href={introduction.source_url} target="_blank" rel="noopener noreferrer">{introduction.source_title} — Wikipediaの寄稿者</a>（冒頭の抜粋・<a href={introduction.license_url} target="_blank" rel="noopener noreferrer">{introduction.license_name}</a>）</p>
      </div> : !googleInfo && <p role="status" className="place-details-status">この場所に一致する詳しい説明は、現在確認できません。施設の案内や地図をご確認ください。</p>}
    {!detailsLoading && <section className="place-official-guide" aria-label="訪問前の確認"><h4>訪問前の確認</h4>
      <p className="place-details-source">施設データ：{place.id.startsWith("osm-") ? "OpenStreetMap" : place.tags?.source ?? "登録済みの施設候補"}{googleInfo ? " · 詳細情報：Google Maps・施設の案内" : ""}。施設の説明と営業時間・料金は、それぞれの出典をご確認ください。</p>
      <dl>{([
        ["opening_hours", "開館・営業時間"], ["closed_days", "休館・定休日"], ["admission", "入館・利用料金"],
      ] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{official?.[key] ?? (key === "opening_hours" && googleInfo?.opening_hours.length ? <>{googleInfo.opening_hours.join("\n")} <a href={googleInfo.source_url} target="_blank" rel="noopener noreferrer">Google Maps掲載情報</a></> : "未確認")}
        {official?.[key] && official.field_sources[key] && <> <a href={official.field_sources[key]} target="_blank" rel="noopener noreferrer" aria-label={`${label}の出典`}>出典</a></>}
        {official?.[key] && !official.field_sources[key] && <small>（項目別の出典は未確認）</small>}
      </dd></div>)}</dl>
      <p className="place-details-status">未確認は、休業・閉館や無料を意味しません。当日の営業状況は公式案内でご確認ください。</p>
      {official?.notices.map(notice => <aside className="place-official-notice" aria-label="臨時休館のお知らせ" key={notice.url}>
        <h4>臨時休館のお知らせ</h4><p>{notice.starts_on}〜{notice.ends_on}</p><p>{notice.text}</p>
        <a href={notice.url} target="_blank" rel="noopener noreferrer">臨時休館の公式出典</a>
      </aside>)}
      {official ? <><a className="place-details-official-link" href={official.url} target="_blank" rel="noopener noreferrer">公式サイトで最新の案内を見る <span aria-hidden="true">↗</span></a>
        <p className="place-details-source">{official.status === "verified" ? `公式ページを確認${official.checked_at && !Number.isNaN(Date.parse(official.checked_at)) ? `：${new Date(official.checked_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}` : ""}。` : official.notices.length ? "公式のお知らせを取得しました。通常の開館情報は未確認です。" : "公式ページの内容は取得できませんでした。"}未確認の項目や臨時休館・展示替えは、リンク先でご確認ください。</p></>
        : !enableOfficialSearch && <><p className="place-details-status">公式サイトを確認できませんでした。開館時間・最終入館・休館日を、施設へお問い合わせいただくか検索してご確認ください。</p>
          <a className="place-details-official-link" href={`https://www.google.com/search?q=${encodeURIComponent(`${place.name} ${place.address ?? ""} 公式 開館時間 休館日`)}`} target="_blank" rel="noopener noreferrer">施設名で公式案内を探す <span aria-hidden="true">↗</span></a></>}
      {needsOfficialSearch && !googleInfo && <OfficialPlaceSearch key={place.id} place={place} />}
    </section>}
    <div className="place-details-map-links">
      <a className="place-details-map-link" href={mapUrl} target="_blank" rel="noopener noreferrer">地図で場所を確認する <span aria-hidden="true">↗</span></a>
      <a className="place-details-map-link" href={googleMapsUrl(place)} target="_blank" rel="noopener noreferrer">Google Mapsで開く <span aria-hidden="true">↗</span></a>
    </div>
  </div>;
}

export function PlaceDetailsDialog({ place, stayMinutes, recommendations, reasonSources, onClose, enableOfficialSearch = true }: { place: Place; stayMinutes?: number; recommendations?: string[]; reasonSources?: ReasonSource[]; onClose: () => void; enableOfficialSearch?: boolean }) {
  return <TripDialog title={place.name} onClose={onClose}><FacilityPhoto place={place} /><PlaceIntroduction place={place} stayMinutes={stayMinutes} recommendations={recommendations} reasonSources={reasonSources} enableOfficialSearch={enableOfficialSearch} /></TripDialog>;
}

export function PlaceDescriptionToggle({ place, stayMinutes, recommendations, reasonSources, enableOfficialSearch = true }: { place: Place; stayMinutes?: number; recommendations?: string[]; reasonSources?: ReasonSource[]; enableOfficialSearch?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="place-description-toggle" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{place.name}の説明を見る</summary>
    {open && <PlaceIntroduction place={place} stayMinutes={stayMinutes} recommendations={recommendations} reasonSources={reasonSources} enableOfficialSearch={enableOfficialSearch} />}
  </details>;
}
