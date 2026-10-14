"""Cache a bounded, sequential OSM tourism query per prefecture (no credentials)."""
import argparse
import json
from pathlib import Path
import ssl
import time
import httpx
from generate_prefecture_routes import AREAS, STATIONS

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.runtime' / 'catalog-expansion-sources'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', default='')
    parser.add_argument('--endpoint', default='https://overpass.private.coffee/api/interpreter')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=60, verify=ssl.create_default_context(), headers={'User-Agent': 'ConcierGO-CatalogReview/1.0 (one-off prefecture catalog audit)'}) as client:
        for area in AREAS:
            if args.only and area.id != args.only:
                continue
            path = CACHE / f'{area.code}.json'
            if path.exists():
                continue
            _, lat, lon = STATIONS[area.id]
            bbox = f'({lat-.6},{lon-.8},{lat+.6},{lon+.8})'
            query = ('[out:json][timeout:20];'
                'nwr["tourism"~"^(museum|attraction|zoo|aquarium|theme_park|gallery)$"]["name"]' + bbox + ';out center tags;')
            print('Fetching', area.name, flush=True)
            endpoint = args.endpoint
            try:
                response = client.get(endpoint, params={'data': query})
                response.raise_for_status()
                data = response.json()
                if data.get('remark') or not data.get('elements'):
                    raise ValueError(str(data.get('remark', 'Empty result'))[:200])
                path.write_text(json.dumps({'endpoint': endpoint, 'query': query, 'data': data}, ensure_ascii=False), encoding='utf-8')
                print(area.name, len(data['elements']), flush=True)
            except Exception as error:
                print(area.name, type(error).__name__, str(error).split('https://')[0][:200], flush=True)
                # End on service errors; resume from cache after reviewing the cause.
                break
            time.sleep(2)

if __name__ == '__main__':
    main()
