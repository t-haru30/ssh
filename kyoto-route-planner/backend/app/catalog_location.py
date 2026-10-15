"""Independent municipality/neighbourhood corroboration, not point geocoding."""
import re
import ssl
import unicodedata
import httpx

MUNICIPALITIES_URL = 'https://maps.gsi.go.jp/js/muni.js'
REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress'
_municipalities = {}


def address_key(value):
    value = unicodedata.normalize('NFKC', value).casefold()
    value = re.sub(r'〒?\s*\d{3}[-－]?\d{4}', '', value)
    digits = {'〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
    def number(match):
        s=match[0]
        if '十' in s:
            a,b=s.split('十')
            return str((digits.get(a,1) if a else 1)*10+(digits.get(b,0) if b else 0))
        return ''.join(str(digits[c]) for c in s)
    value = re.sub(r'[〇零一二三四五六七八九十]+(?=丁目|番地|番|号)', number, value)
    value = re.sub(r'丁目|番地|番|[‐‑–—−ー－]', '-', value).replace('号','')
    return re.sub(r'[\s,、]', '', value)


def name_key(value):
    # Preserve letters and all digits; only punctuation variants are ignored.
    return ''.join(c for c in unicodedata.normalize('NFKC',value).casefold()
                   if c.isalnum() or c == 'ー')


async def location_context(place):
    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False, verify=ssl.create_default_context()) as client:
            if not _municipalities:
                response=await client.get(MUNICIPALITIES_URL)
                response.raise_for_status()
                if len(response.content)>1_000_000: raise ValueError('Municipality response too large')
                for code,value in re.findall(r'GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*\x27([^\x27]+)\x27',response.text):
                    fields=value.split(',')
                    if len(fields)==4: _municipalities[code.zfill(5)]=(fields[1],fields[3])
            response=await client.get(REVERSE_URL,params={'lat':place.latitude,'lon':place.longitude})
            response.raise_for_status()
            if len(response.content)>100_000: raise ValueError('Reverse response too large')
            result=response.json().get('results',{})
            region,city=_municipalities.get(str(result.get('muniCd','')).zfill(5),('',''))
            area=result.get('lv01Nm','')
            if not region or not city or not isinstance(area,str) or len(area)<2: return None
            return {'prefecture':region,'city':city,'neighbourhood':area,
                    'source_url':str(response.url),'municipalities_source':MUNICIPALITIES_URL}
    except (httpx.HTTPError,OSError,ValueError,TypeError,AttributeError):
        return None


def corroborates(address, context):
    if not context: return False
    value=address_key(address)
    prefecture=address_key(context['prefecture'])
    city=address_key(context['city'])
    area=address_key(context['neighbourhood'])
    # Keep chome numbers: matching a whole city or a broad town is insufficient.
    if len(area)<2: return False
    if value.startswith(prefecture): value=value[len(prefecture):]
    if not value.startswith(city): return False
    rest=value[len(city):]
    rest=re.sub(r'^(?:大字|字)', '', rest)
    area=re.sub(r'^(?:大字|字)', '', area)
    if not rest.startswith(area): return False
    tail=rest[len(area):]
    # A concrete block/lot is required; avoid a neighbourhood-only candidate.
    return bool(re.match(r'^-?\d', tail))
