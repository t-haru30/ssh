"""Stage and audit 50 NEW, source-backed visitor facilities per prefecture.

Reads cached Overpass responses, never guesses coordinates, never writes a
partial catalog. --apply requires all 47 prefectures to have 50 valid additions.
"""
import argparse
from collections import Counter
import csv
from datetime import datetime, UTC
import json
import math
from pathlib import Path
import re
import unicodedata
from shapely.geometry import Point, shape
from shapely.prepared import prep
from generate_prefecture_routes import AREAS, STATIONS
from types import SimpleNamespace
from app.facility_quality import chain

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.runtime/catalog-expansion-sources'
MASTER = ROOT / 'backend/app/data/facility_catalog.json'
BATCH = 'prefecture-50-v1'
HUBS = {'北海道','宮城県','東京都','千葉県','神奈川県','石川県','長野県','静岡県','愛知県','京都府','大阪府','兵庫県','奈良県','広島県','福岡県','沖縄県'}

def normalized(name):
    return re.sub(r'[\s・･\-—（）()]', '', unicodedata.normalize('NFKC', name).casefold())

def distance(a, b):
    return math.hypot((a['latitude']-b['latitude'])*111,
                      (a['longitude']-b['longitude'])*111*math.cos(math.radians(a['latitude'])))

def category(tags, name):
    if tags.get('amenity') == 'restaurant': return '飲食店'
    if tags.get('amenity') == 'cafe': return 'カフェ'
    if '水族館' in name: return '水族館'
    tourism = tags.get('tourism')
    if tourism == 'museum': return '美術館' if '美術' in name else '博物館'
    if tourism in {'zoo','aquarium','theme_park','gallery'}:
        return {'zoo':'動物園','aquarium':'水族館','theme_park':'テーマパーク','gallery':'美術館'}[tourism]
    if tags.get('historic') == 'castle': return '史跡'
    if tags.get('amenity') == 'place_of_worship' or re.search(r'(神社|神宮|大社|寺)$', name): return '寺社'
    if tags.get('leisure') in {'park','garden'}: return '公園・庭園'
    return '観光名所'

def reject(tags, name):
    if not name or len(name) > 100: return '名称不足'
    if any(k.startswith(('disused:', 'abandoned:', 'demolished:', 'razed:')) for k in tags): return '休廃止の可能性'
    if any(tags.get(k) == 'yes' for k in ['disused','abandoned','demolished','construction']): return '休廃止・工事中'
    if tags.get('access') in {'private','no','customers'}: return '一般公開不明'
    if tags.get('entrance') or tags.get('historic') in {'memorial','monument','wayside_cross','wayside_shrine'}: return '入口・記念物'
    food = tags.get('amenity') in {'restaurant','cafe'}
    if food and chain(SimpleNamespace(name=name,category='飲食店',tags=tags)): return 'チェーン・支店候補'
    if tags.get('tourism') not in {'museum','attraction','zoo','aquarium','theme_park','gallery'} and tags.get('historic') != 'castle' and not food and not ((tags.get('amenity')=='place_of_worship' or tags.get('leisure') in {'park','garden'}) and (tags.get('wikidata') or tags.get('wikipedia'))): return '分類対象外'
    if re.search(r'放送局|蒸気機関車|ロマン座|メルヘン交差点|空知鉄道|国立アイヌ民族博物館', name): return '公開範囲要確認・施設内展示'
    if food and re.search(r'道の駅|休憩所|喫茶室|ラウンジ|大学|生活協同組合|学生食堂|フードブース|団体専用|レストラン$|^カフェ$|^Cafe$|^Café$|^Coffee$|^食堂$|^そば$|^喫茶$',name,re.I): return '飲食施設本体・独立営業の確認待ち'
    if not food and (re.search(r'門$',name) or name in {'大奥跡','御苑','東京ラーメンストリート'}): return '施設部分・飲食店集合'
    if tags.get('shop') and not food or tags.get('office') or tags.get('amenity') in {'school','university','hospital','parking'}: return '観光本体以外'
    if tags.get('attraction') in {'animal','animal_enclosure','roller_coaster','water_slide','amusement_ride','carousel','train','yes'}: return '園内展示・遊具'
    if any(k in tags for k in ['zoo','artwork_type','memorial','building:part']): return '施設部分・作品'
    if re.search(r'入口|出入口|入場口|料金所|案内所|案内板|撮影|フォトスポット|記念碑|石碑|歌碑|句碑|銅像|の像|鳥居|手水|狛犬|灯籠|灯篭|鐘楼|山門|楼門|拝殿|本殿|本堂|五重塔|三重塔|宝塔|長屋門|城門|天守閣|展望台|展望デッキ|動物舎|展示室|展示棟|管理棟|事務所|慰霊|慰霊碑|跡碑|説明板|メリーゴーランド|ジェットコースター|ローラーコースター|観覧車|スターバックス|タリーズ|ドトール', name): return '施設部分・眺望点・補助候補'
    return ''

