"""Request-local review gate. Google ratings never enter catalog/AI/storage.

Editorial landmarks are exempt from ratings, but dining chains never are.
Missing, ambiguous, stale/unavailable review evidence is not a positive signal.
"""
import asyncio
import logging
import math
import re
import ssl
import httpx
from app.catalog_policy import tier, mix, few_landmarks

MIN_RATING = 4.2
MIN_REVIEWS = 50
logger = logging.getLogger(__name__)
CHAIN = re.compile(r'スターバックス|starbucks|タリーズ|tully|ドトール|doutor|マクドナルド|mcdonald|モスバーガー|バーガーキング|ケンタッキー|kfc|コメダ|星乃珈琲|サンマルク|上島珈琲|プロント|pronto|エクセルシオール|カフェベローチェ|カフェ・ベローチェ|珈琲館|ガスト|サイゼリヤ|ジョイフル|joyfull|ロイヤルホスト|デニーズ|びっくりドンキー|ココス|バーミヤン|ジョナサン|夢庵|藍屋|やよい軒|大戸屋|和食さと|すき家|吉野家|松屋|松のや|なか卯|丸亀製麺|はなまるうどん|リンガーハット|餃子の王将|大阪王将|日高屋|幸楽苑|天下一品|一蘭|一風堂|来来亭|山岡家|スシロー|くら寿司|かっぱ寿司|はま寿司|魚べい|にぎり長次郎|がんこ|木曽路|和民|鳥貴族|魚民|白木屋|笑笑|や台ずし|CoCo壱番屋|カレーハウスCoCo|ゴーゴーカレー|ミスタードーナツ|サーティワン|クリスピークリーム|サブウェイ|subway|ドミノ|ピザハット|ピザーラ|ほっともっと|ほっかほっか亭|オリジン|牛角|焼肉きんぐ|安楽亭|ステーキガスト|いきなり.?ステーキ|ブロンコビリー|宮本むなし|まいどおおきに|さち福や|串家物語|さわやか|五味八珍|フライングガーデン|ホリーズカフェ|ビリオン珈琲', re.I)

def dining(place):
    return place.tags.get('amenity') in {'restaurant','cafe','fast_food','food_court','bar','pub'} or any(w in place.category for w in ['飲食','カフェ','レストラン','食堂','料理','喫茶'])

def chain(place):
    return dining(place) and bool(place.tags.get('brand') or place.tags.get('brand:wikidata') or CHAIN.search(place.name)
        or EXTRA_CHAIN.search(place.name) or place.tags.get('chain_screen')=='multiple_locations'
        or re.search(r'支店|フランチャイズ|分店|本店|総本店|[0-9０-９]+号店|\s+\S+店$', place.name))

