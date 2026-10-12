import json
import unittest
from pathlib import Path

from scripts.generate_prefecture_routes import BOUNDARIES_PATH, FRONTEND_DATA_DIR, AREAS, on_main_landmass


@unittest.skipUnless(BOUNDARIES_PATH.exists(), "prefecture boundaries are not available")
class PrefectureRouteLandmassTests(unittest.TestCase):
    def test_islands_are_not_on_the_main_landmass(self):
        self.assertTrue(on_main_landmass("JP-47", 26.2124, 127.6809))  # Naha
        self.assertFalse(on_main_landmass("JP-47", 25.85, 131.23))  # Minamidaito
        self.assertTrue(on_main_landmass("JP-37", 34.3428, 134.0466))  # Takamatsu
        self.assertFalse(on_main_landmass("JP-37", 34.4466, 133.9966))  # Naoshima
        self.assertTrue(on_main_landmass("JP-26", 34.9858, 135.7588))  # Kyoto Station

    def test_generated_routes_stay_on_one_landmass(self):
        for area in AREAS:
            dataset = json.loads(Path(FRONTEND_DATA_DIR / f"{area.id}.json").read_text(encoding="utf-8"))
            for route in dataset["routes"]:
                for spot in route["spots"]:
                    with self.subTest(route=route["id"], spot=spot["name"]):
                        self.assertTrue(on_main_landmass(area.code, spot["lat"], spot["lng"]))


if __name__ == "__main__":
    unittest.main()
