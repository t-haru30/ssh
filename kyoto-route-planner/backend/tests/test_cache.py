import unittest
from unittest.mock import patch

from app.cache import TTLCache


class TTLCacheTests(unittest.TestCase):
    def test_expired_entry_is_not_returned(self):
        cache: TTLCache[str, str] = TTLCache(ttl_seconds=5, max_entries=2)
        with patch("app.cache.monotonic", side_effect=[10.0, 16.0]):
            cache.set("key", "value")
            found, value = cache.get("key")

        self.assertFalse(found)
        self.assertIsNone(value)

    def test_cache_evicts_least_recently_used_entry(self):
        cache: TTLCache[str, str] = TTLCache(ttl_seconds=60, max_entries=2)
        cache.set("first", "1")
        cache.set("second", "2")
        cache.get("first")
        cache.set("third", "3")

        self.assertEqual(cache.get("first"), (True, "1"))
        self.assertEqual(cache.get("second"), (False, None))
        self.assertEqual(cache.get("third"), (True, "3"))

    def test_cached_values_are_copied_on_read_and_write(self):
        cache: TTLCache[str, list[str]] = TTLCache(ttl_seconds=60, max_entries=2)
        value = ["original"]
        cache.set("key", value)
        value.append("outside")

        found, cached = cache.get("key")
        self.assertTrue(found)
        self.assertEqual(cached, ["original"])
        assert cached is not None
        cached.append("mutated")
        self.assertEqual(cache.get("key"), (True, ["original"]))
