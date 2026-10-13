import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from dotenv import load_dotenv

from app import ai_settings as settings


class AISettingsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.private = Path(directory.name) / "personal-api.env"
        self.backend = Path(directory.name) / "backend.env"
        for mock in (patch.dict(os.environ, {}, clear=True),
                     patch.object(settings, "_PRIVATE_ENV_FILE", self.private),
                     patch.object(settings, "_BACKEND_ENV_FILE", self.backend)):
            mock.start()
            self.addCleanup(mock.stop)

    def test_source_priority_and_alias_migration(self):
        self.backend.write_text("GEMINI_API_KEY=backend-test-only\n", encoding="utf-8")
        self.private.write_text("RECOMMENDATION_GEMINI_API_KEY=private-test-only\n", encoding="utf-8")
        self.assertEqual(settings.gemini_api_key(), "private-test-only")
        os.environ["RECOMMENDATION_GEMINI_API_KEY"] = "environment-test-only"
        self.assertEqual(settings.gemini_api_key(), "environment-test-only")
        os.environ["GEMINI_API_KEY"] = "new-name-test-only"
        self.assertEqual(settings.gemini_api_key(), "new-name-test-only")

    def test_canonical_private_key_wins_without_copying_into_environment(self):
        self.private.write_text("GEMINI_API_KEY=canonical-test-only\nRECOMMENDATION_GEMINI_API_KEY=legacy-test-only\n", encoding="utf-8")
        self.assertEqual(settings.gemini_api_key(), "canonical-test-only")
        self.assertNotIn("GEMINI_API_KEY", os.environ)

    def test_explicit_empty_canonical_key_disables_alias_and_file_fallback(self):
        self.private.write_text("GEMINI_API_KEY=file-test-only\n", encoding="utf-8")
        os.environ.update(GEMINI_API_KEY="", RECOMMENDATION_GEMINI_API_KEY="legacy-test-only")
        self.assertEqual(settings.gemini_api_key(), "")

    def test_dotenv_disabled_never_reads_private_files(self):
        os.environ["PYTHON_DOTENV_DISABLED"] = "1"
        with patch.object(settings, "dotenv_values") as read:
            self.assertEqual(settings.gemini_api_key(), "")
            self.assertEqual(settings.setting("GEMINI_IMAGE_MODEL", "default-model"), "default-model")
        read.assert_not_called()

    def test_values_are_not_interpolated_and_unrelated_settings_are_rejected(self):
        self.private.write_text("GEMINI_IMAGE_MODEL=${OTHER_MODEL}\n", encoding="utf-8")
        self.assertEqual(settings.setting("GEMINI_IMAGE_MODEL"), "${OTHER_MODEL}")
        with self.assertRaises(ValueError):
            settings.setting("UNRELATED_SECRET")

    def test_missing_private_setting_falls_back_to_backend_then_default(self):
        self.backend.write_text("ROUTE_ILLUSTRATION_DAILY_LIMIT=7\n", encoding="utf-8")
        self.assertEqual(settings.setting("ROUTE_ILLUSTRATION_DAILY_LIMIT"), "7")
        self.assertEqual(settings.setting("ROUTE_ILLUSTRATIONS_ENABLED", "0"), "0")

    def test_startup_preserves_private_values_when_legacy_client_loads_backend_env(self):
        self.private.write_text("RECOMMENDATION_GEMINI_API_KEY=private-test-only\nVENUE_EVIDENCE_ENABLED=1\nROUTE_ILLUSTRATIONS_ENABLED=1\n", encoding="utf-8")
        self.backend.write_text("GEMINI_API_KEY=\nVENUE_EVIDENCE_ENABLED=0\nROUTE_ILLUSTRATIONS_ENABLED=0\n", encoding="utf-8")
        settings.configure_ai_environment()
        load_dotenv(self.backend, override=False)
        self.assertEqual(settings.gemini_api_key(), "private-test-only")
        self.assertEqual(settings.setting("VENUE_EVIDENCE_ENABLED"), "1")
        self.assertEqual(settings.setting("ROUTE_ILLUSTRATIONS_ENABLED"), "1")


if __name__ == "__main__":
    unittest.main()
