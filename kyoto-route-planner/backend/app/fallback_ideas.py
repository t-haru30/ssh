import json
import logging
import random
from pathlib import Path

from pydantic import ValidationError

from app.models import RouteIdeaResponse, Theme

logger = logging.getLogger(__name__)
FALLBACK_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "fallback_dataset.json"


def load_fallback_ideas(path: Path = FALLBACK_DATASET_PATH) -> list[RouteIdeaResponse]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.error("Fallback idea dataset is missing: %s", path)
        return []
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read fallback idea dataset: {path}") from error

    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise RuntimeError(f"Unsupported fallback idea dataset format: {path}")
    ideas_payload = payload.get("ideas")
    if not isinstance(ideas_payload, list):
        raise RuntimeError(f"Fallback idea dataset must contain an ideas list: {path}")
    try:
        ideas = [RouteIdeaResponse.model_validate(item) for item in ideas_payload]
    except ValidationError as error:
        raise RuntimeError(f"Fallback idea dataset contains invalid cards: {path}") from error
    if not ideas:
        logger.error("Fallback idea dataset contains no cards: %s", path)
    return ideas


def select_fallback_ideas(
    ideas: list[RouteIdeaResponse],
    count: int,
    theme: Theme,
    excluded_signatures: set[tuple[str, ...]] | None = None,
    prefecture_code: str | None = None,
) -> list[RouteIdeaResponse]:
    excluded = excluded_signatures or set()
    eligible: list[RouteIdeaResponse] = []
    seen: set[tuple[str, ...]] = set(excluded)
    for idea in ideas:
        if prefecture_code is not None and idea.prefecture_code != prefecture_code:
            continue
        if theme != "all" and idea.theme not in {theme, "all"}:
            continue
        signature = tuple(sorted(place.id for place in idea.places))
        if signature in seen:
            continue
        seen.add(signature)
        eligible.append(idea)
    return random.sample(eligible, min(count, len(eligible)))
