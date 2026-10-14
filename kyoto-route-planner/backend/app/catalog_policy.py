"""Editorial discovery tiers, separate from freshness and storage provenance."""
import re
import json
from functools import lru_cache
from pathlib import Path

LABELS = {'classic':'定番', 'regional':'地域の見どころ', 'hidden':'穴場'}


@lru_cache(maxsize=1)
def editorial():
    data = json.loads((Path(__file__).parent/'data/facility_catalog.json').read_text(encoding='utf-8'))
    return {p['id']:p['tags'] for p in data['places']}


def metadata(place):
    return editorial().get(getattr(place, 'id', ''), place.tags)


def kind(place):
    if metadata(place).get('catalog_kind'):
        return metadata(place)['catalog_kind']
    name = place.name
    if re.search(r'から見た|撮影地点|撮影スポット|フォトスポット', name):
        return 'photo_spot'
    if re.search(r'入口|出入口|入場口', name):
        return 'entrance'
    if re.search(r'社号標|記念碑|石碑|道標|案内板|標柱', name):
        return 'monument'
    return 'facility'


def tier(place):
    return metadata(place).get('recommendation_tier', 'regional') if metadata(place).get('recommendation_tier') in LABELS else 'regional'


def recommendation_status(place):
    return metadata(place).get('recommendation_status', 'eligible')


def allowed(place, explicit=False):
    from app.facility_quality import chain
    if chain(place):
        return False
    status = recommendation_status(place)
    if status in {'excluded', 'needs_review', 'duplicate'}:
        return False
    return explicit or (status == 'eligible' and kind(place) == 'facility')


def hidden_requested(request):
    text = request.preference_text + ' ' + request.priority_text
    text = re.sub(r'穴場(?:は|を)?(?:不要|以外|避けたい)|穴場ではなく', '', text)
    return bool(re.search(r'穴場|マイナー|人が少ない|混雑を避け|静かな場所', text))


def mix(request, places):
    """6:3:1 by default, 2:3:5 for hidden-place requests; fill missing tiers."""
    groups = {key:[] for key in LABELS}
    for p in places:
        groups[tier(p)].append(p)
    order = (['hidden','regional','hidden','classic','hidden','regional','hidden','classic','hidden','regional']
             if hidden_requested(request) else
             ['classic','regional','classic','classic','hidden','classic','regional','classic','classic','regional'])
    result=[]
    while any(groups.values()):
        for key in order:
            if groups[key]:
                result.append(groups[key].pop(0))
    return result


def score(request, place):
    return ({'classic':1,'regional':2,'hidden':3} if hidden_requested(request) else {'classic':3,'regional':2,'hidden':1})[tier(place)]


def few_landmarks(request, places):
    """Use the eligible local pool, not the nationwide master, for coverage."""
    from app.discovery import max_stops
    from app.facility_quality import dining
    return sum(tier(p) == 'classic' and not dining(p) for p in places) < max(3, max_stops(request))
