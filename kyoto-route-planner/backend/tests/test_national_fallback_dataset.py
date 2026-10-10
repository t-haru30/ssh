import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.models import CatalogPlace, PlaceSearchHit
from app.search import PREFECTURE_NAMES
from scripts import generate_national_fallback_dataset as generator
from scripts.generate_national_fallback_dataset import (
    GENRE_CODES,
    ROUTES_PER_PREFECTURE,
    _ideas_for_prefecture,
)


def make_hit(index: int) -> PlaceSearchHit:
    place = CatalogPlace(
        id=f"yahoo-{index}",
        name=f"名所{index}",
        category="寺院",
        region="京都府",
        address=f"京都府京都市東山区{index}",
        latitude=35 + index * 0.001,
        longitude=135 + index * 0.001,
        description="施設説明",
        genre_code="0424001",
    )
    return PlaceSearchHit(place=place, score=1.0)


def make_prefecture_hit(index: int, prefecture_name: str) -> PlaceSearchHit:
    place = CatalogPlace(
        id=f"yahoo-{prefecture_name}-{index}",
        name=f"{prefecture_name}名所{index}",
        category="寺院",
        region=prefecture_name,
        address=f"{prefecture_name}市内{index}",
        latitude=35 + index * 0.001,
        longitude=135 + index * 0.001,
        description="施設説明",
        genre_code="0424001",
    )
    return PlaceSearchHit(place=place, score=1.0)


class NationalFallbackDatasetTests(unittest.TestCase):
    def test_generator_searches_multiple_categories_for_local_variety(self):
        self.assertIn("0424001", GENRE_CODES)
        self.assertIn("0424002", GENRE_CODES)
        self.assertIn("01", GENRE_CODES)

    def test_builds_five_unique_nearby_ideas_with_prefecture_tags(self):
        ideas = _ideas_for_prefecture("26", "京都府", [make_hit(index) for index in range(5)])

        self.assertEqual(len(ideas), ROUTES_PER_PREFECTURE)
        self.assertTrue(all(idea.prefecture_code == "26" for idea in ideas))
        self.assertTrue(all(idea.prefecture_name == "京都府" for idea in ideas))
        signatures = {
            tuple(sorted(place.id for place in idea.places))
            for idea in ideas
        }
        self.assertEqual(len(signatures), ROUTES_PER_PREFECTURE)
        self.assertTrue(all(
            place.tags["prefecture_code"] == "26"
            and place.tags["prefecture_name"] == "京都府"
            for idea in ideas
            for place in idea.places
        ))

    def test_fails_instead_of_silently_creating_fewer_than_five_ideas(self):
        with self.assertRaisesRegex(RuntimeError, "only 1 distinct nearby spot pairs"):
            _ideas_for_prefecture("26", "京都府", [make_hit(0), make_hit(1)])


class NationalFallbackGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def test_generates_exactly_five_tagged_ideas_for_all_prefectures(self):
        async def search(query: str, **_kwargs):
            prefecture_name = next(name for name in PREFECTURE_NAMES if name in query)
            return SimpleNamespace(results=[
                make_prefecture_hit(index, prefecture_name)
                for index in range(5)
            ])

        with patch.object(
            generator,
            "search_yahoo_catalog",
            new=AsyncMock(side_effect=search),
        ) as yahoo_search:
            ideas = await generator._generate_ideas()

        self.assertEqual(len(ideas), len(PREFECTURE_NAMES) * ROUTES_PER_PREFECTURE)
        self.assertEqual(yahoo_search.await_count, len(PREFECTURE_NAMES))
        for index, prefecture_name in enumerate(PREFECTURE_NAMES, start=1):
            prefecture_ideas = [
                idea for idea in ideas if idea.prefecture_code == f"{index:02d}"
            ]
            self.assertEqual(len(prefecture_ideas), ROUTES_PER_PREFECTURE)
            self.assertTrue(all(
                idea.prefecture_name == prefecture_name
                for idea in prefecture_ideas
            ))


if __name__ == "__main__":
    unittest.main()
