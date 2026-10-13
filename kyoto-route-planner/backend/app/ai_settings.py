"""Server-only AI settings with a shared Gemini key and a legacy alias."""

import os
from pathlib import Path

from dotenv import dotenv_values

_PRIVATE_ENV_FILE = Path(__file__).resolve().parents[2] / ".local" / "personal-api.env"
_BACKEND_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
_NAMES = {
    "GEMINI_API_KEY", "RECOMMENDATION_GEMINI_API_KEY", "GEMINI_MODEL",
    "RECOMMENDATION_GEMINI_MODEL", "GEMINI_IMAGE_MODEL", "VENUE_EVIDENCE_ENABLED",
    "ROUTE_ILLUSTRATIONS_ENABLED", "ROUTE_ILLUSTRATION_DAILY_LIMIT",
    "ROUTE_ILLUSTRATION_CACHE_DIR",
}


def _resolve(names: tuple[str, ...], default: str | None) -> str | None:
    # Resolve aliases within each source so an environment value wins over files.
    # An explicit empty value also wins; it can intentionally disable a credential.
    for name in names:
        if name in os.environ:
            return os.environ[name]
    if os.getenv("PYTHON_DOTENV_DISABLED") != "1":
        for path in (_PRIVATE_ENV_FILE, _BACKEND_ENV_FILE):
            try:
                values = dotenv_values(path, interpolate=False)
            except OSError:
                continue
            for name in names:
                value = values.get(name)
                if isinstance(value, str):
                    return value
    return default


def setting(name: str, default: str = "") -> str:
    if name not in _NAMES:
        raise ValueError("Unsupported AI setting")
    value = _resolve((name,), default)
    return default if value is None else value


def gemini_api_key() -> str:
    """GEMINI_API_KEY is canonical; the old recommendation name still works."""
    return (_resolve(("GEMINI_API_KEY", "RECOMMENDATION_GEMINI_API_KEY"), "") or "").strip()


def configure_ai_environment() -> None:
    """Resolve once before legacy clients load backend/.env into os.environ."""
    key = gemini_api_key()
    values = {name: _resolve((name,), None) for name in _NAMES
              if name not in {"GEMINI_API_KEY", "RECOMMENDATION_GEMINI_API_KEY"}}
    for name, value in values.items():
        if value is not None:
            os.environ.setdefault(name, value)
    os.environ.setdefault("GEMINI_API_KEY", key)
