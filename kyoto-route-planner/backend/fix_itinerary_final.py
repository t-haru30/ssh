import sys

with open('app/itinerary.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 誤って混入した不要な return best などを消し、元の plan_itinerary 構造に戻す
# さらに plan_itinerary の最後に coordinates を返すように修正する

content = content.replace(
'''    if best is None:
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 9999,
            "arrival_at": None,
            "calls": calls
        }
    
        best["calls"] = calls
    return best

async def plan_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
    origin = next(''',
'''    if best is None:
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 9999,
            "arrival_at": None,
            "calls": calls
        }
    best["calls"] = calls
    return best

async def plan_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
    origin = next('''
)

# plan_itinerary の return ItinerarySuggestion を修正
old_return = '''        route_search_calls=route_search_calls,
        note=(
            "候補はOpenStreetMapのPOIタグ・キーワード・距離検索で選び、"
            "候補順列ごとに駅すぱあとAPIの公共交通所要時間を比較しました。"
            "立ち寄り先あたりの滞在時間は一律90分の仮定です。"
            "営業時間、乗車遅延、施設間の徒歩道順は考慮しません。"
            f"{feasibility_note}"
        ),
    )'''

new_return = '''        route_search_calls=route_search_calls,
        coordinates=[
            [origin.latitude, origin.longitude],
            *[[p.latitude, p.longitude] for p in best.places],
            [origin.latitude, origin.longitude],
        ],
        note=(
            "候補はOpenStreetMapのPOIタグ・キーワード・距離検索で選び、"
            "候補順列ごとに駅すぱあとAPIの公共交通所要時間を比較しました。"
            "立ち寄り先あたりの滞在時間は一律90分の仮定です。"
            "営業時間、乗車遅延、施設間の徒歩道順は考慮しません。"
            f"{feasibility_note}"
        ),
    )'''

content = content.replace(old_return, new_return)

with open('app/itinerary.py', 'w', encoding='utf-8') as f:
    f.write(content)
