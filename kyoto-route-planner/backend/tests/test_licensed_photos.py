import asyncio
import copy
import ssl
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import licensed_photos as photos


def file_page(description="明行寺の外観", latitude=36.654, longitude=138.1894):
    return {"ns": 6, "title": "File:Temple.jpg", "coordinates": [{"lat": latitude, "lon": longitude, "globe": "earth"}],
            "imageinfo": [{"url": "https://upload.wikimedia.org/test/Temple.jpg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:Temple.jpg", "mime": "image/jpeg",
                           "metadata": [{"name": name, "value": value} for name, value in (("Make", "Canon"), ("Model", "EOS"), ("DateTimeOriginal", "2020:01:01 12:00:00"))],
                           "extmetadata": {"ImageDescription": {"value": description}, "Artist": {"value": "Alice"}, "LicenseShortName": {"value": "CC BY-SA 4.0"}, "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"}}}]}


def claim(value, rank="normal"):
    return {"rank": rank, "mainsnak": {"snaktype": "value", "datavalue": {"value": value}}}


def entity():
    return {"id": "Q123", "labels": {"ja": {"value": "明行寺"}}, "claims": {
        "P625": [claim({"latitude": 36.654, "longitude": 138.1894, "globe": "http://www.wikidata.org/entity/Q2", "precision": .00001})],
        "P18": [claim("Temple.jpg")]}}


def client_with(*payloads):
    client = AsyncMock()
    client.get.side_effect = [httpx.Response(200, json=data) for data in payloads]
    return client


class LicensedPhotoTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_commons_search_and_geosearch_need_subject_and_position(self):
        for geo in (False, True):
            client = client_with({"query": {"pages": [file_page()]}})
            image = await photos._commons(client, "明行寺", 36.654, 138.1894, geo=geo)
            self.assertEqual(image.provider, "commons")
            self.assertTrue(image.photo_evidence)
            args = client.get.call_args
            self.assertEqual(args.args[0], photos.COMMONS_API)
            self.assertEqual(args.kwargs["params"]["generator"], "geosearch" if geo else "search")

    async def test_direct_search_does_not_use_nearby_wrong_name_missing_gps_or_view_from(self):
        for mutate in ("name", "far", "missing", "other_globe", "view_from", "nearby", "conflicting"):
            page = file_page()
            if mutate == "name": page["imageinfo"][0]["extmetadata"]["ImageDescription"]["value"] = "別の寺の外観"
            if mutate == "far": page["coordinates"][0]["lat"] = 34.7
            if mutate == "missing": page.pop("coordinates")
            if mutate == "other_globe": page["coordinates"][0]["globe"] = "moon"
            if mutate == "view_from": page["imageinfo"][0]["extmetadata"]["ImageDescription"]["value"] = "明行寺から見た別の寺の外観"
            if mutate == "nearby": page["imageinfo"][0]["extmetadata"]["ImageDescription"]["value"] = "A building near 明行寺"
            if mutate == "conflicting": page["coordinates"].append({"lat": 34, "lon": 135, "globe": "earth"})
            self.assertIsNone(await photos._commons(client_with({"query": {"pages": [page]}}), "明行寺", 36.654, 138.1894, geo=True), mutate)

    async def test_wikidata_p18_works_without_japanese_article_or_file_gps(self):
        page = file_page("Myogyo Temple")
        page.pop("coordinates")
        client = client_with({"search": [{"id": "Q123"}]}, {"entities": {"Q123": entity()}}, {"query": {"pages": [page]}})
        image = await photos._wikidata(client, "明行寺", 36.654, 138.1894)
        self.assertEqual(image.provider, "wikidata")
        self.assertTrue(image.photo_evidence)
        self.assertEqual([call.args[0] for call in client.get.call_args_list], [photos.WIKIDATA_API, photos.WIKIDATA_API, photos.COMMONS_API])
        self.assertEqual(client.get.call_args.kwargs["params"]["titles"], "File:Temple.jpg")

    async def test_same_name_entity_elsewhere_and_id_mismatch_never_fetch_images(self):
        for mutation in ("name", "position", "id", "precision", "globe", "deprecated", "conflicting"):
            item = entity()
            coord = item["claims"]["P625"][0]["mainsnak"]["datavalue"]["value"]
            if mutation == "name": item["labels"]["ja"]["value"] = "別の寺"
            if mutation == "position": coord["latitude"] = 34.735
            if mutation == "id": item["id"] = "Q456"
            if mutation == "precision": coord["precision"] = .1
            if mutation == "globe": coord["globe"] = "http://www.wikidata.org/entity/Q111"
            if mutation == "deprecated": item["claims"]["P625"][0]["rank"] = "deprecated"
            if mutation == "conflicting": item["claims"]["P625"].append(claim({**coord, "latitude": 34.735}))
            client = client_with({"search": [{"id": "Q123"}]}, {"entities": {"Q123": item}})
            self.assertIsNone(await photos._wikidata(client, "明行寺", 36.654, 138.1894), mutation)
            self.assertEqual(client.get.await_count, 2)

    async def test_p18_exact_file_and_conflicting_file_gps_required(self):
        for mutation in ("filename", "gps", "portrait", "generated", "map", "license", "host", "author"):
            page = file_page()
            info = page["imageinfo"][0]
            if mutation == "filename": page["title"] = "File:Other.jpg"; info["descriptionurl"] = "https://commons.wikimedia.org/wiki/File:Other.jpg"
            if mutation == "gps": page["coordinates"][0]["lat"] = 34
            if mutation in ("portrait", "generated", "map"): info["extmetadata"]["ImageDescription"]["value"] = {"portrait": "明行寺 portrait photo", "generated": "明行寺 AI-generated photo", "map": "明行寺の地図"}[mutation]
            if mutation == "license": info["extmetadata"]["LicenseShortName"]["value"] = "CC BY-NC 4.0"
            if mutation == "host": info["url"] = "https://upload.wikimedia.org.evil.test/p.jpg"
            if mutation == "author": info["extmetadata"].pop("Artist")
            client = client_with({"search": [{"id": "Q123"}]}, {"entities": {"Q123": entity()}}, {"query": {"pages": [page]}})
            self.assertIsNone(await photos._wikidata(client, "明行寺", 36.654, 138.1894), mutation)

    def test_pd_self_requires_all_provider_rights_markers(self):
        page = file_page()
        metadata = page["imageinfo"][0]["extmetadata"]
        metadata.pop("LicenseUrl")
        metadata.update(LicenseShortName={"value": "Public domain"}, License={"value": "pd"}, Copyrighted={"value": "False"}, Categories={"value": "Temples in Nagano|PD-self"})
        image = photos._file_image(page, "wikidata")
        self.assertEqual(image.license_url, photos.PD_SELF_URL)
        for key in ("License", "Copyrighted", "Categories", "LicenseShortName"):
            broken = copy.deepcopy(page)
            broken["imageinfo"][0]["extmetadata"].pop(key)
            self.assertIsNone(photos._file_image(broken, "wikidata"), key)
        for url in ("https://commons.wikimedia.org/wiki/Template:PD-art", "https://evil.test/license"):
            metadata["LicenseUrl"] = {"value": url}
            self.assertIsNone(photos._file_image(page, "wikidata"))

    async def test_provider_errors_are_distinguished_and_no_retries(self):
        for response in (httpx.Response(503), httpx.Response(200, json={"error": {"code": "maxlag"}}), httpx.Response(200, text="bad json")):
            client = AsyncMock()
            client.get.return_value = response
            with self.assertRaises(photos.PhotoLookupError):
                await photos._commons(client, "明行寺", 36.654, 138.1894, geo=True)
            self.assertEqual(client.get.await_count, 1)

    async def test_first_success_cancels_other_providers_and_releases_slot(self):
        cancelled = asyncio.Event()
        async def blocked(*args, **kwargs):
            try: await asyncio.Event().wait()
            finally: cancelled.set()
        image = photos._file_image(file_page(), "commons")
        context = AsyncMock()
        with patch.object(photos, "_search_wikipedia", AsyncMock(side_effect=blocked)), patch.object(photos, "_commons", AsyncMock(return_value=image)), patch.object(photos, "_wikidata", AsyncMock(return_value=None)), patch.object(photos.httpx, "AsyncClient", return_value=context) as factory:
            result = await photos.search_verified_place_image("明行寺", 36.654, 138.1894)
        self.assertIs(result, image)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(photos._active_lookups, 0)
        self.assertIsInstance(factory.call_args.kwargs["verify"], ssl.SSLContext)
        self.assertFalse(factory.call_args.kwargs["trust_env"])
        self.assertFalse(factory.call_args.kwargs["follow_redirects"])

    async def test_lookup_deadline_busy_and_failed_provider_leave_no_tasks(self):
        context = AsyncMock()
        async def blocked(*args, **kwargs): await asyncio.Event().wait()
        with patch.object(photos, "LOOKUP_SECONDS", .01), patch.object(photos, "_search_wikipedia", AsyncMock(side_effect=blocked)), patch.object(photos, "_commons", AsyncMock(side_effect=blocked)), patch.object(photos, "_wikidata", AsyncMock(side_effect=blocked)), patch.object(photos.httpx, "AsyncClient", return_value=context):
            with self.assertRaises(photos.PhotoLookupError): await photos.search_verified_place_image("明行寺", 36.654, 138.1894)
        self.assertEqual(photos._active_lookups, 0)
        with patch.object(photos, "_active_lookups", photos.MAX_ACTIVE_LOOKUPS), patch.object(photos.httpx, "AsyncClient") as network:
            with self.assertRaises(photos.PhotoLookupError): await photos.search_verified_place_image("明行寺", 36.654, 138.1894)
            network.assert_not_called()
        with patch.object(photos, "_search_wikipedia", AsyncMock(return_value=None)), patch.object(photos, "_commons", AsyncMock(side_effect=photos.PhotoLookupError())), patch.object(photos, "_wikidata", AsyncMock(return_value=None)), patch.object(photos.httpx, "AsyncClient", return_value=context):
            with self.assertRaises(photos.PhotoLookupError): await photos.search_verified_place_image("明行寺", 36.654, 138.1894)

    def test_invalid_coordinates_are_never_accepted(self):
        for value in (True, None, float("nan"), float("inf"), 91):
            self.assertFalse(photos._near(value, 138, 36, 138, .5))
