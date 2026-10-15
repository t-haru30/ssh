import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from app.catalog_extraction import validate_selection
from app.catalog_url_search import citation_support
from app.official_html import Document
import json
from unittest.mock import Mock


def test_quotes_must_be_literal_complete_and_from_selected_page():
    pages = [{'url': 'https://example.org/', 'text': '喫茶店 営業時間 9:00～18:00 月曜休み'}]
    item = {'field': 'opening_hours', 'page': 0, 'quote': '営業時間 9:00～18:00'}
    got = validate_selection({'fields': [item]}, pages)
    assert got['opening_hours']['quote'] == item['quote']
    assert '喫茶店' in got['opening_hours']['context']
    for change in ({'quote': '営業時間 8:00～18:00'}, {'quote': '喫茶店'}, {'page': -1}, {'page': True}, {'field': 'name'}):
        with pytest.raises(ValueError): validate_selection({'fields': [{**item, **change}]}, pages)
    with pytest.raises(ValueError): validate_selection({'fields': [item, item]}, pages)
    assert validate_selection({'fields': []}, pages) == {}


def test_citation_requires_actual_link_not_plain_url_mention_or_host_similarity():
    official = 'https://museum.example/guide'
    cited = 'https://tourism.example/museum'
    for links, expected in (([(official, '公式サイト')], True),
                            ([('https://museum.example/other', '別のページ')], False),
                            ([], False)):
        doc = Document(lines=[official], links=links)
        with patch('app.catalog_url_search.read_page', AsyncMock(return_value=(cited, doc))):
            supported, _, proof = asyncio.run(citation_support(official, [cited]))
        assert supported is expected
        if expected: assert proof['linked_url'] == official


def test_saved_field_keeps_quote_context():
    from app.catalog_updater import decide
    from tests.test_catalog_updater import observation
    result = observation()
    result.field_evidence['opening_hours'] = {'quote': result.opening_hours, 'context': '博物館 9:00–17:00'}
    status, _, accepted, _ = decide(None, result)
    assert status == 'updated'
    assert accepted['fields']['opening_hours']['evidence']['context'].startswith('博物館')


def test_model_extracts_footer_but_cannot_invent_value():
    from app import catalog_extraction as extraction
    from app.models import Place
    from app.official_place_info import OfficialPlaceInfo
    place = Place(id='x', name='試験カフェ', category='カフェ', description='', access_point='', themes=[], latitude=35, longitude=135)
    doc = Document(title='試験カフェ', lines=['試験カフェ'], identity_text='試験カフェ 営業時間 9:00～18:00')
    result = OfficialPlaceInfo(url='https://cafe.example/', checked_at='2026-10-15T00:00:00Z', note='照合済み')
    for quote, expected in (('営業時間 9:00～18:00', 'extracted'), ('営業時間 8:00～18:00', 'failed')):
        response = Mock(content=b'{}')
        response.json.return_value = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({'fields': [{'field': 'opening_hours', 'page': 0, 'quote': quote}]})}]}}]}
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with patch.object(extraction, 'gemini_api_key', return_value='fake'), patch.object(extraction, 'location_context', AsyncMock(return_value=None)), patch.object(extraction.httpx, 'AsyncClient', return_value=client), patch('app.catalog_url_search.read_page', AsyncMock(return_value=(result.url, doc))):
            enriched = asyncio.run(extraction.enrich(place, result))
        assert enriched.extraction_trace['status'] == expected
        if expected == 'extracted': assert enriched.opening_hours == quote
        else: assert enriched.opening_hours is None


def test_identity_unverified_result_never_reaches_model():
    from app.catalog_extraction import enrich
    from app.official_place_info import OfficialPlaceInfo
    result = OfficialPlaceInfo(url='https://example.org/', note='未照合')
    with patch('app.catalog_extraction.gemini_api_key') as key:
        assert asyncio.run(enrich(None, result)) is result
        key.assert_not_called()


def test_open_ended_hours_and_whitespace_preserve_actual_source():
    pages = [{'url': 'https://cafe.example/', 'text': '営業時間 8:00~売り切れまで 土・日・祝日 11:00→15:00 入場料 700円 小中学生 100円'}]
    for field, quote in (('opening_hours', '営業時間 8:00~売り切れまで'), ('opening_hours', '土・日・祝日 11:00→15:00'), ('admission', '入場料 700円\n小中学生 100円')):
        selected = validate_selection({'fields': [{'field': field, 'page': 0, 'quote': quote}]}, pages)
        assert selected[field]['quote'] in pages[0]['text']


def test_contact_hours_do_not_become_opening_hours():
    pages = [{'url': 'https://example.org/', 'text': 'ご相談はこちら 0120-000-000 水～日/11:00～22：00 お問い合わせフォーム'}]
    with pytest.raises(ValueError, match='Contact hours'):
        validate_selection({'fields': [{'field': 'opening_hours', 'page': 0, 'quote': '水～日/11:00～22：00'}]}, pages)
