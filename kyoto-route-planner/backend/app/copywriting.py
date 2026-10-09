import json
import os
from dataclasses import dataclass
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

from app.models import Place, Theme

GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_GEMINI_MODEL = "gemini-2.0-flash"


@dataclass(frozen=True)
class RouteCopywriting:
    title: str
    story: str


def _response_text(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    candidate = candidates[0]
    if not isinstance(candidate, dict):
        return ""
    content = candidate.get("content")
    if not isinstance(content, dict):
        return ""
    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""
    return "".join(
        part.get("text", "")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def _parse_copywriting(payload: object) -> RouteCopywriting:
    text = _response_text(payload).strip()
    try:
        result = json.loads(text)
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail="Gemini APIからタイトルとストーリーを含むJSONを取得できませんでした。",
        ) from error
    if (
        not isinstance(result, dict)
        or not isinstance(result.get("title"), str)
        or not isinstance(result.get("story"), str)
        or not result["title"].strip()
        or not result["story"].strip()
    ):
        raise HTTPException(
            status_code=502,
            detail="Gemini APIのコピーライティング応答の形式が不正です。",
        )
    return RouteCopywriting(
        title=result["title"].strip(),
        story=result["story"].strip(),
    )


async def generate_route_copywriting(
    places: list[Place],
    theme: Theme,
) -> RouteCopywriting | None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None

    model = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    place_names = "、".join(place.name for place in places)
    theme_label = {
        "all": "おまかせ",
        "history": "歴史・文化",
        "temple": "神社・寺院",
        "nature": "自然・景色",
        "food": "食・商店街",
    }[theme]
    prompt = (
        "あなたは京都旅行の編集者です。次のルートに、感情を揺さぶる魅力的な"
        "日本語タイトルと、80文字以内の簡単なストーリーを付けてください。"
        "事実にない観光情報や断定的な説明は追加しないでください。"
        'JSONのみを返し、形式は {"title":"...","story":"..."} としてください。\n'
        f"テーマ: {theme_label}\n"
        f"スポット: {place_names}"
    )
    url = f"{GEMINI_API_BASE_URL}/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.8,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                url,
                headers={"x-goog-api-key": api_key},
                json=body,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail="Gemini APIへの接続がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="Gemini APIに接続できませんでした。",
        ) from error

    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail="Gemini APIからJSON形式でない応答が返されました。",
        ) from error
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail="Gemini APIでタイトルとストーリーを生成できませんでした。",
        )
    return _parse_copywriting(payload)
