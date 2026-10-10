import logging
import random

from fastapi import HTTPException

from app.copywriting import generate_route_copywriting
from app.image_search import search_pixabay_image
from app.models import Place, RouteIdeaResponse, Theme

logger = logging.getLogger(__name__)


async def generate_random_idea(
    theme: Theme,
    theme_label: str,
    requested_count: int | None,
    candidates: list[Place],
    candidate_note: str,
) -> RouteIdeaResponse:
    if len(candidates) < 2:
        raise HTTPException(
            status_code=404,
            detail="アイデア提案には2件以上のスポットが必要です。テーマを変更してください。",
        )

    places = random.sample(candidates, min(requested_count or random.randint(2, 3), len(candidates)))
    image_url = None
    for image_query in (places[0].name, f"京都 {theme_label}", "京都"):
        image_url = await search_pixabay_image(image_query)
        if image_url:
            break

    copywriting_source = "fallback"
    copywriting_note = "GEMINI_API_KEY未設定のため、簡易タイトルとストーリーを使用しています。"
    try:
        copywriting = await generate_route_copywriting(places, theme)
    except HTTPException as error:
        logger.warning(
            "Gemini idea copywriting failed; using fallback copy: status=%s",
            error.status_code,
        )
        copywriting = None
        copywriting_note = "Geminiを利用できなかったため、簡易タイトルとストーリーを使用しています。"

    if copywriting is None:
        place_names = "と".join(place.name for place in places)
        title = f"{place_names}で楽しむ、{theme_label}"
        story = f"{theme_label}をテーマに、{place_names}を巡る寄り道アイデアです。"
    else:
        title = copywriting.title
        story = copywriting.story
        copywriting_source = "gemini"
        copywriting_note = "Geminiがタイトルとストーリーを生成しました。"

    return RouteIdeaResponse(
        theme=theme,
        title=title,
        story=story,
        places=places,
        image_url=image_url,
        copywriting_source=copywriting_source,
        note=f"{candidate_note} {copywriting_note}",
    )
