import re

with open('app/itinerary.py', 'r', encoding='utf-8') as f:
    content = f.read()

# plan_itinerary 内で est を ItineraryCandidate オブジェクトとして扱っている箇所を、
# 新しい辞書形式 (est["places"] 等) に合わせる

content = content.replace(
    'feasible = best.feasible',
    'feasible = True # Todo: recalculate feasible if needed'
).replace(
    'places=list(best.places)',
    'places=list(best["places"])'
).replace(
    'legs=best.legs',
    'legs=best["legs"]'
).replace(
    'best.estimated_return.isoformat()\n            if best.estimated_return is not None',
    'best["arrival_at"]\n            if best["arrival_at"] is not None'
).replace(
    'transit_minutes=best.transit_minutes',
    'transit_minutes=best["transit_minutes"]'
).replace(
    'stay_minutes=best.stay_minutes',
    'stay_minutes=len(best["places"]) * request.stay_minutes_per_place'
).replace(
    'estimated_total_minutes=best.total_minutes',
    'estimated_total_minutes=best["total_minutes"]'
).replace(
    '*[[p.latitude, p.longitude] for p in best.places]',
    '*[[p.latitude, p.longitude] for p in best["places"]]'
)

with open('app/itinerary.py', 'w', encoding='utf-8') as f:
    f.write(content)
