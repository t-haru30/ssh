import argparse
import asyncio
from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import random
import sys

from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.idea_service import generate_idea_from_places
from app.main import IDEA_THEME_LABELS, _route_candidates
from app.models import Place, RouteIdeaResponse, Theme

THEMES: tuple[Theme, ...] = ("history", "temple", "nature", "food")
logger = logging.getLogger("fallback_dataset")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch and save an offline pool of Kyoto swipe ideas."
    )
    parser.add_argument("--count", type=int, default=30, help="Number of unique cards to generate.")
    parser.add_argument(
        "--output",
        type=Path,
        default=BACKEND_DIR / "data" / "fallback_dataset.json",
        help="Output JSON path (defaults to backend/data/fallback_dataset.json).",
    )
    parser.add_argument(
        "--themes",
        nargs="+",
        choices=THEMES,
        default=list(THEMES),
        help="Themes to include.",
    )
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be at least 1")
    if args.count > 500:
        parser.error("--count must not exceed 500")
    return args


def _unique_place_sets(
    candidates: list[Place],
    target: int,
    signatures: set[tuple[str, ...]],
):
    attempts = max(target * 20, 100)
    for _ in range(attempts):
        if target <= 0:
            return
        places = random.sample(candidates, min(random.randint(2, 3), len(candidates)))
        signature = tuple(sorted(place.id for place in places))
        if signature in signatures:
            continue
        signatures.add(signature)
        target -= 1
        yield places


async def _generate_dataset(count: int, themes: list[Theme]) -> list[RouteIdeaResponse]:
    ideas: list[RouteIdeaResponse] = []
    signatures: set[tuple[str, ...]] = set()
    remaining = count
    per_theme = (count + len(themes) - 1) // len(themes)
    for theme in themes:
        target = min(per_theme, remaining)
        if target <= 0:
            break
        try:
            candidates, candidate_note = await asyncio.wait_for(
                _route_candidates(theme),
                timeout=30,
            )
        except (HTTPException, asyncio.TimeoutError) as error:
            logger.warning(
                "Skipping theme %s because candidate lookup failed (%s)",
                theme,
                type(error).__name__,
            )
            continue
        if len(candidates) < 2:
            logger.warning("Skipping theme %s because fewer than two places were found", theme)
            continue

        for places in _unique_place_sets(candidates, target, signatures):
            try:
                idea = await generate_idea_from_places(
                    places=places,
                    theme=theme,
                    theme_label=IDEA_THEME_LABELS[theme],
                    candidate_note=candidate_note,
                )
            except (HTTPException, asyncio.TimeoutError) as error:
                logger.warning(
                    "Skipping a %s card because generation failed (%s)",
                    theme,
                    type(error).__name__,
                )
                continue
            ideas.append(idea)
            remaining -= 1
            logger.info("Generated %d/%d cards", len(ideas), count)
    if len(ideas) < count:
        raise RuntimeError(
            f"Generated only {len(ideas)} of {count} requested cards; "
            "the existing dataset was left unchanged."
        )
    return ideas


async def main() -> None:
    args = _arguments()
    ideas = await _generate_dataset(args.count, args.themes)
    payload = {
        "version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "ideas": [idea.model_dump(mode="json") for idea in ideas],
    }
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f"{output.name}.tmp")
    temporary_output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_output.replace(output)
    logger.info("Saved %d cards to %s", len(ideas), output)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        asyncio.run(main())
    except (HTTPException, OSError, RuntimeError) as error:
        logger.error("%s", error)
        raise SystemExit(1) from error
