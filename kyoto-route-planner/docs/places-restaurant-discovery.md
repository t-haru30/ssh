# Dining discovery

When meals are requested, `/api/discover` searches Google Places around the
gateway (popularity/distance within 1.5 km and popularity within 6 km), plus up to
two separate regional-food queries. Explicit regeneration rotates distinct local
dishes without increasing the five-call ceiling. Kyoto hints include
京料理・湯豆腐・おばんざい・湯葉・にしんそば; other locations use the regional
hints in `regional_food.py`, or a generic 郷土料理 query. Search terms are hints,
not evidence that an individual restaurant serves a particular menu.

Search is centred on the sightseeing arrival point, within 6 km or the user's
smaller radius. Up to five Google requests run in parallel, each consumes one unit
of the existing shared `GOOGLE_PLACES_MONTHLY_LIMIT` (default 300). There is no
pagination, automatic Google retry or background collection. An unset key,
disabled `GOOGLE_RESTAURANTS_ENABLED`, timeouts or exhausted quota leave the
existing providers and offline catalog usable. These requests ask for identity,
position, type and business status, without reviews or summaries.

The independently queried OSM restaurant data supplies savable names,
coordinates, address fields and cuisine tags. The existing, independently licensed
OpenPOI supplement can also be matched against these request-local Google results,
so Overpass failure does not prevent verification of other already acquired venues.
OpenPOI identity, coordinates and attribution remain unchanged. Matching uses complete name/alias
and location checks, with ambiguous branches rejected. Closed/temporarily closed
or cafe-only matches cannot enter the meal pool. If exact cross-source matches
are sparse, unmatched OSM rows are not added, since their positions/names may be
outdated. The original catalog remains the fallback. The selected prefecture is checked against OSM coordinates and
the existing boundary dataset; neighbouring-prefecture OSM candidates already
supplied by other providers retain the existing cross-prefecture rules.

Runtime prefecture polygons are bundled in `backend/app/data/prefecture_boundaries.json`
(ODbL 1.0, geoBoundaries JPN ADM1; largest landmass, simplified at 0.00005 degrees).
Rebuild with `python -m scripts.build_runtime_boundaries` from the documented development
boundary input. Production needs neither development scripts nor the 62 MB raw input.

Only OSM records are cached (six hours, 64 entries, `osm_restaurants.sqlite3`).
Docker sets `OSM_RESTAURANTS_CACHE_PATH` to the writable `/tmp/conciergo` directory.
Each public Overpass endpoint is bounded to six seconds. Indexed bounding boxes
reduce query work; every result still passes exact radius and prefecture checks.
If both are unavailable,
independently acquired OSM seed records are filtered to the requested radius and
prefecture. Seeds do not bypass the fresh Google identity/location/business-status
match. Unavailable Google and unavailable OSM are distinguishable in diagnostics;
logs contain candidate counts, never keys, precise origins or personal preferences.
Google response content is request-local and never enters OSM storage,
recommendation caches/prompts, reviews or saved journeys. Existing Google detail
and photo views retrieve their display information on demand, with attribution.
The response catalog diagnostics separately count total, added and matched
restaurants. Newly added restaurants are matched; the original offline catalog
is not labelled as newly verified by this lookup.

After AI selection, the application balances dining reuse and rechecks each
replacement against meal times, meal counts, radius, prefecture and trip duration.
Grounded regional cuisine and regional-query matches rank first, followed by
new dining venues and different chain brands before repetitions. Viewed meal IDs in the current browsing
session are a soft penalty on regeneration. The original deck is not mutated.
The client also favours a new meal venue when choosing the next card.

Regional food is evaluated across the deck, so a single specialty venue is not
forced into every alternative. A search match never becomes a claim about a
specific dish. Venue details remain the place to check actual menus and hours.
The initial deterministic composer also balances meal reuse, rather than forcing
one specialty venue into every seed and collapsing a half-day deck to one route.
Ice-cream/confectionery-only venues cannot satisfy lunch or dinner.
When at least three independently sourced meal venues have fresh Places matches,
feasible matched venues rank ahead of unverified shops. Sparse matches keep the
original fallback pool available instead of reducing the deck to one restaurant.

The bundled fallback contains 3,218 independently acquired OSM restaurant records
around Kyoto, Morioka, Kanazawa and Gifu, acquired on 2026-10-14 under ODbL 1.0.

References:

- [Places Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search)
- [Places Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Places storage and attribution policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Kyoto City Tourism Association food guidance](https://global.kyoto.travel/ja/faq/detail.php?faq_id=4016)
- [Morioka tourism association's three noodles](https://www.odette.or.jp/?page_id=5192)
- [Kanazawa tourism association's local cuisine](https://www.kanazawa-kankoukyoukai.or.jp/article/detail_36.html)
- [Gifu tourism association's station-area cuisine](https://www.gifucvb.or.jp/sightseeing/food_02.php)
