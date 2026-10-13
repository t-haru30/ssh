# Official facility information

`backend/app/official_place_info.py` exports `async fetch_official_place_info(place: Place) -> OfficialPlaceInfo`. It requires no API key and performs no paid requests. Wikipedia is a separate provider.

## Response contract

Nullable strings: `url`, `title`, `description`, `description_source_url`, `opening_hours`, `closed_days`, `admission`, and `checked_at`. `highlights` is a list of strings, empty by default. `status` is `verified`, `link_only`, or `unavailable`; `note` is always a string.

`verified` means the fetched HTML names the requested facility and supplies at least one extracted information or description field. It does not guarantee that all three practical fields exist or that temporary changes are reflected. Missing information stays null and the note asks the traveler to confirm it on the official website. `link_only` keeps an official URL when the page fails, names cannot be verified, or no useful information is found. `unavailable` means no matched, safely usable official URL was established.

`checked_at` is the UTC retrieval time of a name-verified HTML page. A manually reviewed seed introduction has its own `reviewed_at`, included in the response note, and never supplies a live hours timestamp. Seed descriptions have their explicit `description_source_url`; HTML meta descriptions use the fetched page URL.

## Identity and sources

1. Read `backend/app/data/official_place_sources.json` if present. A seed must match the exact place ID, its normalized full name, and a location within 500 m. Seeds are reviewed official URLs and optional short editorial descriptions, source links, and highlights.
2. Otherwise, only `osm-node-ID`, `osm-way-ID`, or `osm-relation-ID` identities are eligible. Fetch exactly one `https://api.openstreetmap.org/api/0.6/{kind}/{id}.json` response, verify its element ID/type, normalized full name, and coordinates within 500 m, then use `website` or `contact:website`.
3. Arbitrary URLs from incoming `Place.tags` are ignored. OSM `opening_hours` never becomes official-site-verified opening hours.

Standard OSM way/relation JSON often lacks coordinates or geometry. Such objects cannot pass the location check without a matched reviewed seed; the provider returns unavailable rather than spending additional geometry requests or accepting a name alone. No search engine, guessed facility URL, fuzzy name match, or Wikipedia URL is used to invent an official source.

## Fetching and parsing

Only public HTTP(S) URLs with ordinary ports are accepted. Credentials, local hostnames, private/loopback/link-local/reserved addresses, and DNS answers containing nonpublic addresses are rejected. The connection uses a validated IP address, preferring IPv4, while preserving the original HTTP Host and TLS SNI hostname. Certificate verification remains enabled. Environment proxies are disabled so they cannot bypass destination validation.

Automatic redirects are disabled. At most one explicit redirect is followed after validating its destination. The entire operation has a 12-second deadline, each request including DNS has an 8-second deadline, and there are at most four HTTP requests total: OSM, an old-domain redirect, the official home page and a visitor guide. Each decompressed response body is capped at 512 KiB, regardless of Content-Length.

HTMLParser discards scripts, styles, navigation, headers, footers, and templates from extracted facts. It honors HTTP/meta charsets, including Shift_JIS, and reads image alt text for legacy Japanese section headings. Only a name-verified page can supply practical fields or a meta-description summary of at most 300 characters. Field sections collect up to ten following lines and 300 characters, stopping at a different field; aliases within the same field remain together. Opening/visiting/receiving hours require an actual numeric time, closure information requires a day/date or substantive closure indication, and admission requires a yen amount or explicit free admission.

If a name-verified page lacks any practical field and a request slot remains, follow at most one actual same-host link labeled with a Japanese visitor-guide, opening-hours, access, or temple-visit phrase, preserving already obtained fields. Links may come from navigation, but their navigation text never becomes practical information. URLs are not guessed and external guide links are not followed. Short CMS meta labels such as "利用案内" are not facility introductions; extracted fees stop before access/address sections.

