import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.models import Place
from scripts.generate_prefecture_routes import AREAS, FRONTEND_DATA_DIR, _route
from scripts.validate_prefecture_routes import validate_dataset


class PrefectureRouteContractTests(unittest.TestCase):
    def test_generated_route_keeps_theme_for_discover_filter_and_planner_handoff(self):
        config = next(area for area in AREAS if area.id == "kyoto")
        place = Place(id="garden", name="庭園", category="公園", description="", access_point="",
                      latitude=34.99, longitude=135.76, themes=["nature"])
        spot = {"place_id": place.id, "name": place.name, "category": place.category,
                "lat": place.latitude, "lng": place.longitude, "stay_minutes": 45, "score": 1, "role": "stop"}
        route = _route(config, 0, "half_day", [{"place": place}], [spot])
        self.assertEqual(route["theme"], "nature")
        self.assertEqual(route["start"]["name"], "京都駅")
        self.assertEqual(len(route["legs"]), 2)
        self.assertEqual(route["estimated_minutes"], 45 + sum(leg["minutes"] for leg in route["legs"]))

    def test_validator_rejects_missing_or_unknown_themes(self):
        original = json.loads((FRONTEND_DATA_DIR / "kyoto.json").read_text(encoding="utf-8"))
        for theme in (None, "unknown"):
            with self.subTest(theme=theme), tempfile.TemporaryDirectory() as directory:
                data = json.loads(json.dumps(original))
                data["routes"][0].pop("theme", None)
                if theme is not None:
                    data["routes"][0]["theme"] = theme
                path = Path(directory) / "kyoto.json"
                path.write_text(json.dumps(data), encoding="utf-8")
                with patch("scripts.validate_prefecture_routes.on_main_landmass", return_value=True):
                    result = validate_dataset(path)
                self.assertFalse(result["ok"])
                self.assertIn(f"{data['routes'][0]['id']}:theme", result["errors"])
