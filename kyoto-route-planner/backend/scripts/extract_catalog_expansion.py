"""Extract named visitor POIs, including way/relation bodies, from Geofabrik PBF."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import osmium
from shapely.geometry import Point, shape
from shapely.prepared import prep
from shapely import wkb

ROOT=Path(__file__).resolve().parents[2]
CACHE=ROOT/'.runtime/catalog-expansion-sources'
PAIRS=[('tourism',v) for v in ['attraction','museum','zoo','aquarium','theme_park','gallery']] + [('historic','castle'),('amenity','place_of_worship'),('leisure','park'),('leisure','garden'),('amenity','restaurant'),('amenity','cafe')]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pbf',type=Path,required=True);parser.add_argument('--output',type=Path,default=CACHE);args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    boundaries=json.loads((ROOT/'backend/data/boundaries/jpn-adm1.geojson').read_text(encoding='utf-8'))
    regions=[]
    for f in boundaries['features']:
        g=shape(f['geometry']);regions.append((f['properties']['shapeISO'],g.bounds,prep(g)))
    processor=osmium.FileProcessor(str(args.pbf)).with_locations('sparse_file_array')
    processor.with_areas(osmium.filter.TagFilter(*PAIRS)).with_filter(osmium.filter.TagFilter(*PAIRS))
    factory=osmium.geom.WKBFactory();buckets=defaultdict(dict);seen=0
    print('Extracting nodes, ways and relation areas',flush=True)
    for o in processor:
        tags=dict(o.tags)
        if not (tags.get('name') or tags.get('name:ja')):continue
        if tags.get('amenity')=='place_of_worship' or tags.get('leisure') in {'park','garden'}:
            if not tags.get('wikidata') and not tags.get('wikipedia'):continue
        if o.is_node():
            if not o.location.valid():continue
            typ='node';ident=o.id;lat=o.location.lat;lon=o.location.lon
        elif o.is_way():
            coords=[(n.lon,n.lat) for n in o.nodes if n.location.valid()]
            if len(coords)!=len(o.nodes) or not coords:continue
            typ='way';ident=o.id
            lon=(min(p[0] for p in coords)+max(p[0] for p in coords))/2
            lat=(min(p[1] for p in coords)+max(p[1] for p in coords))/2
        elif o.is_area() and not o.from_way():
            try:g=wkb.loads(factory.create_multipolygon(o),hex=True)
            except (RuntimeError,ValueError):continue
            west,south,east,north=g.bounds;lon=(west+east)/2;lat=(south+north)/2
            typ='relation';ident=o.orig_id()
        else:continue
        point=Point(lon,lat)
        for code,(west,south,east,north),g in regions:
            if west<=lon<=east and south<=lat<=north and g.covers(point):
                entry={'type':typ,'id':ident,'tags':tags}
                if typ=='node':entry.update(lat=lat,lon=lon)
                else:entry['center']={'lat':lat,'lon':lon}
                buckets[code][(typ,ident)]=entry
                break
        seen+=1
        if seen%5000==0:print('Processed POIs',seen,flush=True)
    for code,entries in sorted(buckets.items()):
        # Separate files preserve the initial Overpass snapshot as evidence.
        payload={'endpoint':'https://download.geofabrik.de/asia/japan-latest.osm.pbf',
                 'extract_timestamp':processor.header.get('osmosis_replication_timestamp'),
                 'data':{'elements':list(entries.values())}}
        (args.output/f'{code}-pbf.json').write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
        print(code,len(entries),flush=True)

if __name__=='__main__':main()
