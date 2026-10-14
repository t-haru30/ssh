/** Build redistributable OSM catalogs without opening a database or calling an API. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const license = {
  name: "ODbL-1.0", url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors", source: "https://www.openstreetmap.org/copyright",
};
const themes = new Set(["all", "history", "temple", "nature", "food"]);
const osmTagKeys = new Set(["name:ja", "name:en", "official_name", "amenity", "cuisine", "website", "contact:website", "wikipedia", "wikidata"]);
// Reviewed removals: closed venues and a direction stone mistaken for the shrine.
const excludedPlaces = new Set(["osm-node-1897894350", "osm-node-1177156758", "osm-node-11174591021"]);

function validateSpot(spot) {
  if (excludedPlaces.has(spot.place_id) || /廃業|閉業|閉館|営業終了|休業中/.test(spot.name ?? "")) {
    throw new Error("Public data contains a closed or misidentified facility; review the route source");
  }
  if (!/^osm-(node|way|relation)-\d+$/.test(spot.place_id ?? "") || !spot.name || !spot.category
    || !Number.isFinite(spot.lat) || Math.abs(spot.lat) > 90
    || !Number.isFinite(spot.lng) || Math.abs(spot.lng) > 180) {
    throw new Error("Public data contains an invalid or non-OSM place");
  }
}

export async function buildPublicData(sourceDir, outputDir) {
  const index = JSON.parse(await readFile(path.join(sourceDir, "index.json"), "utf8"));
  if (index.version !== 1 || index.prefectures?.length !== 47) throw new Error("Expected 47 prefectures");
  const datasets = [];
  const catalog = new Map();
  const ideas = [];
  const codes = new Set();
  for (const entry of index.prefectures) {
    if (!/^[a-z]+$/.test(entry.id) || entry.file !== `${entry.id}.json`
      || !/^(0[1-9]|[1-3]\d|4[0-7])$/.test(entry.prefecture_code) || codes.has(entry.prefecture_code)) {
      throw new Error("Invalid prefecture index");
    }
    codes.add(entry.prefecture_code);
    const dataset = JSON.parse(await readFile(path.join(sourceDir, entry.file), "utf8"));
    if (dataset.version !== 1 || dataset.area !== entry.id
      || !dataset.generator_version?.startsWith("osm-deterministic-")
      || !dataset.routes?.length || dataset.routes.length !== entry.route_count) {
      throw new Error(`Unverified route provenance: ${entry.id}`);
    }
    for (const route of dataset.routes) {
      if (!themes.has(route.theme) || route.spots.length < 2) throw new Error("Invalid route theme or stops");
      for (const spot of route.spots) {
        // An explicit empty lunch slot is application-authored, not a real facility.
        if (spot.role === "lunch" && spot.category === "要検討" && spot.name === "昼食: 要検討"
          && new RegExp(`^lunch-undetermined-${entry.id}-\\d+$`).test(spot.place_id)) continue;
        validateSpot(spot);
        const existing = catalog.get(spot.place_id);
        if (existing) {
          if (existing.name !== spot.name || existing.latitude !== spot.lat || existing.longitude !== spot.lng) {
            throw new Error(`Inconsistent OSM place: ${spot.place_id}`);
          }
          if (!existing.themes.includes(route.theme)) existing.themes.push(route.theme);
        } else {
          const [, kind, id] = spot.place_id.split("-");
          catalog.set(spot.place_id, {
            id: spot.place_id, name: spot.name, category: spot.category,
            region: entry.name, address: entry.name, description: "",
            access_point: "座標から経路検索", latitude: spot.lat, longitude: spot.lng,
            themes: [route.theme], source_record_id: `${kind}/${id}`,
            tags: { ...Object.fromEntries(Object.entries(spot.tags ?? {}).filter(([key, value]) => osmTagKeys.has(key) && typeof value === "string")),
              source: "OpenStreetMap", source_url: `https://www.openstreetmap.org/${kind}/${id}`, license: license.name },
          });
        }
      }
      const realSpots = route.spots.filter(spot => catalog.has(spot.place_id));
      const stops = realSpots.filter(spot => spot.role !== "lunch");
      const picked = (stops.length >= 2 ? stops : realSpots).slice(0, 3);
      if (picked.length < 2) throw new Error("A public idea needs at least two verified facilities");
      ideas.push({
        theme: route.theme, prefecture_code: entry.prefecture_code, prefecture_name: entry.name,
        title: route.title, story: `${picked.map(spot => spot.name).join("、")}を訪ねる旅の候補です。`,
        places: picked.map(spot => {
          const place = catalog.get(spot.place_id);
          return { ...place, themes: [...place.themes] };
        }),
        image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
        copywriting_source: "fallback", note: "OpenStreetMapを加工した事前候補です。営業時間・移動時間・料金は未確認です。",
      });
    }
    datasets.push(dataset);
  }
  const places = [...catalog.values()];
  const metadata = { version: 1, generated_at: index.generated_at, license };
  const files = {
    "osm-routes.json": { ...metadata, index, datasets },
    "osm-ideas.json": { ...metadata, ideas },
    "osm-places.json": { ...metadata, places },
  };
  // Validate everything before writing, so rejected data does not replace a usable catalog.
  const encoded = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, JSON.stringify(value, null, 2) + "\n"]));
  const manifest = {
    ...metadata, prefecture_count: codes.size, route_count: ideas.length, place_count: places.length,
    sources: datasets.map(dataset => ({ area: dataset.area, generated_at: dataset.generated_at, generator_version: dataset.generator_version })),
    files: Object.entries(encoded).map(([name, bytes]) => ({ name, sha256: createHash("sha256").update(bytes).digest("hex") })),
  };
  await mkdir(outputDir, { recursive: true });
  for (const [name, bytes] of Object.entries(encoded)) await writeFile(path.join(outputDir, name), bytes);
  await writeFile(path.join(outputDir, "osm-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildPublicData(path.join(frontend, "src/data/routes"), path.join(frontend, "public/data"));
  console.log(`Public OSM data: ${manifest.prefecture_count} prefectures, ${manifest.route_count} routes, ${manifest.place_count} places`);
}