def build():
    data = json.loads(MASTER.read_text(encoding='utf-8'))
    original = [p for p in data['places'] if p['tags'].get('addition_batch') != BATCH]
    known_ids = {p['id'] for p in original}
    boundary = json.loads((ROOT/'backend/data/boundaries/jpn-adm1.geojson').read_text(encoding='utf-8'))
    regions = {f['properties']['shapeISO']: prep(shape(f['geometry'])) for f in boundary['features']}
    elements = {}
    by_region = {a.code:set() for a in AREAS}
    for path in sorted(CACHE.glob('JP-*.json')):
        source = json.loads(path.read_text(encoding='utf-8'))
        if source['data'].get('remark'): raise ValueError(f'Incomplete source: {path}')
        for e in source['data']['elements']:
            identifier=f"osm-{e['type']}-{e['id']}"
            elements[identifier] = e
            by_region[path.name[:5]].add(identifier)
    # Conservative multiple-outlet screen even when brand tags are missing.
    dining_names={}
    for e in elements.values():
        t=e.get('tags',{})
        if t.get('amenity') not in {'restaurant','cafe'}:continue
        name=normalized(t.get('name:ja') or t.get('name',''))
        c=e if e['type']=='node' else e.get('center',{})
        if name and 'lat' in c:
            dining_names.setdefault(name,set()).add((round(c['lat'],2),round(c['lon'],2)))
    for e in elements.values():
        t=e.get('tags',{})
        if t.get('amenity') in {'restaurant','cafe'} and len(dining_names.get(normalized(t.get('name:ja') or t.get('name','')),()))>1:
            t['chain_screen']='multiple_locations'
    # Editorial names are scoped to prefectures; similarly named local temples
    # must never inherit a famous landmark's tier.
    landmarks = {}
    for line in (Path(__file__).parent/'catalog-landmark-targets.tsv').read_text(encoding='utf-8').splitlines():
        fields = line.split('\t')
        landmarks.setdefault(fields[0],set()).update(normalized(n) for n in fields[1].split('|'))
    additions, decisions, counts, breakdown = [], [], {}, {}
    for area in AREAS:
        prior = [p for p in original if p['region'] == area.name]
        candidates = []
        for identifier in sorted(by_region[area.code]):
            e = elements[identifier]
            if identifier in known_ids: continue
            t = e.get('tags', {})
            name = t.get('name:ja') or t.get('name', '')
            center = e if e['type'] == 'node' else e.get('center', {})
            if 'lat' not in center or 'lon' not in center: continue
            if not regions[area.code].covers(Point(center['lon'], center['lat'])): continue
            reason = reject(t, name)
            if reason:
                decisions.append({'id':identifier,'region':area.name,'name':name,'decision':'excluded','reason':reason})
                continue
            p = {'id':identifier,'name':name,'category':category(t,name),'region':area.name,
                 'address': t.get('addr:full') or ''.join(t.get(k,'') for k in ['addr:province','addr:city','addr:quarter','addr:suburb','addr:block_number']) or area.name,
                 'description':'','access_point':'座標から経路検索','latitude':center['lat'],'longitude':center['lon'],
                 'themes':['food'] if t.get('amenity') in {'restaurant','cafe'} else ['nature'] if t.get('tourism') in {'zoo','aquarium'} or t.get('leisure') in {'park','garden'} else ['temple','history'] if t.get('amenity')=='place_of_worship' else ['history'],
                 'source_record_id':f"{e['type']}/{e['id']}", 'tags':dict(t)}
            p['tags'].update(source='OpenStreetMap',source_url=f"https://www.openstreetmap.org/{e['type']}/{e['id']}",license='ODbL-1.0')
            candidates.append(p)
        def is_classic(p):
            if p['tags'].get('amenity') in {'restaurant','cafe'}:return False
            if p['name']=='榛名神社' and p['tags'].get('wikidata')!='Q3128007':return False
            return normalized(p['name']) in landmarks.get(area.name,set())
        _, station_lat, station_lon = STATIONS[area.id]
        anchors = [p for p in prior+candidates if is_classic(p) or p['tags'].get('recommendation_tier')=='classic']
        anchors.append({'latitude':station_lat,'longitude':station_lon})
        candidates.sort(key=lambda p:(-int(is_classic(p)), -int(bool(p['tags'].get('wikipedia'))),
                           -int(bool(p['tags'].get('wikidata'))), min(distance(p,a) for a in anchors), p['name'], p['id']))
        selected = []
        quotas = {'tourism':120 if area.name in HUBS else 50,'dining':80 if area.name in HUBS else 30}
        taken = Counter()
        for p in candidates:
            name = normalized(p['name'])
            duplicate = next((q for q in prior+selected if (normalized(q['name']) == name and distance(p,q) < 2)
                or (p['tags'].get('wikidata') and p['tags'].get('wikidata') == q['tags'].get('wikidata'))
                or (distance(p,q)<.3 and (name in normalized(q['name']) or normalized(q['name']) in name))), None)
            if duplicate:
                decisions.append({'id':p['id'],'region':area.name,'name':p['name'],'decision':'duplicate','reason':duplicate['id']})
                continue
            group='dining' if p['tags'].get('amenity') in {'restaurant','cafe'} else 'tourism'
            if taken[group] >= quotas[group]: continue
            classic = is_classic(p)
            reason = ('定番枠。口コミ評価を条件にしない。' if classic else '口コミ確認用の基礎候補。推薦時に評価4.2以上・50件以上を確認できた場合のみ使用。') + 'OSMの名称・分類・座標・県境・重複を照合。営業継続・営業時間は未確認'
            p['tags'].update(catalog_kind='facility',recommendation_tier='classic' if classic else 'regional',
                recommendation_status='eligible',tier_basis='prefecture-landmark-list-v1' if classic else 'osm-visitor-facility-screen-v1',
                catalog_reviewed_at='2026-10-15',source_checked_at='2026-10-15',
                source_check_scope='OSM identity/type/coordinates and prefecture boundary; not current operation or popularity',
                review_reason=reason,review_version='national-expansion-v3',addition_batch=BATCH,
                quality_policy='landmark_exempt' if classic else 'live_reviews_required')
            selected.append(p)
            taken[group]+=1
            decisions.append({'id':p['id'],'region':area.name,'name':p['name'],'decision':'added','reason':reason})
        counts[area.name] = len(selected)
        breakdown[area.name] = dict(taken)
        additions.extend(selected)
    report = {'batch': BATCH,'original_count':len(original),'added_count':len(additions),'counts':counts,'breakdown':breakdown,'decisions':decisions}
    (ROOT/'.runtime/catalog-expansion-preview.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'.runtime/catalog-expansion-places.json').write_text(json.dumps(additions,ensure_ascii=False,indent=2),encoding='utf-8')
    return data, original, additions, report

def main():
    parser = argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    data, original, additions, report = build()
    print(json.dumps(report['counts'],ensure_ascii=False), flush=True)
    print('New facilities:',len(additions),'Original:',len(original),flush=True)
    if args.apply:
        assert len(report['counts'])==47 and all(v.get('tourism',0)>=50 for v in report['breakdown'].values()), 'Incomplete prefectures; master unchanged'
        backup=CACHE/'baseline-971.json'
        if not backup.exists(): backup.write_bytes(MASTER.read_bytes())
        for p in original:
            p['tags']['quality_policy']='landmark_exempt' if p['tags'].get('recommendation_tier')=='classic' else 'live_reviews_required'
            if chain(SimpleNamespace(**p)):
                p['tags'].update(recommendation_status='excluded',review_reason='チェーン飲食店を推薦・追加対象から除外する利用者方針。既存IDは履歴のため保持')
        data['places']=original+additions
        data['generated_at']=datetime.now(UTC).isoformat()
        data['catalog_version']='independent-v3'
        MASTER.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        (ROOT/'docs/facility-expansion-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        with (ROOT/'docs/facility-expansion-review.csv').open('w',encoding='utf-8-sig',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=['id','region','name','decision','reason']);writer.writeheader();writer.writerows(report['decisions'])

if __name__=='__main__': main()
