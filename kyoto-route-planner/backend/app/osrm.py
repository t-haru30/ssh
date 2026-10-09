import httpx
import logging
from typing import List

# OSRM Public Demo API
# Usage Policy: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
# Maximum 10000 requests per minute. No heavy usage.
OSRM_BASE_URL = "http://router.project-osrm.org/route/v1/driving"

logger = logging.getLogger(__name__)

async def fetch_detailed_polyline(coordinates: List[List[float]]) -> List[List[float]]:
    """
    OSRM APIを使用して、地点間の詳細なルート座標（ポリライン）を取得する。
    エラー時は元の直線座標（フォールバック）をそのまま返す。
    
    :param coordinates: [[lat, lon], [lat, lon], ...] のリスト
    :return: 詳細化された [[lat, lon], [lat, lon], ...] のリスト
    """
    if len(coordinates) < 2:
        return coordinates

    # OSRM API expects format: {lon},{lat};{lon},{lat}...
    # 座標の数が多すぎる場合はAPI制限に引っかかる可能性があるが、
    # 今回は最大でも 出発駅->スポット3つ->ホテル->スポット3つ->帰着駅 (9点程度) なので許容範囲
    coords_str = ";".join([f"{lon},{lat}" for lat, lon in coordinates])
    url = f"{OSRM_BASE_URL}/{coords_str}"
    
    params = {
        "overview": "full",
        "geometries": "geojson"
    }

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            if data.get("code") == "Ok" and data.get("routes"):
                # OSRM returns GeoJSON coordinates as [lon, lat]
                geojson_coords = data["routes"][0]["geometry"]["coordinates"]
                # Convert back to [lat, lon] for our internal model
                return [[lat, lon] for lon, lat in geojson_coords]
                
    except (httpx.RequestError, httpx.HTTPStatusError, ValueError, KeyError, IndexError) as e:
        logger.warning(f"OSRM API routing failed, falling back to straight lines: {e}")
        # Fallback to straight lines
        pass
        
    return coordinates
