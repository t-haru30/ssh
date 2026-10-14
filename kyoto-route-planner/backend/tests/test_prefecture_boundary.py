import unittest
from unittest.mock import patch

from app.prefecture_boundary import _polygons, in_prefecture


class BundledBoundaryTests(unittest.TestCase):
    def tearDown(self):
        _polygons.cache_clear()

    def test_all_prefectures_are_bundled_without_development_data(self):
        self.assertEqual(len(_polygons()), 47)
        self.assertTrue(in_prefecture("kyoto", 34.98585, 135.75877))
        self.assertTrue(in_prefecture("gifu", 35.4097, 136.7564))
        self.assertFalse(in_prefecture("gifu", 35.1709, 136.8815))
        self.assertTrue(in_prefecture("iwate", 39.7013, 141.1363))
        self.assertFalse(in_prefecture("missing", 35, 135))

    def test_invalid_or_missing_boundary_fails_closed(self):
        _polygons.cache_clear()
        with patch("pathlib.Path.read_text", side_effect=FileNotFoundError):
            self.assertFalse(in_prefecture("kyoto", 34.98585, 135.75877))
        with patch("pathlib.Path.read_text", return_value='{"version": 2, "areas": {}}'):
            self.assertFalse(in_prefecture("kyoto", 34.98585, 135.75877))
