import type { Origin } from "./types";
import prefectures from "./data/routes/index.json";
import gatewayPresets from "./data/gatewayPresets.json";

export type DestinationSuggestion = { placeName: string; area: string; prefecture: string; origin: Origin };
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const identity = (origin: Origin) => `${origin.name}|${origin.latitude}|${origin.longitude}`;

/** Match known place names to real station coordinates; never invent coordinates. */
export function destinationsFromText(text: string, localOrigins: Record<string, Origin>): DestinationSuggestion[] {
  text = normalize(text);
  if (!text) return [];
  const aliases: { name: string; area: string; prefecture: string; origin: Origin }[] = [];
  function add(name: string, origin: Origin, area: string, prefecture: string) {
    name = normalize(name);
    if (name) aliases.push({ name, area, prefecture, origin: { name: origin.name, latitude: origin.latitude, longitude: origin.longitude } });
  }
  for (const entry of prefectures.prefectures) {
    const main = localOrigins[entry.id];
    if (main) {
      add(entry.name, main, entry.id, entry.name);
      add(entry.name.replace(/[都府県]$/, ""), main, entry.id, entry.name);
    }
    const stations = new Map([...((gatewayPresets.gateways as Record<string, Origin[]>)[entry.id] ?? []), ...(main ? [main] : [])].map(station => [normalize(station.name), station]));
    for (const station of stations.values()) {
      const name = station.name.replace(/[（(].*?[）)]/g, "");
      add(name, station, entry.id, entry.name);
      add(name.replace(/(?:駅|空港|バスターミナル)$/, ""), station, entry.id, entry.name);
    }
  }
  const matches: { start: number; end: number; name: string; area: string; prefecture: string; origin: Origin; departure: boolean }[] = [];
  for (const { name, origin, area, prefecture } of aliases) {
    let start = text.indexOf(name);
    while (start !== -1) {
      const end = start + name.length;
      const tail = text.slice(end);
      // One-character city names (e.g. 津) need a place particle or suffix.
      const shortName = name.length === 1 && (/\p{Script=Han}/u.test(text[start - 1] ?? "") || !/^(?:市|駅|から|へ|に|で|を|周辺|付近)/.test(tail));
      const avoided = /^[」』"')]*(?:市|駅|県|府|都)?(?:に|へ|は|には|では|を)?(?:行かない|行きたくない|寄らない|避け|以外|じゃなく|ではなく)/.test(tail);
      if (!shortName && !avoided) {
        const departure = /^(?:市|駅|県|府|都)?(?:から|発(?:で|の|は|、|。|$)|を出発)/.test(tail)
          || /出発(?:地点|地)?(?:は|を|:)?$/.test(text.slice(Math.max(0, start - 12), start));
        matches.push({ start, end, name, area, prefecture, origin, departure });
      }
      start = text.indexOf(name, start + 1);
    }
  }
  // 東京都 contains 京都; a complete longer name takes precedence at that position.
  const complete = matches.filter(match => !matches.some(other => other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
  const found = new Map<string, DestinationSuggestion>();
  // A named departure (e.g. 名古屋から金沢へ) is not the sightseeing destination.
  for (const match of complete.filter(match => !match.departure).sort((a, b) => a.start - b.start || b.name.length - a.name.length)) {
    if (!found.has(identity(match.origin))) found.set(identity(match.origin), { placeName: match.name, area: match.area, prefecture: match.prefecture, origin: match.origin });
  }
  return [...found.values()];
}