# Regional chains and romanized brands also occur without OSM brand metadata.
EXTRA_CHAIN = re.compile(r'矢場とん|味仙|どんどん庵|勢川|住よし|竹葉亭|嘉文|稲生|五右衛門|キハチ|寅福|電光石火|アマンド|鳥開|Torikai|Soup.Stock|名古屋備長|トラジ|山本屋|Yamamotoya|よもだそば|やっぱりステーキ|AMANDA.COFFEE|ばんどう太郎|神戸屋|TETSU|サザコーヒー|味の民芸|めしや|キャナリィ|ミスター.?バーク|赤から|かつ庵|長崎ちゃんめん|ぶっかけ.ふるいち|廣榮堂|ゴンチャ|Gong.?cha|くらしき桃子|もつ鍋おおやま|あじとや|中村麵兵衛|金沢まいもん|ぴょんぴょん舎|おっぺしゃん|をかしら屋|スガキヤ|平家の郷|シアトルズベスト|Seattle.s.Best|豊吉うどん|らくい|花月嵐|半田屋|鎌倉パスタ|ぼんたぼんた|スイーツパラダイス|利久|粥餐庁|はやし田|ポムの[樹木]|たんや.?善治郎|仙台っ子|鶴橋風月|そばの神田|すた丼|まるまつ|ホシヤマ|田所商店|イタリアントマト|かつくら|デリーモ|一幸[舎舍]|大勝軒|ラーメン東大|ナナズ.?グリーン|福寿園|麺家いろは|麺屋はなび|都野菜賀茂|小川珈琲|東洋亭|サルヴァトーレ|為治郎|京都勝牛|パンとエスプレッソ|牛禅|マールブランシュ|桂花ラーメン|味千|白玉屋新三郎|油そば専門店.?兎|花山うどん|甘味処.?鎌倉|焼肉ふるさと|SOUP.CURRY.KING|CITY.BAKERY|シティ.?ベーカリー|銀座ライオン|マルコリーニ|ムレスナ|ばくだん屋|SHIMAUMA|good.spoon|うのまち珈琲|弁兵衛|としのや|Cat.Cafe.MOFF|五エ門|讃岐屋|三田製麺|杉玉|杵屋|そじ坊|ラーメン麺王|こだわり麺や|明神丸|佐嘉平川屋|ビスヌ|山田うどん|馬車道|青木亭|いろり庵|豚山|山下本気うどん|回転寿司みさき|萬力屋|昭和食堂|鳥放題|はなの舞|豊丸水産|Vie.de.France|温野菜|カルビ大陸|新宿さぼてん|東京油組|四文屋|小作|ちゃんぽん亭|秋吉|丼丸|Colorado.Coffee|ふぁみり庵|ふく福|Nabeshima|いちにいさん|吹上庵|ざぼんラーメン|本家あべや|寛文五年堂|ナガハマコーヒー|牛玄亭|きりたんぽ屋|無尽蔵|韓激|とんかつ政ちゃん|目利きの銀次|富寿し|いかの墨|きんしゃい亭|焼肉ロッヂ|ぜんてい|不二家|クア.?アイナ|Granny.Smith|Dick.Bruna|chano.ma|Merengue|La.Cocorico|\bbills\b|レッドロブスター|ハングリータイガー|崎陽軒|パパミラノ|もうやんカレー|DALIAN|Afternoon.Tea|アフタヌーンティー|天丼てんや|魚がし鮨|かに本家|すみの坊|高田屋|[８8]番らーめん|すし玉|菜香[樓楼]|すし食いねぇ|HUM&Go|ウエスト|まこと屋|磯丸水[産產]|博多劇場|鳥メロ|とり鉄|こめらく|でんがな|銀のさら|ずんどう屋|ポケモンカフェ|デリフランス|サラベス|ワイヤード|からふね屋|串かつ.*だるま|つるとんたん|四六時中|Mother.Moon|マザームーン|北極星|ハーブス|じゅうじゅうカルビ|ちりめん亭|竹風堂|桜井甘精堂|中華食堂.?一番館|どさん子|築地日本海|すなば珈琲|魚鮮水産|うかい|カービィ|梅園|精養軒|たいめいけん|ジョエル.?ロブション|ソラノイロ|ほぉ.?むカフェ|蒙古タンメン|妻家房|フォルクス|今半|雲林坊|ムーミンカフェ|PAOPAO|鳥麻|茶和々|宇都宮みんみん|宇都宮餃子館|Di.PUNTO|まほろば大仏プリン|MOMI.?TOY|氷見きときと|麺屋つくし|テジカエン|五目亭|ユトリ珈琲|酔灯屋|アバシ|濱かつ|Rec.Coffee|ShinShin|幸ちゃんラーメン|楽天地|益正|梅の花|はかたや|ハニー珈琲|スパゲッティーのパンチョ|Holly.s.Cafe|にしむら珈琲|Dipper.Dan|希望軒|UCC.Cafe|三豊麺|珉珉|オスロコーヒー|トゥーストゥース|神座|宮越屋|みよしの|五丈原|根室花まる|四季花まる|ファイヤーバーグ|串鳥|味の時計台|ピカンティ|よし乃|Curry.Samurai|吉山商店|カフェクロワッサン', re.I)

def passes_reviews(item):
    rating, count = item.get('rating'), item.get('userRatingCount')
    return (type(rating) in (int,float) and math.isfinite(rating) and MIN_RATING <= rating <= 5
        and type(count) is int and count >= MIN_REVIEWS and item.get('businessStatus')=='OPERATIONAL')

def select_reviewed(candidates, google):
    from app.google_place_photos import same_google_venue
    def matches(p,item):
        try:
            return isinstance(item,dict) and isinstance(item.get('id'),str) and same_google_venue(p,item)
        except (ValueError,TypeError,KeyError,AttributeError):return False
    selected=[]
    for p in candidates:
        if chain(p): continue
        matched={item.get('id'):item for item in google if matches(p,item)}
        if any(item.get('businessStatus') in {'CLOSED_PERMANENTLY','CLOSED_TEMPORARILY'} for item in matched.values()):
            continue
        if tier(p)=='classic' and not dining(p):
            selected.append(p);continue
        if len(matched)==1 and passes_reviews(next(iter(matched.values()))): selected.append(p)
    return tuple(selected)

