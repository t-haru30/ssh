import re

with open('app/itinerary.py', 'r', encoding='utf-8') as f:
    content = f.read()

# plan_itinerary 内の ItinerarySuggestion に coordinates を渡す箇所を OSRM に対応
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
        coordinates=await fetch_detailed_polyline([
            [origin.latitude, origin.longitude],
            *[[p.latitude, p.longitude] for p in best.places],
            [origin.latitude, origin.longitude],
        ]),
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