Completed name-verified HTML responses are cached for six hours by place ID, normalized name, and coordinates. Communication failures, timeouts, unknown identities, and missing URLs are not cached. Missing live fields can coexist with a separately reviewed seed description and highlights.

## Live Google Search fallback

Opening a destination detail first requests the free information above. When an official URL or any practical field is missing, the visible detail calls `POST /api/places/official-evidence` with the selected `Place`. This separate endpoint uses Gemini `generateContent` with `google_search`, the shared `GEMINI_API_KEY`, and `VENUE_EVIDENCE_ENABLED=1`. It asks for the facility's own or operating municipality's visitor guide, normal opening and final-entry times, closure exceptions, admission, and a departure-day reminder. Wikipedia and travel/review pages are excluded as requested sources of practical information.

The answer must identify the full name and cite its address and every factual paragraph through grounding metadata. For municipal facilities whose full name identifies the municipality (such as さいたま市立漫画会館), the address must identify that same municipality; their official pages need not invent coordinates. Other facilities must also supply a public position within 500 m; whenever coordinates are returned they are checked. Missing fields remain explicitly unknown. A truncated answer, mismatched facility, unsupported paragraph or unsafe/missing Search Suggestions is withheld. Byte and character citation offsets are accepted only when the supplied segment exactly equals the corresponding answer text. The view displays the answer with clickable source references, its retrieval date, an AI-summary label and Google's unmodified Search Suggestions. It offers manual Google search if live search fails.

Grounded results are kept only in the current detail component, never in the six-hour official-page cache, localStorage, saved routes, files or logs. Search links are not used as crawler input. Ordinary official-page responses above retain their independent cache. See [Google Search grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search) and [the additional terms](https://ai.google.dev/gemini-api/terms).

The official and review searches share a process-wide limit of 20 generation attempts and one active call; failures consume the budget. Each endpoint additionally allows six calls per minute per IP. No automatic retries run. A generation can perform multiple Google queries, so the generation-attempt limit is not a count of billable queries. Closing a detail aborts the browser request and hides its result; an already accepted provider call may still complete and consume quota. Browsing a card or leaving its details collapsed never triggers this search. Existing visitor-guide links remain usable while missing fields are searched separately.

TLS clients use the platform certificate store through `ssl.create_default_context()`, with certificate and hostname verification enabled, no environment proxy and no automatic redirects.

## Validation

Mock tests cover identity and seed mismatches, arbitrary incoming URLs, public/private mixed DNS, address pinning with Host/SNI, IPv4 preference, redirect bounds, same-host guide navigation, size limits, timeout and HTTP failure, cache behavior, absent fields, legacy image-alt headings and Shift_JIS, closure aliases, and misleading navigation text.

On 2026-10-12, direct live requests to the two reviewed Kanazawa museum guide pages resolved to public IPv4 `180.222.81.38` but failed with TLS `UNEXPECTED_EOF_WHILE_READING`. The provider correctly returned link_only, retained reviewed introductions and official links, and left live hours, closures, admission, and checked_at null. The live page content could therefore not be verified in that runtime; no certificate or destination protection was disabled to force access.

Later verification on the same date identified the 漫画会館 issue: OSM node `1420166452` still pointed to the former `www.city.saitama.jp` domain. OSM lookup, redirect and home page consumed the old three-call allowance before its linked visitor guide could be read. The four-call allowance and platform TLS context now reach [さいたま市の公式利用案内](https://www.city.saitama.lg.jp/004/005/002/003/001/001/1001.html); the detail showed opening hours, closure exceptions, free admission and the exact guide link without an AI search.

The separate live Gemini fallback was also exercised in the browser for さいたま市立浦和博物館. Its source link opened the city's [official FAQ](https://www.city.saitama.lg.jp/faq/001/004/002/p110779.html), where the facility/address and practical fields were manually checked against the displayed answer. Search content was not written into provider caches or logs. Backend checks passed 300 tests with zero external network attempts; frontend checks passed 239 tests and the production build.