async def filter_quality(request, candidates, existing_google=()):
    from app.google_place_photos import BASE,google_api_key,reserve_lookup
    from app.discovery import distance_km,eligible_candidates
    nearby=tuple(p for p in eligible_candidates(request,candidates) if not chain(p))
    if not any(tier(p)!='classic' or dining(p) for p in nearby):
        selected=select_reviewed(nearby,existing_google)
        return selected, {'status':'landmarks_only','verified_count':0,'excluded_count':len(candidates)-len(selected)}
    key=google_api_key();google=list(existing_google);success=bool(existing_google)
    if key:
        center={'latitude':request.origin.latitude,'longitude':request.origin.longitude}
        async def search(client, kinds):
            if not reserve_lookup(): return []
            try:
                r=await client.post(BASE+'/places:searchNearby',headers={'X-Goog-Api-Key':key,
                    'X-Goog-FieldMask':'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.businessStatus'},
                    json={'includedTypes':kinds,'maxResultCount':20,'rankPreference':'POPULARITY','languageCode':'ja',
                        'locationRestriction':{'circle':{'center':center,'radius':min(request.radius_km*1000,50000)}}})
                if r.status_code!=200:
                    logger.warning('Quality lookup HTTP status=%d',r.status_code);return []
                if len(r.content)>200000:return []
                value=r.json()
                return value.get('places',[]) if isinstance(value,dict) and isinstance(value.get('places',[]),list) else []
            except (httpx.HTTPError,ValueError):return []
        kinds=[['tourist_attraction','museum','park','zoo','aquarium','amusement_park']]
        if request.meals!=[]:kinds.append(['restaurant','cafe'])
        async with httpx.AsyncClient(timeout=10,trust_env=False,verify=ssl.create_default_context()) as client:
            groups=await asyncio.gather(*(search(client,k) for k in kinds))
            google.extend(p for group in groups for p in group)
            # Popularity results may omit local sights. In sparse landmark areas,
            # verify regional/hidden candidates by name too; never waive reviews.
            selected_now=select_reviewed(nearby,google)
            selected_ids={p.id for p in selected_now}
            food=sorted((p for p in nearby if dining(p)),key=lambda p:(-bool(p.tags.get('wikipedia')),distance_km(request.origin,p),p.id)) if request.meals!=[] and not any(dining(p) for p in selected_now) else []
            sights=mix(request, sorted((p for p in nearby if not dining(p) and tier(p)!='classic' and p.id not in selected_ids),key=lambda p:(distance_km(request.origin,p),p.id))) if few_landmarks(request,nearby) else []
            # Round-robin tiers gives hidden sights a chance within the small budget.
            regional=[p for p in sights if tier(p)=='regional']
            hidden=[p for p in sights if tier(p)=='hidden']
            groups=[g for g in (food,regional,hidden) if g]
            shortlist=[]
            while groups and len(shortlist)<6:
                for group in groups:
                    if group and len(shortlist)<6:shortlist.append(group.pop(0))
                groups=[g for g in groups if g]
            if shortlist:
                slots=asyncio.Semaphore(3)
                async def exact(p):
                    if not reserve_lookup():return []
                    async with slots:
                        try:
                            r=await client.post(BASE+'/places:searchText',headers={'X-Goog-Api-Key':key,
                                'X-Goog-FieldMask':'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.businessStatus'},
                                json={'textQuery':p.name+' '+p.region,'languageCode':'ja','pageSize':3,
                                    'locationBias':{'circle':{'center':{'latitude':p.latitude,'longitude':p.longitude},'radius':500}}})
                            if r.status_code!=200 or len(r.content)>80000:return []
                            d=r.json();return d.get('places',[]) if isinstance(d,dict) and isinstance(d.get('places',[]),list) else []
                        except (httpx.HTTPError,ValueError):return []
                direct=await asyncio.gather(*(exact(p) for p in shortlist))
                google.extend(p for group in direct for p in group)
                groups.extend(direct)
        success=any(groups) or bool(existing_google)
    selected=select_reviewed(nearby,google)
    # Only aggregate status crosses the request boundary, not provider ratings.
    verified=sum(tier(p)!='classic' or dining(p) for p in selected)
    return selected, {'status':'ready' if success else 'reviews_unavailable','verified_count':verified,
                      'excluded_count':len(nearby)-len(selected),'minimum_rating':MIN_RATING,'minimum_reviews':MIN_REVIEWS}
